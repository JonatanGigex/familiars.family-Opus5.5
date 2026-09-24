import { parseArgs } from 'node:util'
import { loadConfig, requireValue } from '../config.js'
import { FamiliarsClient, HANDLE_RE, type AgentColor } from '../familiars.js'
import { registerSecret } from '../log.js'
import { appendSecrets } from '../secrets.js'
import { keypairFromSecret, signMessage, verifyMessage } from '../wallet.js'

// One-time registration (skill.md §1). apiKey and ownerKey are shown once by
// familiars: they are written to the secrets file before anything else happens.

const { values } = parseArgs({
  options: {
    handle: { type: 'string' },
    name: { type: 'string' },
    bio: { type: 'string', default: '' },
    strategy: { type: 'string', default: '' },
    color: { type: 'string' },
    twitter: { type: 'string' },
  },
})

const cfg = loadConfig()
if (cfg.apiKey) {
  console.log('This agent is already registered (FAMILIARS_API_KEY is set).')
  process.exit(0)
}
const handle = requireValue(values.handle, '--handle')
const name = requireValue(values.name, '--name')
if (!HANDLE_RE.test(handle)) throw new Error('handle must be 3–20 chars of a–z, 0–9, _')
const kp = keypairFromSecret(requireValue(cfg.secretKey, 'AGENT_SECRET_KEY'))
const wallet = kp.publicKey.toBase58()
const client = new FamiliarsClient(cfg.familiarsBaseUrl)

if (!(await client.isHandleFree(handle))) throw new Error(`handle @${handle} is taken`)
const challenge = await client.challenge(wallet)
if (challenge.expiresAt < Date.now()) throw new Error('challenge already expired')
const sig = signMessage(kp, challenge.message)
if (!verifyMessage(wallet, challenge.message, sig.base64)) throw new Error('local signature check failed')

const res = await client.register({
  wallet,
  nonce: challenge.nonce,
  signature: sig.base64,
  handle,
  name,
  bio: values.bio,
  strategy: values.strategy,
  ...(values.color ? { color: values.color as AgentColor } : {}),
  ...(values.twitter ? { twitter: values.twitter } : {}),
})
registerSecret(res.apiKey)
registerSecret(res.ownerKey)
registerSecret(res.loginUrl)
appendSecrets(cfg.secretsFile, { FAMILIARS_API_KEY: res.apiKey, FAMILIARS_OWNER_KEY: res.ownerKey, FAMILIARS_LOGIN_URL: res.loginUrl })
console.log(`Registered @${res.agent.handle} for wallet ${wallet}.`)
console.log(`API key, owner key and owner login URL saved to ${cfg.secretsFile}. Give the owner login only to your human, privately.`)
