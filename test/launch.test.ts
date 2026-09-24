import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LAUNCH,
  featureTag,
  launchExit,
  momentum,
  parseFeatureTag,
  replayLaunch,
  screenChain,
  screenCheap,
  utilityScore,
  type LaunchCandidate,
} from '../src/launch.js'
import { bundleFromSlot, createsMint, feePaidLamports, JITO_TIP_ACCOUNTS, ownerDeltas, type RawParsedTx } from '../src/onchain.js'
import { entryFromTrades } from '../src/rebuild.js'
import type { AgentTrade } from '../src/familiars.js'

const p = DEFAULT_LAUNCH

function candidate(over: Partial<LaunchCandidate> = {}): LaunchCandidate {
  return {
    mint: 'M',
    symbol: 'TOOL',
    name: 'Toolkit',
    description: 'An AI agent platform with an open-source SDK and API for builders; beta app is live for users.',
    ageMin: 35,
    mcapUsd: 45_000,
    liquidityUsd: 15_000,
    holders: 320,
    devPct: 1,
    devMints: 1,
    top10Pct: 20,
    organicScore: 60,
    socials: { twitter: 'https://x.com/toolkit_ai', website: 'https://toolkit.dev' },
    solQuoted: true,
    graduated: false,
    authoritiesRevoked: true,
    stats5m: { buyVolume: 9000, sellVolume: 5000, numTraders: 40, priceChange: 12 },
    stats1h: { buyVolume: 60_000, sellVolume: 40_000, numTraders: 300, priceChange: 80 },
    chain: { txCount: 2000, capped: false, creationSlot: 1, bundleWallets: ['a'], bundleBoughtPct: 5, bundleHeldPct: 2, devHeldPct: 1, feesSol: 0.8, sampled: 8 },
    boardAgents: 2,
    ...over,
  }
}

describe("the owner's filters", () => {
  it('pass a clean young launch', () => {
    expect(screenCheap(candidate(), p)).toEqual({ pass: true, reasons: [] })
    expect(screenChain(candidate(), p).pass).toBe(true)
  })

  it('enforce age, market cap, holders, dev share and socials', () => {
    expect(screenCheap(candidate({ ageMin: 121 }), p).reasons[0]).toMatch(/age/)
    expect(screenCheap(candidate({ mcapUsd: 9_999 }), p).reasons[0]).toMatch(/mcap/)
    expect(screenCheap(candidate({ holders: 19 }), p).reasons[0]).toMatch(/holders/)
    expect(screenCheap(candidate({ devPct: 10.5 }), p).reasons[0]).toMatch(/dev holds/)
    expect(screenCheap(candidate({ socials: {} }), p).reasons[0]).toMatch(/no socials/)
  })

  it('enforce bundlers and fees from the on-chain analysis', () => {
    const chain = candidate().chain!
    expect(screenChain(candidate({ chain: { ...chain, bundleHeldPct: 10.5 } }), p).reasons[0]).toMatch(/bundlers still hold/)
    expect(screenChain(candidate({ chain: { ...chain, feesSol: 0.19 } }), p).reasons[0]).toMatch(/fees paid/)
    expect(screenChain(candidate({ chain: null }), p).pass).toBe(false)
  })
})

describe("the agent's added protections", () => {
  it('reject token factories, concentration, runaway caps, thin pools, odd quotes and live authorities', () => {
    expect(screenCheap(candidate({ devMints: 2439 }), p).reasons[0]).toMatch(/minted 2439/)
    expect(screenCheap(candidate({ top10Pct: 60 }), p).reasons[0]).toMatch(/top 10/)
    expect(screenCheap(candidate({ mcapUsd: 5_000_000 }), p).reasons[0]).toMatch(/mcap/)
    expect(screenCheap(candidate({ liquidityUsd: 2_000 }), p).reasons[0]).toMatch(/liquidity/)
    expect(screenCheap(candidate({ solQuoted: false }), p).reasons[0]).toMatch(/SOL/)
    expect(screenCheap(candidate({ authoritiesRevoked: false }), p).reasons[0]).toMatch(/authority/)
  })

  it('reject launches whose activity is bots (no organic score), including unreported scores', () => {
    expect(screenCheap(candidate({ organicScore: 0 }), p).reasons[0]).toMatch(/organic score 0 < 25/)
    expect(screenCheap(candidate({ organicScore: null }), p).pass).toBe(false)
    expect(screenCheap(candidate({ organicScore: 31.6 }), p).pass).toBe(true)
  })

  it('reject a heavily bundled launch even after the bundle sold, and an unverifiable one', () => {
    const chain = candidate().chain!
    expect(screenChain(candidate({ chain: { ...chain, bundleBoughtPct: 76, bundleHeldPct: 0 } }), p).reasons[0]).toMatch(/bundle bought 76%/)
    expect(screenChain(candidate({ chain: { ...chain, capped: true, bundleBoughtPct: null, bundleHeldPct: null } }), p).reasons[0]).toMatch(/could not be verified/)
  })

  it('accept a busy launch whose bundle was verified through its creation block', () => {
    const chain = candidate().chain!
    expect(screenChain(candidate({ chain: { ...chain, capped: true, txCount: 15_000 } }), p).pass).toBe(true)
  })
})

describe('utilityScore', () => {
  it('rewards an own site, a project account, telegram and a product description', () => {
    const u = utilityScore({ ...candidate(), socials: { ...candidate().socials, telegram: 'https://t.me/toolkit' } })
    expect(u.score).toBe(4)
  })

  it('does not count a random tweet or a social link as a website', () => {
    const u = utilityScore({ ...candidate(), description: 'cat', socials: { twitter: 'https://x.com/someone/status/123', website: 'https://x.com/someone' } })
    expect(u.score).toBe(0)
    expect(u.notes).toContain('links a tweet, not an account')
  })

  it('penalises hype and borrowed brand names', () => {
    expect(utilityScore({ ...candidate(), description: 'next pepe, 100x to the moon guaranteed', socials: {} }).score).toBe(-2)
    expect(utilityScore({ ...candidate(), name: 'GitHub', symbol: 'GITHUB' }).notes).toContain('borrows a big brand name')
  })

  it('sees through launches that borrow famous accounts and big platforms', () => {
    // Real cases from the first live scan: $BEAST linked @MrBeast and an Amazon product page.
    const beast = utilityScore({ name: 'Beast', symbol: 'BEAST', description: 'I want to make the world a better place', socials: { twitter: 'https://x.com/MrBeast', website: 'https://www.amazon.com/dp/B0G2RWH1M3' } })
    expect(beast.score).toBe(-4)
    expect(beast.notes).toEqual(expect.arrayContaining(['borrows @MrBeast', 'links amazon.com, not its own site']))
    const sbux = utilityScore({ name: 'Starbucks', symbol: 'STARBUCKS', description: '', socials: { twitter: 'https://x.com/Starbucks', website: 'https://www.instagram.com/Starbucks' } })
    expect(sbux.score).toBeLessThan(0)
  })

  it('credits only an X account that belongs to the token, and code repos', () => {
    expect(utilityScore({ name: 'Pinf', symbol: 'PINF', description: '', socials: { twitter: 'https://x.com/PINF_SOL' } }).notes).toContain('project X account @PINF_SOL')
    expect(utilityScore({ name: 'Pinf', symbol: 'PINF', description: '', socials: { twitter: 'https://x.com/randomguy' } }).score).toBe(0)
    expect(utilityScore({ name: 'Tool', symbol: 'TOOL', description: 'source at https://github.com/toolkit/agent', socials: {} }).notes).toContain('code at github.com/toolkit/agent')
  })
})

describe('momentum', () => {
  it('wants buyers in control without a vertical candle', () => {
    expect(momentum(candidate(), p).ok).toBe(true)
    expect(momentum(candidate({ stats5m: { buyVolume: 1000, sellVolume: 5000, numTraders: 40, priceChange: 1 } }), p).ok).toBe(false)
    expect(momentum(candidate({ stats5m: { buyVolume: 9000, sellVolume: 5000, numTraders: 40, priceChange: 150 } }), p).reasons[0]).toMatch(/vertical/)
    expect(momentum(candidate({ stats1h: { priceChange: -20 } }), p).ok).toBe(false)
  })
})

describe('launchExit', () => {
  const t0 = 1_000_000
  const pos = { entryPrice: 1, entryTimeMs: t0, highWater: 1, tpDone: false, entryLiquidityUsd: 10_000 }

  it('holds inside the band', () => {
    expect(launchExit(pos, 1.1, 10_000, t0 + 60_000, p).action).toBe('hold')
  })
  it('stops out at -30%', () => {
    expect(launchExit(pos, 0.69, 10_000, t0, p)).toMatchObject({ action: 'sell_all', reason: expect.stringMatching(/stop loss/) })
  })
  it('exits when liquidity collapses', () => {
    expect(launchExit(pos, 1.2, 3_000, t0, p)).toMatchObject({ action: 'sell_all', reason: 'liquidity collapsed' })
  })
  it('takes half off at 2x, once', () => {
    expect(launchExit(pos, 2.05, 20_000, t0, p)).toMatchObject({ action: 'take_profit', fraction: 0.5 })
    expect(launchExit({ ...pos, tpDone: true, highWater: 2.05 }, 2.05, 20_000, t0, p).action).toBe('hold')
  })
  it('trails 35% below the high once it has run +50%', () => {
    const run = { ...pos, highWater: 3, tpDone: true }
    expect(launchExit(run, 2.1, 20_000, t0, p).action).toBe('hold')
    expect(launchExit(run, 1.9, 20_000, t0, p)).toMatchObject({ action: 'sell_all', reason: expect.stringMatching(/trailing/) })
  })
  it('gives up after 6 hours without a +20% move', () => {
    expect(launchExit(pos, 1.1, 10_000, t0 + 6 * 3.6e6, p)).toMatchObject({ action: 'sell_all', reason: expect.stringMatching(/time stop/) })
    expect(launchExit(pos, 1.3, 10_000, t0 + 6 * 3.6e6, p).action).toBe('hold')
  })
})

describe('replayLaunch', () => {
  const bar = (t: number, h: number, l: number) => ({ t, o: l, h, l, c: h, v: 1 })
  it('finds a stop hit while offline', () => {
    expect(replayLaunch([bar(100, 1.1, 0.9), bar(400, 1.0, 0.6)], 100, 1, p).exitReason).toMatch(/stop loss/)
  })
  it('keeps the high-water mark and flags a missed take-profit', () => {
    const r = replayLaunch([bar(100, 1.5, 1.0), bar(400, 2.2, 1.6), bar(700, 2.0, 1.8)], 100, 1, p)
    expect(r.highWater).toBe(2.2)
    expect(r.takeProfitDue).toBe(true)
    expect(r.exitReason).toBeUndefined()
  })
  it('finds a trailing stop hit while offline', () => {
    expect(replayLaunch([bar(100, 3, 1), bar(400, 2.5, 1.8)], 100, 1, p).exitReason).toMatch(/trailing/)
  })
})

describe('feature tags', () => {
  it('round-trip what the agent saw at entry', () => {
    const tag = featureTag(candidate(), 3)
    expect(tag).toBe('[mc=45k h=320 bh=2.0 bb=5 d=1.0 fee=0.80 age=35 u=3 ag=2 o=60]')
    expect(parseFeatureTag(`New launch $TOOL ... ${tag}`)).toEqual({ mc: 45_000, h: 320, bh: 2, bb: 5, d: 1, fee: 0.8, age: 35, u: 3, ag: 2, o: 60 })
  })
})

describe('on-chain parsing', () => {
  const tx = (over: Partial<RawParsedTx['meta']> & { ixs?: RawParsedTx['transaction']['message']['instructions'] } = {}): RawParsedTx => ({
    meta: {
      fee: 5_000,
      err: null,
      preTokenBalances: [{ mint: 'M', owner: 'curve', uiTokenAmount: { amount: '1000' } }],
      postTokenBalances: [
        { mint: 'M', owner: 'curve', uiTokenAmount: { amount: '600' } },
        { mint: 'M', owner: 'buyer', uiTokenAmount: { amount: '400' } },
        { mint: 'OTHER', owner: 'buyer', uiTokenAmount: { amount: '9' } },
      ],
      innerInstructions: [],
      ...over,
    },
    transaction: { message: { instructions: over.ixs ?? [] } },
  })

  it('computes per-owner token deltas for one mint', () => {
    const d = ownerDeltas(tx(), 'M')
    expect(d.get('curve')).toBe(-400n)
    expect(d.get('buyer')).toBe(400n)
    expect(d.has('OTHER')).toBe(false)
  })

  it('adds Jito tips to the network fee', () => {
    const tip = [...JITO_TIP_ACCOUNTS][0]!
    const withTip = tx({ ixs: [{ program: 'system', parsed: { type: 'transfer', info: { destination: tip, lamports: 100_000 } } }, { program: 'system', parsed: { type: 'transfer', info: { destination: 'someone', lamports: 9 } } }] })
    expect(feePaidLamports(withTip)).toBe(105_000)
    expect(feePaidLamports(tx())).toBe(5_000)
  })
})

describe('launch bundle from the creation slot', () => {
  // Shaped like a real bundled launch: create + dev buy, two bundle transactions
  // buying 76% between them, the instant migration to the pool, a first pool buy,
  // and an unrelated transaction in the same slot.
  const bal = (owner: string, amount: string, mint = 'M') => ({ mint, owner, uiTokenAmount: { amount } })
  const t = (pre: ReturnType<typeof bal>[], post: ReturnType<typeof bal>[], err: unknown = null) => ({ meta: { fee: 5_000, err, preTokenBalances: pre, postTokenBalances: post } })
  const slot = [
    t([bal('x', '5', 'OTHER')], [bal('x', '1', 'OTHER')]),
    t([], [bal('dev', '34'), bal('curve', '966')]),
    t([bal('curve', '966')], [bal('curve', '418'), bal('b1', '251'), bal('b2', '297')]),
    t([bal('curve', '418')], [bal('curve', '207'), bal('b3', '170'), bal('b4', '41')]),
    t([bal('curve', '207')], [bal('curve', '0'), bal('pool', '207')]),
    t([bal('pool', '207')], [bal('pool', '118'), bal('b5', '89')]),
    t([bal('curve', '0')], [bal('late', '50')], { InstructionError: [0, 'Custom'] }),
  ]

  it('recognises the transaction that creates the mint', () => {
    expect(slot.map((x) => createsMint(x, 'M'))).toEqual([false, true, false, false, false, false, false])
    // An empty account opened for the mint later is not a creation.
    expect(createsMint(t([], [bal('someone', '0')]), 'M')).toBe(false)
  })

  it('counts every non-dev, non-pool wallet that received the token in that slot', () => {
    const b = bundleFromSlot(slot, 'M', new Set(['dev', 'curve', 'pool']))!
    expect(b.wallets.sort()).toEqual(['b1', 'b2', 'b3', 'b4', 'b5'])
    expect(b.boughtRaw).toBe(251n + 297n + 170n + 41n + 89n)
  })

  it('refuses a slot that does not contain the creation', () => {
    expect(bundleFromSlot(slot.slice(2), 'M', new Set(['dev', 'curve', 'pool']))).toBeNull()
  })
})

describe('entryFromTrades partial sells', () => {
  const t = (kind: 'buy' | 'sell', time: number, amount: number, usd: number): AgentTrade => ({
    signature: `s${time}`,
    kind,
    time,
    amount,
    usdValue: usd,
    token: { mint: 'M', symbol: 'T', name: 'T', priceUsd: 1, change24h: 0, marketCap: 0, volume24h: 0, liquidityUsd: 0, url: null },
    quote: null,
  })
  it('knows the take-profit already happened', () => {
    expect(entryFromTrades([t('buy', 1_000, 100, 10), t('sell', 2_000, 50, 10)], 'M', 50)!.partialSold).toBe(true)
    expect(entryFromTrades([t('buy', 1_000, 100, 10)], 'M', 100)!.partialSold).toBe(false)
  })
})
