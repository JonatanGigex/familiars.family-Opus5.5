import { Connection, PublicKey } from '@solana/web3.js'
import { requestJson } from './http.js'
import { associatedTokenAddress } from './solana.js'

// On-chain launch forensics that no public API provides reliably:
// - bundlers: wallets (other than the dev) that bought in the same slot as the
//   token's creation, i.e. inside the launch bundle, and what they still hold.
//   The creation slot comes from the mint's own history when it is short, and
//   from the creator's history when the token is too busy to page back to its
//   first transaction; the whole slot is then read in one getBlock call;
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
  /** True when paging stopped before the mint's first transaction (fees are then a lower bound). */
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

/** What balance-based analysis needs: `getTransaction` and `getBlock` results both fit. */
type WithMeta = Pick<RawParsedTx, 'meta'>

/** A transaction as `getBlock` returns it with `transactionDetails: 'accounts'`. */
export interface BlockTx extends WithMeta {
  transaction: { signatures: string[]; accountKeys: { pubkey: string }[] }
}

/** Token balance change per owner for one mint in one transaction (raw units). */
export function ownerDeltas(tx: WithMeta, mint: string): Map<string, bigint> {
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

/**
 * True when `tx` brings `mint` into existence: no token account held it before
 * and one holds a positive amount after. Tokens cannot appear from nowhere
 * later on (pump.fun mints the whole supply at creation and drops the mint
 * authority), and an empty account opened later does not count.
 */
export function createsMint(tx: WithMeta, mint: string): boolean {
  const m = tx.meta
  if (!m || m.err) return false
  if ((m.preTokenBalances ?? []).some((b) => b.mint === mint)) return false
  return (m.postTokenBalances ?? []).some((b) => b.mint === mint && BigInt(b.uiTokenAmount.amount) > 0n)
}

/**
 * The launch bundle from one slot's transactions: every wallet except the dev
 * and the pools that received the token in the slot where it was created.
 * Null when that slot does not contain the creation.
 */
export function bundleFromSlot(txs: WithMeta[], mint: string, excluded: Set<string>): { wallets: string[]; boughtRaw: bigint } | null {
  const ok = txs.filter((t) => t.meta && !t.meta.err)
  if (!ok.some((t) => createsMint(t, mint))) return null
  const bought = new Map<string, bigint>()
  for (const tx of ok) {
    for (const [owner, d] of ownerDeltas(tx, mint)) {
      if (d > 0n && !excluded.has(owner)) bought.set(owner, (bought.get(owner) ?? 0n) + d)
    }
  }
  return { wallets: [...bought.keys()], boughtRaw: [...bought.values()].reduce((a, b) => a + b, 0n) }
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

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await this.call(() =>
      requestJson<{ result?: T; error?: { message?: string } }>(this.rpcUrl, {
        method: 'POST',
        body: { jsonrpc: '2.0', id: 1, method, params },
        retries: 0,
      }),
    )
    if (res.error) throw new Error(`${method}: ${res.error.message ?? 'error'}`)
    return res.result as T
  }

  private async parsed(signatures: string[]): Promise<RawParsedTx[]> {
    const out: RawParsedTx[] = []
    for (const sig of signatures) {
      const tx = await this.rpc<RawParsedTx | null>('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }])
      if (tx) out.push(tx)
    }
    return out
  }

  /** Every transaction in `slot`, with balances but without instructions (one call). */
  private async slotTxs(slot: number): Promise<BlockTx[]> {
    const block = await this.rpc<{ transactions?: BlockTx[] } | null>('getBlock', [
      slot,
      { encoding: 'jsonParsed', transactionDetails: 'accounts', maxSupportedTransactionVersion: 1, rewards: false, commitment: 'confirmed' },
    ])
    return block?.transactions ?? []
  }

  /**
   * The creation slot through the creator's own history, for tokens too busy
   * to page back to their first transaction. pump.fun's creation time is the
   * block time of the create transaction, so few signatures qualify; each is
   * checked to really create the mint. Null when the creator did not sign it
   * or is too busy to page back that far.
   */
  private async creationSlotViaCreator(mint: string, creator: string, createdAtMs: number): Promise<number | null> {
    const created = Math.round(createdAtMs / 1000)
    const near: { signature: string; slot: number; dt: number }[] = []
    let before: string | undefined
    for (let page = 0; page < 3; page++) {
      const batch = await this.call(() => this.conn.getSignaturesForAddress(new PublicKey(creator), { before, limit: 1000 }, 'confirmed'))
      for (const s of batch) {
        const dt = s.blockTime == null ? Infinity : Math.abs(s.blockTime - created)
        if (!s.err && dt <= 5) near.push({ signature: s.signature, slot: s.slot, dt })
      }
      const oldest = batch[batch.length - 1]?.blockTime
      if (batch.length < 1000 || oldest == null || oldest < created - 5) break
      before = batch[batch.length - 1]!.signature
    }
    near.sort((a, b) => a.dt - b.dt || a.slot - b.slot)
    for (const s of near.slice(0, 4)) {
      const [tx] = await this.parsed([s.signature])
      if (tx && createsMint(tx, mint)) return s.slot
    }
    return null
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
    /** Launchpad creation time: finds the creation slot of busy tokens via the creator. */
    createdAtMs?: number
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
    if (!bundle) {
      let creationSlot: number | null = !capped && sigs.length ? Math.min(...sigs.map((s) => s.slot)) : null
      if (creationSlot === null && p.dev && p.createdAtMs) creationSlot = await this.creationSlotViaCreator(p.mint, p.dev, p.createdAtMs)
      if (creationSlot !== null) {
        const slot = creationSlot
        let txs: WithMeta[]
        try {
          txs = await this.slotTxs(slot)
        } catch (e) {
          if (capped) throw e
          // An RPC that refuses whole blocks: read the slot's transactions one by one.
          txs = await this.parsed(sigs.filter((s) => s.slot === slot && !s.err).map((s) => s.signature).slice(0, 25))
        }
        const found = bundleFromSlot(txs, p.mint, new Set([...p.poolOwners, ...(p.dev ? [p.dev] : [])]))
        if (found) {
          bundle = { creationSlot: slot, ...found }
          this.bundleCache.set(p.mint, bundle)
        }
      }
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
