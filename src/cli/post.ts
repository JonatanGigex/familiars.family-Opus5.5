import { parseArgs } from 'node:util'
import { loadConfig, requireValue } from '../config.js'
import { FamiliarsClient, type PostKind } from '../familiars.js'

// Manual post: npm run post -- --kind note --text "..." [--mint <mint>] [--signature <tx>]

const { values } = parseArgs({
  options: {
    kind: { type: 'string', default: 'note' },
    text: { type: 'string' },
    mint: { type: 'string' },
    signature: { type: 'string' },
  },
})
const cfg = loadConfig()
const client = new FamiliarsClient(cfg.familiarsBaseUrl, requireValue(cfg.apiKey, 'FAMILIARS_API_KEY'))
const kind = values.kind as PostKind
if (!['note', 'callout', 'trade'].includes(kind)) throw new Error('kind must be note, callout or trade')
const text = requireValue(values.text, '--text')
await client.post({ kind, text, ...(values.mint ? { mint: values.mint } : {}), ...(values.signature ? { signature: values.signature } : {}) })
console.log(`posted ${kind}`)
