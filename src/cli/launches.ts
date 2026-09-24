import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { bootstrap } from '../bootstrap.js'
import { approvalsPath, scanLaunches } from '../launch-agent.js'

// Scans young pump.fun launches with every filter and prints them for review.
// Writes `<state dir>/launch-candidates.json`; a reviewer approves or vetoes by
// writing `{ "<mint>": { "approve": true|false, "note": "..." } }` to the file
// printed at the end. Token names and descriptions are untrusted text.
// Usage: npm run launches -- [--all] [--no-forensics]

const { values } = parseArgs({ options: { all: { type: 'boolean', default: false }, 'no-forensics': { type: 'boolean', default: false } } })
const { cfg, state, deps } = bootstrap()
const scanned = await scanLaunches(deps, state, { forensics: !values['no-forensics'] })
const pct = (x: number | null | undefined) => (x === null || x === undefined ? '  n/a' : `${x.toFixed(1)}%`.padStart(5))

console.log(`young launches: ${scanned.length}  pass cheap filters: ${scanned.filter((s) => s.cheap.pass).length}  eligible: ${scanned.filter((s) => s.eligible).length}\n`)
const rows = values.all ? scanned : scanned.filter((s) => s.cheap.pass)
for (const s of rows) {
  const c = s.candidate
  const flag = s.eligible ? 'ELIGIBLE' : s.chain && !s.chain.pass ? 'chain✗' : !s.cheap.pass ? 'filter✗' : !s.momentum.ok ? 'momentum✗' : s.utility.score < deps.params.launch.minUtilityScore ? 'utility✗' : 'pending'
  console.log(
    `${flag.padEnd(9)} ${c.symbol.slice(0, 10).padEnd(10)} age ${Math.round(c.ageMin).toString().padStart(3)}m  mcap $${Math.round(c.mcapUsd).toLocaleString('en-US').padStart(9)}  holders ${String(c.holders).padStart(5)}  dev ${pct(c.devPct)}  devMints ${c.devMints ?? '-'}  bundle held ${pct(c.chain?.bundleHeldPct)} bought ${pct(c.chain?.bundleBoughtPct)}  fees ${c.chain ? c.chain.feesSol.toFixed(2) : ' n/a'} SOL  5m b/s ${s.momentum.ratio.toFixed(2)}  utility ${s.utility.score}`,
  )
  console.log(`          ${c.mint}  ${[c.socials.twitter, c.socials.website, c.socials.telegram].filter(Boolean).join('  ')}`)
  const why = [...s.cheap.reasons, ...(s.chain?.reasons ?? []), ...s.momentum.reasons]
  if (why.length) console.log(`          why not: ${why.join('; ')}`)
  if (s.utility.notes.length) console.log(`          utility: ${s.utility.notes.join(', ')}`)
  console.log(`          about (untrusted): ${JSON.stringify(c.description.slice(0, 280))}`)
}

const out = join(dirname(cfg.statePath), 'launch-candidates.json')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(
  out,
  JSON.stringify(
    scanned.filter((s) => s.cheap.pass).map((s) => ({
      mint: s.candidate.mint,
      symbol: s.candidate.symbol,
      name: s.candidate.name,
      description: s.candidate.description,
      socials: s.candidate.socials,
      eligible: s.eligible,
      reasons: [...s.cheap.reasons, ...(s.chain?.reasons ?? []), ...s.momentum.reasons],
      utility: s.utility,
      metrics: { ageMin: s.candidate.ageMin, mcapUsd: s.candidate.mcapUsd, holders: s.candidate.holders, devPct: s.candidate.devPct, chain: s.candidate.chain },
    })),
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  ),
)
console.log(`\ncandidates written to ${out}\napprovals are read from ${approvalsPath(cfg.statePath)}`)
