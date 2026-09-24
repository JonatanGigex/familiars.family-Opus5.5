import { parseArgs } from 'node:util'
import {
  DEFAULT_PORTFOLIO,
  DEFAULT_ROTATION,
  holdReturn,
  monteCarlo,
  loadResearchDir,
  runBacktest,
  runRotation,
  type BacktestResult,
  type Instrument,
  type PortfolioParams,
  type RotationParams,
} from '../backtest.js'
import { loadParams } from '../bootstrap.js'
import { SOL_MINT } from '../jupiter.js'
import { DEFAULT_PARAMS, type StrategyParams } from '../strategy.js'

// Usage: npm run backtest -- --data data/ohlcv [--oos 0.4] [--trades] [--only name]
// The data dir holds one JSON per token: { mint, sym, hour1: [[t,o,h,l,c,v], ...] }.

const { values } = parseArgs({
  options: {
    data: { type: 'string', default: 'data/ohlcv' },
    oos: { type: 'string', default: '0.4' },
    trades: { type: 'boolean', default: false },
    only: { type: 'string' },
    family: { type: 'string' },
    montecarlo: { type: 'boolean', default: false },
  },
})

type Variant =
  | { family: 'trend'; name: string; sp: Partial<StrategyParams>; pp?: Partial<PortfolioParams> }
  | { family: 'rotation'; name: string; rp: Partial<RotationParams>; pp?: Partial<PortfolioParams>; solOnly?: boolean }

const H4 = { barHours: 4, changeBars: 6, breakoutLookback: 20, volumeLookback: 20, emaFast: 20, emaSlow: 50, timeStopBars: 18 }
const configured = loadParams()
const VARIANTS: Variant[] = [
  {
    family: 'trend',
    name: 'configured',
    sp: configured.strategy,
    pp: { maxPositions: configured.risk.maxPositions, riskPerTrade: configured.risk.riskPerTrade, maxPositionPct: configured.risk.maxPositionPct, cooldownBars: 2 },
  },
  { family: 'trend', name: '1h-breakout', sp: { setups: ['breakout'] } },
  { family: 'trend', name: '1h-breakout-loose', sp: { setups: ['breakout'], trailStartR: 2, trailAtr: 4, stopAtr: 2.5, trendExit: false } },
  { family: 'trend', name: '4h-breakout', sp: { ...H4, setups: ['breakout'] }, pp: { cooldownBars: 2 } },
  { family: 'trend', name: '4h-breakout+regime', sp: { ...H4, setups: ['breakout'], regimeEma: 50 }, pp: { cooldownBars: 2 } },
  { family: 'trend', name: '4h-breakout-loose', sp: { ...H4, setups: ['breakout'], trailStartR: 2, trailAtr: 4, stopAtr: 2.5, maxStopPct: 0.2, trendExit: false }, pp: { cooldownBars: 2 } },
  { family: 'trend', name: '4h-brk-loose+regime', sp: { ...H4, setups: ['breakout'], trailStartR: 2, trailAtr: 4, stopAtr: 2.5, maxStopPct: 0.2, trendExit: false, regimeEma: 50 }, pp: { cooldownBars: 2 } },
  { family: 'trend', name: '4h-both-loose', sp: { ...H4, setups: ['breakout', 'pullback'], trailStartR: 2, trailAtr: 4, stopAtr: 2.5, maxStopPct: 0.2, trendExit: false }, pp: { cooldownBars: 2 } },
  { family: 'rotation', name: 'rot-7d-top3', rp: {} },
  { family: 'rotation', name: 'rot-7d-top3-noregime', rp: { regimeEmaHours: 0 } },
  { family: 'rotation', name: 'rot-3d-top3', rp: { lookbackHours: 72 } },
  { family: 'rotation', name: 'rot-14d-top3', rp: { lookbackHours: 336 } },
  { family: 'rotation', name: 'rot-7d-top2', rp: { topK: 2 } },
  { family: 'rotation', name: 'rot-7d-top5', rp: { topK: 5 } },
  { family: 'rotation', name: 'rot-7d-riskadj', rp: { riskAdjusted: true } },
  { family: 'rotation', name: 'rot-7d-12h', rp: { rebalanceHours: 12 } },
  { family: 'rotation', name: 'rot-7d-tight-stops', rp: { stopLossPct: 0.1, trailingPct: 0.15 } },
  { family: 'rotation', name: 'sol-trend-10d', rp: { topK: 1, trendEmaHours: 240, regimeEmaHours: 0, lookbackHours: 24 }, solOnly: true },
  { family: 'rotation', name: 'sol-trend-20d', rp: { topK: 1, trendEmaHours: 480, regimeEmaHours: 0, lookbackHours: 24 }, solOnly: true },
]

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a')

const all = loadResearchDir(values.data!)
const sol = all.find((x) => x.mint === SOL_MINT)
if (!all.length) throw new Error(`no data in ${values.data}`)
const times = [...new Set(all.flatMap((x) => x.candles.map((c) => c.t)))].sort((a, b) => a - b)
const start = times[0]!
const end = times[times.length - 1]! + 3600
// First 500 hours are warm-up only, then split in-sample / out-of-sample.
const testStart = start + 500 * 3600
const rawSplit = testStart + Math.floor((end - testStart) * (1 - Number(values.oos)))
const split = rawSplit - (rawSplit % (24 * 3600))
const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ')

console.log(`instruments: ${all.length}   test: ${iso(testStart)} -> ${iso(end)}   split (IS|OOS): ${iso(split)}`)
if (sol) {
  console.log(`benchmark SOL hold: full ${pct(holdReturn(sol.candles, testStart, end))}  IS ${pct(holdReturn(sol.candles, testStart, split))}  OOS ${pct(holdReturn(sol.candles, split, end))}`)
}
const ew = (a: number, b: number) => {
  const r = all.map((x) => holdReturn(x.candles, a, b)).filter(Number.isFinite)
  return r.reduce((s, x) => s + x, 0) / r.length
}
console.log(`benchmark equal-weight hold: full ${pct(ew(testStart, end))}  IS ${pct(ew(testStart, split))}  OOS ${pct(ew(split, end))}\n`)

function run(v: Variant, insts: Instrument[], range: { fromT?: number; toT?: number }): BacktestResult {
  const pp = { ...DEFAULT_PORTFOLIO, ...v.pp }
  if (v.family === 'trend') return runBacktest(insts, { ...DEFAULT_PARAMS, ...v.sp }, pp, { ...range, regime: sol?.candles })
  return runRotation(insts, { ...DEFAULT_ROTATION, ...v.rp }, pp, { ...range, regime: sol?.candles })
}

console.log('variant                  trades  win%    PF   avgW    avgL   return   maxDD  expo  sharpe |  IS ret  IS DD | OOS ret OOS DD OOS PF')
for (const v of VARIANTS) {
  if (values.only && v.name !== values.only) continue
  if (values.family && v.family !== values.family) continue
  const insts = v.family === 'rotation' && v.solOnly ? (sol ? [sol] : []) : all
  if (!insts.length) continue
  const full = run(v, insts, { fromT: testStart })
  const is = run(v, insts, { fromT: testStart, toT: split })
  const oos = run(v, insts, { fromT: split })
  console.log(
    `${v.name.padEnd(23)} ${String(full.trades.length).padStart(6)} ${pct(full.winRate).padStart(6)} ${full.profitFactor.toFixed(2).padStart(5)} ${pct(full.avgWin).padStart(6)} ${pct(full.avgLoss).padStart(7)} ${pct(full.totalReturn).padStart(8)} ${pct(full.maxDrawdown).padStart(7)} ${pct(full.exposure).padStart(5)} ${full.sharpe.toFixed(2).padStart(6)} | ${pct(is.totalReturn).padStart(7)} ${pct(is.maxDrawdown).padStart(6)} | ${pct(oos.totalReturn).padStart(7)} ${pct(oos.maxDrawdown).padStart(6)} ${oos.profitFactor.toFixed(2).padStart(6)}`,
  )
  if (values.trades) {
    for (const t of full.trades) console.log(`   ${iso(t.entryT)} ${t.sym.padEnd(10)} ${t.setup.padEnd(8)} ${pct(t.ret).padStart(7)} ${t.bars} bars  ${t.reason}`)
  }
  if (values.montecarlo && full.trades.length >= 20) {
    const perDay = full.trades.length / ((end - testStart) / 86400)
    for (const days of [30, 90]) {
      const mc = monteCarlo(full, Math.max(1, Math.round(perDay * days)))
      console.log(
        `   Monte Carlo ${days}d (~${mc.horizonTrades} trades): return p5 ${pct(mc.returns.p5)} | p25 ${pct(mc.returns.p25)} | median ${pct(mc.returns.p50)} | p75 ${pct(mc.returns.p75)} | p95 ${pct(mc.returns.p95)}; max DD median ${pct(mc.maxDrawdown.p50)}, p95 ${pct(mc.maxDrawdown.p95)}; P(loss) ${pct(mc.probLoss)}`,
      )
    }
  }
}
