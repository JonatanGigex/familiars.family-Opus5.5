import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { requestJson } from './http.js'
import { normalizeCandles, type Candle } from './indicators.js'
import { SOL_MINT, USDC_MINT } from './jupiter.js'

const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'])

export interface PairInfo {
  mint: string
  symbol: string
  pairAddress: string
  dexId: string
  liquidityUsd: number
  volume24h: number
  priceUsd: number
  pairCreatedAt: number | null
  txns1h: { buys: number; sells: number }
}

interface DexPair {
  pairAddress: string
  dexId: string
  baseToken: { address: string; symbol: string }
  quoteToken: { address: string }
  priceUsd?: string
  liquidity?: { usd?: number }
  volume?: { h24?: number }
  txns?: { h1?: { buys: number; sells: number } }
  pairCreatedAt?: number
}

/** Deepest SOL/USDC/USDT pair per mint, from DexScreener (≤30 mints per call). */
export async function bestPairs(mints: string[]): Promise<Record<string, PairInfo>> {
  const out: Record<string, PairInfo> = {}
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30)
    if (!chunk.length) continue
    const pairs = await requestJson<DexPair[]>(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(',')}`)
    for (const p of pairs ?? []) {
      const mint = p.baseToken.address
      if (!chunk.includes(mint) || !QUOTE_MINTS.has(p.quoteToken.address)) continue
      const liq = p.liquidity?.usd ?? 0
      if (liq <= (out[mint]?.liquidityUsd ?? 0)) continue
      out[mint] = {
        mint,
        symbol: p.baseToken.symbol,
        pairAddress: p.pairAddress,
        dexId: p.dexId,
        liquidityUsd: liq,
        volume24h: p.volume?.h24 ?? 0,
        priceUsd: Number(p.priceUsd ?? 0),
        pairCreatedAt: p.pairCreatedAt ?? null,
        txns1h: p.txns?.h1 ?? { buys: 0, sells: 0 },
      }
    }
  }
  return out
}

/**
 * GeckoTerminal OHLCV with a disk cache and a global pacing gate: the public API
 * allows roughly 30 calls per minute and answers 429 above that.
 */
export class CandleSource {
  private lastCall = 0
  private readonly minGapMs: number

  constructor(
    private readonly cacheDir: string,
    opts: { minGapMs?: number } = {},
  ) {
    this.minGapMs = opts.minGapMs ?? 2200
    mkdirSync(join(cacheDir, 'ohlcv'), { recursive: true })
  }

  private async pace(): Promise<void> {
    const wait = this.lastCall + this.minGapMs - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    this.lastCall = Date.now()
  }

  /**
   * timeframe 'hour' | 'minute' with aggregate (1/4/12 for hour, 1/5/15 for minute).
   * `maxAgeSec` controls cache freshness; completed bars never change, so the
   * cache only has to be as fresh as the bar size.
   */
  async candles(pair: string, mint: string, timeframe: 'hour' | 'minute', aggregate: number, limit = 300, maxAgeSec = 300): Promise<Candle[]> {
    const file = join(this.cacheDir, 'ohlcv', `${pair}_${mint}_${timeframe}${aggregate}.json`)
    if (existsSync(file)) {
      try {
        const cached = JSON.parse(readFileSync(file, 'utf8')) as { fetchedAt: number; candles: Candle[] }
        if (Date.now() / 1000 - cached.fetchedAt < maxAgeSec && cached.candles.length >= Math.min(limit, 50)) return cached.candles
      } catch {
        // corrupt cache: refetch
      }
    }
    await this.pace()
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pair}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}&currency=usd&token=${mint}`
    const res = await requestJson<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(url, { retries: 3 })
    const list = res?.data?.attributes?.ohlcv_list ?? []
    const candles = normalizeCandles(list.map((r) => ({ t: r[0]!, o: r[1]!, h: r[2]!, l: r[3]!, c: r[4]!, v: r[5] ?? 0 })))
    writeFileSync(file, JSON.stringify({ fetchedAt: Math.floor(Date.now() / 1000), candles }))
    return candles
  }
}
