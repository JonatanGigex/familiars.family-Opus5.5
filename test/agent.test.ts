import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetCaches, tick, type AgentDeps } from '../src/agent.js'
import { loadParams } from '../src/bootstrap.js'
import type { AppConfig } from '../src/config.js'
import { PaperExecutor } from '../src/executor.js'
import type { FamiliarsClient } from '../src/familiars.js'
import type { Candle } from '../src/indicators.js'
import { SOL_MINT, USDC_MINT, type JupiterClient, type JupToken, type UltraOrder } from '../src/jupiter.js'
import type { CandleSource, PairInfo } from '../src/market.js'
import { TOKEN_PROGRAM, type SolanaClient } from '../src/solana.js'
import { emptyState, type AgentState } from '../src/state.js'

// End-to-end ticks in paper mode against deterministic fakes of every outside service.

const NOW = Date.parse('2026-09-24T09:30:00Z')
const H4 = 4 * 3600
/** Open time of the last closed 4h bar at NOW (04:00 UTC). */
const LAST_CLOSED = Math.floor(NOW / 1000 / H4) * H4 - H4
const X = 'Xtok1111111111111111111111111111111111111111'
const Y = 'Ytok1111111111111111111111111111111111111111'

function candles(kind: 'breakout' | 'up' | 'down', n = 120): Candle[] {
  const out: Candle[] = []
  const t0 = LAST_CLOSED - (n - 1) * H4
  let p = kind === 'down' ? 200 : 100
  for (let i = 0; i < n; i++) {
    if (kind === 'up') p *= 1.004
    if (kind === 'down') p *= 0.996
    if (kind === 'breakout') p *= i < n - 31 ? 1.004 : 1
    const c = p + Math.sin(i / 2) * 0.4
    out.push({ t: t0 + i * H4, o: c - 0.1, h: c + 0.6, l: c - 0.6, c, v: 1000 })
  }
  if (kind === 'breakout') {
    const prev = out[n - 2]!.c
    out[n - 1] = { t: LAST_CLOSED, o: prev, h: prev * 1.03, l: prev - 0.2, c: prev * 1.025, v: 5000 }
  }
  // The bar still forming must be ignored by the agent.
  const last = out[n - 1]!
  out.push({ t: LAST_CLOSED + H4, o: last.c, h: last.c * 1.5, l: last.c * 0.5, c: last.c, v: 99_999 })
  return out
}

function token(id: string, symbol: string): JupToken {
  return {
    id,
    name: symbol,
    symbol,
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM,
    liquidity: 2_000_000,
    mcap: 50_000_000,
    organicScore: 80,
    firstPool: { id: 'p', createdAt: '2026-01-01T00:00:00Z' },
    audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 20 },
    stats1h: { buyOrganicVolume: 1000, sellOrganicVolume: 1000 },
    stats24h: { buyVolume: 1_000_000, sellVolume: 1_000_000 },
  }
}

interface World {
  prices: Record<string, number>
  candles: Record<string, Candle[]>
  instructions: string | null
  /** Sells of these mints fail once, as a flaky route would. */
  failNextSell?: Set<string>
}

function makeDeps(state: AgentState, world: World, withOwner = false): AgentDeps {
  const decimals = (m: string) => (m === SOL_MINT ? 9 : 6)
  const jup = {
    tokens: async (mints: string[]) => [token(X, 'XTK'), token(Y, 'YTK')].filter((t) => mints.includes(t.id)),
    top: async () => [],
    prices: async (mints: string[]) => Object.fromEntries(mints.filter((m) => world.prices[m]).map((m) => [m, world.prices[m]!])),
    shield: async () => ({}),
    order: async (q: { inputMint: string; outputMint: string; amount: string }): Promise<UltraOrder> => {
      if (world.failNextSell?.delete(q.inputMint)) throw new Error('route unavailable')
      const inQty = Number(q.amount) / 10 ** decimals(q.inputMint)
      const outQty = ((inQty * world.prices[q.inputMint]!) / world.prices[q.outputMint]!) * 0.999
      return { requestId: 'r', inputMint: q.inputMint, outputMint: q.outputMint, inAmount: q.amount, outAmount: String(Math.floor(outQty * 10 ** decimals(q.outputMint))), transaction: null }
    },
  } as unknown as JupiterClient
  const sol = {
    mintInfo: async (mint: string) => ({ mint, program: TOKEN_PROGRAM, decimals: 6, supplyRaw: 1n, mintAuthority: null, freezeAuthority: null, extensions: [] }),
  } as unknown as SolanaClient
  const candleSource = { candles: async (_pair: string, mint: string) => world.candles[mint] ?? [] } as unknown as CandleSource
  const pairs = async (mints: string[]): Promise<Record<string, PairInfo>> =>
    Object.fromEntries(mints.map((m) => [m, { mint: m, symbol: m.slice(0, 3), pairAddress: `pair-${m}`, dexId: 'fake', liquidityUsd: 2e6, volume24h: 2e6, priceUsd: 1, pairCreatedAt: 0, txns1h: { buys: 1, sells: 1 } }]))
  const fam = withOwner
    ? ({ me: async () => ({ agent: { handle: 'ballast' }, settings: { instructions: world.instructions, maxPositionUsd: null, dailyLimitUsd: null } }) } as unknown as FamiliarsClient)
    : null
  const cfg = { familiarsBaseUrl: '', jupiterBaseUrl: '', rpcUrl: '', mode: 'paper', posting: false, statePath: '', cacheDir: '', secretsFile: '' } as AppConfig
  const params = { ...loadParams(), coreMints: [X] }
  return { cfg, jup, sol, fam, candles: candleSource, executor: new PaperExecutor(jup, state, USDC_MINT), wallet: null, params, pairs }
}

function paperState(): AgentState {
  const s = emptyState()
  s.paper = { cashUsd: 1000, balances: {}, startUsd: 1000 }
  return s
}

describe('tick (paper mode, fake markets)', () => {
  let world: World
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    resetCaches()
    const x = candles('breakout')
    world = {
      prices: { [USDC_MINT]: 1, [SOL_MINT]: 150, [X]: x[x.length - 2]!.c, [Y]: 2 },
      candles: { [X]: x, [SOL_MINT]: candles('up') },
      instructions: null,
    }
  })
  afterEach(() => vi.useRealTimers())

  it('buys a volume breakout, sized to risk 1% of equity, with the stop at least 4% away', async () => {
    const state = paperState()
    const report = await tick(makeDeps(state, world), state)
    const pos = state.positions[X]
    expect(pos, report.actions.join(' | ')).toBeDefined()
    expect(pos!.setup).toBe('breakout')
    expect(pos!.lastBarT).toBe(LAST_CLOSED)
    const stopPct = 1 - pos!.stop / world.prices[X]!
    expect(stopPct).toBeGreaterThanOrEqual(0.0399)
    // risk = size * stopPct ≈ 1% of $1000
    expect(pos!.costUsd * stopPct).toBeCloseTo(10, 0)
    expect(state.paper!.cashUsd).toBeCloseTo(1000 - pos!.costUsd, 1)
  })

  it('sells on a stop hit, books the loss and cools the token down', async () => {
    const state = paperState()
    const deps = makeDeps(state, world)
    await tick(deps, state)
    const pos = state.positions[X]!
    world.prices[X] = pos.stop * 0.99
    const report = await tick(deps, state)
    expect(state.positions[X]).toBeUndefined()
    expect(report.actions.some((a) => a.startsWith('SELL XTK'))).toBe(true)
    const sell = state.trades.find((t) => t.side === 'sell')!
    expect(sell.pnlUsd).toBeLessThan(0)
    expect(state.cooldowns[X]).toBeGreaterThan(NOW)
  })

  it('stays in cash when SOL is below its regime EMA', async () => {
    world.candles[SOL_MINT] = candles('down')
    const state = paperState()
    const report = await tick(makeDeps(state, world), state)
    expect(state.positions[X]).toBeUndefined()
    expect(report.actions.some((a) => a.startsWith('regime off'))).toBe(true)
  })

  it('obeys the owner: pause blocks entries, liquidate closes positions', async () => {
    world.instructions = 'Pause for now please'
    const state = paperState()
    const paused = await tick(makeDeps(state, world, true), state)
    expect(paused.entryBlockedBy).toMatch(/pause/)
    expect(state.positions[X]).toBeUndefined()

    world.instructions = null
    resetCaches()
    await tick(makeDeps(state, world, true), state)
    expect(state.positions[X]).toBeDefined()

    world.instructions = 'liquidate'
    const liq = await tick(makeDeps(state, world, true), state)
    expect(state.positions[X]).toBeUndefined()
    expect(liq.actions.some((a) => a.includes('owner asked to liquidate'))).toBe(true)
  })

  it('keeps a bar-close exit until the sell goes through', async () => {
    const state = paperState()
    const deps = makeDeps(state, world)
    await tick(deps, state)
    const pos = state.positions[X]!
    // The 08:00 bar closes having traded through the stop, then recovered.
    const bars = world.candles[X]!.slice(0, -1)
    const entry = world.prices[X]!
    bars.push({ t: LAST_CLOSED + H4, o: entry, h: entry * 1.01, l: pos.stop * 0.95, c: entry, v: 1000 })
    bars.push({ t: LAST_CLOSED + 2 * H4, o: entry, h: entry, l: entry, c: entry, v: 10 })
    world.candles[X] = bars
    vi.setSystemTime(NOW + 4 * 3600_000)
    world.failNextSell = new Set([X])
    const failed = await tick(deps, state)
    expect(failed.actions.some((a) => a.startsWith('SELL XTK failed'))).toBe(true)
    expect(state.positions[X]?.exitReason).toMatch(/stop loss touched/)
    const retried = await tick(deps, state)
    expect(retried.actions.some((a) => a.startsWith('SELL XTK') && !a.includes('failed'))).toBe(true)
    expect(state.positions[X]).toBeUndefined()
  })

  it('adopts a holding it did not open instead of ignoring it', async () => {
    const state = paperState()
    state.paper!.balances[Y] = 50 // $100 of YTK at $2
    world.candles[SOL_MINT] = candles('down') // no new entries, isolate the adoption
    const report = await tick(makeDeps(state, world), state)
    const pos = state.positions[Y]
    expect(pos, report.actions.join(' | ')).toBeDefined()
    expect(pos!.adopted).toBe(true)
    expect(pos!.stop).toBeCloseTo(2 * 0.8, 6)
  })
})
