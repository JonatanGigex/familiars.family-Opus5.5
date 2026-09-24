import type { AgentDetail } from './familiars.js'
import { parseFeatureTag, type LaunchParams } from './launch.js'

// Learning from outcomes. The agent's own launch buys carry a public feature
// tag, so its familiars history is a durable dataset: what it saw at entry and
// what happened next. Suggestions stay inside the owner's rules: the learner may
// tighten the owner's filters, never loosen them.

export interface Outcome {
  mint: string
  symbol: string
  entryTime: number
  features: Record<string, number>
  costUsd: number
  /** Realized proceeds plus the value still held. */
  valueUsd: number
  pnlPct: number
  closed: boolean
}

interface PostLike {
  kind: string
  text: string
  time: number
  token?: { mint: string; symbol?: string | null } | null
}

/** Pairs each tagged launch buy with its trades and current position. */
export function outcomesFrom(detail: AgentDetail): Outcome[] {
  const posts = (detail.posts ?? []) as PostLike[]
  const out: Outcome[] = []
  for (const p of posts) {
    if (p.kind !== 'trade' || !p.token?.mint) continue
    const features = parseFeatureTag(p.text)
    if (!features) continue
    const mint = p.token.mint
    const trades = detail.trades.filter((t) => t.token?.mint === mint && t.time >= p.time - 10 * 60_000)
    const cost = trades.filter((t) => t.kind === 'buy').reduce((s, t) => s + Math.abs(t.usdValue ?? 0), 0)
    const sold = trades.filter((t) => t.kind === 'sell').reduce((s, t) => s + Math.abs(t.usdValue ?? 0), 0)
    const held = detail.positions.find((x) => x.token.mint === mint)?.valueUsd ?? 0
    if (!(cost > 0)) continue
    out.push({
      mint,
      symbol: p.token.symbol ?? mint.slice(0, 4),
      entryTime: p.time,
      features,
      costUsd: cost,
      valueUsd: sold + held,
      pnlPct: (sold + held) / cost - 1,
      closed: held < cost * 0.01,
    })
  }
  return out
}

function median(xs: number[]): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]!
}

export interface FeatureStat {
  feature: string
  winnersMedian: number
  losersMedian: number
  n: number
}

export function featureStats(outcomes: Outcome[]): FeatureStat[] {
  const winners = outcomes.filter((o) => o.pnlPct > 0)
  const losers = outcomes.filter((o) => o.pnlPct <= 0)
  const keys = [...new Set(outcomes.flatMap((o) => Object.keys(o.features)))]
  return keys.map((feature) => ({
    feature,
    winnersMedian: median(winners.map((o) => o.features[feature]).filter((x): x is number => x !== undefined)),
    losersMedian: median(losers.map((o) => o.features[feature]).filter((x): x is number => x !== undefined)),
    n: outcomes.length,
  }))
}

export interface Suggestion {
  param: keyof LaunchParams
  from: number
  to: number
  why: string
}

/**
 * Conservative, bounded threshold moves. Nothing changes below `minTrades`
 * closed trades, a move needs a clear gap between winners and losers, and
 * each move is at most halfway toward the winners' lower quartile.
 */
export function suggest(outcomes: Outcome[], p: LaunchParams, owner: Pick<LaunchParams, 'minFeesSol' | 'minHolders' | 'maxBundlersHeldPct' | 'maxDevPct' | 'maxAgeMin' | 'minMcapUsd'>, minTrades = 20): Suggestion[] {
  const closed = outcomes.filter((o) => o.closed)
  if (closed.length < minTrades) return []
  const winners = closed.filter((o) => o.pnlPct > 0)
  const losers = closed.filter((o) => o.pnlPct <= 0)
  if (winners.length < 5 || losers.length < 5) return []
  const out: Suggestion[] = []
  const vals = (os: Outcome[], k: string) => os.map((o) => o.features[k]).filter((x): x is number => x !== undefined && Number.isFinite(x))

  // "Higher is better" features with a floor: fees paid, holders, market cap.
  const floors: [keyof LaunchParams, string, number, number][] = [
    ['minFeesSol', 'fee', owner.minFeesSol, 5],
    ['minHolders', 'h', owner.minHolders, 2000],
    ['minMcapUsd', 'mc', owner.minMcapUsd, 500_000],
  ]
  for (const [param, key, lo, hi] of floors) {
    const w = vals(winners, key)
    const l = vals(losers, key)
    if (w.length < 5 || l.length < 5) continue
    const wq = quantile(w, 0.25)
    if (!(median(w) > median(l) * 1.5) || !(wq > (p[param] as number))) continue
    const to = Math.min(hi, Math.max(lo, (p[param] as number) + (wq - (p[param] as number)) / 2))
    if (to > (p[param] as number)) out.push({ param, from: p[param] as number, to: round(to), why: `winners' median ${key} ${round(median(w))} vs losers' ${round(median(l))}` })
  }
  // "Lower is better" features with a ceiling: bundlers still holding, dev share, age.
  const ceilings: [keyof LaunchParams, string, number, number][] = [
    ['maxBundlersHeldPct', 'bh', 1, owner.maxBundlersHeldPct],
    ['maxDevPct', 'd', 1, owner.maxDevPct],
    ['maxAgeMin', 'age', 20, owner.maxAgeMin],
  ]
  for (const [param, key, lo, hi] of ceilings) {
    const w = vals(winners, key)
    const l = vals(losers, key)
    if (w.length < 5 || l.length < 5) continue
    const wq = quantile(w, 0.75)
    if (!(median(l) > median(w) * 1.5) || !(wq < (p[param] as number))) continue
    const to = Math.max(lo, Math.min(hi, (p[param] as number) - ((p[param] as number) - wq) / 2))
    if (to < (p[param] as number)) out.push({ param, from: p[param] as number, to: round(to), why: `losers' median ${key} ${round(median(l))} vs winners' ${round(median(w))}` })
  }
  return out
}

function round(x: number): number {
  return Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 100) / 100
}

export interface BoardLesson {
  handle: string
  pnlUsd: number
  buys: number
  youngBuys: number
  medianAgeAtBuyMin: number | null
  winners: string[]
}

/**
 * What the board's best agents do with young tokens: how old the tokens were
 * when they bought (from pump.fun-style creation times when known) and which
 * holdings made them money.
 */
export function boardLesson(detail: AgentDetail, createdAt: (mint: string) => number | undefined): BoardLesson {
  const buys = detail.trades.filter((t) => t.kind === 'buy')
  const ages = buys.map((t) => {
    const c = createdAt(t.token.mint)
    return c === undefined ? undefined : (t.time - c) / 60_000
  })
  const known = ages.filter((a): a is number => a !== undefined && a >= 0)
  return {
    handle: detail.agent.handle,
    pnlUsd: detail.agent.pnl?.ALL ?? 0,
    buys: buys.length,
    youngBuys: known.filter((a) => a <= 120).length,
    medianAgeAtBuyMin: known.length ? Math.round(median(known)) : null,
    winners: detail.positions.filter((x) => (x.unrealizedUsd ?? 0) > 0).map((x) => x.token.symbol ?? x.token.mint.slice(0, 4)),
  }
}
