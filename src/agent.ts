import type { AppConfig } from './config.js'
import type { Executor } from './executor.js'
import type { AgentDetail, AgentTrade, FamiliarsClient, OwnerSettings } from './familiars.js'
import type { Candle } from './indicators.js'
import { JupiterClient, SOL_MINT, USDC_MINT, type JupToken } from './jupiter.js'
import { errMsg, log } from './log.js'
import { bestPairs, type CandleSource, type PairInfo } from './market.js'
import { buyText, calloutText, enqueue, flushPosts, introText, recapText, sellText } from './poster.js'
import { accountFromHistory, entryGuard, parseDirective, sizePosition, type AccountPnl, type RiskParams } from './risk.js'
import { discoverMints, screenToken, shieldBlock, volume24h, type ScreenParams } from './screener.js'
import { LAMPORTS_PER_SOL, mintRisks, type SolanaClient } from './solana.js'
import { dayStats, utcDay, type AgentState, type PositionState } from './state.js'
import { boughtOnDay, entryFromTrades } from './rebuild.js'
import { buildSeries, entrySignal, manageOnBarClose, regimeOn, replayPosition, warmupBars, type StrategyParams } from './strategy.js'

export interface AgentParams {
  strategy: StrategyParams
  risk: RiskParams
  screen: ScreenParams
  /** Max value lost versus reference prices on any swap. */
  maxSwapLossPct: number
  /** Max quoted round-trip cost (buy then sell back) for a new position. */
  maxRoundTripPct: number
  /** Skip an entry if price already ran this far above the signal close. */
  maxChasePct: number
  /** Tokens evaluated with candles per hour, ranked by 1h organic flow. */
  maxCandidates: number
  coreMints: string[]
  calloutsPerDay: number
}

export interface AgentDeps {
  cfg: AppConfig
  jup: JupiterClient
  sol: SolanaClient
  fam: FamiliarsClient | null
  candles: CandleSource
  executor: Executor
  /** Agent wallet (live) or null in paper mode. */
  wallet: string | null
  params: AgentParams
}

export interface Holding {
  mint: string
  qty: number
  amountRaw?: bigint
  decimals: number
  priceUsd: number
  valueUsd: number
}

export interface TickReport {
  at: string
  mode: string
  equityUsd: number
  cashUsd: number
  positions: { symbol: string; valueUsd: number; pnlPct: number; stop: number }[]
  /** Equity minus net deposits (familiars' definition), when known. */
  pnlUsd: number | null
  actions: string[]
  entryBlockedBy: string | null
}

// Per-process caches: token metadata, best pairs, and the last bar evaluated per mint.
const tokenMeta = new Map<string, JupToken>()
const pairCache = new Map<string, { at: number; pair: PairInfo | null }>()
const lastEvaluatedBar = new Map<string, number>()
let discovered: { at: number; mints: string[] } = { at: 0, mints: [] }

const HOUR = 3600

function closedBars(candles: Candle[], nowSec: number, barSec: number): Candle[] {
  // A bar is final once its period has passed; give the data source a minute.
  return candles.filter((c) => c.t + barSec + 60 <= nowSec)
}

async function metaFor(jup: JupiterClient, mints: string[]): Promise<void> {
  const missing = mints.filter((m) => !tokenMeta.has(m))
  if (!missing.length) return
  for (const t of await jup.tokens(missing)) tokenMeta.set(t.id, t)
}

async function pairFor(mint: string): Promise<PairInfo | null> {
  const hit = pairCache.get(mint)
  if (hit && Date.now() - hit.at < 3.6e6) return hit.pair
  const pairs = await bestPairs([mint])
  const pair = pairs[mint] ?? null
  pairCache.set(mint, { at: Date.now(), pair })
  return pair
}

async function barCandles(deps: AgentDeps, mint: string, nowSec: number): Promise<{ pair: PairInfo; candles: Candle[] } | null> {
  const pair = await pairFor(mint)
  if (!pair) return null
  const barHours = deps.params.strategy.barHours
  const barSec = barHours * HOUR
  // Refresh right after each bar closes; otherwise the cache is good.
  const secsIntoBar = nowSec % barSec
  const maxAge = secsIntoBar < 120 ? 30 : Math.max(60, secsIntoBar - 60)
  const candles = await deps.candles.candles(pair.pairAddress, mint, 'hour', barHours, 300, maxAge)
  return { pair, candles: closedBars(candles, nowSec, barSec) }
}

// --- portfolio -----------------------------------------------------------

async function snapshot(deps: AgentDeps, state: AgentState): Promise<{ holdings: Map<string, Holding>; prices: Record<string, number>; cashUsd: number; solQty: number; equityUsd: number }> {
  const holdings = new Map<string, Holding>()
  let cashUsd = 0
  let solQty = 0
  const positionMints = Object.keys(state.positions)
  if (deps.wallet) {
    const [lamports, tokens] = await Promise.all([deps.sol.solBalanceLamports(deps.wallet), deps.sol.tokenBalances(deps.wallet)])
    solQty = lamports / LAMPORTS_PER_SOL
    const prices = await deps.jup.prices([SOL_MINT, USDC_MINT, ...positionMints, ...tokens.filter((t) => t.amountRaw > 0n).map((t) => t.mint)])
    for (const t of tokens) {
      if (t.amountRaw === 0n) continue
      if (t.mint === USDC_MINT) {
        cashUsd += t.uiAmount * (prices[USDC_MINT] ?? 1)
        continue
      }
      const price = prices[t.mint] ?? 0
      const prev = holdings.get(t.mint)
      const qty = (prev?.qty ?? 0) + t.uiAmount
      const amountRaw = (prev?.amountRaw ?? 0n) + t.amountRaw
      holdings.set(t.mint, { mint: t.mint, qty, amountRaw, decimals: t.decimals, priceUsd: price, valueUsd: qty * price })
    }
    const solPrice = prices[SOL_MINT] ?? 0
    holdings.set(SOL_MINT, { mint: SOL_MINT, qty: solQty, amountRaw: BigInt(lamports), decimals: 9, priceUsd: solPrice, valueUsd: solQty * solPrice })
    let equityUsd = cashUsd
    for (const h of holdings.values()) equityUsd += h.valueUsd
    return { holdings, prices, cashUsd, solQty, equityUsd }
  }
  // Paper wallet.
  const paper = (state.paper ??= { cashUsd: 0, balances: {} })
  const prices = await deps.jup.prices([SOL_MINT, USDC_MINT, ...Object.keys(paper.balances), ...positionMints])
  await metaFor(deps.jup, Object.keys(paper.balances))
  cashUsd = paper.cashUsd
  let equityUsd = cashUsd
  for (const [mint, qty] of Object.entries(paper.balances)) {
    const price = prices[mint] ?? 0
    const decimals = mint === SOL_MINT ? 9 : (tokenMeta.get(mint)?.decimals ?? 6)
    holdings.set(mint, { mint, qty, decimals, priceUsd: price, valueUsd: qty * price })
    equityUsd += qty * price
    if (mint === SOL_MINT) solQty = qty
  }
  return { holdings, prices, cashUsd, solQty, equityUsd }
}

function symbolOf(mint: string): string {
  if (mint === SOL_MINT) return 'SOL'
  return tokenMeta.get(mint)?.symbol ?? mint.slice(0, 4)
}

function toRaw(qty: number, decimals: number): bigint {
  // Round down so we never ask to spend more than we hold.
  const [int, frac = ''] = qty.toFixed(decimals).split('.')
  return BigInt(int! + frac.padEnd(decimals, '0').slice(0, decimals))
}

// --- trading actions -----------------------------------------------------

async function sellPosition(deps: AgentDeps, state: AgentState, pos: PositionState, holding: Holding | undefined, price: number, reason: string, actions: string[]): Promise<boolean> {
  const { params } = deps
  const qty = holding?.qty ?? 0
  const amountRaw = holding?.amountRaw
  const decimals = holding?.decimals ?? tokenMeta.get(pos.mint)?.decimals ?? 6
  if (qty <= 0) {
    delete state.positions[pos.mint]
    actions.push(`dropped ${pos.symbol}: no balance left`)
    return true
  }
  const raw = amountRaw ?? toRaw(qty, decimals)
  const res = await deps.executor.swap({
    inputMint: pos.mint,
    outputMint: USDC_MINT,
    amountRaw: raw,
    inputDecimals: decimals,
    outputDecimals: 6,
    inputPriceUsd: price,
    outputPriceUsd: 1,
    // Exits must get out: allow a wider band than entries.
    maxLossPct: Math.max(params.maxSwapLossPct * 2, 0.08),
  })
  if (!res.ok) {
    actions.push(`SELL ${pos.symbol} failed: ${res.error}`)
    log.warn(`sell ${pos.symbol} failed`, { error: res.error })
    return false
  }
  const proceeds = Number(res.outAmountRaw) / 1e6
  const soldQty = Number(res.inAmountRaw) / 10 ** decimals
  const cost = pos.costUsd * Math.min(1, soldQty / pos.qty)
  const pnlUsd = proceeds - cost
  const now = Date.now()
  const day = dayStats(state, now, 0)
  day.realizedPnlUsd += pnlUsd
  day.trades++
  state.trades.push({ time: now, side: 'sell', mint: pos.mint, symbol: pos.symbol, usd: proceeds, qty: soldQty, price: proceeds / soldQty, signature: res.signature, reason, pnlUsd })
  if (pnlUsd < 0) state.cooldowns[pos.mint] = now + 6 * 3.6e6
  delete state.positions[pos.mint]
  actions.push(`SELL ${pos.symbol} ${proceeds.toFixed(2)} USDC (${pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(2)}) — ${reason}`)
  log.info(`sold ${pos.symbol}`, { proceeds, pnlUsd, reason, signature: res.signature })
  if (res.signature) {
    enqueue(state, {
      kind: 'trade',
      signature: res.signature,
      text: sellText({ symbol: pos.symbol, pnlUsd, pnlPct: pnlUsd / cost, reason, heldHours: (now - pos.openedAt) / 3.6e6 }),
      delayMs: 90_000,
    })
  }
  return true
}

async function manageExits(deps: AgentDeps, state: AgentState, snap: Awaited<ReturnType<typeof snapshot>>, directive: string | null, actions: string[]): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000)
  const roundTrip = 2 * 0.0025
  for (const pos of Object.values(state.positions)) {
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
    pos.highWater = Math.max(pos.highWater, price)
    if (price <= pos.stop) {
      const reason = pos.stop >= pos.entryPrice ? `trailing stop ${pos.stop.toPrecision(4)} hit` : `stop loss ${pos.stop.toPrecision(4)} hit`
      await sellPosition(deps, state, pos, holding, price, reason, actions)
      continue
    }
    // Bar-close management (stop ratchet, trend break, time stop).
    try {
      const data = await barCandles(deps, pos.mint, nowSec)
      if (!data || data.candles.length < warmupBars(deps.params.strategy)) continue
      const series = buildSeries(data.candles, deps.params.strategy)
      // lastBarT starts at the signal bar, so the bar we bought in is the first
      // one managed, exactly as in the backtest.
      for (let i = 0; i < data.candles.length; i++) {
        const bar = data.candles[i]!
        if (bar.t <= pos.lastBarT) continue
        pos.barsHeld++
        const chk = manageOnBarClose(
          { entryPrice: pos.entryPrice, initialStop: pos.initialStop, stop: pos.stop, highWater: pos.highWater, barsHeld: pos.barsHeld },
          series,
          i,
          deps.params.strategy,
          roundTrip,
        )
        pos.highWater = Math.max(pos.highWater, bar.h)
        pos.lastBarT = bar.t
        if (chk.stop > pos.stop) {
          actions.push(`${pos.symbol} stop ${pos.stop.toPrecision(4)} -> ${chk.stop.toPrecision(4)}`)
          pos.stop = chk.stop
        }
        if (chk.exit && i === data.candles.length - 1) {
          await sellPosition(deps, state, pos, holding, price, chk.reason ?? 'exit signal', actions)
          break
        }
      }
    } catch (e) {
      actions.push(`candles for ${pos.symbol} unavailable: ${errMsg(e)}`)
    }
  }
}

/**
 * Brings local state in line with the wallet. Holdings without a local record
 * (fresh machine, lost cache, manual buys) are rebuilt from our public trade
 * history by replaying the exit rules; failing that they are adopted with a
 * wide stop so they are managed rather than ignored.
 */
async function reconcile(deps: AgentDeps, state: AgentState, snap: Awaited<ReturnType<typeof snapshot>>, actions: string[], trades: AgentTrade[]): Promise<void> {
  for (const pos of Object.values(state.positions)) {
    const h = snap.holdings.get(pos.mint)
    const held = h?.qty ?? 0
    if (held * (h?.priceUsd ?? 0) < 1 && held < pos.qty * 0.01) {
      delete state.positions[pos.mint]
      actions.push(`${pos.symbol} no longer in wallet; position closed in state`)
    } else if (held < pos.qty * 0.999) {
      pos.costUsd *= held / pos.qty
      pos.qty = held
    }
  }
  const untracked = [...snap.holdings.values()].filter(
    (h) => h.mint !== SOL_MINT && h.mint !== USDC_MINT && !state.positions[h.mint] && !deps.params.screen.denylist.includes(h.mint) && h.valueUsd >= 5 && h.priceUsd > 0,
  )
  if (!untracked.length) return
  const barSec = deps.params.strategy.barHours * HOUR
  const nowSec = Math.floor(Date.now() / 1000)
  for (const h of untracked) {
    const symbol = symbolOf(h.mint)
    const entry = entryFromTrades(trades, h.mint, h.qty)
    if (entry) {
      try {
        const data = await barCandles(deps, h.mint, nowSec)
        const rp = data ? replayPosition(data.candles, entry.timeSec, entry.price, deps.params.strategy, 2 * 0.0025) : null
        if (data && rp) {
          state.positions[h.mint] = {
            mint: h.mint,
            symbol,
            pair: data.pair.pairAddress,
            setup: 'rebuilt',
            openedAt: entry.timeSec * 1000,
            entryPrice: entry.price,
            qty: h.qty,
            costUsd: entry.price * h.qty,
            initialStop: rp.initialStop,
            stop: rp.stop,
            highWater: Math.max(rp.highWater, h.priceUsd),
            barsHeld: rp.barsHeld,
            lastBarT: rp.lastBarT,
            reasons: ['rebuilt from trade history'],
            ...(rp.exit ? { exitReason: rp.exit.reason } : {}),
          }
          actions.push(`rebuilt ${symbol}: entry ${entry.price.toPrecision(4)}, stop ${rp.stop.toPrecision(4)}${rp.exit ? `, exit due (${rp.exit.reason})` : ''}`)
          continue
        }
      } catch (e) {
        actions.push(`rebuild of ${symbol} failed: ${errMsg(e)}`)
      }
    }
    const stop = h.priceUsd * (1 - deps.params.strategy.maxStopPct)
    state.positions[h.mint] = {
      mint: h.mint,
      symbol,
      setup: 'adopted',
      openedAt: Date.now(),
      entryPrice: h.priceUsd,
      qty: h.qty,
      costUsd: h.valueUsd,
      initialStop: stop,
      stop,
      highWater: h.priceUsd,
      barsHeld: 0,
      lastBarT: Math.floor(nowSec / barSec) * barSec - barSec,
      reasons: ['found in wallet'],
      adopted: true,
    }
    actions.push(`adopted ${symbol} worth $${h.valueUsd.toFixed(2)} with stop ${stop.toPrecision(4)}`)
  }
}

/** Idle SOL above the fee reserve goes to USDC: the agent is flat unless it has a signal. */
async function sweepSol(deps: AgentDeps, state: AgentState, snap: Awaited<ReturnType<typeof snapshot>>, actions: string[]): Promise<void> {
  if (!deps.wallet) return
  const solPrice = snap.prices[SOL_MINT] ?? 0
  const free = snap.solQty - deps.params.risk.solReserve
  if (!(solPrice > 0) || free * solPrice < 10) return
  const res = await deps.executor.swap({
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    amountRaw: toRaw(free, 9),
    inputDecimals: 9,
    outputDecimals: 6,
    inputPriceUsd: solPrice,
    outputPriceUsd: 1,
    maxLossPct: deps.params.maxSwapLossPct,
  })
  actions.push(res.ok ? `parked ${free.toFixed(4)} idle SOL in USDC` : `could not park idle SOL: ${res.error}`)
}

async function findEntries(deps: AgentDeps, state: AgentState, snap: Awaited<ReturnType<typeof snapshot>>, owner: OwnerSettings, actions: string[]): Promise<void> {
  const { params } = deps
  const now = Date.now()
  const nowSec = Math.floor(now / 1000)
  const cash = deps.wallet ? snap.cashUsd : (state.paper?.cashUsd ?? 0)
  if (cash < params.risk.minTradeUsd) {
    actions.push(`no cash to deploy ($${cash.toFixed(2)})`)
    return
  }
  if (Object.keys(state.positions).length >= params.risk.maxPositions) return
  if (params.strategy.regimeEma > 0) {
    const solData = await barCandles(deps, SOL_MINT, nowSec)
    if (!solData || !regimeOn(solData.candles, params.strategy)) {
      actions.push(`regime off: SOL below its ${params.strategy.regimeEma}-bar EMA on ${params.strategy.barHours}h bars; staying in cash`)
      return
    }
  }
  if (now - discovered.at > 15 * 60_000) {
    discovered = { at: now, mints: await discoverMints(deps.jup, params.coreMints) }
  }
  const candidates = discovered.mints.filter((m) => !state.positions[m] && (state.cooldowns[m] ?? 0) < now)
  await metaFor(deps.jup, candidates)
  const screened = candidates
    .map((m) => tokenMeta.get(m))
    .filter((t): t is JupToken => !!t)
    .map((t) => screenToken(t, params.screen, now))
    .filter((v) => v.pass)
    .map((v) => v.token)
  // Rank by organic 1h flow so the candle budget goes to tokens people actually trade.
  const ranked = screened
    .sort((a, b) => (b.stats1h?.buyOrganicVolume ?? 0) + (b.stats1h?.sellOrganicVolume ?? 0) - ((a.stats1h?.buyOrganicVolume ?? 0) + (a.stats1h?.sellOrganicVolume ?? 0)))
    .slice(0, params.maxCandidates)
  const day = dayStats(state, now, snap.equityUsd)
  let entries = 0
  const signals: { token: JupToken; pair: PairInfo; sig: NonNullable<ReturnType<typeof entrySignal>>; barT: number }[] = []
  for (const token of ranked) {
    try {
      const data = await barCandles(deps, token.id, nowSec)
      if (!data || data.candles.length < warmupBars(params.strategy) + 1) continue
      const last = data.candles[data.candles.length - 1]!
      if (lastEvaluatedBar.get(token.id) === last.t) continue
      lastEvaluatedBar.set(token.id, last.t)
      const series = buildSeries(data.candles, params.strategy)
      const i = data.candles.length - 1
      const sig = entrySignal(series, i, params.strategy)
      if (sig) {
        signals.push({ token, pair: data.pair, sig, barT: last.t })
        continue
      }
      maybeCallout(state, token, series, i, params)
    } catch (e) {
      log.debug(`candles failed for ${token.symbol}`, { error: errMsg(e) })
    }
  }
  signals.sort((a, b) => b.sig.score - a.sig.score)
  for (const { token, pair, sig, barT } of signals) {
    if (entries >= params.risk.maxEntriesPerTick) break
    const symbol = token.symbol
    const price = (await deps.jup.prices([token.id]))[token.id] ?? 0
    if (!(price > 0)) continue
    if (price > sig.price * (1 + params.maxChasePct) || price <= sig.stop) {
      actions.push(`skip ${symbol}: price ${price.toPrecision(4)} moved away from signal ${sig.price.toPrecision(4)}`)
      continue
    }
    const warnings = (await deps.jup.shield([token.id]))[token.id]
    const blocked = shieldBlock(warnings, params.screen, token.id)
    if (blocked) {
      actions.push(`skip ${symbol}: ${blocked}`)
      state.cooldowns[token.id] = now + 24 * 3.6e6
      continue
    }
    if (token.id !== SOL_MINT && !params.screen.authorityAllowlist.includes(token.id)) {
      const info = await deps.sol.mintInfo(token.id)
      const risks = info ? mintRisks(info) : ['mint account not found']
      if (risks.length) {
        actions.push(`skip ${symbol}: ${risks.join(', ')}`)
        state.cooldowns[token.id] = now + 24 * 3.6e6
        continue
      }
    }
    // Keep at least the minimum stop distance from the price we actually pay,
    // as the backtest does from the signal close.
    const stop = Math.min(sig.stop, price * (1 - params.strategy.minStopPct))
    const stopPct = (price - stop) / price
    const size = sizePosition(
      { equityUsd: snap.equityUsd, spendableUsd: cash, stopPct, openPositions: Object.keys(state.positions).length, boughtTodayUsd: day.boughtUsd, owner },
      params.risk,
    )
    if (!size.usd) {
      actions.push(`skip ${symbol}: ${size.blockedReason}`)
      continue
    }
    // Round trip at our size: catches sell taxes, honeypots and thin books.
    const buyRaw = toRaw(size.usd, 6)
    try {
      const buyQ = await deps.jup.order({ inputMint: USDC_MINT, outputMint: token.id, amount: buyRaw.toString() })
      const sellQ = await deps.jup.order({ inputMint: token.id, outputMint: USDC_MINT, amount: buyQ.outAmount })
      const roundTrip = 1 - Number(sellQ.outAmount) / Number(buyRaw)
      if (!(roundTrip < params.maxRoundTripPct)) {
        actions.push(`skip ${symbol}: round trip costs ${(roundTrip * 100).toFixed(2)}%`)
        state.cooldowns[token.id] = now + 24 * 3.6e6
        continue
      }
    } catch (e) {
      actions.push(`skip ${symbol}: round-trip quote failed (${errMsg(e)})`)
      continue
    }
    const res = await deps.executor.swap({
      inputMint: USDC_MINT,
      outputMint: token.id,
      amountRaw: buyRaw,
      inputDecimals: 6,
      outputDecimals: token.decimals,
      outputProgram: token.tokenProgram,
      inputPriceUsd: 1,
      outputPriceUsd: price,
      maxLossPct: params.maxSwapLossPct,
    })
    if (!res.ok) {
      actions.push(`BUY ${symbol} failed: ${res.error}`)
      continue
    }
    const qty = Number(res.outAmountRaw) / 10 ** token.decimals
    const spent = Number(res.inAmountRaw) / 1e6
    entries++
    day.boughtUsd += spent
    state.positions[token.id] = {
      mint: token.id,
      symbol,
      pair: pair.pairAddress,
      setup: sig.setup,
      openedAt: now,
      entryPrice: spent / qty,
      qty,
      costUsd: spent,
      initialStop: stop,
      stop,
      highWater: price,
      barsHeld: 0,
      lastBarT: barT,
      entrySignature: res.signature,
      reasons: sig.reasons,
    }
    state.trades.push({ time: now, side: 'buy', mint: token.id, symbol, usd: spent, qty, price: spent / qty, signature: res.signature, reason: sig.reasons.join('; ') })
    actions.push(`BUY ${symbol} $${spent.toFixed(2)} @ ${(spent / qty).toPrecision(4)} stop ${stop.toPrecision(4)} (${sig.setup}; ${size.limitedBy.join(', ') || 'risk-sized'})`)
    log.info(`bought ${symbol}`, { spent, qty, stop, signature: res.signature })
    if (res.signature) {
      enqueue(state, {
        kind: 'trade',
        signature: res.signature,
        text: buyText({ symbol, usd: spent, signal: { ...sig, stop, stopPct }, riskPct: (spent * stopPct) / snap.equityUsd, liquidityUsd: token.liquidity }),
        delayMs: 90_000,
      })
    }
  }
}

function maybeCallout(state: AgentState, token: JupToken, series: ReturnType<typeof buildSeries>, i: number, params: AgentParams): void {
  const now = Date.now()
  const today = utcDay(now)
  const todays = Object.entries(state.lastCallouts).filter(([, t]) => utcDay(t) === today).length
  if (todays >= params.calloutsPerDay || now - (state.lastCallouts[token.id] ?? 0) < 24 * 3.6e6) return
  const c = series.close[i]!
  const trigger = series.priorHigh[i]!
  const volRatio = series.medVol[i]! > 0 ? series.candles[i]!.v / series.medVol[i]! : 0
  const trending = c > series.emaSlow[i]! && series.emaFast[i]! > series.emaSlow[i]! && series.mom[i]! > 0
  if (!trending || !(trigger > c) || trigger / c - 1 > 0.03 || volRatio < 1) return
  state.lastCallouts[token.id] = now
  enqueue(state, { kind: 'callout', mint: token.id, text: calloutText({ symbol: token.symbol, trigger, momentum: series.mom[i]!, momentumHours: params.strategy.changeBars * params.strategy.barHours, barHours: params.strategy.barHours, volumeRatio: volRatio }) })
}

/** Daily recap from familiars' own history, so deposits never count as profit. */
function maybeRecap(state: AgentState, detail: AgentDetail | null): void {
  if (!detail) return
  const today = utcDay(Date.now())
  const snaps = detail.history?.snapshots ?? []
  for (const [day, d] of Object.entries(state.days)) {
    if (day >= today || d.recapPosted) continue
    d.recapPosted = true
    const start = accountFromHistory(snaps, Date.parse(`${day}T00:00:00Z`))
    const end = accountFromHistory(snaps, Date.parse(`${day}T23:59:59Z`))
    const endRow = snaps.filter((x) => x.timestamp <= Date.parse(`${day}T23:59:59Z`)).sort((a, b) => a.timestamp - b.timestamp).pop()
    if (!start || !end || !endRow || !(endRow.equityUsd > 0)) continue
    const closed = detail.trades.filter((t) => t.kind === 'sell' && utcDay(t.time) === day)
    const dayPnl = end.pnlUsd - start.pnlUsd
    enqueue(state, {
      kind: 'note',
      text: recapText({
        day,
        equityUsd: endRow.equityUsd,
        dayPnlUsd: dayPnl,
        dayPnlPct: dayPnl / Math.max(end.netDepositsUsd + start.pnlUsd, 1),
        trades: closed.length,
        wins: state.trades.filter((t) => t.side === 'sell' && utcDay(t.time) === day && (t.pnlUsd ?? 0) > 0).length,
        open: Object.values(state.positions).map((p) => p.symbol),
      }),
    })
  }
}

// Our public profile (P&L history + trades), refreshed every few minutes.
let detailCache: { at: number; detail: AgentDetail } | null = null

async function ourDetail(deps: AgentDeps, state: AgentState): Promise<AgentDetail | null> {
  if (!deps.fam || !state.handle || !deps.executor.live) return null
  if (detailCache && Date.now() - detailCache.at < 5 * 60_000) return detailCache.detail
  const detail = await deps.fam.agent(state.handle)
  detailCache = { at: Date.now(), detail }
  return detail
}

function paperAccount(state: AgentState, equityUsd: number, dayStartPnl: number): AccountPnl {
  const start = state.paper?.startUsd ?? equityUsd
  const pnl = equityUsd - start
  state.peakPnlUsd = Math.max(state.peakPnlUsd ?? 0, pnl)
  return { netDepositsUsd: start, pnlUsd: pnl, peakPnlUsd: state.peakPnlUsd, dayStartPnlUsd: dayStartPnl }
}

export async function tick(deps: AgentDeps, state: AgentState): Promise<TickReport> {
  const actions: string[] = []
  const now = Date.now()

  // 1) Owner limits. In live mode we do not open trades without them.
  let owner: OwnerSettings = { instructions: null, maxPositionUsd: null, dailyLimitUsd: null }
  let ownerOk = !deps.executor.live
  if (deps.fam) {
    try {
      const me = await deps.fam.me()
      owner = me.settings ?? owner
      ownerOk = true
      const handle = (me.agent as { handle?: string } | undefined)?.handle ?? (me as { handle?: string }).handle
      if (handle) state.handle = handle
    } catch (e) {
      actions.push(`could not read owner settings (${errMsg(e)}); no new entries this tick`)
    }
  }
  const directive = parseDirective(owner.instructions)

  // 2) Portfolio and account P&L (equity minus net deposits, as familiars counts it).
  let snap = await snapshot(deps, state)
  await metaFor(deps.jup, [...snap.holdings.keys()].filter((m) => m !== SOL_MINT))
  let detail: AgentDetail | null = null
  try {
    detail = await ourDetail(deps, state)
  } catch (e) {
    actions.push(`public profile unavailable: ${errMsg(e)}`)
  }
  await reconcile(deps, state, snap, actions, detail?.trades ?? [])
  const freshDay = !state.days[utcDay(now)]
  const day = dayStats(state, now, snap.equityUsd)
  let account: AccountPnl | null
  if (deps.executor.live) {
    account = detail ? accountFromHistory(detail.history?.snapshots ?? [], now) : null
    // A new machine mid-day must still honour the owner's daily limit.
    if (freshDay && detail) day.boughtUsd = Math.max(day.boughtUsd, boughtOnDay(detail.trades ?? [], utcDay(now)))
    if (freshDay && !detail) ownerOk = false
  } else {
    day.startPnlUsd ??= snap.equityUsd - (state.paper?.startUsd ?? snap.equityUsd)
    account = paperAccount(state, snap.equityUsd, day.startPnlUsd)
  }

  // 3) Exits first: they are never blocked.
  await manageExits(deps, state, snap, directive, actions)
  await sweepSol(deps, state, snap, actions)
  if (actions.some((a) => a.startsWith('SELL') || a.startsWith('parked'))) snap = await snapshot(deps, state)

  // 4) Entries, behind every guard.
  const guard =
    directive === 'pause' || directive === 'liquidate'
      ? `owner instruction: ${directive}`
      : !ownerOk
        ? 'owner settings or trade history unavailable'
        : !account
          ? 'account P&L unavailable'
          : entryGuard(account, deps.params.risk)
  if (!guard) {
    try {
      await findEntries(deps, state, snap, owner, actions)
    } catch (e) {
      actions.push(`entry scan failed: ${errMsg(e)}`)
    }
  } else {
    actions.push(`entries blocked: ${guard}`)
  }

  // 5) Communication.
  // Introduce ourselves only once there is money to trade with.
  if (!state.introPosted && deps.cfg.posting && deps.fam && deps.executor.live && snap.equityUsd >= 10) {
    enqueue(state, { kind: 'note', text: introText() })
    state.introPosted = true
  }
  maybeRecap(state, detail)
  await flushPosts(state, deps.fam, deps.cfg.posting && deps.executor.live)
  state.lastTickAt = now

  const positions = Object.values(state.positions).map((p) => {
    const price = snap.prices[p.mint] ?? p.entryPrice
    return { symbol: p.symbol, valueUsd: p.qty * price, pnlPct: price / p.entryPrice - 1, stop: p.stop }
  })
  return {
    at: new Date(now).toISOString(),
    mode: deps.executor.live ? 'live' : 'paper',
    equityUsd: snap.equityUsd,
    cashUsd: snap.cashUsd,
    pnlUsd: account?.pnlUsd ?? null,
    positions,
    actions,
    entryBlockedBy: guard,
  }
}

export { volume24h }
