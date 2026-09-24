import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ema, normalizeCandles, resample, type Candle } from './indicators.js'
import { buildSeries, entrySignal, manageOnBarClose, type Series, type StrategyParams } from './strategy.js'

// Portfolio-level backtester for the live strategy. Signals are evaluated on
// closed 1h bars; stops are checked intrabar, including gaps through the stop.

export interface Instrument {
  mint: string
  sym: string
  candles: Candle[]
}

export interface PortfolioParams {
  initialEquity: number
  maxPositions: number
  /** Fraction of equity lost if the initial stop is hit. */
  riskPerTrade: number
  maxPositionPct: number
  minTradeUsd: number
  /** Fee + price impact per side, e.g. 0.0025. */
  costPerSide: number
  /** Extra slippage when a stop fills. */
  stopSlippage: number
  /** Bars to wait before re-entering a token after a losing exit. */
  cooldownBars: number
}

export const DEFAULT_PORTFOLIO: PortfolioParams = {
  initialEquity: 1000,
  maxPositions: 4,
  riskPerTrade: 0.015,
  maxPositionPct: 0.3,
  minTradeUsd: 10,
  costPerSide: 0.0025,
  stopSlippage: 0.003,
  cooldownBars: 6,
}

export interface Trade {
  sym: string
  setup: string
  entryT: number
  exitT: number
  entry: number
  exit: number
  sizeUsd: number
  pnlUsd: number
  ret: number
  bars: number
  reason: string
}

export interface BacktestResult {
  trades: Trade[]
  equity: { t: number; v: number }[]
  totalReturn: number
  maxDrawdown: number
  winRate: number
  profitFactor: number
  avgWin: number
  avgLoss: number
  exposure: number
  sharpe: number
}

export function loadResearchDir(dir: string): Instrument[] {
  const out: Instrument[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const rec = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { mint: string; sym: string; hour1?: number[][] }
    const candles = normalizeCandles((rec.hour1 ?? []).map((r) => ({ t: r[0]!, o: r[1]!, h: r[2]!, l: r[3]!, c: r[4]!, v: r[5] ?? 0 })))
    if (candles.length >= 200) out.push({ mint: rec.mint, sym: rec.sym, candles })
  }
  return out
}

interface OpenPos {
  inst: number
  setup: string
  entryT: number
  entry: number
  qty: number
  costUsd: number
  initialStop: number
  stop: number
  highWater: number
  barsHeld: number
}

/**
 * Runs the strategy between [fromT, toT) (bar open times). Bars before fromT are
 * used for indicator warm-up only.
 */
export function runBacktest(
  raw: Instrument[],
  sp: StrategyParams,
  pp: PortfolioParams,
  opts: { fromT?: number; toT?: number; regime?: Candle[] } = {},
): BacktestResult {
  const barSec = sp.barHours * 3600
  const insts = sp.barHours > 1 ? raw.map((x) => ({ ...x, candles: resample(x.candles, 3600, sp.barHours) })) : raw
  const series: Series[] = insts.map((x) => buildSeries(x.candles, sp))
  const index: Map<number, number>[] = insts.map((x) => new Map(x.candles.map((c, i) => [c.t, i])))
  const times = [...new Set(insts.flatMap((x) => x.candles.map((c) => c.t)))].sort((a, b) => a - b)
  const fromT = opts.fromT ?? -Infinity
  const toT = opts.toT ?? Infinity

  let regimeOk: (t: number) => boolean = () => true
  if (sp.regimeEma > 0 && opts.regime?.length) {
    const rc = sp.barHours > 1 ? resample(opts.regime, 3600, sp.barHours) : opts.regime
    const re = ema(rc.map((c) => c.c), sp.regimeEma)
    const m = new Map(rc.map((c, i) => [c.t, Number.isFinite(re[i]!) && c.c > re[i]!]))
    regimeOk = (t) => m.get(t) ?? false
  }

  let cash = pp.initialEquity
  const open = new Map<number, OpenPos>()
  const trades: Trade[] = []
  const equity: { t: number; v: number }[] = []
  const lastClose = new Map<number, number>()
  const cooldownUntil = new Map<number, number>()
  let investedBars = 0
  let bars = 0
  const roundTrip = 2 * pp.costPerSide

  const close = (p: OpenPos, t: number, rawPrice: number, reason: string, slip: number) => {
    const px = rawPrice * (1 - pp.costPerSide - slip)
    const proceeds = p.qty * px
    cash += proceeds
    const pnl = proceeds - p.costUsd
    trades.push({
      sym: insts[p.inst]!.sym,
      setup: p.setup,
      entryT: p.entryT,
      exitT: t,
      entry: p.entry,
      exit: px,
      sizeUsd: p.costUsd,
      pnlUsd: pnl,
      ret: pnl / p.costUsd,
      bars: p.barsHeld,
      reason,
    })
    open.delete(p.inst)
    if (pnl < 0) cooldownUntil.set(p.inst, t + pp.cooldownBars * barSec)
  }

  for (const t of times) {
    if (t >= toT) break
    const active = t >= fromT && t + barSec <= (opts.toT ?? Infinity)

    // 1) Manage open positions on this bar.
    for (const p of [...open.values()]) {
      const i = index[p.inst]!.get(t)
      if (i === undefined) continue
      const bar = series[p.inst]!.candles[i]!
      lastClose.set(p.inst, bar.c)
      if (bar.o <= p.stop) {
        close(p, t, bar.o, 'stop (gap)', pp.stopSlippage)
        continue
      }
      if (bar.l <= p.stop) {
        close(p, t, p.stop, p.stop >= p.entry ? 'trailing stop' : 'stop loss', pp.stopSlippage)
        continue
      }
      p.barsHeld++
      const chk = manageOnBarClose(
        { entryPrice: p.entry, initialStop: p.initialStop, stop: p.stop, highWater: p.highWater, barsHeld: p.barsHeld },
        series[p.inst]!,
        i,
        sp,
        roundTrip,
      )
      p.highWater = Math.max(p.highWater, bar.h)
      p.stop = chk.stop
      if (chk.exit) close(p, t, bar.c, chk.reason ?? 'exit', 0)
    }

    // 2) Mark to market.
    for (let k = 0; k < insts.length; k++) {
      const i = index[k]!.get(t)
      if (i !== undefined) lastClose.set(k, series[k]!.candles[i]!.c)
    }
    let posValue = 0
    for (const p of open.values()) posValue += p.qty * (lastClose.get(p.inst) ?? p.entry)
    const eq = cash + posValue
    if (active) {
      equity.push({ t, v: eq })
      bars++
      if (open.size) investedBars += posValue / eq
    }

    // 3) New entries on this closed bar.
    if (!active || open.size >= pp.maxPositions || !regimeOk(t)) continue
    const signals: { k: number; sig: NonNullable<ReturnType<typeof entrySignal>> }[] = []
    for (let k = 0; k < insts.length; k++) {
      if (open.has(k) || (cooldownUntil.get(k) ?? 0) > t) continue
      const i = index[k]!.get(t)
      if (i === undefined) continue
      const sig = entrySignal(series[k]!, i, sp)
      if (sig) signals.push({ k, sig })
    }
    signals.sort((a, b) => b.sig.score - a.sig.score)
    for (const { k, sig } of signals) {
      if (open.size >= pp.maxPositions) break
      const riskUsd = eq * pp.riskPerTrade
      let size = Math.min(riskUsd / sig.stopPct, eq * pp.maxPositionPct, cash * 0.98)
      if (size < pp.minTradeUsd) continue
      const px = sig.price * (1 + pp.costPerSide)
      const qty = size / px
      cash -= size
      size = qty * px
      open.set(k, {
        inst: k,
        setup: sig.setup,
        entryT: t,
        entry: px,
        qty,
        costUsd: size,
        initialStop: sig.stop,
        stop: sig.stop,
        highWater: sig.price,
        barsHeld: 0,
      })
    }
  }
  // Close whatever is still open at the last price.
  const endT = equity.length ? equity[equity.length - 1]!.t : 0
  for (const p of [...open.values()]) close(p, endT, lastClose.get(p.inst) ?? p.entry, 'end of test', 0)

  return summarize(trades, equity, pp.initialEquity, cash, bars, investedBars)
}

function summarize(trades: Trade[], equity: { t: number; v: number }[], initial: number, finalCash: number, bars: number, investedBars: number): BacktestResult {
  let peak = initial
  let maxDd = 0
  const rets: number[] = []
  for (let i = 0; i < equity.length; i++) {
    const v = equity[i]!.v
    peak = Math.max(peak, v)
    maxDd = Math.max(maxDd, 1 - v / peak)
    if (i > 0) rets.push(v / equity[i - 1]!.v - 1)
  }
  const wins = trades.filter((t) => t.pnlUsd > 0)
  const losses = trades.filter((t) => t.pnlUsd <= 0)
  const gp = wins.reduce((s, t) => s + t.pnlUsd, 0)
  const gl = -losses.reduce((s, t) => s + t.pnlUsd, 0)
  const mean = rets.reduce((s, r) => s + r, 0) / Math.max(rets.length, 1)
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(rets.length - 1, 1))
  return {
    trades,
    equity,
    totalReturn: finalCash / initial - 1,
    maxDrawdown: maxDd,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    avgWin: wins.length ? wins.reduce((s, t) => s + t.ret, 0) / wins.length : 0,
    avgLoss: losses.length ? losses.reduce((s, t) => s + t.ret, 0) / losses.length : 0,
    exposure: bars ? investedBars / bars : 0,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(24 * 365) : 0,
  }
}

/** Buy-and-hold return of an instrument over [fromT, toT). */
export function holdReturn(candles: Candle[], fromT: number, toT: number): number {
  const inRange = candles.filter((c) => c.t >= fromT && c.t < toT)
  if (inRange.length < 2) return NaN
  return inRange[inRange.length - 1]!.c / inRange[0]!.o - 1
}

// --- Momentum rotation -------------------------------------------------------

export interface RotationParams {
  rebalanceHours: number
  lookbackHours: number
  topK: number
  /** Only hold tokens closing above their EMA of this many hours. */
  trendEmaHours: number
  /** Go to cash when SOL closes below its EMA of this many hours (0 = off). */
  regimeEmaHours: number
  /** Keep a holding while it ranks within topK * hysteresis. */
  hysteresis: number
  stopLossPct: number
  trailingPct: number
  /** Rank by return divided by volatility instead of raw return. */
  riskAdjusted: boolean
}

export const DEFAULT_ROTATION: RotationParams = {
  rebalanceHours: 24,
  lookbackHours: 168,
  topK: 3,
  trendEmaHours: 240,
  regimeEmaHours: 480,
  hysteresis: 2,
  stopLossPct: 0.15,
  trailingPct: 0.25,
  riskAdjusted: false,
}

/** Hourly simulation of a top-K momentum rotation with trend, regime and stop filters. */
export function runRotation(
  instruments: Instrument[],
  rp: RotationParams,
  pp: PortfolioParams,
  opts: { fromT?: number; toT?: number; regime?: Candle[] } = {},
): BacktestResult {
  const closes = instruments.map((x) => x.candles.map((c) => c.c))
  const trend = closes.map((c) => ema(c, rp.trendEmaHours))
  const index = instruments.map((x) => new Map(x.candles.map((c, i) => [c.t, i])))
  const times = [...new Set(instruments.flatMap((x) => x.candles.map((c) => c.t)))].sort((a, b) => a - b)
  const fromT = opts.fromT ?? -Infinity
  const toT = opts.toT ?? Infinity
  let regimeOk: (t: number) => boolean = () => true
  if (rp.regimeEmaHours > 0 && opts.regime?.length) {
    const rc = opts.regime
    const re = ema(rc.map((c) => c.c), rp.regimeEmaHours)
    const m = new Map(rc.map((c, i) => [c.t, Number.isFinite(re[i]!) && c.c > re[i]!]))
    regimeOk = (t) => m.get(t) ?? false
  }
  let cash = pp.initialEquity
  const open = new Map<number, { entry: number; qty: number; cost: number; peak: number; entryT: number; bars: number }>()
  const trades: Trade[] = []
  const equity: { t: number; v: number }[] = []
  const last = new Map<number, number>()
  let investedBars = 0
  let bars = 0
  const sell = (k: number, t: number, raw: number, reason: string, slip: number) => {
    const p = open.get(k)!
    const px = raw * (1 - pp.costPerSide - slip)
    const proceeds = p.qty * px
    cash += proceeds
    trades.push({ sym: instruments[k]!.sym, setup: 'rotation', entryT: p.entryT, exitT: t, entry: p.entry, exit: px, sizeUsd: p.cost, pnlUsd: proceeds - p.cost, ret: proceeds / p.cost - 1, bars: p.bars, reason })
    open.delete(k)
  }
  const score = (k: number, i: number): number => {
    const c = closes[k]!
    if (i < Math.max(rp.lookbackHours, rp.trendEmaHours)) return NaN
    const ret = c[i]! / c[i - rp.lookbackHours]! - 1
    if (!rp.riskAdjusted) return ret
    let s2 = 0
    for (let j = i - rp.lookbackHours + 1; j <= i; j++) s2 += Math.log(c[j]! / c[j - 1]!) ** 2
    const vol = Math.sqrt(s2 / rp.lookbackHours)
    return vol > 0 ? ret / vol : NaN
  }
  for (const t of times) {
    if (t >= toT) break
    const active = t >= fromT
    for (const [k, p] of [...open.entries()]) {
      const i = index[k]!.get(t)
      if (i === undefined) continue
      const bar = instruments[k]!.candles[i]!
      p.bars++
      const stop = Math.max(p.entry * (1 - rp.stopLossPct), p.peak * (1 - rp.trailingPct))
      if (bar.o <= stop) sell(k, t, bar.o, 'stop (gap)', pp.stopSlippage)
      else if (bar.l <= stop) sell(k, t, stop, 'stop', pp.stopSlippage)
      else p.peak = Math.max(p.peak, bar.h)
    }
    for (let k = 0; k < instruments.length; k++) {
      const i = index[k]!.get(t)
      if (i !== undefined) last.set(k, closes[k]![i]!)
    }
    let posValue = 0
    for (const [k, p] of open) posValue += p.qty * (last.get(k) ?? p.entry)
    const eq = cash + posValue
    if (!active) continue
    equity.push({ t, v: eq })
    bars++
    if (open.size) investedBars += posValue / eq
    if (Math.floor(t / 3600) % rp.rebalanceHours !== 0) continue
    // Rebalance.
    const ranked: { k: number; s: number }[] = []
    for (let k = 0; k < instruments.length; k++) {
      const i = index[k]!.get(t)
      if (i === undefined) continue
      const s = score(k, i)
      if (Number.isFinite(s) && s > 0 && closes[k]![i]! > trend[k]![i]!) ranked.push({ k, s })
    }
    ranked.sort((a, b) => b.s - a.s)
    const ok = regimeOk(t)
    const keep = new Set(ok ? ranked.slice(0, rp.topK * rp.hysteresis).map((r) => r.k) : [])
    for (const k of [...open.keys()]) if (!keep.has(k)) sell(k, t, last.get(k)!, ok ? 'dropped from ranking' : 'regime off', 0)
    if (!ok) continue
    for (const { k } of ranked.slice(0, rp.topK)) {
      if (open.has(k) || open.size >= rp.topK) continue
      const target = Math.min(eq / rp.topK, cash * 0.98)
      if (target < pp.minTradeUsd) break
      const px = last.get(k)! * (1 + pp.costPerSide)
      cash -= target
      open.set(k, { entry: px, qty: target / px, cost: target, peak: last.get(k)!, entryT: t, bars: 0 })
    }
  }
  const endT = equity.length ? equity[equity.length - 1]!.t : 0
  for (const k of [...open.keys()]) sell(k, endT, last.get(k)!, 'end of test', 0)
  return summarize(trades, equity, pp.initialEquity, cash, bars, investedBars)
}
