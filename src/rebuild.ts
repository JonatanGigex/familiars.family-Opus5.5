import type { AgentTrade } from './familiars.js'

// Rebuilding local state from public data (familiars' view of our own swaps),
// so a fresh machine can pick up exactly where the last one stopped.

export interface EntryInfo {
  /** Unix seconds of the first buy of the current holding. */
  timeSec: number
  /** Average USD price paid per token. */
  price: number
  costUsd: number
  qty: number
}

/**
 * Walks our trades in one token from oldest to newest and returns the entry of
 * the holding that is still open: the buys since the position was last flat.
 */
export function entryFromTrades(trades: AgentTrade[], mint: string, heldQty: number): EntryInfo | null {
  const mine = trades.filter((t) => t.token?.mint === mint && (t.kind === 'buy' || t.kind === 'sell')).sort((a, b) => a.time - b.time)
  let qty = 0
  let cost = 0
  let firstBuy = 0
  for (const t of mine) {
    const amount = Math.abs(t.amount)
    const usd = Math.abs(t.usdValue ?? 0)
    if (t.kind === 'buy') {
      if (qty <= heldQty * 0.01) {
        qty = 0
        cost = 0
        firstBuy = t.time
      }
      qty += amount
      cost += usd
    } else {
      const sold = Math.min(amount, qty)
      if (qty > 0) cost *= 1 - sold / qty
      qty -= sold
    }
  }
  if (!(qty > 0) || !(cost > 0) || !firstBuy) return null
  return { timeSec: Math.floor(firstBuy / 1000), price: cost / qty, costUsd: cost * Math.min(1, heldQty / qty), qty }
}

/** USD bought today (UTC) according to our public trade history. */
export function boughtOnDay(trades: AgentTrade[], day: string): number {
  return trades
    .filter((t) => t.kind === 'buy' && new Date(t.time).toISOString().slice(0, 10) === day)
    .reduce((s, t) => s + Math.abs(t.usdValue ?? 0), 0)
}
