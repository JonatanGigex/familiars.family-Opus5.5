import { describe, expect, it } from 'vitest'
import { atr, change, ema, normalizeCandles, priorHigh, priorMedianVolume, resample, rsi, sma, type Candle } from '../src/indicators.js'

const bar = (t: number, c: number, spread = 1, v = 100): Candle => ({ t, o: c, h: c + spread, l: c - spread, c, v })

describe('indicators', () => {
  it('sma and ema seed and follow the series', () => {
    const v = [1, 2, 3, 4, 5, 6]
    expect(sma(v, 3).slice(2)).toEqual([2, 3, 4, 5])
    const e = ema(v, 3)
    expect(Number.isNaN(e[1]!)).toBe(true)
    expect(e[2]).toBe(2)
    expect(e[3]).toBeCloseTo(3)
    expect(e[5]).toBeCloseTo(5)
  })

  it('atr equals the constant range of flat bars', () => {
    const candles = Array.from({ length: 30 }, (_, i) => bar(i * 3600, 10, 0.5))
    expect(atr(candles, 14)[29]).toBeCloseTo(1)
  })

  it('rsi is 100 in a pure uptrend and near 0 in a pure downtrend', () => {
    const up = Array.from({ length: 30 }, (_, i) => i + 1)
    expect(rsi(up, 14)[29]).toBe(100)
    const down = Array.from({ length: 30 }, (_, i) => 100 - i)
    expect(rsi(down, 14)[29]!).toBeLessThan(1)
  })

  it('priorHigh excludes the current bar', () => {
    const candles = [bar(0, 1), bar(1, 5), bar(2, 2), bar(3, 10)]
    expect(priorHigh(candles, 3)[3]).toBe(6)
  })

  it('priorMedianVolume ignores a single spike', () => {
    const candles = [1, 1, 1000, 1, 1].map((v, i) => ({ ...bar(i, 1), v }))
    expect(priorMedianVolume(candles, 4)[4]).toBe(1)
  })

  it('change is relative to lookback', () => {
    expect(change([100, 110, 121], 2)[2]).toBeCloseTo(0.21)
  })

  it('normalizeCandles sorts, de-duplicates and drops bad rows', () => {
    const out = normalizeCandles([bar(3, 3), bar(1, 1, 0.5), bar(3, 4), { t: 2, o: 0, h: 1, l: 1, c: 1, v: 1 }])
    expect(out.map((c) => c.t)).toEqual([1, 3])
    expect(out[1]!.c).toBe(4)
  })

  it('resample aggregates OHLCV', () => {
    const m15 = [bar(0, 1, 0.1, 1), bar(900, 2, 0.1, 2), bar(1800, 3, 0.1, 3), bar(2700, 4, 0.1, 4), bar(3600, 5, 0.1, 5)]
    const h1 = resample(m15, 900, 4)
    expect(h1).toHaveLength(2)
    expect(h1[0]).toMatchObject({ t: 0, o: 1, c: 4, v: 10 })
    expect(h1[0]!.h).toBeCloseTo(4.1)
    expect(h1[0]!.l).toBeCloseTo(0.9)
  })
})
