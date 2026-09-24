import { describe, expect, it } from 'vitest'
import { DEFAULT_PORTFOLIO, monteCarlo, runBacktest, type BacktestResult } from '../src/backtest.js'
import type { Candle } from '../src/indicators.js'
import { buildSeries, DEFAULT_PARAMS, entrySignal, manageOnBarClose, type StrategyParams } from '../src/strategy.js'

// Slow grind up with noise, then a range, then a breakout bar on high volume.
function breakoutSeries(): Candle[] {
  const out: Candle[] = []
  let p = 100
  for (let i = 0; i < 120; i++) {
    p *= i < 90 ? 1.002 : 1.0
    const wiggle = Math.sin(i / 2) * 0.4
    const c = p + wiggle
    out.push({ t: i * 3600, o: c - 0.1, h: c + 0.6, l: c - 0.6, c, v: 1000 })
  }
  const last = out[out.length - 1]!.c
  out.push({ t: 120 * 3600, o: last, h: last * 1.03, l: last - 0.2, c: last * 1.025, v: 5000 })
  return out
}

describe('entrySignal', () => {
  it('fires on a volume breakout inside an uptrend', () => {
    const candles = breakoutSeries()
    const s = buildSeries(candles, DEFAULT_PARAMS)
    const sig = entrySignal(s, candles.length - 1, DEFAULT_PARAMS)
    expect(sig).not.toBeNull()
    expect(sig!.setup).toBe('breakout')
    expect(sig!.stop).toBeLessThan(sig!.price)
    expect(sig!.stopPct).toBeGreaterThanOrEqual(DEFAULT_PARAMS.minStopPct)
    expect(sig!.stopPct).toBeLessThanOrEqual(DEFAULT_PARAMS.maxStopPct)
  })

  it('does not fire without volume confirmation', () => {
    const candles = breakoutSeries()
    candles[candles.length - 1]!.v = 1000
    const s = buildSeries(candles, DEFAULT_PARAMS)
    expect(entrySignal(s, candles.length - 1, DEFAULT_PARAMS)).toBeNull()
  })

  it('does not fire in a downtrend', () => {
    const candles = breakoutSeries().map((c, i, all) => {
      const m = all[all.length - 1 - i]!
      return { ...m, t: c.t }
    })
    const s = buildSeries(candles, DEFAULT_PARAMS)
    expect(entrySignal(s, candles.length - 1, DEFAULT_PARAMS)).toBeNull()
  })

  it('never fires during warm-up', () => {
    const candles = breakoutSeries().slice(0, 40)
    const s = buildSeries(candles, DEFAULT_PARAMS)
    for (let i = 0; i < candles.length; i++) expect(entrySignal(s, i, DEFAULT_PARAMS)).toBeNull()
  })
})

describe('manageOnBarClose', () => {
  const p: StrategyParams = { ...DEFAULT_PARAMS, trendExit: false }
  const candles = breakoutSeries()
  const s = buildSeries(candles, p)
  const i = candles.length - 1

  it('moves the stop to break-even after +1R and never lowers it', () => {
    const entry = candles[i]!.c / 1.03
    const r = manageOnBarClose({ entryPrice: entry, initialStop: entry * 0.97, stop: entry * 0.97, highWater: entry, barsHeld: 1 }, s, i, p, 0.005)
    expect(r.stop).toBeGreaterThanOrEqual(entry * 1.005)
    const r2 = manageOnBarClose({ entryPrice: entry, initialStop: entry * 0.97, stop: entry * 1.2, highWater: entry, barsHeld: 1 }, s, i, p, 0.005)
    expect(r2.stop).toBe(entry * 1.2)
  })

  it('reports a time stop when nothing happens', () => {
    const entry = candles[i]!.c
    const r = manageOnBarClose({ entryPrice: entry, initialStop: entry * 0.9, stop: entry * 0.9, highWater: entry, barsHeld: 100 }, s, i, p, 0.005)
    expect(r.exit).toBe(true)
    expect(r.reason).toMatch(/time stop/)
  })
})

describe('runBacktest', () => {
  it('trades the breakout and books the costs', () => {
    const candles = breakoutSeries()
    // Continue the move so the position can be closed by the end of the test.
    let c = candles[candles.length - 1]!.c
    for (let k = 1; k <= 20; k++) {
      c *= 1.01
      candles.push({ t: (120 + k) * 3600, o: c / 1.01, h: c * 1.005, l: c / 1.012, c, v: 2000 })
    }
    const res = runBacktest([{ mint: 'X', sym: 'X', candles }], DEFAULT_PARAMS, DEFAULT_PORTFOLIO)
    expect(res.trades.length).toBeGreaterThanOrEqual(1)
    expect(res.trades[0]!.pnlUsd).toBeGreaterThan(0)
    expect(res.totalReturn).toBeGreaterThan(0)
  })

  it('fills gap-down stops at the open, not at the stop', () => {
    const candles = breakoutSeries()
    const last = candles[candles.length - 1]!.c
    candles.push({ t: 121 * 3600, o: last * 0.7, h: last * 0.71, l: last * 0.69, c: last * 0.7, v: 1000 })
    const res = runBacktest([{ mint: 'X', sym: 'X', candles }], DEFAULT_PARAMS, DEFAULT_PORTFOLIO)
    const t = res.trades[0]!
    expect(t.reason).toBe('stop (gap)')
    expect(t.ret).toBeLessThan(-0.25)
  })
})

describe('monteCarlo', () => {
  const result = (pnls: number[]): BacktestResult => ({
    trades: pnls.map((pnl, k) => ({ sym: 'X', setup: 'breakout', entryT: k * 3600, exitT: k * 3600 + 1, entry: 1, exit: 1, sizeUsd: 100, pnlUsd: pnl, ret: pnl / 100, bars: 1, reason: 'x' })),
    equity: pnls.map((_, k) => ({ t: k * 3600, v: 1000 })),
    totalReturn: 0,
    maxDrawdown: 0,
    winRate: 0,
    profitFactor: 0,
    avgWin: 0,
    avgLoss: 0,
    exposure: 0,
    sharpe: 0,
  })

  it('never loses when every trade wins, and is reproducible', () => {
    const a = monteCarlo(result([10, 20, 5]), 10, 500)
    expect(a.probLoss).toBe(0)
    expect(a.maxDrawdown.p95).toBe(0)
    expect(monteCarlo(result([10, -20, 5]), 10, 500)).toEqual(monteCarlo(result([10, -20, 5]), 10, 500))
  })

  it('always loses when every trade loses', () => {
    const b = monteCarlo(result([-10, -5]), 5, 500)
    expect(b.probLoss).toBe(1)
    expect(b.returns.p95).toBeLessThan(0)
  })
})
