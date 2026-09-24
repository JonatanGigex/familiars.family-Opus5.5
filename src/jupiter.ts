import { requestJson } from './http.js'

export const SOL_MINT = 'So11111111111111111111111111111111111111112'
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

export interface JupTokenStats {
  priceChange?: number
  liquidityChange?: number
  volumeChange?: number
  buyVolume?: number
  sellVolume?: number
  buyOrganicVolume?: number
  sellOrganicVolume?: number
  numBuys?: number
  numSells?: number
  numTraders?: number
  numOrganicBuyers?: number
  numNetBuyers?: number
}

export interface JupToken {
  id: string
  name: string
  symbol: string
  decimals: number
  tokenProgram?: string
  holderCount?: number
  fdv?: number
  mcap?: number
  usdPrice?: number
  liquidity?: number
  stats5m?: JupTokenStats
  stats1h?: JupTokenStats
  stats6h?: JupTokenStats
  stats24h?: JupTokenStats
  firstPool?: { id: string; createdAt: string }
  audit?: {
    mintAuthorityDisabled?: boolean
    freezeAuthorityDisabled?: boolean
    topHoldersPercentage?: number
    devMints?: number
    isSus?: boolean
  }
  organicScore?: number
  organicScoreLabel?: string
  isVerified?: boolean
  tags?: string[]
}

export interface ShieldWarning {
  type: string
  message: string
  severity: 'info' | 'warning' | 'critical' | string
}

export interface UltraOrder {
  requestId: string
  inputMint: string
  outputMint: string
  inAmount: string
  outAmount: string
  otherAmountThreshold?: string
  slippageBps?: number
  priceImpactPct?: string
  feeBps?: number
  router?: string
  swapType?: string
  gasless?: boolean
  transaction: string | null
  inUsdValue?: number
  outUsdValue?: number
  errorCode?: number
  errorMessage?: string
  error?: string
}

export interface UltraExecuteResult {
  status: 'Success' | 'Failed' | string
  signature?: string
  slot?: string
  code?: number
  error?: string
  inputAmountResult?: string
  outputAmountResult?: string
  totalInputAmount?: string
  totalOutputAmount?: string
}

export type TopCategory = 'toptrending' | 'toporganicscore' | 'toptraded'
export type TopInterval = '5m' | '1h' | '6h' | '24h'

export class JupiterClient {
  constructor(
    readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  private headers(): Record<string, string> {
    return this.apiKey ? { 'x-api-key': this.apiKey } : {}
  }

  private get<T>(path: string): Promise<T> {
    return requestJson<T>(`${this.baseUrl}${path}`, { headers: this.headers() })
  }

  /** Token metadata, audit flags and rolling stats for up to 100 mints per call. */
  async tokens(mints: string[]): Promise<JupToken[]> {
    const out: JupToken[] = []
    for (let i = 0; i < mints.length; i += 100) {
      const chunk = mints.slice(i, i + 100)
      if (!chunk.length) continue
      out.push(...(await this.get<JupToken[]>(`/tokens/v2/search?query=${chunk.join(',')}`)))
    }
    return out
  }

  top(category: TopCategory, interval: TopInterval, limit = 100): Promise<JupToken[]> {
    return this.get<JupToken[]>(`/tokens/v2/${category}/${interval}?limit=${limit}`)
  }

  /** USD prices for up to 50 mints per call. Missing mints have no reliable price. */
  async prices(mints: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {}
    const unique = [...new Set(mints)]
    for (let i = 0; i < unique.length; i += 50) {
      const chunk = unique.slice(i, i + 50)
      if (!chunk.length) continue
      const res = await this.get<Record<string, { usdPrice?: number } | null>>(`/price/v3?ids=${chunk.join(',')}`)
      for (const [mint, v] of Object.entries(res ?? {})) {
        if (v && typeof v.usdPrice === 'number' && Number.isFinite(v.usdPrice) && v.usdPrice > 0) out[mint] = v.usdPrice
      }
    }
    return out
  }

  async shield(mints: string[]): Promise<Record<string, ShieldWarning[]>> {
    const out: Record<string, ShieldWarning[]> = {}
    for (let i = 0; i < mints.length; i += 50) {
      const chunk = mints.slice(i, i + 50)
      if (!chunk.length) continue
      const res = await this.get<{ warnings: Record<string, ShieldWarning[]> }>(`/ultra/v1/shield?mints=${chunk.join(',')}`)
      Object.assign(out, res.warnings ?? {})
    }
    return out
  }

  /** Without `taker` this is a pure quote (no transaction). */
  order(params: { inputMint: string; outputMint: string; amount: string; taker?: string }): Promise<UltraOrder> {
    const q = new URLSearchParams({ inputMint: params.inputMint, outputMint: params.outputMint, amount: params.amount })
    if (params.taker) q.set('taker', params.taker)
    return this.get<UltraOrder>(`/ultra/v1/order?${q.toString()}`)
  }

  execute(signedTransaction: string, requestId: string): Promise<UltraExecuteResult> {
    return requestJson<UltraExecuteResult>(`${this.baseUrl}/ultra/v1/execute`, {
      method: 'POST',
      headers: this.headers(),
      body: { signedTransaction, requestId },
      timeoutMs: 60_000,
      // Re-submitting the same signed transaction is safe: it has one signature.
      retries: 2,
    })
  }
}
