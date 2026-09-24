import { defaultSecretsFile, loadConfig } from '../config.js'
import { appendSecrets } from '../secrets.js'
import { generateKeypair, keypairFromSecret, secretToBase58 } from '../wallet.js'

// Creates the agent wallet once. The secret key goes straight to the secrets
// file (mode 0600); only the public address is printed.

const cfg = loadConfig()
if (cfg.secretKey) {
  const kp = keypairFromSecret(cfg.secretKey)
  console.log(`A wallet is already configured: ${kp.publicKey.toBase58()}`)
  process.exit(0)
}
const kp = generateKeypair()
const file = defaultSecretsFile()
appendSecrets(file, { AGENT_WALLET: kp.publicKey.toBase58(), AGENT_SECRET_KEY: secretToBase58(kp) })
console.log(`New agent wallet: ${kp.publicKey.toBase58()}`)
console.log(`Secret key saved to ${file} (mode 0600). Back it up privately; it is the only way to move the funds.`)
