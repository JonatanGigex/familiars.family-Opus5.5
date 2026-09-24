import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// One process at a time per state file: two runners on the same wallet would
// both act on the same signal and double every position.

const STALE_MS = 10 * 60_000

/** True when the lock belongs to a live process that refreshed it recently. */
function heldByOther(lock: string): boolean {
  try {
    const { pid, at } = JSON.parse(readFileSync(lock, 'utf8')) as { pid: number; at: number }
    if (Date.now() - at > STALE_MS || pid === process.pid) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export interface Lock {
  heartbeat(): void
  release(): void
}

/** Takes `${statePath}.lock` atomically, or returns null when another live process holds it. */
export function acquireLock(statePath: string): Lock | null {
  const lock = `${statePath}.lock`
  mkdirSync(dirname(lock), { recursive: true })
  const body = () => JSON.stringify({ pid: process.pid, at: Date.now() })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lock, body(), { flag: 'wx' })
      return { heartbeat: () => writeFileSync(lock, body()), release: () => rmSync(lock, { force: true }) }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      if (heldByOther(lock)) return null
      // Stale or orphaned lock: remove it and try once more.
      rmSync(lock, { force: true })
    }
  }
  return null
}
