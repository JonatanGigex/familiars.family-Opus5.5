import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { checkBalanceChanges } from '../src/executor.js'
import { SOL_MINT, USDC_MINT } from '../src/jupiter.js'
import { parseTokenAccount, type TokenAccountState } from '../src/solana.js'

// The simulation guard decides whether a swap transaction built by an external
// API may be signed. These are the ways a malicious or broken one would hurt us.

const SOL = 1_000_000_000n
const SYSTEM = '11111111111111111111111111111111'
const WALLET = Keypair.generate().publicKey.toBase58()
const ATTACKER = Keypair.generate().publicKey.toBase58()
const X = Keypair.generate().publicKey.toBase58()
const Y = Keypair.generate().publicKey.toBase58()

type Acc = { mint: string; pre?: bigint; post: bigint | null; owner?: string; delegate?: string; closeAuthority?: string }

function check(opts: { input: string; output: string; amount: bigint; minOut: bigint; lamports: [bigint, bigint]; walletOwner?: string; accounts: Record<string, Acc> }) {
  const post: Record<string, TokenAccountState | null> = {}
  for (const [k, a] of Object.entries(opts.accounts)) {
    post[k] = a.post === null ? null : { mint: a.mint, owner: a.owner ?? WALLET, amount: a.post, delegate: a.delegate ?? null, closeAuthority: a.closeAuthority ?? null }
  }
  return checkBalanceChanges({
    req: { inputMint: opts.input, outputMint: opts.output, amountRaw: opts.amount },
    minOutRaw: opts.minOut,
    wallet: WALLET,
    preLamports: opts.lamports[0],
    postLamports: opts.lamports[1],
    walletOwnerAfter: opts.walletOwner ?? SYSTEM,
    pre: new Map(Object.entries(opts.accounts).filter(([, a]) => a.pre !== undefined).map(([k, a]) => [k, a.pre!])),
    post,
    accountMints: new Map(Object.entries(opts.accounts).map(([k, a]) => [k, a.mint])),
  })
}

const buy = { input: USDC_MINT, output: X, amount: 50_000_000n, minOut: 950n }
const usdcSpent: Acc = { mint: USDC_MINT, pre: 100_000_000n, post: 50_000_000n }

describe('simulation guard', () => {
  it('passes an honest USDC -> token buy that opens a new token account', () => {
    expect(check({ ...buy, lamports: [SOL / 10n, SOL / 10n - 2_500_000n], accounts: { usdc: usdcSpent, xAta: { mint: X, post: 1000n } } })).toBeNull()
  })

  it('refuses a transaction that drains SOL', () => {
    expect(check({ ...buy, lamports: [SOL, SOL / 100n], accounts: { usdc: usdcSpent, xAta: { mint: X, post: 1000n } } })).toMatch(/SOL would drop/)
  })

  it('refuses a transaction that takes another token we hold', () => {
    expect(check({ ...buy, lamports: [SOL, SOL], accounts: { usdc: usdcSpent, xAta: { mint: X, post: 1000n }, y: { mint: Y, pre: 500n, post: 0n } } })).toMatch(/unrelated token/)
  })

  it('refuses spending more than requested, even split across two accounts', () => {
    expect(check({ ...buy, lamports: [SOL, SOL], accounts: { usdc: { mint: USDC_MINT, pre: 100_000_000n, post: 0n }, xAta: { mint: X, post: 1000n } } })).toMatch(/more than/)
    expect(
      check({
        input: X,
        output: USDC_MINT,
        amount: 1000n,
        minOut: 45_000_000n,
        lamports: [SOL, SOL],
        accounts: { x1: { mint: X, pre: 1000n, post: 0n }, x2: { mint: X, pre: 500n, post: 0n }, usdc: { mint: USDC_MINT, pre: 0n, post: 49_000_000n } },
      }),
    ).toMatch(/more than/)
  })

  it('refuses a swap that pays nothing or a token amount far below the quote', () => {
    expect(check({ ...buy, lamports: [SOL, SOL], accounts: { usdc: usdcSpent, xAta: { mint: X, post: null } } })).toMatch(/short of/)
    expect(check({ ...buy, lamports: [SOL, SOL], accounts: { usdc: usdcSpent, xAta: { mint: X, post: 1n } } })).toMatch(/short of/)
  })

  it('passes a full sell that closes the token account', () => {
    expect(
      check({ input: X, output: USDC_MINT, amount: 1000n, minOut: 45_000_000n, lamports: [SOL, SOL + 2_000_000n], accounts: { x: { mint: X, pre: 1000n, post: null }, usdc: { mint: USDC_MINT, pre: 0n, post: 49_000_000n } } }),
    ).toBeNull()
  })

  it('does not let a rent refund pass for a SOL payout', () => {
    // Selling X for ~0.5 SOL, but the transaction only returns the closed account's rent.
    expect(check({ input: X, output: SOL_MINT, amount: 1000n, minOut: SOL / 2n, lamports: [SOL, SOL + 2_039_280n], accounts: { x: { mint: X, pre: 1000n, post: null } } })).toMatch(/SOL output/)
    expect(check({ input: X, output: SOL_MINT, amount: 1000n, minOut: SOL / 2n, lamports: [SOL, SOL + SOL / 2n], accounts: { x: { mint: X, pre: 1000n, post: null } } })).toBeNull()
  })

  it('counts native SOL and wSOL as one budget', () => {
    const wsolDrained = { xAta: { mint: X, post: 10n }, wsol: { mint: SOL_MINT, pre: SOL, post: 0n } }
    expect(check({ input: SOL_MINT, output: X, amount: SOL, minOut: 10n, lamports: [2n * SOL, SOL - 5_000_000n], accounts: wsolDrained })).toMatch(/SOL would drop/)
    expect(check({ input: SOL_MINT, output: X, amount: SOL / 2n, minOut: 10n, lamports: [SOL, SOL / 2n - 5_000_000n], accounts: { xAta: { mint: X, post: 10n } } })).toBeNull()
    // A wSOL account must not shrink when selling into SOL.
    expect(
      check({ input: X, output: SOL_MINT, amount: 1000n, minOut: SOL / 2n, lamports: [SOL, SOL + SOL / 2n], accounts: { x: { mint: X, pre: 1000n, post: 0n }, wsol: { mint: SOL_MINT, pre: SOL, post: 0n } } }),
    ).toMatch(/SOL output/)
  })

  it('refuses handing over control of our accounts', () => {
    const ok = { usdc: usdcSpent, xAta: { mint: X, post: 1000n } }
    expect(check({ ...buy, lamports: [SOL, SOL], accounts: { ...ok, usdc: { ...usdcSpent, delegate: ATTACKER } } })).toMatch(/delegate/)
    expect(check({ ...buy, lamports: [SOL, SOL], accounts: { ...ok, usdc: { ...usdcSpent, owner: ATTACKER } } })).toMatch(/change owner/)
    expect(check({ ...buy, lamports: [SOL, SOL], accounts: { ...ok, xAta: { mint: X, post: 1000n, closeAuthority: ATTACKER } } })).toMatch(/close authority/)
    expect(check({ ...buy, lamports: [SOL, SOL], walletOwner: ATTACKER, accounts: ok })).toMatch(/assigned/)
  })
})

describe('parseTokenAccount', () => {
  it('reads mint, owner, amount, delegate and close authority from the SPL layout', () => {
    const buf = Buffer.alloc(165)
    const mint = Keypair.generate().publicKey
    const owner = Keypair.generate().publicKey
    const delegate = Keypair.generate().publicKey
    mint.toBuffer().copy(buf, 0)
    owner.toBuffer().copy(buf, 32)
    buf.writeBigUInt64LE(123_456n, 64)
    buf.writeUInt32LE(1, 72)
    delegate.toBuffer().copy(buf, 76)
    buf.writeUInt32LE(0, 129)
    expect(parseTokenAccount(buf)).toEqual({ mint: mint.toBase58(), owner: owner.toBase58(), amount: 123_456n, delegate: delegate.toBase58(), closeAuthority: null })
    expect(parseTokenAccount(Buffer.alloc(100))).toBeNull()
  })
})
