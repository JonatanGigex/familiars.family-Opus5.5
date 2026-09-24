import type { OwnerSettings } from './familiars.js'

// Position sizing and the guard rails that sit above the strategy. Everything
// here only limits NEW risk; exits are never blocked by a limit.

export interface RiskParams {
  maxPositions: number
  /** Fraction of equity lost if the initial stop is hit (before costs). */
  riskPerTrade: number
  /** Max position size as a fraction of equity. */
  maxPositionPct: number
  minTradeUsd: number
  /** SOL kept for fees and token-account rent; never traded. */
  solReserve: number
  /** Stop opening trades for the rest of the UTC day after losing this fraction of the day's starting equity. */
  dailyLossLimit: number
  /** Pause entries when equity is this far below its peak. */
  maxDrawdown: number
  maxEntriesPerTick: number
}

export const DEFAULT_RISK: RiskParams = {
  maxPositions: 4,
  riskPerTrade: 0.015,
  maxPositionPct: 0.3,
  minTradeUsd: 5,
  solReserve: 0.03,
  dailyLossLimit: 0.06,
  maxDrawdown: 0.25,
  maxEntriesPerTick: 1,
}

export interface SizingInput {
  equityUsd: number
  /** USD value available to spend (cash above the reserve). */
  spendableUsd: number
  stopPct: number
  openPositions: number
  /** USD of buys already made today (UTC). */
  boughtTodayUsd: number
  owner: OwnerSettings
}

export interface SizingResult {
  usd: number
  limitedBy: string[]
  blockedReason?: string
}

export function sizePosition(input: SizingInput, rp: RiskParams): SizingResult {
  const limitedBy: string[] = []
  if (input.openPositions >= rp.maxPositions) return { usd: 0, limitedBy, blockedReason: `max ${rp.maxPositions} positions open` }
  if (!(input.stopPct > 0)) return { usd: 0, limitedBy, blockedReason: 'invalid stop distance' }

  let usd = (input.equityUsd * rp.riskPerTrade) / input.stopPct
  const cap = (value: number, label: string) => {
    if (value < usd) {
      usd = value
      limitedBy.push(label)
    }
  }
  cap(input.equityUsd * rp.maxPositionPct, `${Math.round(rp.maxPositionPct * 100)}% of equity`)
  cap(input.spendableUsd * 0.98, 'available cash')
  if (input.owner.maxPositionUsd != null) cap(input.owner.maxPositionUsd, 'owner max position')
  if (input.owner.dailyLimitUsd != null) cap(Math.max(0, input.owner.dailyLimitUsd - input.boughtTodayUsd), 'owner daily limit')

  if (usd < rp.minTradeUsd) {
    return { usd: 0, limitedBy, blockedReason: `size $${usd.toFixed(2)} below minimum $${rp.minTradeUsd} (${limitedBy.join(', ') || 'risk budget'})` }
  }
  return { usd: Math.floor(usd * 100) / 100, limitedBy }
}

/**
 * Account P&L the way familiars measures it: equity minus net deposits, so a
 * deposit is never mistaken for profit nor a withdrawal for a drawdown.
 */
export interface AccountPnl {
  netDepositsUsd: number
  pnlUsd: number
  peakPnlUsd: number
  dayStartPnlUsd: number
}

export interface Snapshot {
  timestamp: number
  equityUsd: number
  netDepositsUsd: number
  pnlUsd?: number | null
}

/** The drawdown guard measures from the best P&L of this window, so a pause cools off on its own. */
export const PEAK_WINDOW_MS = 7 * 24 * 3.6e6

export function accountFromHistory(snapshots: Snapshot[], nowMs: number): AccountPnl | null {
  const rows = snapshots
    .filter((x) => Number.isFinite(x.equityUsd) && Number.isFinite(x.netDepositsUsd) && x.timestamp <= nowMs)
    .sort((a, b) => a.timestamp - b.timestamp)
  const last = rows[rows.length - 1]
  if (!last) return null
  const pnl = (x: Snapshot) => x.pnlUsd ?? x.equityUsd - x.netDepositsUsd
  const dayStart = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00Z`)
  const before = rows.filter((x) => x.timestamp <= dayStart)
  const startRow = before[before.length - 1] ?? rows.find((x) => x.timestamp >= dayStart) ?? last
  return {
    netDepositsUsd: last.netDepositsUsd,
    pnlUsd: pnl(last),
    peakPnlUsd: Math.max(pnl(last), ...rows.filter((x) => x.timestamp >= nowMs - PEAK_WINDOW_MS).map(pnl)),
    dayStartPnlUsd: pnl(startRow),
  }
}

/** Returns a reason to stop opening trades, or null when entries are allowed. */
export function entryGuard(a: AccountPnl, rp: RiskParams): string | null {
  const peakValue = a.netDepositsUsd + a.peakPnlUsd
  if (peakValue > 0) {
    const dd = (a.peakPnlUsd - a.pnlUsd) / peakValue
    if (dd > rp.maxDrawdown) return `drawdown ${(dd * 100).toFixed(1)}% exceeds ${(rp.maxDrawdown * 100).toFixed(0)}% limit`
  }
  const dayValue = a.netDepositsUsd + a.dayStartPnlUsd
  if (dayValue > 0) {
    const loss = (a.dayStartPnlUsd - a.pnlUsd) / dayValue
    if (loss > rp.dailyLossLimit) return `down ${(loss * 100).toFixed(1)}% today, over the ${(rp.dailyLossLimit * 100).toFixed(0)}% daily loss limit`
  }
  return null
}

export type Directive = 'pause' | 'liquidate' | null

/**
 * The owner's free-text instructions are shown on familiars. A deterministic
 * agent cannot follow arbitrary prose, so it honours the unambiguous ones and
 * leaves the rest to the human-reviewed configuration.
 */
export function parseDirective(instructions: string | null | undefined): Directive {
  const text = (instructions ?? '').toLowerCase()
  if (!text.trim()) return null
  if (/\b(liquidate|sell (it )?all|close all|exit all|vende todo|liquida|cierra todo)\b/.test(text)) return 'liquidate'
  if (/\b(pause|stop trading|halt|no new (trades|positions)|do not trade|don't trade|para de operar|pausa|detente|no operes)\b/.test(text)) return 'pause'
  return null
}
