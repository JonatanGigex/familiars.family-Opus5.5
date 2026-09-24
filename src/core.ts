import type { AppConfig } from './config.js'
import type { Executor } from './executor.js'
import type { FamiliarsClient } from './familiars.js'
import type { Candle } from './indicators.js'
import { JupiterClient, SOL_MINT, USDC_MINT, type JupToken } from './jupiter.js'
import type { LaunchParams } from './launch.js'
import type { LaunchForensics } from './onchain.js'
import { log } from './log.js'
import { bestPairs, type CandleSource, type PairInfo } from './market.js'
import { enqueue, sellText, takeProfitText } from './poster.js'
import type { PumpFunClient } from './pumpfun.js'
import type { RiskParams } from './risk.js'
import type { ScreenParams } from './screener.js'
import { LAMPORTS_PER_SOL, type SolanaClient } from './solana.js'
import { dayStats, type AgentState, type PositionState } from './state.js'
import type { StrategyParams } from './strategy.js'

// Runtime pieces shared by every strategy: parameters and dependencies,
// per-process caches, portfolio snapshot, candles, and the sell path.

export type StrategyMode = 'trend' | 'launch'

export interface AgentParams {
  /** Which strategy opens positions. Exits always follow each position's own rules. */
  mode: StrategyMode
  launch: LaunchParams
  strategy: StrategyParams
  risk: RiskParams
  screen: ScreenParams
  /** Max value lost versus reference prices on any swap. */
  maxSwapLossPct: number
  /** Max quoted round-trip cost (buy then sell back) for a new position. */
  maxRoundTripPct: number
  /** Skip an entry if price already ran this far above the signal close. */
  maxChasePct: number
  /** Tokens evaluated with candles per hour, ranked by 1h organic flow. */
  maxCandidates: number
  coreMints: string[]
  calloutsPerDay: number
}

export interface AgentDeps {
  cfg: AppConfig
  jup: JupiterClient
  sol: SolanaClient
  fam: FamiliarsClient | null
  candles: CandleSource
  executor: Executor
  /** Agent wallet (live) or null in paper mode. */
  wallet: string | null
  params: AgentParams
  /** Deepest pair per mint; DexScreener by default (injectable for tests). */
  pairs?: (mints: string[]) => Promise<Record<string, PairInfo>>
  /** Launch mode: pump.fun metadata and on-chain forensics. */
  pump?: PumpFunClient
  forensics?: LaunchForensics
  /** Public familiars reads (board flow), also without an API key. */
  board?: FamiliarsClient
}

export type Snapshot = Awaited<ReturnType<typeof snapshot>>

export interface Holding {
  mint: string
  qty: number
  amountRaw?: bigint
  decimals: number
  priceUsd: number
  valueUsd: number
}

export interface TickReport {
  at: string
  mode: string
  equityUsd: number
  cashUsd: number
  positions: { symbol: string; valueUsd: number; pnlPct: number; stop: number }[]
  /** Equity minus net deposits (familiars' definition), when known. */
  pnlUsd: number | null
  actions: string[]
  entryBlockedBy: string | null
}

// Per-process caches: token metadata and best pairs.
export const tokenMeta = new Map<string, JupToken>()
const tokenMetaAt = new Map<string, number>()
const pairCache = new Map<string, { at: number; pair: PairInfo | null }>()

export function resetCoreCaches(): void {
  tokenMeta.clear()
  tokenMetaAt.clear()
  pairCache.clear()
}

export const HOUR = 3600

export function closedBars(candles: Candle[], nowSec: number, barSec: number): Candle[] {
  // A bar is final once its period has passed; give the data source a minute.
  return candles.filter((c) => c.t + barSec + 60 <= nowSec)
}

/** Loads token metadata; `maxAgeMs` refreshes entries whose stats may have gone stale. */
export async function metaFor(jup: JupiterClient, mints: string[], maxAgeMs = Infinity): Promise<void> {
  const now = Date.now()
  const stale = mints.filter((m) => !tokenMeta.has(m) || now - (tokenMetaAt.get(m) ?? 0) > maxAgeMs)
  if (!stale.length) return
  for (const t of await jup.tokens(stale)) {
    tokenMeta.set(t.id, t)
    tokenMetaAt.set(t.id, now)
  }
}

export async function pairFor(deps: AgentDeps, mint: string): Promise<PairInfo | null> {
  const hit = pairCache.get(mint)
  if (hit && Date.now() - hit.at < 3.6e6) return hit.pair
  const pairs = await (deps.pairs ?? bestPairs)([mint])
  const pair = pairs[mint] ?? null
  pairCache.set(mint, { at: Date.now(), pair })
  return pair
}

export async function barCandles(deps: AgentDeps, mint: string, nowSec: number): Promise<{ pair: PairInfo; candles: Candle[] } | null> {
  const pair = await pairFor(deps, mint)
  if (!pair) return null
  const barHours = deps.params.strategy.barHours
  const barSec = barHours * HOUR
  // Refresh right after each bar closes; otherwise the cache is good.
  const secsIntoBar = nowSec % barSec
  const maxAge = secsIntoBar < 120 ? 30 : Math.max(60, secsIntoBar - 60)
  const candles = await deps.candles.candles(pair.pairAddress, mint, 'hour', barHours, 300, maxAge)
  return { pair, candles: closedBars(candles, nowSec, barSec) }
}

// --- portfolio -----------------------------------------------------------

export async function snapshot(deps: AgentDeps, state: AgentState): Promise<{ holdings: Map<string, Holding>; prices: Record<string, number>; cashUsd: number; solQty: number; equityUsd: number }> {
  const holdings = new Map<string, Holding>()
  let cashUsd = 0
  let solQty = 0
  const positionMints = Object.keys(state.positions)
  if (deps.wallet) {
    const [lamports, tokens] = await Promise.all([deps.sol.solBalanceLamports(deps.wallet), deps.sol.tokenBalances(deps.wallet)])
    solQty = lamports / LAMPORTS_PER_SOL
    const prices = await deps.jup.prices([SOL_MINT, USDC_MINT, ...positionMints, ...tokens.filter((t) => t.amountRaw > 0n).map((t) => t.mint)])
    let wsolQty = 0
    for (const t of tokens) {
      if (t.amountRaw === 0n) continue
      if (t.mint === USDC_MINT) {
        cashUsd += t.uiAmount * (prices[USDC_MINT] ?? 1)
        continue
      }
      if (t.mint === SOL_MINT) {
        // Wrapped SOL counts toward equity with native SOL; swaps use native SOL only.
        wsolQty += t.uiAmount
        continue
      }
      const price = prices[t.mint] ?? 0
      const prev = holdings.get(t.mint)
      const qty = (prev?.qty ?? 0) + t.uiAmount
      const amountRaw = (prev?.amountRaw ?? 0n) + t.amountRaw
      holdings.set(t.mint, { mint: t.mint, qty, amountRaw, decimals: t.decimals, priceUsd: price, valueUsd: qty * price })
    }
    const solPrice = prices[SOL_MINT] ?? 0
    holdings.set(SOL_MINT, { mint: SOL_MINT, qty: solQty + wsolQty, amountRaw: BigInt(lamports), decimals: 9, priceUsd: solPrice, valueUsd: (solQty + wsolQty) * solPrice })
    let equityUsd = cashUsd
    for (const h of holdings.values()) equityUsd += h.valueUsd
    return { holdings, prices, cashUsd, solQty, equityUsd }
  }
  // Paper wallet.
  const paper = (state.paper ??= { cashUsd: 0, balances: {} })
  const prices = await deps.jup.prices([SOL_MINT, USDC_MINT, ...Object.keys(paper.balances), ...positionMints])
  await metaFor(deps.jup, Object.keys(paper.balances))
  cashUsd = paper.cashUsd
  let equityUsd = cashUsd
  for (const [mint, qty] of Object.entries(paper.balances)) {
    const price = prices[mint] ?? 0
    const decimals = mint === SOL_MINT ? 9 : (tokenMeta.get(mint)?.decimals ?? 6)
    holdings.set(mint, { mint, qty, decimals, priceUsd: price, valueUsd: qty * price })
    equityUsd += qty * price
    if (mint === SOL_MINT) solQty = qty
  }
  return { holdings, prices, cashUsd, solQty, equityUsd }
}

export function symbolOf(mint: string): string {
  if (mint === SOL_MINT) return 'SOL'
  return tokenMeta.get(mint)?.symbol ?? mint.slice(0, 4)
}

export function toRaw(qty: number, decimals: number): bigint {
  // Round down so we never ask to spend more than we hold.
  const [int, frac = ''] = qty.toFixed(decimals).split('.')
  return BigInt(int! + frac.padEnd(decimals, '0').slice(0, decimals))
}

// --- trading actions -----------------------------------------------------

/** Max value an exit may give up versus the reference price, after `failures` failed attempts. */
export function exitTolerance(failures: number, maxSwapLossPct: number): number {
  const base = Math.max(maxSwapLossPct * 2, 0.08)
  if (failures >= 6) return Math.max(base, 0.25)
  if (failures >= 3) return Math.max(base, 0.15)
  return base
}

/**
 * Sells `fraction` of a position (1 = all) into USDC. A partial sell keeps the
 * position with a proportionally smaller quantity and cost, marked `tpDone`.
 */
export async function sellPosition(
  deps: AgentDeps,
  state: AgentState,
  pos: PositionState,
  holding: Holding | undefined,
  price: number,
  reason: string,
  actions: string[],
  fraction = 1,
): Promise<boolean> {
  const { params } = deps
  const qty = holding?.qty ?? 0
  const decimals = holding?.decimals ?? tokenMeta.get(pos.mint)?.decimals ?? 6
  if (qty <= 0) {
    delete state.positions[pos.mint]
    actions.push(`dropped ${pos.symbol}: no balance left`)
    return true
  }
  const full = holding?.amountRaw ?? toRaw(qty, decimals)
  const partial = fraction < 1
  const raw = partial ? (full * BigInt(Math.round(fraction * 10_000))) / 10_000n : full
  if (raw <= 0n) return false
  const res = await deps.executor.swap({
    inputMint: pos.mint,
    outputMint: USDC_MINT,
    amountRaw: raw,
    inputDecimals: decimals,
    outputDecimals: 6,
    inputPriceUsd: price,
    outputPriceUsd: 1,
    // Exits must get out: a wider band than entries, widening further while a
    // falling market keeps the reference price ahead of what can be filled.
    maxLossPct: exitTolerance(state.sellFailures?.[pos.mint] ?? 0, params.maxSwapLossPct),
  })
  if (!res.ok) {
    state.sellFailures = { ...state.sellFailures, [pos.mint]: (state.sellFailures?.[pos.mint] ?? 0) + 1 }
    actions.push(`SELL ${pos.symbol} failed (${state.sellFailures[pos.mint]}x): ${res.error}`)
    log.warn(`sell ${pos.symbol} failed`, { error: res.error })
    return false
  }
  if (state.sellFailures) delete state.sellFailures[pos.mint]
  const proceeds = Number(res.outAmountRaw) / 1e6
  const soldQty = Number(res.inAmountRaw) / 10 ** decimals
  const share = Math.min(1, soldQty / pos.qty)
  const cost = pos.costUsd * share
  const pnlUsd = proceeds - cost
  const now = Date.now()
  const day = dayStats(state, now, 0)
  day.realizedPnlUsd += pnlUsd
  day.trades++
  state.trades.push({ time: now, side: 'sell', mint: pos.mint, symbol: pos.symbol, usd: proceeds, qty: soldQty, price: proceeds / soldQty, signature: res.signature, reason, pnlUsd })
  if (partial) {
    pos.qty -= soldQty
    pos.costUsd -= cost
    pos.tpDone = true
  } else {
    // A launch is a one-shot trade: never chase it again right after leaving.
    if (pos.strategy === 'launch') state.cooldowns[pos.mint] = now + 12 * 3.6e6
    else if (pnlUsd < 0) state.cooldowns[pos.mint] = now + 6 * 3.6e6
    delete state.positions[pos.mint]
  }
  actions.push(`SELL ${pos.symbol}${partial ? ` ${Math.round(fraction * 100)}%` : ''} ${proceeds.toFixed(2)} USDC (${pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(2)}) — ${reason}`)
  log.info(`sold ${partial ? 'part of ' : ''}${pos.symbol}`, { proceeds, pnlUsd, reason, signature: res.signature })
  if (res.signature) {
    enqueue(state, {
      kind: 'trade',
      signature: res.signature,
      text: partial
        ? takeProfitText({ symbol: pos.symbol, pnlUsd, multiple: price / pos.entryPrice, keptPct: 1 - fraction })
        : sellText({ symbol: pos.symbol, pnlUsd, pnlPct: pnlUsd / cost, reason, heldHours: (now - pos.openedAt) / 3.6e6 }),
      delayMs: 90_000,
    })
  }
  return true
}
