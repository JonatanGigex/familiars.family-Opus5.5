import { atr, change, ema, priorHigh, priorMedianVolume, rsi, type Candle } from './indicators.js'

// Trend-following entries on closed bars (1h or larger) with ATR-based risk
// management. The same functions drive the live agent and the backtester.
// All lookbacks are in bars of `barHours` hours.

export type Setup = 'breakout' | 'pullback'

export interface StrategyParams {
  /** Bar size in hours: 1, 4 or 12 (what GeckoTerminal serves directly). */
  barHours: number
  setups: Setup[]
  emaFast: number
  emaSlow: number
  /** Long-term trend filter; 0 disables it. */
  emaTrend: number
  breakoutLookback: number
  volumeLookback: number
  minVolumeRatio: number
  /** Max distance of the close above emaFast, in ATRs (avoid chasing). */
  maxExtensionAtr: number
  /** Momentum lookback in bars, and the allowed band for that change. */
  changeBars: number
  minMomentum: number
  maxMomentum: number
  rsiPeriod: number
  pullbackRsi: number
  reclaimRsi: number
  atrPeriod: number
  stopAtr: number
  minStopPct: number
  maxStopPct: number
  /** Move the stop to break-even once price has run this many R. */
  breakevenR: number
  /** Start trailing once price has run this many R. */
  trailStartR: number
  trailAtr: number
  timeStopBars: number
  timeStopMinR: number
  /** Exit when a bar closes below emaSlow. */
  trendExit: boolean
  /** Only open trades while SOL closes above its EMA of this many bars (0 = off). */
  regimeEma: number
}

export const DEFAULT_PARAMS: StrategyParams = {
  barHours: 1,
  setups: ['breakout'],
  emaFast: 20,
  emaSlow: 50,
  emaTrend: 0,
  breakoutLookback: 24,
  volumeLookback: 24,
  minVolumeRatio: 1.5,
  maxExtensionAtr: 3,
  changeBars: 24,
  minMomentum: 0,
  maxMomentum: 1.5,
  rsiPeriod: 14,
  pullbackRsi: 40,
  reclaimRsi: 50,
  atrPeriod: 14,
  stopAtr: 2,
  minStopPct: 0.04,
  maxStopPct: 0.15,
  breakevenR: 1,
  trailStartR: 1.5,
  trailAtr: 3,
  timeStopBars: 48,
  timeStopMinR: 0.3,
  trendExit: true,
  regimeEma: 0,
}

/** Market regime: SOL's last closed bar above its EMA. Unknown counts as risk-off. */
export function regimeOn(solCandles: Candle[], p: StrategyParams): boolean {
  if (p.regimeEma <= 0) return true
  if (solCandles.length <= p.regimeEma) return false
  const e = ema(solCandles.map((c) => c.c), p.regimeEma)
  const i = solCandles.length - 1
  return Number.isFinite(e[i]!) && solCandles[i]!.c > e[i]!
}

export interface Series {
  candles: Candle[]
  close: number[]
  emaFast: number[]
  emaSlow: number[]
  emaTrend: number[]
  atr: number[]
  rsi: number[]
  priorHigh: number[]
  medVol: number[]
  /** Change over `changeBars` bars. */
  mom: number[]
}

export function buildSeries(candles: Candle[], p: StrategyParams): Series {
  const close = candles.map((c) => c.c)
  return {
    candles,
    close,
    emaFast: ema(close, p.emaFast),
    emaSlow: ema(close, p.emaSlow),
    emaTrend: p.emaTrend > 0 ? ema(close, p.emaTrend) : close.map(() => NaN),
    atr: atr(candles, p.atrPeriod),
    rsi: rsi(close, p.rsiPeriod),
    priorHigh: priorHigh(candles, p.breakoutLookback),
    medVol: priorMedianVolume(candles, p.volumeLookback),
    mom: change(close, p.changeBars),
  }
}

export function warmupBars(p: StrategyParams): number {
  return Math.max(p.emaSlow, p.emaTrend, p.breakoutLookback, p.volumeLookback, p.atrPeriod + 1, p.changeBars + 1) + 1
}

export interface EntrySignal {
  setup: Setup
  /** Reference price: close of the signal bar. */
  price: number
  stop: number
  stopPct: number
  atr: number
  score: number
  volumeRatio: number
  momentum: number
  reasons: string[]
}

/** Evaluates bar i, which must be closed. Returns null when there is no entry. */
export function entrySignal(s: Series, i: number, p: StrategyParams): EntrySignal | null {
  if (i < warmupBars(p) || i >= s.candles.length) return null
  const bar = s.candles[i]!
  const c = bar.c
  const a = s.atr[i]!
  const ef = s.emaFast[i]!
  const es = s.emaSlow[i]!
  const mom = s.mom[i]!
  if (![a, ef, es, mom].every(Number.isFinite) || a <= 0) return null

  // Trend and momentum context shared by every setup.
  if (!(c > es && ef > es)) return null
  if (p.emaTrend > 0 && !(c > s.emaTrend[i]!)) return null
  if (mom < p.minMomentum || mom > p.maxMomentum) return null
  const extension = (c - ef) / a
  if (extension > p.maxExtensionAtr) return null

  const volRatio = s.medVol[i]! > 0 ? bar.v / s.medVol[i]! : 0
  let setup: Setup | null = null
  const reasons: string[] = []

  if (p.setups.includes('breakout') && c > s.priorHigh[i]! && volRatio >= p.minVolumeRatio) {
    setup = 'breakout'
    reasons.push(`closed above the ${p.breakoutLookback * p.barHours}h high on ${volRatio.toFixed(1)}x median volume`)
  } else if (p.setups.includes('pullback')) {
    const recentMin = Math.min(s.rsi[i - 1]!, s.rsi[i - 2]!, s.rsi[i - 3]!)
    if (recentMin <= p.pullbackRsi && s.rsi[i]! >= p.reclaimRsi && c > bar.o) {
      setup = 'pullback'
      reasons.push(`RSI reset to ${recentMin.toFixed(0)} and reclaimed ${s.rsi[i]!.toFixed(0)} inside the uptrend`)
    }
  }
  if (!setup) return null

  const rawStopPct = (p.stopAtr * a) / c
  const stopPct = Math.min(Math.max(rawStopPct, p.minStopPct), p.maxStopPct)
  // A stop wider than the cap means the token is too volatile for the risk budget.
  if (rawStopPct > p.maxStopPct * 1.5) return null
  reasons.push(`EMA${p.emaFast} > EMA${p.emaSlow} on ${p.barHours}h bars`, `${p.changeBars * p.barHours}h ${(mom * 100).toFixed(1)}%`)
  const atrPct = a / c
  const score = (c / es - 1) / atrPct + Math.log(Math.max(volRatio, 0.5)) + (setup === 'breakout' ? 0.5 : 0)
  return { setup, price: c, stop: c * (1 - stopPct), stopPct, atr: a, score, volumeRatio: volRatio, momentum: mom, reasons }
}

export interface ManagedPosition {
  entryPrice: number
  initialStop: number
  stop: number
  highWater: number
  barsHeld: number
}

export interface ExitCheck {
  exit: boolean
  reason?: string
  /** Updated stop (never lower than before). */
  stop: number
}

/**
 * Called once per closed bar while a position is open. Ratchets the stop and
 * reports discretionary exits (trend break, time stop). Hard stops against the
 * live price are handled by the caller between bars.
 */
export function manageOnBarClose(pos: ManagedPosition, s: Series, i: number, p: StrategyParams, roundTripCost: number): ExitCheck {
  const bar = s.candles[i]!
  const R = pos.entryPrice - pos.initialStop
  let stop = pos.stop
  const high = Math.max(pos.highWater, bar.h)
  const a = s.atr[i]!
  if (R > 0) {
    if (high >= pos.entryPrice + p.breakevenR * R) stop = Math.max(stop, pos.entryPrice * (1 + roundTripCost))
    if (high >= pos.entryPrice + p.trailStartR * R && Number.isFinite(a)) stop = Math.max(stop, high - p.trailAtr * a)
  }
  if (p.trendExit && Number.isFinite(s.emaSlow[i]!) && bar.c < s.emaSlow[i]!) {
    return { exit: true, reason: `closed below EMA${p.emaSlow}: trend broken`, stop }
  }
  if (pos.barsHeld >= p.timeStopBars && R > 0 && bar.c < pos.entryPrice + p.timeStopMinR * R) {
    return { exit: true, reason: `time stop: ${pos.barsHeld * p.barHours}h without progress`, stop }
  }
  return { exit: false, stop }
}

/** Initial stop for an entry at `entryPrice` right after closed bar i. */
export function initialStopAt(s: Series, i: number, entryPrice: number, p: StrategyParams): number {
  const c = s.close[i]!
  const a = s.atr[i]!
  const pct = Number.isFinite(a) && c > 0 ? Math.min(Math.max((p.stopAtr * a) / c, p.minStopPct), p.maxStopPct) : p.maxStopPct
  return Math.min(c * (1 - pct), entryPrice * (1 - p.minStopPct))
}

export interface ReplayedPosition extends ManagedPosition {
  /** Open time of the last closed bar applied. */
  lastBarT: number
  /** Set when the rules would already have closed the position. */
  exit?: { reason: string; barT: number }
}

/**
 * Rebuilds a position's risk state from its entry alone by replaying the exit
 * rules over the closed bars since the entry. The agent's local state is only a
 * cache: after a restart (or on a fresh machine) the same stops come back, and a
 * stop that was hit while nothing was running is reported.
 */
export function replayPosition(candles: Candle[], entryTimeSec: number, entryPrice: number, p: StrategyParams, roundTripCost: number): ReplayedPosition | null {
  const barSec = p.barHours * 3600
  let sig = -1
  for (let i = 0; i < candles.length; i++) if (candles[i]!.t + barSec <= entryTimeSec) sig = i
  if (sig < 0) return null
  const s = buildSeries(candles, p)
  const initialStop = initialStopAt(s, sig, entryPrice, p)
  const pos: ReplayedPosition = { entryPrice, initialStop, stop: initialStop, highWater: entryPrice, barsHeld: 0, lastBarT: candles[sig]!.t }
  for (let i = sig + 1; i < candles.length; i++) {
    const bar = candles[i]!
    if (bar.l <= pos.stop) {
      pos.exit = { reason: pos.stop >= entryPrice ? 'trailing stop hit while offline' : 'stop loss hit while offline', barT: bar.t }
      pos.lastBarT = bar.t
      return pos
    }
    pos.barsHeld++
    const chk = manageOnBarClose(pos, s, i, p, roundTripCost)
    pos.highWater = Math.max(pos.highWater, bar.h)
    pos.stop = chk.stop
    pos.lastBarT = bar.t
    if (chk.exit) {
      pos.exit = { reason: chk.reason ?? 'exit rule', barT: bar.t }
      return pos
    }
  }
  return pos
}
