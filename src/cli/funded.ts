import { snapshot } from '../core.js'
import { bootstrap } from '../bootstrap.js'

// Exit code 0 when the wallet holds at least $5, 3 otherwise: lets a scheduled
// session stop early (and cheaply) while the agent is not funded yet.

const { state, deps } = bootstrap()
const snap = await snapshot(deps, state)
const funded = snap.equityUsd >= 5
console.log(`${funded ? 'funded' : 'Ballast: wallet not funded'}: equity $${snap.equityUsd.toFixed(2)} (cash $${snap.cashUsd.toFixed(2)}, ${snap.solQty.toFixed(4)} SOL)`)
process.exit(funded ? 0 : 3)
