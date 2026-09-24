import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireLock } from '../src/lock.js'

describe('acquireLock', () => {
  it('creates missing directories and releases cleanly', () => {
    const state = join(mkdtempSync(join(tmpdir(), 'lock-')), 'nested', 'agent.json')
    const lock = acquireLock(state)!
    expect(lock).not.toBeNull()
    lock.release()
    const again = acquireLock(state)
    expect(again).not.toBeNull()
    again!.release()
  })

  it('refuses a lock held by another live process', () => {
    const state = join(mkdtempSync(join(tmpdir(), 'lock-')), 'agent.json')
    // PID 1 is always alive in a container or on a host.
    writeFileSync(`${state}.lock`, JSON.stringify({ pid: 1, at: Date.now() }))
    expect(acquireLock(state)).toBeNull()
  })

  it('takes over a stale or orphaned lock', () => {
    const state = join(mkdtempSync(join(tmpdir(), 'lock-')), 'agent.json')
    writeFileSync(`${state}.lock`, JSON.stringify({ pid: 1, at: Date.now() - 60 * 60_000 }))
    const lock = acquireLock(state)
    expect(lock).not.toBeNull()
    lock!.release()
    writeFileSync(`${state}.lock`, JSON.stringify({ pid: 999_999_999, at: Date.now() }))
    expect(acquireLock(state)).not.toBeNull()
  })
})
