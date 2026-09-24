import type { AgentDetail, AgentTrade, OwnerSettings } from './familiars.js'
import { SOL_MINT, USDC_MINT, type JupToken } from './jupiter.js'
import { errMsg, log } from './log.js'
import type { PairInfo } from './market.js'
import { buyText, calloutText, enqueue, flushPosts, introText, recapText } from './poster.js'
import { accountFromHistory, entryGuard, parseDirective, sizePosition, type AccountPnl } from './risk.js'
import { discoverMints, screenToken, shieldBlock, volume24h } from './screener.js'
import { mintRisks } from './solana.js'
import { dayStats, utcDay, type AgentState } from './state.js'
import { boughtOnDay, entryFromTrades } from './rebuild.js'
import { buildSeries, entrySignal, manageOnBarClose, regimeOn, replayPosition, warmupBars } from './strategy.js'
import {
  barCandles,
  HOUR,
  metaFor,
  resetCoreCaches,
  sellPosition,
  snapshot,
  symbolOf,
  tokenMeta,
  toRaw,
  type AgentDeps,
  type AgentParams,
  type Snapshot,
  type TickReport,
} from './core.js'
import { findLaunchEntries, manageLaunchExits, rebuildLaunch, resetLaunchCaches } from './launch-agent.js'

export type { AgentDeps, AgentParams, Holding, TickReport } from './core.js'
export { exitTolerance } from './core.js'

// Trend-strategy agent and the per-tick orchestration shared by all modes.

const lastEvaluatedBar = new Map<string, number>()
let discovered: { at: number; mints: string[] } = { at: 0, mints: [] }

/** Clears per-process caches (tests, or after a configuration change). */
export function resetCaches(): void {
  resetCoreCaches()
  resetLaunchCaches()
  lastEvaluatedBar.clear()
  discovered = { at: 0, mints: [] }
  detailCache = null
}

async function manageExits(deps: AgentDeps, state: AgentState, snap: Snapshot, directive: string | null, actions: string[]): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000)
  const roundTrip = 2 * 0.0025
  for (const pos of Object.values(state.positions)) {
    if (pos.strategy === 'launch') continue
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
        pos.lastBarT = bar.t
        // Same order as the backtest: the stop is checked inside the bar first.
        if (bar.l <= pos.stop) {
          pos.exitReason = pos.stop >= pos.entryPrice ? 'trailing stop touched during the bar' : 'stop loss touched during the bar'
          break
        }
        pos.barsHeld++
        const chk = manageOnBarClose(
          { entryPrice: pos.entryPrice, initialStop: pos.initialStop, stop: pos.stop, highWater: pos.highWater, barsHeld: pos.barsHeld },
          series,
          i,
          deps.params.strategy,
          roundTrip,
        )
        pos.highWater = Math.max(pos.highWater, bar.h)
        if (chk.stop > pos.stop) {
          actions.push(`${pos.symbol} stop ${pos.stop.toPrecision(4)} -> ${chk.stop.toPrecision(4)}`)
          pos.stop = chk.stop
        }
        if (chk.exit) {
          // Kept on the position until the sell succeeds, so a failed exit is retried.
          pos.exitReason = chk.reason ?? 'exit rule'
          break
        }
      }
      if (pos.exitReason) await sellPosition(deps, state, pos, holding, price, pos.exitReason, actions)
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
async function reconcile(deps: AgentDeps, state: AgentState, snap: Snapshot, actions: string[], trades: AgentTrade[]): Promise<void> {
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
  if (deps.params.mode === 'launch') {
    for (const h of untracked) await rebuildLaunch(deps, state, h, trades, actions)
    return
  }
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

/**
 * Keeps the SOL fee reserve at its target: idle SOL above it goes to USDC (the
 * agent is flat unless it has a signal) and a wallet funded only with USDC buys
 * the SOL it needs for fees and token-account rent.
 */
async function balanceSol(deps: AgentDeps, state: AgentState, snap: Snapshot, actions: string[]): Promise<void> {
  if (!deps.wallet) return
  const solPrice = snap.prices[SOL_MINT] ?? 0
  if (!(solPrice > 0)) return
  const reserve = deps.params.risk.solReserve
  const free = snap.solQty - reserve
  if (free * solPrice >= 10) {
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
    return
  }
  const missingUsd = (reserve - snap.solQty) * solPrice
  if (snap.solQty < reserve / 2 && snap.cashUsd >= missingUsd + 5) {
    const usd = Math.max(missingUsd, 1)
    const res = await deps.executor.swap({
      inputMint: USDC_MINT,
      outputMint: SOL_MINT,
      amountRaw: toRaw(usd, 6),
      inputDecimals: 6,
      outputDecimals: 9,
      inputPriceUsd: 1,
      outputPriceUsd: solPrice,
      maxLossPct: deps.params.maxSwapLossPct,
    })
    actions.push(res.ok ? `topped up the SOL fee reserve with $${usd.toFixed(2)}` : `could not top up SOL reserve: ${res.error}`)
  }
}

async function findEntries(deps: AgentDeps, state: AgentState, snap: Snapshot, owner: OwnerSettings, actions: string[]): Promise<void> {
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
  // Screening needs current liquidity, volume and audit data, not the first read.
  await metaFor(deps.jup, candidates, 15 * 60_000)
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
  const day = dayStats(state, now, snap.equityUsd)
  let account: AccountPnl | null
  if (deps.executor.live) {
    account = detail ? accountFromHistory(detail.history?.snapshots ?? [], now) : null
    // A new machine mid-day must still honour the owner's daily limit: no
    // entries until today's buys have been read from the public history.
    if (!day.boughtRebuilt) {
      if (detail) {
        day.boughtUsd = Math.max(day.boughtUsd, boughtOnDay(detail.trades ?? [], utcDay(now)))
        day.boughtRebuilt = true
      } else {
        ownerOk = false
      }
    }
  } else {
    day.startPnlUsd ??= snap.equityUsd - (state.paper?.startUsd ?? snap.equityUsd)
    account = paperAccount(state, snap.equityUsd, day.startPnlUsd)
  }

  // 3) Exits first: they are never blocked. Each position follows its own rules.
  await manageExits(deps, state, snap, directive, actions)
  await manageLaunchExits(deps, state, snap, directive, actions)
  // A paused agent only makes protective exits.
  if (directive !== 'pause') await balanceSol(deps, state, snap, actions)
  if (actions.some((a) => a.startsWith('SELL') || a.startsWith('parked') || a.startsWith('topped up'))) snap = await snapshot(deps, state)

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
      if (deps.params.mode === 'launch') await findLaunchEntries(deps, state, snap, owner, actions)
      else await findEntries(deps, state, snap, owner, actions)
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
