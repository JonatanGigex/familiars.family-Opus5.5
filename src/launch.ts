import type { Candle } from './indicators.js'
import type { LaunchChainStats } from './onchain.js'

// New-launch memecoin strategy: pure rules, shared by the live agent, the
// screening CLI and the tests.

export interface LaunchParams {
  // --- the owner's filters ---------------------------------------------------
  maxAgeMin: number
  minMcapUsd: number
  minHolders: number
  /** % of supply still held by the wallets that bought inside the launch bundle. */
  maxBundlersHeldPct: number
  /** SOL paid in fees and tips by everyone trading the token (estimated on-chain). */
  minFeesSol: number
  maxDevPct: number
  minSocials: number
  // --- extra protection added by the agent ------------------------------------
  /** A launch whose bundle bought this much is a rug signature even after it sold. */
  maxBundlersBoughtPct: number
  /** Devs who mint token after token are factories: skip them. */
  maxDevMints: number
  /** Top-10 holders share (Jupiter, pools excluded). */
  maxTop10Pct: number
  /** Stay early: skip launches that already ran this far. */
  maxMcapUsd: number
  minLiquidityUsd: number
  /** Quoted buy-then-sell cost at our size: catches taxes and honeypots. */
  maxRoundTripPct: number
  /** Skip launches quoted in custom tokens (their prices and caps are unreliable). */
  requireSolQuote: boolean
  // --- quality ------------------------------------------------------------------
  minUtilityScore: number
  /**
   * Jupiter's organic score (0-100): the share of activity from real traders.
   * Volume bots pass every count-based filter (holders, traders, even fees);
   * a launch with no organic activity is trading against bots.
   */
  minOrganicScore: number
  /** Only buy mints a reviewer approved (the Claude routine writes approvals). */
  requireApproval: boolean
  // --- momentum confirmation -----------------------------------------------------
  minBuySellRatio5m: number
  minTraders5m: number
  /** Skip vertical candles: % change over 5 minutes. */
  maxPriceChange5mPct: number
  minPriceChange1hPct: number
  // --- risk and exits -------------------------------------------------------------
  riskPerTrade: number
  stopPct: number
  /** Take `takeProfitFraction` off once price is this far above entry (1 = +100%). */
  takeProfitAt: number
  takeProfitFraction: number
  /** Trail once price has run this far; the trail sits `trailPct` below the high. */
  trailActivateAt: number
  trailPct: number
  timeStopHours: number
  timeStopMinGain: number
  /** Exit if liquidity falls this much from entry. */
  liquidityCollapsePct: number
  maxPositions: number
  /** Never take more than this share of the pool. */
  maxPositionPctOfLiquidity: number
  /** Candidates per pass that get the (slow) on-chain forensics. */
  maxForensicsPerPass: number
}

export const DEFAULT_LAUNCH: LaunchParams = {
  maxAgeMin: 120,
  minMcapUsd: 10_000,
  minHolders: 20,
  maxBundlersHeldPct: 10,
  minFeesSol: 0.2,
  maxDevPct: 10,
  minSocials: 1,
  maxBundlersBoughtPct: 30,
  maxDevMints: 3,
  maxTop10Pct: 35,
  maxMcapUsd: 3_000_000,
  minLiquidityUsd: 5_000,
  maxRoundTripPct: 0.06,
  requireSolQuote: true,
  minUtilityScore: 1,
  minOrganicScore: 25,
  requireApproval: false,
  minBuySellRatio5m: 1.1,
  minTraders5m: 8,
  maxPriceChange5mPct: 60,
  minPriceChange1hPct: 0,
  riskPerTrade: 0.01,
  stopPct: 0.3,
  takeProfitAt: 1,
  takeProfitFraction: 0.5,
  trailActivateAt: 0.5,
  trailPct: 0.35,
  timeStopHours: 6,
  timeStopMinGain: 0.2,
  liquidityCollapsePct: 0.6,
  maxPositions: 5,
  maxPositionPctOfLiquidity: 0.01,
  maxForensicsPerPass: 6,
}

export interface WindowStats {
  buyVolume?: number
  sellVolume?: number
  numTraders?: number
  priceChange?: number
}

export interface LaunchCandidate {
  mint: string
  symbol: string
  name: string
  description: string
  ageMin: number
  mcapUsd: number
  liquidityUsd: number
  holders: number
  devPct: number | null
  devMints: number | null
  top10Pct: number | null
  /** Jupiter's organic score, null when not reported. */
  organicScore: number | null
  socials: { twitter?: string; telegram?: string; website?: string }
  solQuoted: boolean
  graduated: boolean
  authoritiesRevoked: boolean
  stats5m: WindowStats
  stats1h: WindowStats
  chain: LaunchChainStats | null
  /** familiars agents that have traded it (the board's own flow). */
  boardAgents: number
}

export interface Verdict {
  pass: boolean
  reasons: string[]
}

export function socialCount(c: Pick<LaunchCandidate, 'socials'>): number {
  return [c.socials.twitter, c.socials.telegram, c.socials.website].filter(Boolean).length
}

/** Filters that need no on-chain forensics. */
export function screenCheap(c: LaunchCandidate, p: LaunchParams): Verdict {
  const r: string[] = []
  if (c.ageMin > p.maxAgeMin) r.push(`age ${Math.round(c.ageMin)}m > ${p.maxAgeMin}m`)
  if (c.mcapUsd < p.minMcapUsd) r.push(`mcap $${Math.round(c.mcapUsd)} < $${p.minMcapUsd}`)
  if (c.mcapUsd > p.maxMcapUsd) r.push(`mcap $${Math.round(c.mcapUsd)} > $${p.maxMcapUsd}`)
  if (c.holders < p.minHolders) r.push(`${c.holders} holders < ${p.minHolders}`)
  if (c.devPct !== null && c.devPct > p.maxDevPct) r.push(`dev holds ${c.devPct.toFixed(1)}%`)
  if (c.devMints !== null && c.devMints > p.maxDevMints) r.push(`dev has minted ${c.devMints} tokens`)
  if (c.top10Pct !== null && c.top10Pct > p.maxTop10Pct) r.push(`top 10 hold ${c.top10Pct.toFixed(0)}%`)
  if (socialCount(c) < p.minSocials) r.push('no socials')
  if (p.requireSolQuote && !c.solQuoted) r.push('not quoted in SOL')
  if (!c.authoritiesRevoked) r.push('mint/freeze authority active')
  if (c.liquidityUsd < p.minLiquidityUsd) r.push(`liquidity $${Math.round(c.liquidityUsd)}`)
  if ((c.organicScore ?? 0) < p.minOrganicScore) r.push(`organic score ${(c.organicScore ?? 0).toFixed(0)} < ${p.minOrganicScore} (bot activity)`)
  return { pass: r.length === 0, reasons: r }
}

/** Filters that need the on-chain forensics (bundle, fees, verified dev share). */
export function screenChain(c: LaunchCandidate, p: LaunchParams): Verdict {
  const r: string[] = []
  const ch = c.chain
  if (!ch) return { pass: false, reasons: ['on-chain analysis missing'] }
  if (ch.bundleHeldPct === null || ch.bundleBoughtPct === null) r.push('launch bundle could not be verified')
  else {
    if (ch.bundleHeldPct > p.maxBundlersHeldPct) r.push(`bundlers still hold ${ch.bundleHeldPct.toFixed(1)}%`)
    if (ch.bundleBoughtPct > p.maxBundlersBoughtPct) r.push(`bundle bought ${ch.bundleBoughtPct.toFixed(0)}% at launch`)
  }
  if (ch.feesSol < p.minFeesSol) r.push(`fees paid ≈${ch.feesSol.toFixed(2)} SOL < ${p.minFeesSol}`)
  if (ch.devHeldPct !== null && ch.devHeldPct > p.maxDevPct) r.push(`dev holds ${ch.devHeldPct.toFixed(1)}% on chain`)
  return { pass: r.length === 0, reasons: r }
}

const SOCIAL_HOSTS = /(^|\.)(x\.com|twitter\.com|t\.me|telegram\.me|instagram\.com|tiktok\.com|youtube\.com|youtu\.be|pump\.fun|dexscreener\.com|linktr\.ee|facebook\.com|reddit\.com|github\.com)$/i
/** Pages on big platforms are not a project's own site (a common impersonation trick). */
const BIG_PLATFORMS = /(^|\.)(amazon|ebay|etsy|walmart|wikipedia|google|apple|microsoft|nytimes|cnn|bbc|reuters|bloomberg|forbes|yahoo|medium|coinmarketcap|coingecko|binance|coinbase|openai|anthropic|nasa|whitehouse|tesla|spacex|nike|starbucks|netflix|disney)\.[a-z.]+$/i
/** Accounts that launches borrow to look legitimate. */
const FAMOUS_HANDLES = new Set(
  ['mrbeast', 'elonmusk', 'realdonaldtrump', 'potus', 'whitehouse', 'starbucks', 'nike', 'cz_binance', 'binance', 'coinbase', 'vitalikbuterin', 'saylor', 'openai', 'anthropicai', 'google', 'apple', 'tesla', 'spacex', 'nasa', 'youtube', 'netflix', 'amazon', 'microsoft', 'meta', 'solana', 'pumpdotfun', 'jupiterexchange', 'toly', 'aeyakovenko', 'kanyewest', 'kimkardashian', 'drake', 'snoopdogg', 'taylorswift13', 'cristiano', 'nfl', 'nba'],
)
const UTILITY_WORDS = /\b(ai|agent|agents|protocol|platform|app|tool|tools|bot|sdk|api|open[- ]source|github|dapp|defi|infra|infrastructure|analytics|wallet|payments?|marketplace|launchpad|terminal|dashboard|game|beta|mainnet|testnet|users|product|network|oracle|bridge|staking|dex)\b/i
const RED_FLAGS = /\b(100x|1000x|moon(ing)?|guaranteed|no utility|just a meme|pure meme|free money|next (pepe|bonk|doge)|pump it|send it|to the moon|rug|airdrop claim)\b/i
const BRANDS = /^(github|youtube|google|apple|microsoft|nike|nfl|nba|openai|chatgpt|anthropic|claude|tesla|spacex|amazon|meta|netflix|x|twitter|solana|binance|coinbase|starbucks|mrbeast)$/i

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '')

/** True when an X handle plausibly belongs to this token (shares its name or ticker). */
function handleMatches(handle: string, name: string, symbol: string): boolean {
  const h = norm(handle)
  return [norm(symbol), norm(name)].some((k) => k.length >= 3 && (h.includes(k) || (h.length >= 4 && k.includes(h))))
}

/**
 * A rough prior for "is there something behind it": the project's own site and
 * account, code, a product description. Links to famous accounts or big
 * platforms count against it: borrowing a real brand is a classic launch scam.
 * Deliberately simple and transparent; the routine's reviewer can veto on top.
 */
export function utilityScore(c: Pick<LaunchCandidate, 'socials' | 'description' | 'name' | 'symbol'>): { score: number; notes: string[] } {
  const notes: string[] = []
  let score = 0
  const site = c.socials.website ? host(c.socials.website) : ''
  if (site && BIG_PLATFORMS.test(site)) {
    score -= 2
    notes.push(`links ${site}, not its own site`)
  } else if (site && !SOCIAL_HOSTS.test(site)) {
    score++
    notes.push(`own site ${site}`)
  }
  const repo = [c.socials.website ?? '', c.description ?? ''].join(' ').match(/github\.com\/[\w.-]+\/[\w.-]+/i)
  if (repo) {
    score++
    notes.push(`code at ${repo[0]}`)
  }
  const tw = c.socials.twitter ?? ''
  const handle = /^https?:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?(?:\?.*)?$/i.exec(tw)?.[1]
  if (handle && FAMOUS_HANDLES.has(handle.toLowerCase())) {
    score -= 2
    notes.push(`borrows @${handle}`)
  } else if (handle && handleMatches(handle, c.name, c.symbol)) {
    score++
    notes.push(`project X account @${handle}`)
  } else if (handle) {
    notes.push(`X account @${handle} does not match the token`)
  } else if (/\/i\/communities\//i.test(tw)) {
    notes.push('X community')
  } else if (/\/status\//i.test(tw)) {
    notes.push('links a tweet, not an account')
  }
  if (c.socials.telegram) {
    score++
    notes.push('telegram')
  }
  const desc = (c.description ?? '').trim()
  if (desc.length >= 60 && UTILITY_WORDS.test(desc)) {
    score++
    notes.push('describes a product')
  }
  if (RED_FLAGS.test(desc)) {
    score -= 2
    notes.push('hype red flags in description')
  }
  if (BRANDS.test(c.name.trim()) || BRANDS.test(c.symbol.trim())) {
    score -= 2
    notes.push('borrows a big brand name')
  }
  return { score, notes }
}

/** Buyers in control right now, without chasing a vertical candle. */
export function momentum(c: LaunchCandidate, p: LaunchParams): { ok: boolean; ratio: number; reasons: string[] } {
  const buys = c.stats5m.buyVolume ?? 0
  const sells = c.stats5m.sellVolume ?? 0
  const ratio = buys / Math.max(sells, 1)
  const r: string[] = []
  if (ratio < p.minBuySellRatio5m) r.push(`5m buys/sells ${ratio.toFixed(2)}`)
  if ((c.stats5m.numTraders ?? 0) < p.minTraders5m) r.push(`${c.stats5m.numTraders ?? 0} traders in 5m`)
  if ((c.stats5m.priceChange ?? 0) > p.maxPriceChange5mPct) r.push(`+${(c.stats5m.priceChange ?? 0).toFixed(0)}% in 5m, too vertical`)
  if ((c.stats1h.priceChange ?? 0) < p.minPriceChange1hPct) r.push(`1h ${(c.stats1h.priceChange ?? 0).toFixed(0)}%`)
  return { ok: r.length === 0, ratio, reasons: r }
}

export function rankScore(c: LaunchCandidate, utility: number, ratio: number): number {
  return utility + 2 * Math.log(Math.max(ratio, 0.1)) + Math.log1p(c.stats5m.numTraders ?? 0) / 2 + Math.min(c.boardAgents, 10) * 0.5
}

// --- exits -------------------------------------------------------------------------

export interface LaunchPosition {
  entryPrice: number
  entryTimeMs: number
  highWater: number
  tpDone: boolean
  entryLiquidityUsd?: number
}

export type LaunchAction =
  | { action: 'hold'; highWater: number }
  | { action: 'sell_all'; reason: string; highWater: number }
  | { action: 'take_profit'; fraction: number; reason: string; highWater: number }

export function launchExit(pos: LaunchPosition, price: number, liquidityUsd: number | null, nowMs: number, p: LaunchParams): LaunchAction {
  const highWater = Math.max(pos.highWater, price)
  const e = pos.entryPrice
  if (price <= e * (1 - p.stopPct)) return { action: 'sell_all', reason: `stop loss −${Math.round(p.stopPct * 100)}%`, highWater }
  if (liquidityUsd !== null && pos.entryLiquidityUsd && liquidityUsd < pos.entryLiquidityUsd * (1 - p.liquidityCollapsePct)) {
    return { action: 'sell_all', reason: 'liquidity collapsed', highWater }
  }
  if (!pos.tpDone && price >= e * (1 + p.takeProfitAt)) {
    return { action: 'take_profit', fraction: p.takeProfitFraction, reason: `took ${Math.round(p.takeProfitFraction * 100)}% off at ${(price / e).toFixed(1)}x`, highWater }
  }
  if (highWater >= e * (1 + p.trailActivateAt) && price <= highWater * (1 - p.trailPct)) {
    return { action: 'sell_all', reason: `trailing stop ${Math.round(p.trailPct * 100)}% below the high`, highWater }
  }
  if (nowMs - pos.entryTimeMs >= p.timeStopHours * 3.6e6 && price < e * (1 + p.timeStopMinGain)) {
    return { action: 'sell_all', reason: `time stop: ${p.timeStopHours}h without a +${Math.round(p.timeStopMinGain * 100)}% move`, highWater }
  }
  return { action: 'hold', highWater }
}

/**
 * Rebuilds a launch position's high-water mark from candles after entry and
 * reports a stop that fired while nothing was running.
 */
export function replayLaunch(candles: Candle[], entryTimeSec: number, entryPrice: number, p: LaunchParams): { highWater: number; exitReason?: string; takeProfitDue: boolean } {
  let highWater = entryPrice
  let takeProfitDue = false
  for (const bar of candles) {
    if (bar.t < entryTimeSec) continue
    if (bar.l <= entryPrice * (1 - p.stopPct)) return { highWater, exitReason: 'stop loss hit while offline', takeProfitDue }
    if (highWater >= entryPrice * (1 + p.trailActivateAt) && bar.l <= highWater * (1 - p.trailPct)) {
      return { highWater, exitReason: 'trailing stop hit while offline', takeProfitDue }
    }
    highWater = Math.max(highWater, bar.h)
    if (highWater >= entryPrice * (1 + p.takeProfitAt)) takeProfitDue = true
  }
  return { highWater, takeProfitDue }
}

/** Compact, public record of what the agent saw at entry, used to learn later. */
export function featureTag(c: LaunchCandidate, utility: number): string {
  const ch = c.chain
  const f = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? '-' : x.toFixed(d))
  return `[mc=${Math.round(c.mcapUsd / 1000)}k h=${c.holders} bh=${f(ch?.bundleHeldPct)} bb=${f(ch?.bundleBoughtPct, 0)} d=${f(c.devPct)} fee=${f(ch?.feesSol, 2)} age=${Math.round(c.ageMin)} u=${utility} ag=${c.boardAgents} o=${f(c.organicScore, 0)}]`
}

export function parseFeatureTag(text: string): Record<string, number> | null {
  const m = /\[mc=([^\]]+)\]/.exec(text)
  if (!m) return null
  const out: Record<string, number> = {}
  for (const part of `mc=${m[1]}`.split(/\s+/)) {
    const [k, v] = part.split('=')
    if (!k || v === undefined || v === '-') continue
    const n = Number(v.replace(/k$/, ''))
    if (Number.isFinite(n)) out[k] = v.endsWith('k') ? n * 1000 : n
  }
  return out
}
