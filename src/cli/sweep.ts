import { parseArgs } from 'node:util'
import { DEFAULT_PORTFOLIO, loadResearchDir, runBacktest, type PortfolioParams } from '../backtest.js'
import { SOL_MINT } from '../jupiter.js'
import { DEFAULT_PARAMS, type StrategyParams } from '../strategy.js'
import { loadParams } from '../bootstrap.js'

// Robustness check: how do neighbours of the configured strategy behave?
// A setting worth trading should stay positive when its knobs move a little.
// Usage: npm run sweep -- --data data/ohlcv

const { values } = parseArgs({ options: { data: { type: 'string', default: 'data/ohlcv' }, oos: { type: 'string', default: '0.4' } } })
const all = loadResearchDir(values.data!)
const sol = all.find((x) => x.mint === SOL_MINT)
const times = [...new Set(all.flatMap((x) => x.candles.map((c) => c.t)))].sort((a, b) => a - b)
const testStart = times[0]! + 500 * 3600
const end = times[times.length - 1]! + 3600
const rawSplit = testStart + Math.floor((end - testStart) * (1 - Number(values.oos)))
const split = rawSplit - (rawSplit % 86400)

const configured = loadParams()
const base: StrategyParams = { ...DEFAULT_PARAMS, ...configured.strategy }
const basePp: PortfolioParams = {
  ...DEFAULT_PORTFOLIO,
  maxPositions: configured.risk.maxPositions,
  riskPerTrade: configured.risk.riskPerTrade,
  maxPositionPct: configured.risk.maxPositionPct,
  cooldownBars: 2,
}

const grid: Record<string, unknown[]> = {
  trailAtr: [3, 4, 5],
  stopAtr: [2, 2.5, 3],
  breakoutLookback: [10, 20, 30],
  minVolumeRatio: [1.2, 1.5, 2],
  trailStartR: [1.5, 2, 3],
  maxStopPct: [0.15, 0.2, 0.25],
  timeStopBars: [12, 18, 30],
  trendExit: [false, true],
  regimeEma: [0, 30, 50, 100],
  riskPerTrade: [0.01, 0.015, 0.02],
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const row = (label: string, sp: StrategyParams, pp: PortfolioParams) => {
  const full = runBacktest(all, sp, pp, { fromT: testStart, regime: sol?.candles })
  const is = runBacktest(all, sp, pp, { fromT: testStart, toT: split, regime: sol?.candles })
  const oos = runBacktest(all, sp, pp, { fromT: split, regime: sol?.candles })
  console.log(
    `${label.padEnd(28)} trades ${String(full.trades.length).padStart(4)}  PF ${full.profitFactor.toFixed(2)}  ret ${pct(full.totalReturn).padStart(7)}  DD ${pct(full.maxDrawdown).padStart(6)} | IS ${pct(is.totalReturn).padStart(7)} | OOS ${pct(oos.totalReturn).padStart(7)}`,
  )
  return full.totalReturn
}

console.log(`instruments ${all.length}; base = config/agent.json strategy\n`)
row('BASE', base, basePp)
const results: number[] = []
for (const [key, vals] of Object.entries(grid)) {
  for (const v of vals) {
    const sp = { ...base }
    const pp = { ...basePp }
    if (key in sp) (sp as unknown as Record<string, unknown>)[key] = v
    else (pp as unknown as Record<string, unknown>)[key] = v
    results.push(row(`${key}=${String(v)}`, sp, pp))
  }
}
const positive = results.filter((r) => r > 0).length
console.log(`\n${positive}/${results.length} one-at-a-time neighbours have a positive full-period return`)
