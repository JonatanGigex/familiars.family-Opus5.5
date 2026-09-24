import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { loadParams } from '../bootstrap.js'
import { loadConfig } from '../config.js'
import { FamiliarsClient } from '../familiars.js'
import { JupiterClient } from '../jupiter.js'
import { DEFAULT_LAUNCH } from '../launch.js'
import { boardLesson, featureStats, outcomesFrom, suggest } from '../learn.js'
import { errMsg } from '../log.js'

// Daily review: what worked for this agent and for the board's best agents.
// Usage: npm run learn -- [--handle ballast] [--apply] [--post]
//   --apply  writes the (bounded) suggestions into config/agent.json
//   --post   posts a short "what I learned" note (needs FAMILIARS_API_KEY)

const { values } = parseArgs({ options: { handle: { type: 'string', default: 'ballast' }, apply: { type: 'boolean', default: false }, post: { type: 'boolean', default: false }, top: { type: 'string', default: '10' } } })
const cfg = loadConfig()
const params = loadParams()
const board = new FamiliarsClient(cfg.familiarsBaseUrl)
const jup = new JupiterClient(cfg.jupiterBaseUrl, cfg.jupiterApiKey)

// 1) Our own outcomes.
const me = await board.agent(values.handle!)
const outcomes = outcomesFrom(me)
const closed = outcomes.filter((o) => o.closed)
const wins = closed.filter((o) => o.pnlPct > 0)
console.log(`@${values.handle}: ${outcomes.length} tagged launch trades, ${closed.length} closed, ${wins.length} winners`)
for (const o of outcomes.slice(0, 15)) {
  console.log(`  ${o.symbol.padEnd(10)} ${(o.pnlPct * 100).toFixed(0).padStart(5)}%  cost $${o.costUsd.toFixed(2)}  ${o.closed ? 'closed' : 'open'}  ${JSON.stringify(o.features)}`)
}
for (const f of featureStats(outcomes)) {
  if (Number.isFinite(f.winnersMedian) || Number.isFinite(f.losersMedian)) console.log(`  feature ${f.feature.padEnd(4)} winners' median ${f.winnersMedian}  losers' median ${f.losersMedian}`)
}

// 2) The board's best agents.
const top = (await board.agents('7D')).filter((a) => a.handle !== values.handle && (a.trades ?? 0) > 0).sort((a, b) => (b.pnl['7D'] ?? 0) - (a.pnl['7D'] ?? 0)).slice(0, Number(values.top))
const details = []
for (const a of top) {
  try {
    details.push(await board.agent(a.handle))
  } catch (e) {
    console.log(`  @${a.handle}: unavailable (${errMsg(e)})`)
  }
}
const mints = [...new Set(details.flatMap((d) => d.trades.map((t) => t.token.mint)))]
const created = new Map<string, number>()
try {
  for (const t of await jup.tokens(mints)) {
    const at = Date.parse(t.firstPool?.createdAt ?? '')
    if (Number.isFinite(at)) created.set(t.id, at)
  }
} catch (e) {
  console.log(`token creation times unavailable (${errMsg(e)})`)
}
console.log(`\nboard's top ${details.length} by 7-day P&L:`)
for (const d of details) {
  const l = boardLesson(d, (m) => created.get(m))
  console.log(`  @${l.handle.padEnd(16)} P&L $${l.pnlUsd.toFixed(0).padStart(6)}  buys ${String(l.buys).padStart(3)}  of tokens <=120m old ${String(l.youngBuys).padStart(3)}  median token age at buy ${l.medianAgeAtBuyMin ?? '-'}m  winners ${l.winners.slice(0, 4).join(', ') || '-'}  strategy ${JSON.stringify(d.agent.strategy)}`)
}

// 3) Bounded suggestions: the owner's filters are hard limits.
const suggestions = suggest(outcomes, params.launch, DEFAULT_LAUNCH)
console.log(`\nsuggestions (${suggestions.length}):${suggestions.length ? '' : ` none yet, needs 20 closed trades with at least 5 winners and 5 losers (have ${closed.length})`}`)
for (const s of suggestions) console.log(`  ${s.param}: ${s.from} -> ${s.to}  (${s.why})`)

if (values.apply && suggestions.length) {
  const path = resolve(process.env.AGENT_PARAMS ?? 'config/agent.json')
  const file = JSON.parse(readFileSync(path, 'utf8')) as { launch?: Record<string, unknown> }
  file.launch ??= {}
  for (const s of suggestions) file.launch[s.param] = s.to
  const log = (file.launch.$learned as unknown[] | undefined) ?? []
  log.push({ at: new Date().toISOString(), closedTrades: closed.length, changes: suggestions })
  file.launch.$learned = log.slice(-20)
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  console.log(`applied to ${path}`)
}

if (values.post && cfg.apiKey) {
  const lead = suggestions.length
    ? `Tightened ${suggestions.map((s) => `${s.param} ${s.from}→${s.to}`).join(', ')} (${suggestions[0]!.why}).`
    : `No filter changes yet: ${closed.length} closed launch trades, learning needs 20.`
  const text = `Daily review: ${closed.length} closed launch trades, ${wins.length} winners. ${lead} The board's best buy tokens at a median age of ${median(details.map((d) => boardLesson(d, (m) => created.get(m)).medianAgeAtBuyMin).filter((x): x is number => x !== null)) ?? '-'}m.`
  await new FamiliarsClient(cfg.familiarsBaseUrl, cfg.apiKey).post({ kind: 'note', text: text.slice(0, 500) })
  console.log('posted the daily review note')
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}
