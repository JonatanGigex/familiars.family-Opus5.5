import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { metaFor, pairFor, sellPosition, symbolOf, tokenMeta, toRaw, type AgentDeps, type Holding, type Snapshot } from './core.js'
import { FamiliarsClient, type AgentTrade, type OwnerSettings } from './familiars.js'
import { USDC_MINT } from './jupiter.js'
import {
  featureTag,
  launchExit,
  momentum,
  rankScore,
  replayLaunch,
  screenChain,
  screenCheap,
  utilityScore,
  type LaunchCandidate,
  type LaunchParams,
  type Verdict,
} from './launch.js'
import { errMsg, log } from './log.js'
import type { LaunchChainStats } from './onchain.js'
import { enqueue, launchBuyText } from './poster.js'
import { isSolQuoted, socialsOf, type PumpCoin } from './pumpfun.js'
import { entryFromTrades } from './rebuild.js'
import { sizePosition } from './risk.js'
import { shieldBlock } from './screener.js'
import { mintRisks, TOKEN_2022_PROGRAM } from './solana.js'
import { dayStats, type AgentState, type PositionState } from './state.js'

// New-launch memecoin mode: discovery on pump.fun, screening with the owner's
// filters plus the agent's own anti-rug checks, and launch-specific exits.

const coinCache = new Map<string, PumpCoin>()
const chainCache = new Map<string, { at: number; stats: LaunchChainStats }>()
let boardCache: { at: number; agents: Map<string, number> } | null = null

export function resetLaunchCaches(): void {
  coinCache.clear()
  chainCache.clear()
  boardCache = null
}

export interface ScannedLaunch {
  candidate: LaunchCandidate
  cheap: Verdict
  chain: Verdict | null
  utility: { score: number; notes: string[] }
  momentum: ReturnType<typeof momentum>
  score: number
  /** Reviewer verdict when an approvals file exists; null when none was given. */
  approved: boolean | null
  eligible: boolean
}

/** Where the reviewer (the Claude routine) writes approvals: { [mint]: { approve, note } }. */
export function approvalsPath(statePath: string): string {
  return process.env.LAUNCH_APPROVALS ?? join(dirname(statePath), 'launch-approvals.json')
}

function readApprovals(path: string): Record<string, { approve: boolean; note?: string }> {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, { approve: boolean; note?: string }>
  } catch (e) {
    log.warn('approvals file unreadable; treating every launch as unreviewed', { error: errMsg(e) })
    return {}
  }
}

/** How many familiars agents have traded each mint: the board's own flow. */
async function boardAgents(deps: AgentDeps): Promise<Map<string, number>> {
  if (boardCache && Date.now() - boardCache.at < 2 * 60_000) return boardCache.agents
  const client = deps.board ?? new FamiliarsClient(deps.cfg.familiarsBaseUrl)
  const agents = new Map<string, number>()
  try {
    for (const t of await client.tokens()) agents.set(t.mint, t.agents ?? 0)
  } catch (e) {
    log.debug('board tokens unavailable', { error: errMsg(e) })
  }
  boardCache = { at: Date.now(), agents }
  return agents
}

function candidateOf(coin: PumpCoin, nowMs: number, board: Map<string, number>): LaunchCandidate | null {
  const j = tokenMeta.get(coin.mint)
  if (!j) return null
  const a = j.audit ?? {}
  return {
    mint: coin.mint,
    symbol: coin.symbol,
    name: coin.name,
    description: coin.description ?? '',
    ageMin: (nowMs - coin.created_timestamp) / 60_000,
    mcapUsd: j.mcap ?? j.fdv ?? 0,
    liquidityUsd: j.liquidity ?? 0,
    holders: j.holderCount ?? 0,
    devPct: a.devBalancePercentage ?? null,
    devMints: a.devMints ?? null,
    top10Pct: a.topHoldersPercentage ?? null,
    socials: socialsOf(coin),
    solQuoted: isSolQuoted(coin),
    graduated: coin.complete,
    authoritiesRevoked: a.mintAuthorityDisabled === true && a.freezeAuthorityDisabled === true,
    stats5m: { buyVolume: j.stats5m?.buyVolume, sellVolume: j.stats5m?.sellVolume, numTraders: j.stats5m?.numTraders, priceChange: j.stats5m?.priceChange },
    stats1h: { buyVolume: j.stats1h?.buyVolume, sellVolume: j.stats1h?.sellVolume, numTraders: j.stats1h?.numTraders, priceChange: j.stats1h?.priceChange },
    chain: chainCache.get(coin.mint)?.stats ?? null,
    boardAgents: board.get(coin.mint) ?? 0,
  }
}

/**
 * Finds young pump.fun launches and runs every filter. On-chain forensics (slow)
 * only run for the best few that pass the cheap filters and show momentum.
 */
export async function scanLaunches(deps: AgentDeps, state: AgentState, opts: { forensics?: boolean } = {}): Promise<ScannedLaunch[]> {
  const p = deps.params.launch
  if (!deps.pump) throw new Error('launch mode needs the pump.fun client')
  const now = Date.now()
  const coins = (await deps.pump.activeCoins(6)).filter(
    (c) => (now - c.created_timestamp) / 60_000 <= p.maxAgeMin && !c.is_banned && !c.nsfw && !state.positions[c.mint] && (state.cooldowns[c.mint] ?? 0) < now,
  )
  for (const c of coins) coinCache.set(c.mint, c)
  await metaFor(deps.jup, coins.map((c) => c.mint), 60_000)
  const board = await boardAgents(deps)
  const approvals = readApprovals(approvalsPath(deps.cfg.statePath))

  const scanned: ScannedLaunch[] = []
  for (const coin of coins) {
    const candidate = candidateOf(coin, now, board)
    if (!candidate) continue
    const cheap = screenCheap(candidate, p)
    const utility = utilityScore(candidate)
    const mom = momentum(candidate, p)
    const verdict = approvals[coin.mint]
    scanned.push({
      candidate,
      cheap,
      chain: null,
      utility,
      momentum: mom,
      score: rankScore(candidate, utility.score, mom.ratio),
      approved: verdict ? verdict.approve === true : null,
      eligible: false,
    })
  }
  const shortlist = scanned
    .filter((s) => s.cheap.pass && s.momentum.ok && s.utility.score >= p.minUtilityScore && s.approved !== false)
    .sort((a, b) => b.score - a.score)
    .slice(0, p.maxForensicsPerPass)
  if (opts.forensics !== false && deps.forensics) {
    for (const s of shortlist) {
      const cached = chainCache.get(s.candidate.mint)
      if (!cached || now - cached.at > 10 * 60_000) {
        const coin = coinCache.get(s.candidate.mint)!
        try {
          const stats = await deps.forensics.analyze({
            mint: coin.mint,
            dev: coin.creator,
            supplyRaw: BigInt(Math.round(Number((coin as { total_supply?: number }).total_supply ?? 1e15))),
            tokenProgram: coin.token_program ?? TOKEN_2022_PROGRAM,
            poolOwners: [coin.bonding_curve, coin.pump_swap_pool].filter((x): x is string => !!x),
          })
          chainCache.set(coin.mint, { at: now, stats })
        } catch (e) {
          log.debug(`forensics failed for ${coin.symbol}`, { error: errMsg(e) })
          continue
        }
      }
      s.candidate.chain = chainCache.get(s.candidate.mint)!.stats
      if (s.candidate.chain.devHeldPct !== null) s.candidate.devPct = s.candidate.chain.devHeldPct
      s.chain = screenChain(s.candidate, p)
      s.eligible = s.chain.pass && (!p.requireApproval || s.approved === true)
    }
  }
  return scanned.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score)
}

function stopFor(pos: PositionState, p: LaunchParams): number {
  const trailing = pos.highWater >= pos.entryPrice * (1 + p.trailActivateAt)
  return Math.max(pos.entryPrice * (1 - p.stopPct), trailing ? pos.highWater * (1 - p.trailPct) : 0)
}

export async function findLaunchEntries(deps: AgentDeps, state: AgentState, snap: Snapshot, owner: OwnerSettings, actions: string[]): Promise<void> {
  const p = deps.params.launch
  const risk = { ...deps.params.risk, riskPerTrade: p.riskPerTrade, maxPositions: p.maxPositions }
  const now = Date.now()
  const cash = deps.wallet ? snap.cashUsd : (state.paper?.cashUsd ?? 0)
  if (cash < risk.minTradeUsd) {
    actions.push(`no cash to deploy ($${cash.toFixed(2)})`)
    return
  }
  const open = Object.values(state.positions).filter((x) => x.strategy === 'launch').length
  if (open >= p.maxPositions) return

  const scanned = await scanLaunches(deps, state, { forensics: true })
  const passing = scanned.filter((s) => s.cheap.pass)
  const eligible = scanned.filter((s) => s.eligible)
  actions.push(`launch scan: ${scanned.length} young, ${passing.length} pass filters, ${eligible.length} eligible${eligible.length ? ` (${eligible.map((s) => s.candidate.symbol).join(', ')})` : ''}`)
  for (const s of scanned.filter((x) => x.chain && !x.chain.pass).slice(0, 3)) actions.push(`skip ${s.candidate.symbol}: ${s.chain!.reasons.join('; ')}`)

  const day = dayStats(state, now, snap.equityUsd)
  let entries = 0
  for (const s of eligible) {
    if (entries >= risk.maxEntriesPerTick) break
    const c = s.candidate
    const price = (await deps.jup.prices([c.mint]))[c.mint] ?? 0
    if (!(price > 0)) continue
    const warnings = (await deps.jup.shield([c.mint]))[c.mint]
    const blocked = shieldBlock(warnings, deps.params.screen, c.mint)
    if (blocked) {
      actions.push(`skip ${c.symbol}: ${blocked}`)
      state.cooldowns[c.mint] = now + 24 * 3.6e6
      continue
    }
    const info = await deps.sol.mintInfo(c.mint)
    const risks = info ? mintRisks(info) : ['mint account not found']
    if (risks.length) {
      actions.push(`skip ${c.symbol}: ${risks.join(', ')}`)
      state.cooldowns[c.mint] = now + 24 * 3.6e6
      continue
    }
    const size = sizePosition(
      { equityUsd: snap.equityUsd, spendableUsd: cash, stopPct: p.stopPct, openPositions: open + entries, boughtTodayUsd: day.boughtUsd, owner },
      risk,
    )
    const usd = Math.min(size.usd, c.liquidityUsd * p.maxPositionPctOfLiquidity)
    if (usd < risk.minTradeUsd) {
      actions.push(`skip ${c.symbol}: ${size.blockedReason ?? `pool too thin for $${risk.minTradeUsd} (liquidity $${Math.round(c.liquidityUsd)})`}`)
      continue
    }
    const token = tokenMeta.get(c.mint)!
    const buyRaw = toRaw(usd, 6)
    try {
      const buyQ = await deps.jup.order({ inputMint: USDC_MINT, outputMint: c.mint, amount: buyRaw.toString() })
      const sellQ = await deps.jup.order({ inputMint: c.mint, outputMint: USDC_MINT, amount: buyQ.outAmount })
      const roundTrip = 1 - Number(sellQ.outAmount) / Number(buyRaw)
      if (!(roundTrip < p.maxRoundTripPct)) {
        actions.push(`skip ${c.symbol}: round trip costs ${(roundTrip * 100).toFixed(1)}%`)
        state.cooldowns[c.mint] = now + 6 * 3.6e6
        continue
      }
    } catch (e) {
      actions.push(`skip ${c.symbol}: round-trip quote failed (${errMsg(e)})`)
      continue
    }
    const res = await deps.executor.swap({
      inputMint: USDC_MINT,
      outputMint: c.mint,
      amountRaw: buyRaw,
      inputDecimals: 6,
      outputDecimals: token.decimals,
      outputProgram: token.tokenProgram,
      inputPriceUsd: 1,
      outputPriceUsd: price,
      maxLossPct: Math.max(deps.params.maxSwapLossPct, p.maxRoundTripPct),
    })
    if (!res.ok) {
      actions.push(`BUY ${c.symbol} failed: ${res.error}`)
      continue
    }
    const qty = Number(res.outAmountRaw) / 10 ** token.decimals
    const spent = Number(res.inAmountRaw) / 1e6
    const entryPrice = spent / qty
    entries++
    day.boughtUsd += spent
    const tag = featureTag(c, s.utility.score)
    state.positions[c.mint] = {
      mint: c.mint,
      symbol: c.symbol,
      setup: 'launch',
      strategy: 'launch',
      openedAt: now,
      entryPrice,
      qty,
      costUsd: spent,
      initialStop: entryPrice * (1 - p.stopPct),
      stop: entryPrice * (1 - p.stopPct),
      highWater: entryPrice,
      barsHeld: 0,
      lastBarT: 0,
      tpDone: false,
      entryLiquidityUsd: c.liquidityUsd,
      features: tag,
      entrySignature: res.signature,
      reasons: s.utility.notes,
    }
    state.trades.push({ time: now, side: 'buy', mint: c.mint, symbol: c.symbol, usd: spent, qty, price: entryPrice, signature: res.signature, reason: `launch ${tag}` })
    actions.push(`BUY ${c.symbol} $${spent.toFixed(2)} launch ${tag}`)
    log.info(`bought launch ${c.symbol}`, { spent, qty, signature: res.signature })
    if (res.signature) {
      enqueue(state, {
        kind: 'trade',
        signature: res.signature,
        delayMs: 90_000,
        text: launchBuyText({
          symbol: c.symbol,
          usd: spent,
          ageMin: c.ageMin,
          mcapUsd: c.mcapUsd,
          holders: c.holders,
          bundlersHeldPct: c.chain?.bundleHeldPct ?? null,
          devPct: c.devPct,
          feesSol: c.chain?.feesSol ?? null,
          buySellRatio: s.momentum.ratio,
          socials: [c.socials.twitter && 'X', c.socials.website && 'site', c.socials.telegram && 'TG'].filter((x): x is string => !!x),
          notes: s.utility.notes.slice(0, 2),
          stopPct: p.stopPct,
          takeProfitAt: p.takeProfitAt,
          trailPct: p.trailPct,
          tag,
        }),
      })
    }
  }
}

/** Launch positions: stop, liquidity collapse, partial take-profit, trailing stop, time stop. */
export async function manageLaunchExits(deps: AgentDeps, state: AgentState, snap: Snapshot, directive: string | null, actions: string[]): Promise<void> {
  const p = deps.params.launch
  const mine = Object.values(state.positions).filter((x) => x.strategy === 'launch')
  if (!mine.length) return
  await metaFor(deps.jup, mine.map((x) => x.mint), 60_000)
  const now = Date.now()
  for (const pos of mine) {
    const holding = snap.holdings.get(pos.mint)
    const price = snap.prices[pos.mint] ?? holding?.priceUsd ?? 0
    if (directive === 'liquidate') {
      if (price > 0) await sellPosition(deps, state, pos, holding, price, 'owner asked to liquidate', actions)
      continue
    }
    if (!(price > 0)) {
      actions.push(`no price for ${pos.symbol}; holding`)
      continue
    }
    if (pos.exitReason) {
      await sellPosition(deps, state, pos, holding, price, pos.exitReason, actions)
      continue
    }
    const liquidity = tokenMeta.get(pos.mint)?.liquidity ?? null
    const act = launchExit(
      { entryPrice: pos.entryPrice, entryTimeMs: pos.openedAt, highWater: pos.highWater, tpDone: pos.tpDone === true, entryLiquidityUsd: pos.entryLiquidityUsd },
      price,
      liquidity,
      now,
      p,
    )
    pos.highWater = act.highWater
    pos.stop = stopFor(pos, p)
    if (act.action === 'take_profit') await sellPosition(deps, state, pos, holding, price, act.reason, actions, act.fraction)
    else if (act.action === 'sell_all') {
      pos.exitReason = act.reason
      await sellPosition(deps, state, pos, holding, price, act.reason, actions)
    }
  }
}

/**
 * A launch holding without local state (fresh machine): entry from our public
 * trades, high-water mark replayed from 5-minute candles since entry.
 */
export async function rebuildLaunch(deps: AgentDeps, state: AgentState, h: Holding, trades: AgentTrade[], actions: string[]): Promise<void> {
  const p = deps.params.launch
  const symbol = symbolOf(h.mint)
  const entry = entryFromTrades(trades, h.mint, h.qty)
  const entryPrice = entry?.price ?? h.priceUsd
  const openedAt = entry ? entry.timeSec * 1000 : Date.now()
  let highWater = Math.max(entryPrice, h.priceUsd)
  let exitReason: string | undefined
  if (entry) {
    try {
      const pair = await pairFor(deps, h.mint)
      const candles = pair ? await deps.candles.candles(pair.pairAddress, h.mint, 'minute', 5, 300, 120) : []
      const rp = replayLaunch(candles, entry.timeSec, entry.price, p)
      highWater = Math.max(rp.highWater, h.priceUsd)
      exitReason = rp.exitReason
    } catch (e) {
      actions.push(`candles for ${symbol} unavailable: ${errMsg(e)}`)
    }
  }
  state.positions[h.mint] = {
    mint: h.mint,
    symbol,
    setup: entry ? 'rebuilt' : 'adopted',
    strategy: 'launch',
    openedAt,
    entryPrice,
    qty: h.qty,
    costUsd: entryPrice * h.qty,
    initialStop: entryPrice * (1 - p.stopPct),
    stop: entryPrice * (1 - p.stopPct),
    highWater,
    barsHeld: 0,
    lastBarT: 0,
    tpDone: entry?.partialSold === true,
    reasons: [entry ? 'rebuilt from trade history' : 'found in wallet'],
    ...(entry ? {} : { adopted: true }),
    ...(exitReason ? { exitReason } : {}),
  }
  actions.push(`${entry ? 'rebuilt' : 'adopted'} launch ${symbol}: entry ${entryPrice.toPrecision(4)}, high ${highWater.toPrecision(4)}${exitReason ? `, exit due (${exitReason})` : ''}`)
}
