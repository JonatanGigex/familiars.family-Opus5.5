import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseEnvFile } from './config.js'

/**
 * Adds keys to the secrets file (mode 0600). Existing keys are never
 * overwritten: losing a wallet key or an API key shown once is unrecoverable.
 */
export function appendSecrets(path: string, values: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '# familiars agent secrets. Never commit or share this file.\n'
  const existing = parseEnvFile(current)
  let out = current.endsWith('\n') ? current : `${current}\n`
  for (const [k, v] of Object.entries(values)) {
    if (existing[k] !== undefined) throw new Error(`${k} already exists in ${path}; refusing to overwrite it`)
    out += `${k}=${v}\n`
  }
  writeFileSync(path, out, { mode: 0o600 })
  chmodSync(path, 0o600)
}
