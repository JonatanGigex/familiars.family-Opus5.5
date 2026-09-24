import { describe, expect, it } from 'vitest'
import { accountFromHistory, DEFAULT_RISK, entryGuard, parseDirective, sizePosition } from '../src/risk.js'

const noLimits = { instructions: null, maxPositionUsd: null, dailyLimitUsd: null }

describe('sizePosition', () => {
  it('sizes by risk: 1.5% of 1000 at a 10% stop is $150', () => {
    const r = sizePosition({ equityUsd: 1000, spendableUsd: 1000, stopPct: 0.1, openPositions: 0, boughtTodayUsd: 0, owner: noLimits }, DEFAULT_RISK)
    expect(r.usd).toBe(150)
  })

  it('caps by max position share of equity', () => {
    const r = sizePosition({ equityUsd: 1000, spendableUsd: 1000, stopPct: 0.02, openPositions: 0, boughtTodayUsd: 0, owner: noLimits }, DEFAULT_RISK)
    expect(r.usd).toBe(300)
    expect(r.limitedBy[0]).toMatch(/equity/)
  })

  it("respects the owner's max position and daily limit", () => {
    const owner = { instructions: null, maxPositionUsd: 50, dailyLimitUsd: 200 }
    expect(sizePosition({ equityUsd: 1000, spendableUsd: 1000, stopPct: 0.1, openPositions: 0, boughtTodayUsd: 0, owner }, DEFAULT_RISK).usd).toBe(50)
    const r = sizePosition({ equityUsd: 1000, spendableUsd: 1000, stopPct: 0.1, openPositions: 0, boughtTodayUsd: 180, owner }, DEFAULT_RISK)
    expect(r.usd).toBe(20)
    const blocked = sizePosition({ equityUsd: 1000, spendableUsd: 1000, stopPct: 0.1, openPositions: 0, boughtTodayUsd: 199, owner }, DEFAULT_RISK)
    expect(blocked.usd).toBe(0)
    expect(blocked.blockedReason).toMatch(/owner daily limit/)
  })

  it('blocks when all slots are used or cash is gone', () => {
    expect(sizePosition({ equityUsd: 1000, spendableUsd: 1000, stopPct: 0.1, openPositions: 4, boughtTodayUsd: 0, owner: noLimits }, DEFAULT_RISK).usd).toBe(0)
    expect(sizePosition({ equityUsd: 1000, spendableUsd: 2, stopPct: 0.1, openPositions: 0, boughtTodayUsd: 0, owner: noLimits }, DEFAULT_RISK).usd).toBe(0)
  })
})

describe('entryGuard', () => {
  it('trips on drawdown and on daily loss', () => {
    expect(entryGuard({ netDepositsUsd: 100, pnlUsd: 0, peakPnlUsd: 0, dayStartPnlUsd: 0 }, DEFAULT_RISK)).toBeNull()
    expect(entryGuard({ netDepositsUsd: 100, pnlUsd: -30, peakPnlUsd: 0, dayStartPnlUsd: -29 }, DEFAULT_RISK)).toMatch(/drawdown/)
    expect(entryGuard({ netDepositsUsd: 100, pnlUsd: -7, peakPnlUsd: 0, dayStartPnlUsd: 0 }, DEFAULT_RISK)).toMatch(/today/)
  })
})

describe('accountFromHistory', () => {
  const day = Date.parse('2026-09-24T00:00:00Z')
  it('treats deposits as flows, not profit', () => {
    const a = accountFromHistory(
      [
        { timestamp: day - 600_000, equityUsd: 0, netDepositsUsd: 0 },
        { timestamp: day + 600_000, equityUsd: 500, netDepositsUsd: 500 },
        { timestamp: day + 1_200_000, equityUsd: 520, netDepositsUsd: 500 },
      ],
      day + 1_300_000,
    )!
    expect(a).toEqual({ netDepositsUsd: 500, pnlUsd: 20, peakPnlUsd: 20, dayStartPnlUsd: 0 })
    expect(entryGuard(a, DEFAULT_RISK)).toBeNull()
  })
  it('measures drawdown from the 7-day peak only', () => {
    const a = accountFromHistory(
      [
        { timestamp: day - 10 * 86_400_000, equityUsd: 2000, netDepositsUsd: 1000 },
        { timestamp: day - 86_400_000, equityUsd: 1100, netDepositsUsd: 1000 },
        { timestamp: day + 600_000, equityUsd: 1050, netDepositsUsd: 1000 },
      ],
      day + 700_000,
    )!
    expect(a.peakPnlUsd).toBe(100)
    expect(entryGuard(a, DEFAULT_RISK)).toBeNull()
  })
  it('does not see a withdrawal as a drawdown', () => {
    const a = accountFromHistory(
      [
        { timestamp: day + 600_000, equityUsd: 1000, netDepositsUsd: 1000 },
        { timestamp: day + 1_200_000, equityUsd: 400, netDepositsUsd: 400 },
      ],
      day + 1_300_000,
    )!
    expect(a.pnlUsd).toBe(0)
    expect(entryGuard(a, DEFAULT_RISK)).toBeNull()
  })
})

describe('parseDirective', () => {
  it('understands pause and liquidate in English and Spanish', () => {
    expect(parseDirective('Only liquid tokens')).toBeNull()
    expect(parseDirective('Please pause for today')).toBe('pause')
    expect(parseDirective('para de operar')).toBe('pause')
    expect(parseDirective('Liquidate everything now')).toBe('liquidate')
    expect(parseDirective('vende todo')).toBe('liquidate')
    expect(parseDirective(null)).toBeNull()
  })
})
