import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig, parseEnvFile } from '../src/config.js'
import { checkQuote, type SwapRequest } from '../src/executor.js'
import type { JupToken, UltraOrder } from '../src/jupiter.js'
import { redact, registerSecret } from '../src/log.js'
import { clip, sellText } from '../src/poster.js'
import { DEFAULT_SCREEN, screenToken, shieldBlock } from '../src/screener.js'
import { appendSecrets } from '../src/secrets.js'
import { mintRisks } from '../src/solana.js'
import { generateKeypair, keypairFromSecret, secretToBase58, signMessage, verifyMessage } from '../src/wallet.js'

describe('secrets never leak', () => {
  it('redacts registered secrets and anything shaped like a familiars key', () => {
    registerSecret('super-secret-value-123')
    expect(redact('key=super-secret-value-123')).toBe('key=[REDACTED]')
    expect(redact('Bearer fam_abcdefghijkl')).toBe('Bearer fam_[REDACTED]')
    expect(redact('login #/login/fam_owner_abcdefghijkl')).toBe('login #/login/fam_owner_[REDACTED]')
  })

  it('writes the secrets file with mode 0600 and refuses to overwrite keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fam-'))
    const file = join(dir, 'agent.env')
    appendSecrets(file, { A: '1' })
    appendSecrets(file, { B: '2' })
    expect(parseEnvFile(readFileSync(file, 'utf8'))).toEqual({ A: '1', B: '2' })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(() => appendSecrets(file, { A: '3' })).toThrow(/refusing/)
  })

  it('loads secrets from the file and lets env override', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fam-'))
    const file = join(dir, 'agent.env')
    appendSecrets(file, { FAMILIARS_API_KEY: 'fam_fromfile123', TRADING_MODE: 'live' })
    const cfg = loadConfig({ FAMILIARS_SECRETS_FILE: file })
    expect(cfg.apiKey).toBe('fam_fromfile123')
    expect(cfg.mode).toBe('live')
    expect(loadConfig({ FAMILIARS_SECRETS_FILE: file, TRADING_MODE: 'paper' }).mode).toBe('paper')
  })
})

describe('wallet', () => {
  it('signs the registration message verifiably and round-trips keys', () => {
    const kp = generateKeypair()
    const msg = 'familiars: register agent wallet\nnonce: 123'
    const sig = signMessage(kp, msg)
    expect(verifyMessage(kp.publicKey.toBase58(), msg, sig.base64)).toBe(true)
    expect(verifyMessage(kp.publicKey.toBase58(), `${msg}!`, sig.base64)).toBe(false)
    expect(keypairFromSecret(secretToBase58(kp)).publicKey.toBase58()).toBe(kp.publicKey.toBase58())
    expect(keypairFromSecret(JSON.stringify([...kp.secretKey])).publicKey.toBase58()).toBe(kp.publicKey.toBase58())
  })
})

describe('checkQuote', () => {
  const req: SwapRequest = { inputMint: 'USDC', outputMint: 'TOK', amountRaw: 100_000_000n, inputDecimals: 6, outputDecimals: 6, inputPriceUsd: 1, outputPriceUsd: 2, maxLossPct: 0.03 }
  const order = (outAmount: string, extra: Partial<UltraOrder> = {}): UltraOrder => ({ requestId: 'r', inputMint: 'USDC', outputMint: 'TOK', inAmount: '100000000', outAmount, transaction: null, ...extra })

  it('accepts a fair quote', () => {
    expect(checkQuote(req, order('49700000')).error).toBeNull()
  })
  it('rejects a quote that loses too much value', () => {
    expect(checkQuote(req, order('45000000')).error).toMatch(/loses/)
  })
  it('rejects a quote for a different amount or with an error', () => {
    expect(checkQuote(req, order('49700000', { inAmount: '200000000' })).error).toMatch(/differs/)
    expect(checkQuote(req, order('49700000', { errorCode: 1, errorMessage: 'Insufficient funds' })).error).toMatch(/Insufficient/)
  })
})

describe('screening', () => {
  const now = Date.parse('2026-09-24T00:00:00Z')
  const base: JupToken = {
    id: 'Tok111',
    name: 'Token',
    symbol: 'TOK',
    decimals: 6,
    liquidity: 2_000_000,
    mcap: 50_000_000,
    organicScore: 80,
    firstPool: { id: 'p', createdAt: '2026-01-01T00:00:00Z' },
    audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 20 },
    stats24h: { buyVolume: 1_000_000, sellVolume: 1_000_000 },
  }
  it('passes a clean liquid token', () => {
    expect(screenToken(base, DEFAULT_SCREEN, now).pass).toBe(true)
  })
  it('rejects active authorities, stables, thin books and brand new tokens', () => {
    expect(screenToken({ ...base, audit: { ...base.audit, freezeAuthorityDisabled: false } }, DEFAULT_SCREEN, now).reasons).toContain('freeze authority not revoked')
    expect(screenToken({ ...base, symbol: 'USDX' }, DEFAULT_SCREEN, now).pass).toBe(false)
    expect(screenToken({ ...base, liquidity: 10_000 }, DEFAULT_SCREEN, now).pass).toBe(false)
    expect(screenToken({ ...base, firstPool: { id: 'p', createdAt: '2026-09-23T12:00:00Z' } }, DEFAULT_SCREEN, now).reasons).toContain('too new')
    expect(screenToken({ ...base, audit: { ...base.audit, topHoldersPercentage: 85 } }, DEFAULT_SCREEN, now).pass).toBe(false)
  })
  it('blocks dangerous shield warnings', () => {
    expect(shieldBlock([{ type: 'NOT_SELLABLE', message: 'x', severity: 'warning' }], DEFAULT_SCREEN, 'Tok111')).toMatch(/NOT_SELLABLE/)
    expect(shieldBlock([{ type: 'NEW_LISTING', message: 'x', severity: 'info' }], DEFAULT_SCREEN, 'Tok111')).toBeNull()
  })
  it('flags token-2022 transfer fees and hooks', () => {
    const info = { mint: 'm', program: 'p', decimals: 6, supplyRaw: 1n, mintAuthority: null, freezeAuthority: null, extensions: [] as { extension: string; state?: Record<string, unknown> }[] }
    expect(mintRisks(info)).toEqual([])
    expect(mintRisks({ ...info, extensions: [{ extension: 'transferHook' }] })).toContain('token-2022 transferHook')
    expect(mintRisks({ ...info, extensions: [{ extension: 'transferFeeConfig', state: { newerTransferFee: { transferFeeBasisPoints: 300 } } }] })[0]).toMatch(/300 bps/)
  })
})

describe('posts', () => {
  it('stay within 500 characters', () => {
    expect(clip('x'.repeat(900))).toHaveLength(500)
    const t = sellText({ symbol: 'BONK', pnlUsd: -3.2, pnlPct: -0.041, reason: 'stop loss hit', heldHours: 5 })
    expect(t).toMatch(/^Cut \$BONK: -\$3.20 \(-4.1%\) after 5h/)
  })
})
