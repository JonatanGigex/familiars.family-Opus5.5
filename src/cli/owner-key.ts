import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadConfig, requireValue } from '../config.js'
import { FamiliarsClient } from '../familiars.js'
import { registerSecret } from '../log.js'

// Issues a new owner key (skill.md §5). The previous key stops working at once,
// so the secrets file is checked for writability before asking for a new one.

const cfg = loadConfig()
const client = new FamiliarsClient(cfg.familiarsBaseUrl, requireValue(cfg.apiKey, 'FAMILIARS_API_KEY'))
const file = cfg.secretsFile

mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
closeSync(openSync(file, 'a', 0o600))
if (process.env.FAMILIARS_OWNER_KEY || process.env.FAMILIARS_LOGIN_URL) {
  console.warn('Note: FAMILIARS_OWNER_KEY / FAMILIARS_LOGIN_URL are set in the environment and would hide the new values in the file; update them too.')
}

const res = await client.issueOwnerKey()
registerSecret(res.ownerKey)
registerSecret(res.loginUrl)
try {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []
  const kept = lines.filter((l) => !l.startsWith('FAMILIARS_OWNER_KEY=') && !l.startsWith('FAMILIARS_LOGIN_URL=') && l !== '')
  kept.push(`FAMILIARS_OWNER_KEY=${res.ownerKey}`, `FAMILIARS_LOGIN_URL=${res.loginUrl}`)
  writeFileSync(file, `${kept.join('\n')}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  console.log(`New owner key issued; the old one no longer works. Saved to ${file}.`)
} catch (e) {
  // The old key is already revoked: losing the new one would lock the owner out.
  // Printing it to the operator's own terminal is the lesser evil.
  console.error(`Could not save the new owner key (${e instanceof Error ? e.message : String(e)}).`)
  process.stdout.write(`Owner login URL (store it now, it is shown only here): ${res.loginUrl}\n`)
  process.exitCode = 1
}
