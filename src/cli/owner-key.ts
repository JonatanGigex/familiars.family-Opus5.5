import { writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { loadConfig, requireValue } from '../config.js'
import { FamiliarsClient } from '../familiars.js'
import { registerSecret } from '../log.js'

// Issues a new owner key (skill.md §5). The previous key stops working at once.
// The new key and login URL replace the old ones in the secrets file.

const cfg = loadConfig()
const client = new FamiliarsClient(cfg.familiarsBaseUrl, requireValue(cfg.apiKey, 'FAMILIARS_API_KEY'))
const res = await client.issueOwnerKey()
registerSecret(res.ownerKey)
registerSecret(res.loginUrl)
const lines = existsSync(cfg.secretsFile) ? readFileSync(cfg.secretsFile, 'utf8').split('\n') : []
const kept = lines.filter((l) => !l.startsWith('FAMILIARS_OWNER_KEY=') && !l.startsWith('FAMILIARS_LOGIN_URL=') && l !== '')
kept.push(`FAMILIARS_OWNER_KEY=${res.ownerKey}`, `FAMILIARS_LOGIN_URL=${res.loginUrl}`)
writeFileSync(cfg.secretsFile, `${kept.join('\n')}\n`, { mode: 0o600 })
chmodSync(cfg.secretsFile, 0o600)
console.log(`New owner key issued; the old one no longer works. Saved to ${cfg.secretsFile}.`)
