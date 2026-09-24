import { VersionedTransaction, type Keypair } from '@solana/web3.js'
import { errMsg, log } from './log.js'
import { JupiterClient, SOL_MINT, type UltraOrder } from './jupiter.js'
import { associatedTokenAddress, SolanaClient, TOKEN_PROGRAM, type TokenAccountState, type TokenBalance } from './solana.js'
import type { AgentState } from './state.js'

export interface SwapRequest {
  inputMint: string
  outputMint: string
  amountRaw: bigint
  inputDecimals: number
  outputDecimals: number
  /** Token program of the output mint (for locating our account in simulation). */
  outputProgram?: string
  /** Independent USD reference prices used to sanity-check the quote. */
  inputPriceUsd: number
  outputPriceUsd: number
  /** Max value lost versus reference prices (fees + impact + drift), e.g. 0.03. */
  maxLossPct: number
}

export interface SwapResult {
  ok: boolean
  signature?: string
  inAmountRaw: bigint
  outAmountRaw: bigint
  inUsd: number
  outUsd: number
  error?: string
}

export interface Executor {
  readonly live: boolean
  swap(req: SwapRequest): Promise<SwapResult>
}

// Fees, priority fees, tips and up to two new token accounts' rent.
const MAX_SOL_OVERHEAD_LAMPORTS = 15_000_000n

function fail(req: SwapRequest, error: string, signature?: string): SwapResult {
  return { ok: false, error, signature, inAmountRaw: req.amountRaw, outAmountRaw: 0n, inUsd: 0, outUsd: 0 }
}

const SYSTEM_PROGRAM = '11111111111111111111111111111111'

/**
 * The simulation guard's decision, on our balances and accounts before and
 * after a simulated swap. It refuses a transaction when:
 * - SOL (native lamports and wSOL counted as one budget) drops by more than
 *   what we spend plus bounded fees, or a SOL output falls short of the quote;
 * - the input token (summed over all our accounts of that mint) loses more than
 *   requested, the output token receives less than `minOutRaw`, or any other
 *   token we hold decreases;
 * - any of our token accounts ends up with another owner, a delegate, or a
 *   close authority that is not us, or the wallet itself stops being a plain
 *   system account (so nothing can be handed over for a later drain).
 * Returns a reason to refuse, or null when the transaction only does what was asked.
 */
export function checkBalanceChanges(p: {
  req: Pick<SwapRequest, 'inputMint' | 'outputMint' | 'amountRaw'>
  /** Least acceptable output, in raw units of the output mint (lamports for SOL). */
  minOutRaw: bigint
  wallet: string
  preLamports: bigint
  postLamports: bigint
  walletOwnerAfter: string | null
  /** account -> raw amount before */
  pre: Map<string, bigint>
  /** account -> state after (null = closed or absent) */
  post: Record<string, TokenAccountState | null>
  /** account -> mint, for every watched account */
  accountMints: Map<string, string>
}): string | null {
  const { req } = p
  if (p.walletOwnerAfter !== SYSTEM_PROGRAM) return `wallet would be assigned to ${p.walletOwnerAfter}`
  for (const [account, state] of Object.entries(p.post)) {
    if (!state) continue
    if (state.owner !== p.wallet) return `token account ${account} would change owner to ${state.owner}`
    if (state.delegate) return `token account ${account} would get delegate ${state.delegate}`
    if (state.closeAuthority && state.closeAuthority !== p.wallet) return `token account ${account} would get close authority ${state.closeAuthority}`
  }
  const delta = new Map<string, bigint>()
  for (const [account, mint] of p.accountMints) {
    const change = (p.post[account]?.amount ?? 0n) - (p.pre.get(account) ?? 0n)
    delta.set(mint, (delta.get(mint) ?? 0n) + change)
  }
  // SOL: native lamports and wSOL are one budget.
  const solDelta = p.postLamports - p.preLamports + (delta.get(SOL_MINT) ?? 0n)
  if (req.inputMint === SOL_MINT) {
    if (solDelta < -(req.amountRaw + MAX_SOL_OVERHEAD_LAMPORTS)) return `SOL would drop by ${-solDelta}, more than ${req.amountRaw} plus fees`
  } else if (req.outputMint === SOL_MINT) {
    if (solDelta + MAX_SOL_OVERHEAD_LAMPORTS < p.minOutRaw) return `SOL output ${solDelta} short of the ${p.minOutRaw} expected`
  } else if (solDelta < -MAX_SOL_OVERHEAD_LAMPORTS) {
    return `SOL would drop by ${-solDelta}`
  }
  for (const [mint, d] of delta) {
    if (mint === SOL_MINT) continue
    if (mint === req.inputMint) {
      if (-d > req.amountRaw) return `input would lose ${-d}, more than the ${req.amountRaw} requested`
    } else if (mint === req.outputMint) {
      if (d < p.minOutRaw) return `output ${d} short of the ${p.minOutRaw} expected`
    } else if (d < 0n) {
      return `unrelated token ${mint} would decrease by ${-d}`
    }
  }
  if (req.outputMint !== SOL_MINT && !delta.has(req.outputMint)) return 'output account not watched'
  return null
}

/** Value check of a quote against reference prices. Returns an error string or null. */
export function checkQuote(req: SwapRequest, order: UltraOrder): { inUsd: number; outUsd: number; error: string | null } {
  if (order.errorCode || order.error || order.errorMessage) {
    return { inUsd: 0, outUsd: 0, error: `order error: ${order.errorMessage ?? order.error ?? order.errorCode}` }
  }
  const inAmount = BigInt(order.inAmount ?? '0')
  const outAmount = BigInt(order.outAmount ?? '0')
  if (inAmount !== req.amountRaw) return { inUsd: 0, outUsd: 0, error: `order input ${inAmount} differs from requested ${req.amountRaw}` }
  if (outAmount <= 0n) return { inUsd: 0, outUsd: 0, error: 'order has no output' }
  const inUsd = (Number(inAmount) / 10 ** req.inputDecimals) * req.inputPriceUsd
  const outUsd = (Number(outAmount) / 10 ** req.outputDecimals) * req.outputPriceUsd
  if (!(inUsd > 0) || !(outUsd > 0)) return { inUsd, outUsd, error: 'missing reference price' }
  const loss = 1 - outUsd / inUsd
  if (loss > req.maxLossPct) {
    return { inUsd, outUsd, error: `quote loses ${(loss * 100).toFixed(2)}% vs reference (limit ${(req.maxLossPct * 100).toFixed(1)}%)` }
  }
  return { inUsd, outUsd, error: null }
}

export class LiveExecutor implements Executor {
  readonly live = true

  constructor(
    private readonly jup: JupiterClient,
    private readonly sol: SolanaClient,
    private readonly kp: Keypair,
  ) {}

  async swap(req: SwapRequest): Promise<SwapResult> {
    const wallet = this.kp.publicKey.toBase58()
    let order: UltraOrder
    try {
      order = await this.jup.order({ inputMint: req.inputMint, outputMint: req.outputMint, amount: req.amountRaw.toString(), taker: wallet })
    } catch (e) {
      return fail(req, `order request failed: ${errMsg(e)}`)
    }
    const q = checkQuote(req, order)
    if (q.error) return fail(req, q.error)
    if (!order.transaction) return fail(req, 'order returned no transaction (insufficient balance?)')

    let tx: VersionedTransaction
    try {
      tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'))
    } catch (e) {
      return fail(req, `cannot decode transaction: ${errMsg(e)}`)
    }
    const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58())
    if (!signers.includes(wallet)) return fail(req, 'transaction does not require our signature')

    // The transaction must pay at least what the quote promised, less our tolerance.
    const minOutRaw = (BigInt(order.outAmount) * BigInt(Math.round((1 - req.maxLossPct) * 10_000))) / 10_000n
    const guard = await this.verifyBySimulation(tx, req, wallet, minOutRaw)
    if (guard) return fail(req, `simulation guard: ${guard}`)

    tx.sign([this.kp])
    const signed = Buffer.from(tx.serialize()).toString('base64')
    try {
      const res = await this.jup.execute(signed, order.requestId)
      if (res.status !== 'Success') return fail(req, `execute ${res.status}: ${res.error ?? res.code}`, res.signature)
      const inRaw = BigInt(res.inputAmountResult ?? res.totalInputAmount ?? order.inAmount)
      const outRaw = BigInt(res.outputAmountResult ?? res.totalOutputAmount ?? order.outAmount)
      return {
        ok: true,
        signature: res.signature,
        inAmountRaw: inRaw,
        outAmountRaw: outRaw,
        inUsd: (Number(inRaw) / 10 ** req.inputDecimals) * req.inputPriceUsd,
        outUsd: (Number(outRaw) / 10 ** req.outputDecimals) * req.outputPriceUsd,
      }
    } catch (e) {
      return fail(req, `execute request failed: ${errMsg(e)}`)
    }
  }

  /**
   * Simulates the swap and checks our balances afterwards: SOL may only drop by
   * the SOL we are spending plus bounded overhead, the input account may only
   * lose the requested amount, the output must grow, and nothing else we hold
   * may decrease. Returns an error string, or null when the transaction is sound.
   */
  private async verifyBySimulation(tx: VersionedTransaction, req: SwapRequest, wallet: string, minOutRaw: bigint): Promise<string | null> {
    let holdings: TokenBalance[]
    let preLamports: number
    try {
      ;[holdings, preLamports] = await Promise.all([this.sol.tokenBalances(wallet), this.sol.solBalanceLamports(wallet)])
    } catch (e) {
      return `could not read balances: ${errMsg(e)}`
    }
    const watch = new Set(holdings.map((h) => h.account))
    // Existing accounts of the output mint are already watched; the associated
    // account is where a new balance lands.
    const outAccount = req.outputMint !== SOL_MINT ? associatedTokenAddress(wallet, req.outputMint, req.outputProgram ?? TOKEN_PROGRAM) : null
    if (outAccount) watch.add(outAccount)
    let sim
    try {
      sim = await this.sol.simulate(tx, wallet, [...watch])
    } catch (e) {
      return `simulation request failed: ${errMsg(e)}`
    }
    if (sim.err) return `simulation error ${JSON.stringify(sim.err)} ${sim.logs.slice(-3).join(' | ')}`
    if (!sim.wallet) return 'simulation returned no wallet state'
    const accountMints = new Map(holdings.map((h) => [h.account, h.mint]))
    if (outAccount) accountMints.set(outAccount, req.outputMint)
    const verdict = checkBalanceChanges({
      req,
      minOutRaw,
      wallet,
      preLamports: BigInt(preLamports),
      postLamports: BigInt(sim.wallet.lamports),
      walletOwnerAfter: sim.wallet.owner,
      pre: new Map(holdings.map((h) => [h.account, h.amountRaw])),
      post: sim.accounts,
      accountMints,
    })
    if (verdict) return verdict
    log.debug('simulation guard passed')
    return null
  }
}

/** Paper trading: real Jupiter quotes, simulated balances. Nothing is signed or sent. */
export class PaperExecutor implements Executor {
  readonly live = false

  constructor(
    private readonly jup: JupiterClient,
    private readonly state: AgentState,
    private readonly cashMint: string,
  ) {}

  async swap(req: SwapRequest): Promise<SwapResult> {
    let order: UltraOrder
    try {
      order = await this.jup.order({ inputMint: req.inputMint, outputMint: req.outputMint, amount: req.amountRaw.toString() })
    } catch (e) {
      return fail(req, `quote failed: ${errMsg(e)}`)
    }
    const q = checkQuote(req, order)
    if (q.error) return fail(req, q.error)
    const paper = (this.state.paper ??= { cashUsd: 0, balances: {}, startUsd: 0 })
    const inQty = Number(req.amountRaw) / 10 ** req.inputDecimals
    const outRaw = BigInt(order.outAmount)
    const outQty = Number(outRaw) / 10 ** req.outputDecimals
    if (req.inputMint === this.cashMint) {
      if (paper.cashUsd + 1e-9 < inQty) return fail(req, 'paper cash too low')
      paper.cashUsd -= inQty
    } else {
      const bal = paper.balances[req.inputMint] ?? 0
      if (bal + 1e-12 < inQty) return fail(req, 'paper balance too low')
      paper.balances[req.inputMint] = bal - inQty
      if (paper.balances[req.inputMint]! <= 1e-12) delete paper.balances[req.inputMint]
    }
    if (req.outputMint === this.cashMint) paper.cashUsd += outQty
    else paper.balances[req.outputMint] = (paper.balances[req.outputMint] ?? 0) + outQty
    return { ok: true, inAmountRaw: req.amountRaw, outAmountRaw: outRaw, inUsd: q.inUsd, outUsd: q.outUsd }
  }
}
