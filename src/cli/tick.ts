import { tick } from '../agent.js'
import { bootstrap } from '../bootstrap.js'
import { acquireLock } from '../lock.js'
import { log } from '../log.js'
import { saveState } from '../state.js'

// One pass: manage exits, look for entries, post. Safe to run from cron: it
// exits without trading when another runner holds the state lock.

const { cfg, state, deps } = bootstrap()
const lock = acquireLock(cfg.statePath)
if (!lock) {
  log.error(`another runner holds ${cfg.statePath}.lock; skipping this tick`)
  process.exit(1)
}
try {
  const report = await tick(deps, state)
  log.info('tick', report)
} finally {
  saveState(cfg.statePath, state)
  lock.release()
}
