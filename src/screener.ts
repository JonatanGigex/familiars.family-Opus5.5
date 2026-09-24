import type { JupiterClient, JupToken, ShieldWarning } from './jupiter.js'
import { SOL_MINT, USDC_MINT } from './jupiter.js'

// Candidate discovery and the safety filters every token must pass before the
// strategy is even allowed to look at it.

export interface ScreenParams {
  minLiquidityUsd: number
  minVolume24hUsd: number
  minMcapUsd: number
  minOrganicScore: number
  /** Minimum age of the token's first pool, in hours (strategy needs history). */
  minAgeHours: number
  /** Max share of supply held by top holders, applied below `concentrationMcapUsd`. */
  maxTopHoldersPct: number
  concentrationMcapUsd: number
  /** Tokens allowed despite mint/freeze authority (e.g. wrapped majors). */
  authorityAllowlist: string[]
  /** Never trade these (stables, LSTs, our own token...). */
  denylist: string[]
  /** Shield warning types that block a token regardless of severity. */
  blockingWarnings: string[]
}

export const DEFAULT_SCREEN: ScreenParams = {
  minLiquidityUsd: 400_000,
  minVolume24hUsd: 500_000,
  minMcapUsd: 5_000_000,
  minOrganicScore: 50,
  minAgeHours: 72,
  maxTopHoldersPct: 60,
  concentrationMcapUsd: 100_000_000,
  authorityAllowlist: [],
  // SOL is the regime gauge and fee reserve, not a position.
  denylist: [SOL_MINT, USDC_MINT, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'],
  blockingWarnings: [
    'NOT_SELLABLE',
    'HAS_FREEZE_AUTHORITY',
    'HAS_MINT_AUTHORITY',
    'PERMANENT_DELEGATE',
    'HAS_TRANSFER_HOOK',
    'TRANSFER_FEE',
    'MUTABLE_TRANSFER_FEES',
    'NON_TRANSFERABLE',
    'HIGH_SINGLE_OWNERSHIP',
    'SUSPICIOUS_DEV_ACTIVITY',
    'SUSPICIOUS_TOP_HOLDER_ACTIVITY',
  ],
}

const STABLE_SYMBOL = /^(USD|EUR|PYUSD|USDC|USDT|USDS|USDG|FDUSD|USDE|USDY|UXD|EURC)/i

export function isCashLike(t: JupToken): boolean {
  const tags = t.tags ?? []
  if (tags.includes('stablecoin') || tags.includes('lst')) return true
  if (STABLE_SYMBOL.test(t.symbol ?? '') || /USD$/i.test(t.symbol ?? '')) return true
  // Liquid staking tokens mirror SOL; SOL itself is traded directly.
  return t.id !== SOL_MINT && /SOL$/i.test(t.symbol ?? '') && (t.symbol ?? '').length > 3
}

export interface ScreenVerdict {
  token: JupToken
  pass: boolean
  reasons: string[]
}

export function volume24h(t: JupToken): number {
  return (t.stats24h?.buyVolume ?? 0) + (t.stats24h?.sellVolume ?? 0)
}

export function screenToken(t: JupToken, p: ScreenParams, nowMs = Date.now()): ScreenVerdict {
  const reasons: string[] = []
  const allowAuthority = p.authorityAllowlist.includes(t.id) || t.id === SOL_MINT
  if (p.denylist.includes(t.id)) reasons.push('denylisted')
  if (isCashLike(t)) reasons.push('stablecoin/LST')
  if ((t.liquidity ?? 0) < p.minLiquidityUsd) reasons.push(`liquidity $${Math.round(t.liquidity ?? 0)}`)
  if (volume24h(t) < p.minVolume24hUsd) reasons.push(`24h volume $${Math.round(volume24h(t))}`)
  if ((t.mcap ?? t.fdv ?? 0) < p.minMcapUsd) reasons.push(`mcap $${Math.round(t.mcap ?? 0)}`)
  if (t.id !== SOL_MINT && (t.organicScore ?? 0) < p.minOrganicScore) reasons.push(`organic score ${Math.round(t.organicScore ?? 0)}`)
  const created = t.firstPool?.createdAt ? Date.parse(t.firstPool.createdAt) : NaN
  if (!Number.isFinite(created) || (nowMs - created) / 3.6e6 < p.minAgeHours) reasons.push('too new')
  if (!allowAuthority) {
    if (t.audit?.mintAuthorityDisabled !== true) reasons.push('mint authority not revoked')
    if (t.audit?.freezeAuthorityDisabled !== true) reasons.push('freeze authority not revoked')
  }
  if (t.audit?.isSus) reasons.push('flagged suspicious')
  const top = t.audit?.topHoldersPercentage
  if ((t.mcap ?? 0) < p.concentrationMcapUsd && typeof top === 'number' && top > p.maxTopHoldersPct) {
    reasons.push(`top holders ${top.toFixed(0)}%`)
  }
  return { token: t, pass: reasons.length === 0, reasons }
}

export function shieldBlock(warnings: ShieldWarning[] | undefined, p: ScreenParams, mint: string): string | null {
  const allowAuthority = p.authorityAllowlist.includes(mint) || mint === SOL_MINT
  for (const w of warnings ?? []) {
    if (allowAuthority && (w.type === 'HAS_FREEZE_AUTHORITY' || w.type === 'HAS_MINT_AUTHORITY')) continue
    if (w.severity === 'critical' || p.blockingWarnings.includes(w.type)) return `${w.type}: ${w.message}`
  }
  return null
}

/** Core list plus whatever Jupiter currently ranks as trending, organic or traded. */
export async function discoverMints(jup: JupiterClient, core: string[]): Promise<string[]> {
  const mints = new Set(core)
  const lists: Array<[Parameters<JupiterClient['top']>[0], Parameters<JupiterClient['top']>[1]]> = [
    ['toporganicscore', '1h'],
    ['toporganicscore', '6h'],
    ['toptrending', '1h'],
    ['toptrending', '6h'],
    ['toptraded', '1h'],
  ]
  for (const [cat, interval] of lists) {
    try {
      for (const t of await jup.top(cat, interval, 50)) mints.add(t.id)
    } catch {
      // A missing list only narrows discovery.
    }
  }
  return [...mints]
}
