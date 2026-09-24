import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PostKind } from './familiars.js'

export interface PositionState {
  mint: string
  symbol: string
  pair?: string
  setup: string
  openedAt: number
  /** Effective USD price paid per token, costs included. */
  entryPrice: number
  qty: number
  costUsd: number
  initialStop: number
  stop: number
  highWater: number
  barsHeld: number
  /** Open time (unix s) of the last closed bar already processed. */
  lastBarT: number
  entrySignature?: string
  reasons: string[]
  /** True when the position was found on chain rather than opened by this agent. */
  adopted?: boolean
  /** Set when a rule already fired (e.g. while offline): sell on the next tick. */
  exitReason?: string
  /** Which rules manage the position; trend when absent (older state files). */
  strategy?: 'trend' | 'launch'
  /** Launch positions: the partial take-profit already happened. */
  tpDone?: boolean
  /** Launch positions: pool liquidity at entry, to detect a collapse. */
  entryLiquidityUsd?: number
  /** Launch positions: what the agent saw at entry, for the learning review. */
  features?: string
}

export interface TradeRecord {
  time: number
  side: 'buy' | 'sell'
  mint: string
  symbol: string
  usd: number
  qty: number
  price: number
  signature?: string
  reason: string
  pnlUsd?: number
}

export interface PendingPost {
  kind: PostKind
  text: string
  mint?: string
  signature?: string
  notBefore: number
  attempts: number
}

export interface DayStats {
  startEquityUsd: number
  /** Paper mode: P&L at the first tick of the day. */
  startPnlUsd?: number
  /** Live mode: today's buys have been merged from familiars' history. */
  boughtRebuilt?: boolean
  boughtUsd: number
  realizedPnlUsd: number
  trades: number
  recapPosted?: boolean
}

export interface AgentState {
  version: 1
  positions: Record<string, PositionState>
  trades: TradeRecord[]
  days: Record<string, DayStats>
  /** Paper mode only; live mode reads its peak from familiars' history. */
  peakPnlUsd?: number
  cooldowns: Record<string, number>
  pendingPosts: PendingPost[]
  lastCallouts: Record<string, number>
  /** Simulated wallet used in paper mode: USD cash plus token quantities. */
  paper?: { cashUsd: number; balances: Record<string, number>; startUsd?: number }
  lastTickAt?: number
  introPosted?: boolean
  /** Our familiars handle, learned from /api/agent/me. */
  handle?: string
  /** Consecutive failed exits per mint; widens the exit tolerance. */
  sellFailures?: Record<string, number>
}

export function emptyState(): AgentState {
  return { version: 1, positions: {}, trades: [], days: {}, cooldowns: {}, pendingPosts: [], lastCallouts: {} }
}

export function loadState(path: string): AgentState {
  if (!existsSync(path)) return emptyState()
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as AgentState
  return { ...emptyState(), ...parsed }
}

/** Write to a temp file and rename, so a crash never leaves half a state file. */
export function saveState(path: string, state: AgentState): void {
  mkdirSync(dirname(path), { recursive: true })
  const trimmed: AgentState = { ...state, trades: state.trades.slice(-500), pendingPosts: state.pendingPosts.slice(-50) }
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(trimmed, null, 2))
  renameSync(tmp, path)
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function dayStats(state: AgentState, ms: number, equityUsd: number): DayStats {
  const key = utcDay(ms)
  let d = state.days[key]
  if (!d) {
    d = { startEquityUsd: equityUsd, boughtUsd: 0, realizedPnlUsd: 0, trades: 0 }
    state.days[key] = d
    // Keep two weeks of daily stats.
    const keys = Object.keys(state.days).sort()
    for (const k of keys.slice(0, Math.max(0, keys.length - 14))) delete state.days[k]
  }
  return d
}
