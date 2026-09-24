import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetCaches, tick, type AgentDeps } from '../src/agent.js'
import { loadParams } from '../src/bootstrap.js'
import type { AppConfig } from '../src/config.js'
import { PaperExecutor } from '../src/executor.js'
import type { FamiliarsClient } from '../src/familiars.js'
import { SOL_MINT, USDC_MINT, type JupiterClient, type JupToken, type UltraOrder } from '../src/jupiter.js'
import { DEFAULT_LAUNCH } from '../src/launch.js'
import type { CandleSource } from '../src/market.js'
import type { LaunchChainStats, LaunchForensics } from '../src/onchain.js'
import type { PumpCoin, PumpFunClient } from '../src/pumpfun.js'
import { TOKEN_2022_PROGRAM, type SolanaClient } from '../src/solana.js'
import { emptyState, type AgentState } from '../src/state.js'

// Launch mode end to end, in paper mode, against fakes of every outside service.

const NOW = Date.parse('2026-09-24T12:00:00Z')
const L = 'Launch11111111111111111111111111111111111pump'

interface World {
  price: number
  liquidity: number
  chain: LaunchChainStats
}

function coin(): PumpCoin {
  return {
    mint: L,
    name: 'Toolkit',
    symbol: 'TOOL',
    description: 'An AI agent platform with an open-source SDK and API for builders; beta app is live for users.',
    twitter: 'https://x.com/toolkit_ai',
    website: 'https://toolkit.dev',
    creator: 'Dev1111111111111111111111111111111111111111',
    created_timestamp: NOW - 35 * 60_000,
    complete: false,
    bonding_curve: 'Curve111111111111111111111111111111111111111',
    quote_mint: '11111111111111111111111111111111',
    token_program: TOKEN_2022_PROGRAM,
  }
}

function jupToken(w: World): JupToken {
  return {
    id: L,
    name: 'Toolkit',
    symbol: 'TOOL',
    decimals: 6,
    tokenProgram: TOKEN_2022_PROGRAM,
    mcap: w.price * 1e9,
    liquidity: w.liquidity,
    holderCount: 320,
    audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 20, devBalancePercentage: 1, devMints: 1 },
    stats5m: { buyVolume: 9000, sellVolume: 5000, numTraders: 40, priceChange: 12 },
    stats1h: { buyVolume: 60_000, sellVolume: 40_000, numTraders: 300, priceChange: 80 },
  }
}

function deps(state: AgentState, w: World): AgentDeps {
  const prices = () => ({ [USDC_MINT]: 1, [SOL_MINT]: 150, [L]: w.price })
  const jup = {
    tokens: async (mints: string[]) => (mints.includes(L) ? [jupToken(w)] : []),
    top: async () => [],
    prices: async (mints: string[]) => Object.fromEntries(mints.filter((m) => m in prices()).map((m) => [m, prices()[m as keyof ReturnType<typeof prices>]])),
    shield: async () => ({}),
    order: async (q: { inputMint: string; outputMint: string; amount: string }): Promise<UltraOrder> => {
      const px = prices() as Record<string, number>
      const outQty = ((Number(q.amount) / 1e6) * px[q.inputMint]!) / px[q.outputMint]! * 0.99
      return { requestId: 'r', inputMint: q.inputMint, outputMint: q.outputMint, inAmount: q.amount, outAmount: String(Math.floor(outQty * 1e6)), transaction: null }
    },
  } as unknown as JupiterClient
  const sol = { mintInfo: async (mint: string) => ({ mint, program: TOKEN_2022_PROGRAM, decimals: 6, supplyRaw: 1n, mintAuthority: null, freezeAuthority: null, extensions: [] }) } as unknown as SolanaClient
  const pump = { activeCoins: async () => [coin()] } as unknown as PumpFunClient
  const forensics = { analyze: async () => w.chain } as unknown as LaunchForensics
  const board = { tokens: async () => [] } as unknown as FamiliarsClient
  const cfg = { familiarsBaseUrl: '', jupiterBaseUrl: '', rpcUrl: '', mode: 'paper', posting: false, statePath: '/tmp/none/state.json', cacheDir: '', secretsFile: '' } as AppConfig
  const params = { ...loadParams(), mode: 'launch' as const, launch: { ...DEFAULT_LAUNCH } }
  return { cfg, jup, sol, fam: null, candles: { candles: async () => [] } as unknown as CandleSource, executor: new PaperExecutor(jup, state, USDC_MINT), wallet: null, params, pump, forensics, board }
}

describe('tick in launch mode (paper, fakes)', () => {
  let world: World
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    resetCaches()
    world = {
      price: 0.00005,
      liquidity: 15_000,
      chain: { txCount: 2000, capped: false, creationSlot: 1, bundleWallets: [], bundleBoughtPct: 3, bundleHeldPct: 1, devHeldPct: 1, feesSol: 0.8, sampled: 8 },
    }
  })
  afterEach(() => vi.useRealTimers())

  it('buys a clean launch, takes half at 2x, then trails out', async () => {
    const state = emptyState()
    state.paper = { cashUsd: 1000, balances: {}, startUsd: 1000 }
    const d = deps(state, world)

    const buy = await tick(d, state)
    const pos = state.positions[L]
    expect(pos, buy.actions.join(' | ')).toBeDefined()
    expect(pos!.strategy).toBe('launch')
    // 1% of $1000 at a 30% stop is $33.33 (the pool allows $150).
    expect(pos!.costUsd).toBeCloseTo(33.33, 1)
    expect(pos!.features).toMatch(/^\[mc=50k h=320 bh=1\.0/)

    world.price *= 2.1
    const tp = await tick(d, state)
    expect(tp.actions.some((a) => a.startsWith('SELL TOOL 50%')), tp.actions.join(' | ')).toBe(true)
    expect(state.positions[L]!.tpDone).toBe(true)
    expect(state.positions[L]!.qty).toBeCloseTo(pos!.qty, 0)

    world.price *= 1.5 // new high
    await tick(d, state)
    expect(state.positions[L]).toBeDefined()
    world.price *= 0.6 // 40% below the high: trailing stop
    const out = await tick(d, state)
    expect(out.actions.some((a) => a.includes('trailing stop')), out.actions.join(' | ')).toBe(true)
    expect(state.positions[L]).toBeUndefined()
    const pnl = state.trades.filter((t) => t.side === 'sell').reduce((s, t) => s + (t.pnlUsd ?? 0), 0)
    expect(pnl).toBeGreaterThan(0)
  })

  it('does not buy when the launch bundle still holds too much', async () => {
    world.chain = { ...world.chain, bundleHeldPct: 14 }
    const state = emptyState()
    state.paper = { cashUsd: 1000, balances: {}, startUsd: 1000 }
    const report = await tick(deps(state, world), state)
    expect(state.positions[L]).toBeUndefined()
    expect(report.actions.some((a) => a.includes('bundlers still hold 14.0%'))).toBe(true)
  })
})
