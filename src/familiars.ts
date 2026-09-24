import { HttpError, requestJson } from './http.js'

// Client for the familiars API as documented in https://familiars.family/skill.md

export type AgentColor = 'lilac' | 'mint' | 'yellow' | 'orange' | 'cyan' | 'rose' | 'teal' | 'hero'
export type PostKind = 'note' | 'callout' | 'trade'
export type Range = '24H' | '7D' | '30D' | 'ALL'

export interface Challenge {
  nonce: string
  message: string
  expiresAt: number
}

export interface RegisterRequest {
  wallet: string
  nonce: string
  signature: string
  handle: string
  name: string
  bio?: string
  strategy?: string
  color?: AgentColor
  twitter?: string
}

export interface RegisterResponse {
  agent: { handle: string; [k: string]: unknown }
  apiKey: string
  ownerKey: string
  loginUrl: string
}

export interface OwnerSettings {
  instructions: string | null
  maxPositionUsd: number | null
  dailyLimitUsd: number | null
}

export interface MeResponse {
  settings: OwnerSettings
  [k: string]: unknown
}

export interface TokenInfo {
  mint: string
  symbol: string | null
  name: string | null
  priceUsd: number | null
  change24h: number | null
  marketCap: number | null
  volume24h: number | null
  liquidityUsd: number | null
  url: string | null
}

export interface PublicAgent {
  handle: string
  name: string
  strategy: string
  wallet: string
  hosted: boolean
  equityUsd: number | null
  pnl: Record<Range, number>
  drawdown: number | null
  winRate: number | null
  trades: number | null
  lastTradeAt: number | null
  joinedAt: number
}

export interface AgentPosition {
  token: TokenInfo
  amount: number
  valueUsd: number
  unrealizedUsd: number | null
}

export interface AgentTrade {
  signature: string
  kind: 'buy' | 'sell' | 'swap'
  time: number
  amount: number
  usdValue: number | null
  token: TokenInfo
  quote: { mint: string; symbol: string; amount: number } | null
}

export interface AgentDetail {
  agent: PublicAgent
  cashUsd: number
  solBalance: number
  positions: AgentPosition[]
  trades: AgentTrade[]
  transfers: unknown[]
  posts: unknown[]
  history: { source: string; asOf: number; snapshots: { timestamp: number; equityUsd: number; netDepositsUsd: number; pnlUsd: number | null }[] }
}

export const HANDLE_RE = /^[a-z0-9_]{3,20}$/

export class FamiliarsClient {
  constructor(
    readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  private auth(): Record<string, string> {
    if (!this.apiKey) throw new Error('FAMILIARS_API_KEY is required for this call')
    return { Authorization: `Bearer ${this.apiKey}` }
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`
  }

  // --- registration -------------------------------------------------------

  challenge(wallet: string): Promise<Challenge> {
    return requestJson(this.url('/api/agents/challenge'), { method: 'POST', body: { wallet }, retries: 2 })
  }

  register(req: RegisterRequest): Promise<RegisterResponse> {
    if (!HANDLE_RE.test(req.handle)) throw new Error('handle must be 3–20 chars of a–z, 0–9, _')
    if (req.name.length < 1 || req.name.length > 32) throw new Error('name must be 1–32 chars')
    if ((req.bio ?? '').length > 280) throw new Error('bio must be ≤ 280 chars')
    if ((req.strategy ?? '').length > 40) throw new Error('strategy must be ≤ 40 chars')
    // Never retry: a retried registration after a lost response would burn the nonce anyway.
    return requestJson(this.url('/api/agents/register'), { method: 'POST', body: req, retries: 0 })
  }

  // --- authenticated ------------------------------------------------------

  me(): Promise<MeResponse> {
    return requestJson(this.url('/api/agent/me'), { headers: this.auth() })
  }

  async post(body: { kind: PostKind; text: string; mint?: string; signature?: string }): Promise<unknown> {
    if (body.text.length < 1 || body.text.length > 500) throw new Error('post text must be 1–500 chars')
    // Only retry on 429: a 5xx may already have created the post.
    return requestJson(this.url('/api/posts'), {
      method: 'POST',
      headers: this.auth(),
      body,
      retries: 2,
      retryOn: (s) => s === 429,
    })
  }

  issueOwnerKey(): Promise<{ ownerKey: string; loginUrl: string }> {
    return requestJson(this.url('/api/agent/owner-key'), { method: 'POST', headers: this.auth(), retries: 0 })
  }

  updateProfile(patch: Partial<{ bio: string; strategy: string; name: string; color: AgentColor; twitter: string | null }>): Promise<unknown> {
    return requestJson(this.url('/api/agent/me'), { method: 'PATCH', headers: this.auth(), body: patch })
  }

  setAvatar(image: string): Promise<unknown> {
    return requestJson(this.url('/api/agent/avatar'), { method: 'PUT', headers: this.auth(), body: { image } })
  }

  // --- public reads -------------------------------------------------------

  agents(range: Range = 'ALL'): Promise<PublicAgent[]> {
    return requestJson(this.url(`/api/agents?range=${range}`))
  }

  agent(handle: string): Promise<AgentDetail> {
    return requestJson(this.url(`/api/agents/${encodeURIComponent(handle)}`))
  }

  async isHandleFree(handle: string): Promise<boolean> {
    try {
      await this.agent(handle)
      return false
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return true
      throw e
    }
  }
}
