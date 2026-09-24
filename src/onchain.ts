import { Connection, PublicKey } from '@solana/web3.js'
import { requestJson } from './http.js'
import { associatedTokenAddress } from './solana.js'

// On-chain launch forensics that no public API provides reliably:
// - bundlers: wallets (other than the dev) that bought in the same slot as the
//   token's creation, i.e. inside the launch bundle, and what they still hold;
// - fees paid: network fees plus Jito tips paid by everyone trading the token,
//   estimated from a sample of its transactions scaled to the total count.

/** Jito's tip accounts: a transfer to one of these is a bundle/priority tip. */
export const JITO_TIP_ACCOUNTS = new Set([
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
])

export interface LaunchChainStats {
  /** Signatures seen for the mint (a lower bound when `capped`). */
  txCount: number
  /** True when paging stopped before reaching the creation transaction. */
  capped: boolean
  creationSlot: number | null
  bundleWallets: string[]
  /** % of supply bought in the creation slot by wallets other than the dev. */
  bundleBoughtPct: number | null
  /** % of supply those wallets still hold now. */
  bundleHeldPct: number | null
  devHeldPct: number | null
  /** Estimated SOL paid in fees and tips by everyone trading the token. */
  feesSol: number
  sampled: number
}

/**
 * The fields we read from a `jsonParsed` transaction. Fetched with raw JSON-RPC
 * because @solana/web3.js 1.x cannot decode version-1 transactions.
 */
export interface RawParsedTx {
  meta: {
    fee: number
    err: unknown
    preTokenBalances?: { mint: string; owner?: string; uiTokenAmount: { amount: string } }[]
    postTokenBalances?: { mint: string; owner?: string; uiTokenAmount: { amount: string } }[]
    innerInstructions?: { instructions: RawIx[] }[]
  } | null
  transaction: { message: { instructions: RawIx[] } }
}

interface RawIx {
  program?: string
  parsed?: unknown
}

/** Token balance change per owner for one mint in one transaction (raw units). */
export function ownerDeltas(tx: RawParsedTx, mint: string): Map<string, bigint> {
  const out = new Map<string, bigint>()
  const meta = tx.meta
  if (!meta) return out
  for (const b of meta.preTokenBalances ?? []) {
    if (b.mint !== mint || !b.owner) continue
    out.set(b.owner, (out.get(b.owner) ?? 0n) - BigInt(b.uiTokenAmount.amount))
  }
  for (const b of meta.postTokenBalances ?? []) {
    if (b.mint !== mint || !b.owner) continue
    out.set(b.owner, (out.get(b.owner) ?? 0n) + BigInt(b.uiTokenAmount.amount))
  }
  return out
}

/** Network fee plus any Jito tips in a transaction, in lamports. */
export function feePaidLamports(tx: RawParsedTx): number {
  let total = tx.meta?.fee ?? 0
  const all = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)]
  for (const ix of all) {
    if (!ix.parsed || ix.program !== 'system') continue
    const p = ix.parsed as { type?: string; info?: { destination?: string; lamports?: number } }
    if (p?.type === 'transfer' && p.info?.destination && JITO_TIP_ACCOUNTS.has(p.info.destination)) total += p.info.lamports ?? 0
  }
  return total
}

export class LaunchForensics {
  private readonly bundleCache = new Map<string, { creationSlot: number; wallets: string[]; boughtRaw: bigint }>()
  private readonly conn: Connection
  private last = 0

  /**
   * `minGapMs` paces calls: the public RPC allows ~40 calls per 10 s per method
   * and answers 429 to bursts. A private RPC can take a much smaller gap.
   */
  constructor(
    private readonly rpcUrl: string,
    private readonly minGapMs = 300,
  ) {
    this.conn = new Connection(rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true })
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + this.minGapMs - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      this.last = Date.now()
      try {
        return await fn()
      } catch (e) {
        const limited = /429|Too many requests/i.test(e instanceof Error ? e.message : String(e))
        if (!limited || attempt >= 4) throw e
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
      }
    }
  }

  private async parsed(signatures: string[]): Promise<RawParsedTx[]> {
    const out: RawParsedTx[] = []
    for (const sig of signatures) {
      const res = await this.call(() =>
        requestJson<{ result?: RawParsedTx | null; error?: { message?: string } }>(this.rpcUrl, {
          method: 'POST',
          body: { jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }] },
          retries: 0,
        }),
      )
      if (res.error) throw new Error(`getTransaction: ${res.error.message ?? 'error'}`)
      if (res.result) out.push(res.result)
    }
    return out
  }

  /** Sum of `mint` held by `owners` in their associated accounts (raw units). */
  private async heldBy(owners: string[], mint: string, tokenProgram: string): Promise<bigint> {
    let total = 0n
    for (let i = 0; i < owners.length; i += 100) {
      const atas = owners.slice(i, i + 100).map((o) => new PublicKey(associatedTokenAddress(o, mint, tokenProgram)))
      const infos = await this.call(() => this.conn.getMultipleParsedAccounts(atas, { commitment: 'confirmed' }))
      for (const acc of infos.value) {
        const amount = (acc?.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } } | undefined)?.parsed?.info?.tokenAmount?.amount
        if (amount) total += BigInt(amount)
      }
    }
    return total
  }

  async analyze(p: {
    mint: string
    dev: string | null
    supplyRaw: bigint
    tokenProgram: string
    /** Owners that are pools or bonding curves, never counted as bundlers. */
    poolOwners: string[]
    maxPages?: number
    feeSample?: number
  }): Promise<LaunchChainStats> {
    const maxPages = p.maxPages ?? 15
    const feeSample = p.feeSample ?? 8
    const sigs: { signature: string; slot: number; err: unknown }[] = []
    let before: string | undefined
    let capped = true
    for (let page = 0; page < maxPages; page++) {
      const batch = await this.call(() => this.conn.getSignaturesForAddress(new PublicKey(p.mint), { before, limit: 1000 }, 'confirmed'))
      sigs.push(...batch)
      if (batch.length < 1000) {
        capped = false
        break
      }
      before = batch[batch.length - 1]!.signature
    }
    const pct = (raw: bigint) => (p.supplyRaw > 0n ? Number((raw * 1_000_000n) / p.supplyRaw) / 10_000 : 0)

    // Bundle: buyers in the creation slot, cached because it never changes.
    let bundle = this.bundleCache.get(p.mint)
    if (!bundle && !capped && sigs.length) {
      const creationSlot = Math.min(...sigs.map((s) => s.slot))
      const inSlot = sigs.filter((s) => s.slot === creationSlot && !s.err).map((s) => s.signature).slice(0, 25)
      const excluded = new Set([...p.poolOwners, ...(p.dev ? [p.dev] : [])])
      const bought = new Map<string, bigint>()
      for (const tx of await this.parsed(inSlot)) {
        for (const [owner, d] of ownerDeltas(tx, p.mint)) {
          if (d > 0n && !excluded.has(owner)) bought.set(owner, (bought.get(owner) ?? 0n) + d)
        }
      }
      bundle = { creationSlot, wallets: [...bought.keys()], boughtRaw: [...bought.values()].reduce((a, b) => a + b, 0n) }
      this.bundleCache.set(p.mint, bundle)
    }
    const bundleHeld = bundle ? await this.heldBy(bundle.wallets, p.mint, p.tokenProgram) : null
    const devHeld = p.dev ? await this.heldBy([p.dev], p.mint, p.tokenProgram) : null

    // Fees: average over transactions spread across the token's life (the most
    // recent ones are often a single bot), scaled to the count.
    const ok = sigs.filter((s) => !s.err)
    const step = Math.max(1, Math.floor(ok.length / feeSample))
    const sample = ok.filter((_, i) => i % step === 0).slice(0, feeSample).map((s) => s.signature)
    const txs = await this.parsed(sample)
    const avg = txs.length ? txs.reduce((s, tx) => s + feePaidLamports(tx), 0) / txs.length : 0
    return {
      txCount: sigs.length,
      capped,
      creationSlot: bundle?.creationSlot ?? null,
      bundleWallets: bundle?.wallets ?? [],
      bundleBoughtPct: bundle ? pct(bundle.boughtRaw) : null,
      bundleHeldPct: bundleHeld === null ? null : pct(bundleHeld),
      devHeldPct: devHeld === null ? null : pct(devHeld),
      feesSol: (avg * sigs.length) / 1e9,
      sampled: txs.length,
    }
  }
}
