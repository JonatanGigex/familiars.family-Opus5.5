import { requestJson } from './http.js'

// Read-only client for pump.fun's public frontend API: launch metadata that no
// other source has (socials, description, creator, exact creation time).
// Prices and market caps are NOT taken from here: tokens quoted in illiquid
// custom mints show absurd values. Jupiter provides real prices and liquidity.

const BASE = 'https://frontend-api-v3.pump.fun'
const NATIVE_QUOTES = new Set(['11111111111111111111111111111111', 'So11111111111111111111111111111111111111112'])

export interface PumpCoin {
  mint: string
  name: string
  symbol: string
  description?: string
  twitter?: string | null
  telegram?: string | null
  website?: string | null
  creator: string
  created_timestamp: number
  complete: boolean
  bonding_curve?: string
  associated_bonding_curve?: string
  pump_swap_pool?: string | null
  quote_mint?: string | null
  token_program?: string
  nsfw?: boolean
  is_banned?: boolean
  reply_count?: number
}

export function isSolQuoted(c: PumpCoin): boolean {
  return !c.quote_mint || NATIVE_QUOTES.has(c.quote_mint)
}

export function socialsOf(c: PumpCoin): { twitter?: string; telegram?: string; website?: string } {
  const clean = (v?: string | null) => (v && /^https?:\/\//i.test(v.trim()) ? v.trim() : undefined)
  return { twitter: clean(c.twitter), telegram: clean(c.telegram), website: clean(c.website) }
}

export class PumpFunClient {
  /**
   * Coins traded most recently, newest trade first. Young coins with real
   * activity surface here; paging `pages` x 50 keeps the call count small.
   */
  async activeCoins(pages = 6): Promise<PumpCoin[]> {
    const out = new Map<string, PumpCoin>()
    for (let p = 0; p < pages; p++) {
      const batch = await requestJson<PumpCoin[]>(`${BASE}/coins?offset=${p * 50}&limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=false`, { retries: 2 })
      for (const c of batch ?? []) out.set(c.mint, c)
      if (!batch?.length) break
    }
    return [...out.values()]
  }

  coin(mint: string): Promise<PumpCoin> {
    return requestJson<PumpCoin>(`${BASE}/coins/${mint}`, { retries: 2 })
  }
}
