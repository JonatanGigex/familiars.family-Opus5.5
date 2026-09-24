import { describe, expect, it } from 'vitest'
import type { AgentDetail } from '../src/familiars.js'
import { DEFAULT_LAUNCH } from '../src/launch.js'
import { boardLesson, outcomesFrom, suggest, type Outcome } from '../src/learn.js'

const tok = (mint: string) => ({ mint, symbol: mint, name: mint, priceUsd: 1, change24h: 0, marketCap: 0, volume24h: 0, liquidityUsd: 0, url: null })

function detail(over: Partial<AgentDetail> = {}): AgentDetail {
  return {
    agent: { handle: 'ballast', name: 'Ballast', strategy: '', wallet: '', hosted: false, equityUsd: 0, pnl: { '24H': 0, '7D': 0, '30D': 0, ALL: 12 }, drawdown: 0, winRate: null, trades: 0, lastTradeAt: null, joinedAt: 0 },
    cashUsd: 0,
    solBalance: 0,
    positions: [],
    trades: [],
    transfers: [],
    posts: [],
    history: { source: 'live', asOf: 0, snapshots: [] },
    ...over,
  }
}

describe('outcomesFrom', () => {
  it('pairs a tagged launch post with its trades and what is still held', () => {
    const d = detail({
      posts: [{ kind: 'trade', text: 'New launch $A ... [mc=45k h=320 bh=2.0 bb=5 d=1.0 fee=0.80 age=35 u=3 ag=2]', time: 1_000_000, token: tok('A') }],
      trades: [
        { signature: '1', kind: 'buy', time: 1_000_000, amount: 100, usdValue: 20, token: tok('A'), quote: null },
        { signature: '2', kind: 'sell', time: 2_000_000, amount: 50, usdValue: 20, token: tok('A'), quote: null },
      ],
      positions: [{ token: tok('A'), amount: 50, valueUsd: 15, unrealizedUsd: 5 }],
    })
    const [o] = outcomesFrom(d)
    expect(o).toMatchObject({ mint: 'A', costUsd: 20, valueUsd: 35, closed: false })
    expect(o!.pnlPct).toBeCloseTo(0.75)
    expect(o!.features).toMatchObject({ mc: 45_000, fee: 0.8, bh: 2 })
  })

  it('ignores posts without a feature tag', () => {
    expect(outcomesFrom(detail({ posts: [{ kind: 'trade', text: 'Took profit', time: 1, token: tok('A') }] }))).toEqual([])
  })
})

describe('suggest', () => {
  const o = (pnlPct: number, fee: number, bh: number): Outcome => ({ mint: 'm', symbol: 'M', entryTime: 0, features: { fee, bh, h: 300, mc: 50_000, d: 1, age: 40 }, costUsd: 10, valueUsd: 10 * (1 + pnlPct), pnlPct, closed: true })

  it('waits for enough closed trades', () => {
    expect(suggest([o(1, 2, 1), o(-0.3, 0.3, 8)], DEFAULT_LAUNCH, DEFAULT_LAUNCH)).toEqual([])
  })

  it('tightens filters when winners and losers clearly differ, halfway and within bounds', () => {
    const winners = Array.from({ length: 10 }, (_, i) => o(0.8, 2 + i * 0.1, 1))
    const losers = Array.from({ length: 10 }, (_, i) => o(-0.3, 0.3 + i * 0.01, 8))
    const s = suggest([...winners, ...losers], DEFAULT_LAUNCH, DEFAULT_LAUNCH)
    const fees = s.find((x) => x.param === 'minFeesSol')!
    expect(fees.from).toBe(0.2)
    expect(fees.to).toBeGreaterThan(0.2)
    expect(fees.to).toBeLessThan(2.2)
    const bund = s.find((x) => x.param === 'maxBundlersHeldPct')!
    expect(bund.to).toBeLessThan(10)
    expect(bund.to).toBeGreaterThanOrEqual(1)
  })

  it("never loosens the owner's filters", () => {
    // Here losers had MORE fees and winners had MORE bundle: no move may relax a filter.
    const winners = Array.from({ length: 10 }, () => o(0.8, 0.25, 9))
    const losers = Array.from({ length: 10 }, () => o(-0.3, 3, 1))
    for (const x of suggest([...winners, ...losers], DEFAULT_LAUNCH, DEFAULT_LAUNCH)) {
      if (x.param.startsWith('min')) expect(x.to).toBeGreaterThanOrEqual(x.from)
      else expect(x.to).toBeLessThanOrEqual(x.from)
    }
  })
})

describe('boardLesson', () => {
  it('measures how old tokens were when a top agent bought them', () => {
    const d = detail({
      trades: [
        { signature: '1', kind: 'buy', time: 60 * 60_000, amount: 1, usdValue: 1, token: tok('A'), quote: null },
        { signature: '2', kind: 'buy', time: 600 * 60_000, amount: 1, usdValue: 1, token: tok('B'), quote: null },
      ],
      positions: [{ token: tok('A'), amount: 1, valueUsd: 9, unrealizedUsd: 8 }],
    })
    const l = boardLesson(d, () => 0)
    expect(l).toMatchObject({ buys: 2, youngBuys: 1, winners: ['A'] })
    expect(l.medianAgeAtBuyMin).toBe(330)
  })
})
