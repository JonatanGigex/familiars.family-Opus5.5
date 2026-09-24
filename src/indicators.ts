// Pure indicator functions shared by the live agent and the backtester.
// Arrays are aligned with the input: index i uses data up to and including i.
// Values that are not yet defined are NaN.

export interface Candle {
  /** Bar open time, unix seconds. */
  t: number
  o: number
  h: number
  l: number
  c: number
  /** Volume in USD. */
  v: number
}

export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!
    if (i >= period) sum -= values[i - period]!
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

/** EMA seeded with the SMA of the first `period` values. */
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN)
  if (values.length < period) return out
  const k = 2 / (period + 1)
  let prev = 0
  for (let i = 0; i < period; i++) prev += values[i]!
  prev /= period
  out[period - 1] = prev
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

/** Wilder's average true range. */
export function atr(candles: Candle[], period = 14): number[] {
  const out = new Array<number>(candles.length).fill(NaN)
  if (candles.length <= period) return out
  const tr = candles.map((c, i) => {
    if (i === 0) return c.h - c.l
    const pc = candles[i - 1]!.c
    return Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc))
  })
  let prev = 0
  for (let i = 1; i <= period; i++) prev += tr[i]!
  prev /= period
  out[period] = prev
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]!) / period
    out[i] = prev
  }
  return out
}

/** Wilder's RSI. */
export function rsi(values: number[], period = 14): number[] {
  const out = new Array<number>(values.length).fill(NaN)
  if (values.length <= period) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!
    if (d >= 0) gain += d
    else loss -= d
  }
  gain /= period
  loss /= period
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!
    gain = (gain * (period - 1) + Math.max(d, 0)) / period
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  }
  return out
}

/** Highest high of the `period` bars before i (excludes bar i). */
export function priorHigh(candles: Candle[], period: number): number[] {
  const out = new Array<number>(candles.length).fill(NaN)
  for (let i = period; i < candles.length; i++) {
    let m = -Infinity
    for (let j = i - period; j < i; j++) m = Math.max(m, candles[j]!.h)
    out[i] = m
  }
  return out
}

/** Lowest low of the `period` bars before i (excludes bar i). */
export function priorLow(candles: Candle[], period: number): number[] {
  const out = new Array<number>(candles.length).fill(NaN)
  for (let i = period; i < candles.length; i++) {
    let m = Infinity
    for (let j = i - period; j < i; j++) m = Math.min(m, candles[j]!.l)
    out[i] = m
  }
  return out
}

/** Median of the `period` volumes before i (excludes bar i). Robust to single spikes. */
export function priorMedianVolume(candles: Candle[], period: number): number[] {
  const out = new Array<number>(candles.length).fill(NaN)
  for (let i = period; i < candles.length; i++) {
    const w = candles.slice(i - period, i).map((c) => c.v).sort((a, b) => a - b)
    const mid = Math.floor(w.length / 2)
    out[i] = w.length % 2 ? w[mid]! : (w[mid - 1]! + w[mid]!) / 2
  }
  return out
}

/** Simple return over `lookback` bars: c[i] / c[i - lookback] - 1. */
export function change(values: number[], lookback: number): number[] {
  return values.map((v, i) => (i >= lookback && values[i - lookback]! > 0 ? v / values[i - lookback]! - 1 : NaN))
}

/**
 * Candles from different sources arrive newest-first, with gaps and duplicates.
 * Returns them oldest-first, de-duplicated, with non-positive prices removed.
 */
export function normalizeCandles(raw: Candle[]): Candle[] {
  const byT = new Map<number, Candle>()
  for (const c of raw) {
    if (![c.t, c.o, c.h, c.l, c.c].every((x) => Number.isFinite(x) && x > 0)) continue
    byT.set(c.t, { ...c, v: Number.isFinite(c.v) && c.v > 0 ? c.v : 0 })
  }
  return [...byT.values()].sort((a, b) => a.t - b.t)
}

/** Aggregates candles into larger bars (e.g. 15m -> 1h with factor 4), aligned on factor*step. */
export function resample(candles: Candle[], stepSec: number, factor: number): Candle[] {
  const size = stepSec * factor
  const out: Candle[] = []
  let cur: Candle | null = null
  for (const c of candles) {
    const bucket = Math.floor(c.t / size) * size
    if (!cur || cur.t !== bucket) {
      if (cur) out.push(cur)
      cur = { t: bucket, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }
    } else {
      cur.h = Math.max(cur.h, c.h)
      cur.l = Math.min(cur.l, c.l)
      cur.c = c.c
      cur.v += c.v
    }
  }
  if (cur) out.push(cur)
  return out
}
