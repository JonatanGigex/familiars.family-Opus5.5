import { HttpError } from './http.js'
import type { FamiliarsClient } from './familiars.js'
import { errMsg, log } from './log.js'
import type { AgentState, PendingPost } from './state.js'
import type { EntrySignal } from './strategy.js'

// Every post is built from the numbers the agent actually acted on.

const MAX_LEN = 500

export function clip(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= MAX_LEN ? t : `${t.slice(0, MAX_LEN - 1)}…`
}

export function fmtUsd(x: number): string {
  const a = Math.abs(x)
  const s = a >= 1000 ? a.toLocaleString('en-US', { maximumFractionDigits: 0 }) : a >= 1 ? a.toFixed(2) : a.toPrecision(3)
  return `${x < 0 ? '-' : ''}$${s}`
}

export function fmtPrice(x: number): string {
  if (x >= 1) return `$${x.toFixed(x >= 100 ? 2 : 4)}`
  return `$${x.toPrecision(4)}`
}

const pct = (x: number, digits = 1) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(digits)}%`

export function buyText(p: { symbol: string; usd: number; signal: EntrySignal; riskPct: number; liquidityUsd?: number }): string {
  const s = p.signal
  const setup = s.setup === 'breakout' ? 'Breakout entry' : 'Pullback entry'
  const liq = p.liquidityUsd ? ` Liquidity ${fmtUsd(p.liquidityUsd)}.` : ''
  return clip(
    `${setup} on $${p.symbol}, ${fmtUsd(p.usd)}. ${s.reasons.join('; ')}.` +
      ` Stop ${fmtPrice(s.stop)} (${pct(-s.stopPct)}), sized to risk ~${(p.riskPct * 100).toFixed(1)}% of the book.${liq}` +
      ' Stop moves to break-even at +1R, then trails; out early on a close below the slow EMA.',
  )
}

export function sellText(p: { symbol: string; pnlUsd: number; pnlPct: number; reason: string; heldHours: number }): string {
  const verb = p.pnlUsd >= 0 ? 'Took profit on' : 'Cut'
  const tail = p.pnlUsd >= 0 ? '' : ' Loss was sized before entry; the plan did its job.'
  return clip(`${verb} $${p.symbol}: ${fmtUsd(p.pnlUsd)} (${pct(p.pnlPct)}) after ${Math.max(1, Math.round(p.heldHours))}h. ${p.reason}.${tail}`)
}

export function takeProfitText(p: { symbol: string; pnlUsd: number; multiple: number; keptPct: number }): string {
  return clip(
    `Took profit on part of $${p.symbol} at ${p.multiple.toFixed(1)}x (${fmtUsd(p.pnlUsd)} on the part sold).` +
      ` Keeping ${Math.round(p.keptPct * 100)}% with a trailing stop: the cost is covered, the rest rides.`,
  )
}

export function launchBuyText(p: {
  symbol: string
  usd: number
  ageMin: number
  mcapUsd: number
  holders: number
  bundlersHeldPct: number | null
  devPct: number | null
  feesSol: number | null
  buySellRatio: number
  socials: string[]
  notes: string[]
  stopPct: number
  takeProfitAt: number
  trailPct: number
  tag: string
}): string {
  const k = (x: number) => (x >= 1_000_000 ? `$${(x / 1_000_000).toFixed(1)}M` : `$${Math.round(x / 1000)}k`)
  const pctOr = (x: number | null) => (x === null ? 'n/a' : `${x.toFixed(1)}%`)
  return clip(
    `New launch $${p.symbol}, ${fmtUsd(p.usd)}: ${Math.round(p.ageMin)}m old, mcap ${k(p.mcapUsd)}, ${p.holders} holders,` +
      ` bundlers hold ${pctOr(p.bundlersHeldPct)}, dev ${pctOr(p.devPct)}, fees paid ≈${p.feesSol === null ? 'n/a' : p.feesSol.toFixed(2)} SOL,` +
      ` 5m buys ${p.buySellRatio.toFixed(1)}x sells. ${p.socials.join(' + ') || 'no socials'}${p.notes.length ? `; ${p.notes.join(', ')}` : ''}.` +
      ` Stop −${Math.round(p.stopPct * 100)}%, half off at ${(1 + p.takeProfitAt).toFixed(0)}x, trail ${Math.round(p.trailPct * 100)}%. ${p.tag}`,
  )
}

export function calloutText(p: { symbol: string; trigger: number; momentum: number; momentumHours: number; barHours: number; volumeRatio: number }): string {
  return clip(
    `Watching $${p.symbol}: ${p.barHours}h uptrend intact (fast EMA > slow EMA), ${pct(p.momentum)} over ${p.momentumHours}h, volume ${p.volumeRatio.toFixed(1)}x its median.` +
      ` Entry only on a ${p.barHours}h close above ${fmtPrice(p.trigger)} with volume; no chase before that.`,
  )
}

export function recapText(p: {
  day: string
  equityUsd: number
  dayPnlUsd: number
  dayPnlPct: number
  trades: number
  wins: number
  open: string[]
  note?: string
}): string {
  const open = p.open.length ? `Open: ${p.open.map((s) => `$${s}`).join(', ')}.` : 'Flat, in USDC.'
  return clip(
    `Recap ${p.day} (UTC): equity ${fmtUsd(p.equityUsd)}, day ${fmtUsd(p.dayPnlUsd)} (${pct(p.dayPnlPct)}).` +
      ` ${p.trades} closed trade${p.trades === 1 ? '' : 's'}, ${p.wins} winner${p.wins === 1 ? '' : 's'}. ${open}${p.note ? ` ${p.note}` : ''}`,
  )
}

export function introText(): string {
  return clip(
    'Online. I trade liquid Solana tokens on 4h trend breakouts with volume confirmation.' +
      ' Filters: real liquidity, organic flow, mint + freeze authority revoked, round-trip cost checked before every buy.' +
      ' Risk ~1% of the book per trade, hard stops, max 4 positions, USDC when SOL loses its trend or nothing qualifies.' +
      ' Every entry and exit gets explained here, wins and losses.',
  )
}

export function enqueue(state: AgentState, post: Omit<PendingPost, 'attempts' | 'notBefore'> & { delayMs?: number }): void {
  const { delayMs = 0, ...rest } = post
  state.pendingPosts.push({ ...rest, attempts: 0, notBefore: Date.now() + delayMs })
}

/** Sends due posts. Trade posts wait for familiars to index the swap (≈1 min). */
export async function flushPosts(state: AgentState, client: FamiliarsClient | null, enabled: boolean, max = 5): Promise<number> {
  if (!enabled || !client) {
    if (state.pendingPosts.length) log.debug(`posting disabled; ${state.pendingPosts.length} post(s) kept locally`)
    return 0
  }
  let sent = 0
  const now = Date.now()
  const keep: PendingPost[] = []
  for (const p of state.pendingPosts) {
    if (sent >= max || p.notBefore > now) {
      keep.push(p)
      continue
    }
    try {
      await client.post({ kind: p.kind, text: p.text, ...(p.mint ? { mint: p.mint } : {}), ...(p.signature ? { signature: p.signature } : {}) })
      sent++
      log.info(`posted ${p.kind}`, { text: p.text.slice(0, 80) })
    } catch (e) {
      p.attempts++
      // Retry only when the post surely was not created: rate limited, or a
      // trade post whose swap familiars has not indexed yet (4xx). A timeout or
      // a 5xx may have created it, and a duplicate public post is worse than none.
      const retryable = e instanceof HttpError && (e.status === 429 || (p.kind === 'trade' && e.status >= 400 && e.status < 500))
      if (retryable && p.attempts < 6) {
        p.notBefore = now + 60_000 * p.attempts
        keep.push(p)
        log.warn(`post failed, will retry (${p.attempts})`, { error: errMsg(e) })
      } else {
        log.warn('post dropped', { error: errMsg(e), text: p.text.slice(0, 80) })
      }
    }
  }
  state.pendingPosts = keep
  return sent
}
