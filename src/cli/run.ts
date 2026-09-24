import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { tick } from '../agent.js'
import { bootstrap } from '../bootstrap.js'
import { errMsg, log } from '../log.js'
import { flushPosts } from '../poster.js'
import { saveState } from '../state.js'

// Runs ticks in a loop: `npm run run -- --interval 60 --minutes 55`.
// A lock file keeps two runners from trading the same state.

const { values } = parseArgs({
  options: {
    interval: { type: 'string', default: '60' },
    minutes: { type: 'string', default: '0' },
  },
})
const intervalMs = Math.max(20, Number(values.interval)) * 1000
const deadline = Number(values.minutes) > 0 ? Date.now() + Number(values.minutes) * 60_000 : Infinity

const { cfg, state, deps } = bootstrap()
const lock = `${cfg.statePath}.lock`

function lockHeld(): boolean {
  if (!existsSync(lock)) return false
  try {
    const { pid, at } = JSON.parse(readFileSync(lock, 'utf8')) as { pid: number; at: number }
    if (Date.now() - at > 10 * 60_000) return false
    process.kill(pid, 0)
    return pid !== process.pid
  } catch {
    return false
  }
}

if (lockHeld()) {
  log.error(`another runner holds ${lock}; exiting`)
  process.exit(1)
}
const heartbeat = () => writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }))
heartbeat()

let stopping = false
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info(`${sig} received; finishing the current tick`)
    stopping = true
  })
}

log.info(`runner started in ${cfg.mode} mode`, { intervalSec: intervalMs / 1000, until: Number.isFinite(deadline) ? new Date(deadline).toISOString() : 'forever' })
let failures = 0
while (!stopping && Date.now() < deadline) {
  const started = Date.now()
  try {
    const report = await tick(deps, state)
    failures = 0
    const interesting = report.actions.filter((a) => !a.startsWith('skip '))
    log.info(`equity $${report.equityUsd.toFixed(2)} cash $${report.cashUsd.toFixed(2)} positions ${report.positions.length}`, interesting.length ? interesting : undefined)
  } catch (e) {
    failures++
    log.error(`tick failed (${failures} in a row)`, { error: errMsg(e) })
  } finally {
    saveState(cfg.statePath, state)
    heartbeat()
  }
  // Back off when something upstream is down.
  const wait = intervalMs * Math.min(2 ** Math.max(0, failures - 1), 8) - (Date.now() - started)
  const until = Date.now() + Math.max(wait, 1000)
  while (!stopping && Date.now() < until && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000))
}
// Trade posts wait ~90s for familiars to index the swap: give them time to go out.
const posting = cfg.posting && deps.executor.live
const flushUntil = Date.now() + 3 * 60_000
while (posting && state.pendingPosts.length && Date.now() < flushUntil && !stopping) {
  await flushPosts(state, deps.fam, posting)
  saveState(cfg.statePath, state)
  if (state.pendingPosts.length) await new Promise((r) => setTimeout(r, 15_000))
}
rmSync(lock, { force: true })
log.info('runner stopped')
