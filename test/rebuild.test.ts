import { describe, expect, it } from 'vitest'
import type { AgentTrade } from '../src/familiars.js'
import type { Candle } from '../src/indicators.js'
import { boughtOnDay, entryFromTrades } from '../src/rebuild.js'
import { DEFAULT_PARAMS, replayPosition } from '../src/strategy.js'

const tok = (mint: string) => ({ mint, symbol: 'T', name: 'T', priceUsd: 1, change24h: 0, marketCap: 0, volume24h: 0, liquidityUsd: 0, url: null })
const trade = (kind: 'buy' | 'sell', time: number, amount: number, usd: number, mint = 'M'): AgentTrade => ({ signature: `s${time}`, kind, time, amount, usdValue: usd, token: tok(mint), quote: null })

describe('entryFromTrades', () => {
  it('uses only the buys since the position was last flat', () => {
    const trades = [trade('buy', 1_000, 100, 100), trade('sell', 2_000, 100, 120), trade('buy', 3_000, 50, 100), trade('buy', 4_000, 50, 150), trade('buy', 5_000, 10, 10, 'OTHER')]
    const e = entryFromTrades(trades, 'M', 100)!
    expect(e.timeSec).toBe(3)
    expect(e.price).toBeCloseTo(2.5)
    expect(e.qty).toBe(100)
  })

  it('reduces cost proportionally on partial sells', () => {
    const e = entryFromTrades([trade('buy', 1_000, 100, 200), trade('sell', 2_000, 50, 150)], 'M', 50)!
    expect(e.qty).toBe(50)
    expect(e.price).toBeCloseTo(2)
  })

  it('returns null when nothing is held', () => {
    expect(entryFromTrades([trade('buy', 1_000, 100, 100), trade('sell', 2_000, 100, 90)], 'M', 0)).toBeNull()
  })

  it('sums today’s buys', () => {
    const day = new Date(4_000).toISOString().slice(0, 10)
    expect(boughtOnDay([trade('buy', 3_000, 1, 40), trade('sell', 3_500, 1, 30), trade('buy', 4_000, 1, 25)], day)).toBe(65)
  })
})

describe('replayPosition', () => {
  const p = { ...DEFAULT_PARAMS, trendExit: false }
  const flat = (n: number, price: number): Candle[] => Array.from({ length: n }, (_, i) => ({ t: i * 3600, o: price, h: price * 1.01, l: price * 0.99, c: price, v: 100 }))

  it('reproduces the initial stop and survives quiet bars', () => {
    const candles = flat(80, 10)
    const r = replayPosition(candles, 60 * 3600, 10, p, 0.005)!
    expect(r.initialStop).toBeLessThan(10)
    expect(r.stop).toBeGreaterThanOrEqual(r.initialStop)
    expect(r.lastBarT).toBe(79 * 3600)
  })

  it('reports a stop that was hit while offline', () => {
    const candles = flat(80, 10)
    candles[70] = { ...candles[70]!, l: 5, c: 6 }
    const r = replayPosition(candles, 60 * 3600, 10, p, 0.005)!
    expect(r.exit?.reason).toMatch(/stop loss hit while offline/)
    expect(r.exit?.barT).toBe(70 * 3600)
  })

  it('ratchets to break-even after a run-up', () => {
    const candles = flat(80, 10)
    for (let i = 62; i < 80; i++) candles[i] = { t: i * 3600, o: 11, h: 11.5, l: 10.9, c: 11.2, v: 100 }
    const r = replayPosition(candles, 60 * 3600, 10, p, 0.005)!
    expect(r.exit).toBeUndefined()
    expect(r.stop).toBeGreaterThanOrEqual(10 * 1.005)
  })
})
