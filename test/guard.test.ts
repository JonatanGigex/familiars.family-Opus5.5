import { describe, expect, it } from 'vitest'
import { checkBalanceChanges } from '../src/executor.js'
import { SOL_MINT, USDC_MINT } from '../src/jupiter.js'

// The simulation guard decides whether a swap transaction built by an external
// API may be signed. These are the ways a malicious or broken one would hurt us.

const SOL = 1_000_000_000n
const X = 'XmintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
const Y = 'YmintYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY'

function check(opts: {
  input: string
  output: string
  amount: bigint
  lamports: [bigint, bigint]
  accounts: Record<string, { mint: string; pre?: bigint; post: bigint | null }>
}) {
  return checkBalanceChanges({
    req: { inputMint: opts.input, outputMint: opts.output, amountRaw: opts.amount },
    preLamports: opts.lamports[0],
    postLamports: opts.lamports[1],
    pre: new Map(Object.entries(opts.accounts).filter(([, a]) => a.pre !== undefined).map(([k, a]) => [k, a.pre!])),
    post: Object.fromEntries(Object.entries(opts.accounts).map(([k, a]) => [k, a.post])),
    accountMints: new Map(Object.entries(opts.accounts).map(([k, a]) => [k, a.mint])),
  })
}

describe('simulation guard', () => {
  const buy = { input: USDC_MINT, output: X, amount: 50_000_000n }

  it('passes an honest USDC -> token buy that opens a new token account', () => {
    expect(
      check({ ...buy, lamports: [SOL / 10n, SOL / 10n - 2_500_000n], accounts: { usdc: { mint: USDC_MINT, pre: 100_000_000n, post: 50_000_000n }, xAta: { mint: X, post: 1000n } } }),
    ).toBeNull()
  })

  it('refuses a transaction that drains SOL', () => {
    expect(check({ ...buy, lamports: [SOL, SOL / 100n], accounts: { usdc: { mint: USDC_MINT, pre: 100_000_000n, post: 50_000_000n }, xAta: { mint: X, post: 1000n } } })).toMatch(/SOL would drop/)
  })

  it('refuses a transaction that takes another token we hold', () => {
    expect(
      check({ ...buy, lamports: [SOL, SOL], accounts: { usdc: { mint: USDC_MINT, pre: 100_000_000n, post: 50_000_000n }, xAta: { mint: X, post: 1000n }, y: { mint: Y, pre: 500n, post: 0n } } }),
    ).toMatch(/unrelated token/)
  })

  it('refuses spending more than requested, even split across two accounts', () => {
    expect(check({ ...buy, lamports: [SOL, SOL], accounts: { usdc: { mint: USDC_MINT, pre: 100_000_000n, post: 0n }, xAta: { mint: X, post: 1000n } } })).toMatch(/more than/)
    expect(
      check({
        input: X,
        output: USDC_MINT,
        amount: 1000n,
        lamports: [SOL, SOL],
        accounts: { x1: { mint: X, pre: 1000n, post: 0n }, x2: { mint: X, pre: 500n, post: 0n }, usdc: { mint: USDC_MINT, pre: 0n, post: 49_000_000n } },
      }),
    ).toMatch(/more than/)
  })

  it('refuses a swap that pays nothing out', () => {
    expect(check({ ...buy, lamports: [SOL, SOL], accounts: { usdc: { mint: USDC_MINT, pre: 100_000_000n, post: 50_000_000n }, xAta: { mint: X, post: null } } })).toMatch(/would not receive/)
  })

  it('passes a full sell that closes the token account', () => {
    expect(
      check({ input: X, output: USDC_MINT, amount: 1000n, lamports: [SOL, SOL + 2_000_000n], accounts: { x: { mint: X, pre: 1000n, post: null }, usdc: { mint: USDC_MINT, pre: 0n, post: 49_000_000n } } }),
    ).toBeNull()
  })

  it('checks SOL output through lamports, without touching a wSOL account', () => {
    const accounts = { x: { mint: X, pre: 1000n, post: 0n }, wsol: { mint: SOL_MINT, pre: 7n, post: 7n } }
    expect(check({ input: X, output: SOL_MINT, amount: 1000n, lamports: [SOL, SOL + SOL / 2n], accounts })).toBeNull()
    expect(check({ input: X, output: SOL_MINT, amount: 1000n, lamports: [SOL, SOL - 5000n], accounts })).toMatch(/SOL output/)
    expect(check({ input: X, output: SOL_MINT, amount: 1000n, lamports: [SOL, SOL * 2n], accounts: { ...accounts, wsol: { mint: SOL_MINT, pre: 7n, post: 0n } } })).toMatch(/unrelated token/)
  })

  it('allows spending SOL plus bounded fees on a SOL -> token buy', () => {
    const accounts = { xAta: { mint: X, post: 10n } }
    expect(check({ input: SOL_MINT, output: X, amount: SOL / 2n, lamports: [SOL, SOL / 2n - 5_000_000n], accounts })).toBeNull()
    expect(check({ input: SOL_MINT, output: X, amount: SOL / 2n, lamports: [SOL, SOL / 4n], accounts })).toMatch(/SOL would drop/)
  })
})
