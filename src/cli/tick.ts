import { tick } from '../agent.js'
import { bootstrap } from '../bootstrap.js'
import { log } from '../log.js'
import { saveState } from '../state.js'

// One pass: manage exits, look for entries, post. Safe to run from cron.

const { cfg, state, deps } = bootstrap()
try {
  const report = await tick(deps, state)
  log.info('tick', report)
} finally {
  saveState(cfg.statePath, state)
}
