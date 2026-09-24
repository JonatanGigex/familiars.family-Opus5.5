import { loadConfig } from '../config.js'
import { FamiliarsClient } from '../familiars.js'
import { errMsg } from '../log.js'
import { loadState } from '../state.js'
import { keypairFromSecret } from '../wallet.js'

// Read-only overview: wallet, owner limits, board position, local positions and trades.

const cfg = loadConfig()
const state = loadState(cfg.statePath)
const wallet = cfg.secretKey ? keypairFromSecret(cfg.secretKey).publicKey.toBase58() : null
console.log(`mode: ${cfg.mode}   posting: ${cfg.posting ? 'on' : 'off'}   state: ${cfg.statePath}`)
console.log(`wallet: ${wallet ?? 'not configured'}`)

if (cfg.apiKey) {
  const fam = new FamiliarsClient(cfg.familiarsBaseUrl, cfg.apiKey)
  try {
    const me = await fam.me()
    const agent = (me.agent ?? me) as { handle?: string }
    console.log(`familiars: @${agent.handle ?? '?'}   limits: ${JSON.stringify(me.settings)}`)
    if (agent.handle) {
      for (const range of ['24H', '7D', 'ALL'] as const) {
        const board = await fam.agents(range)
        const sorted = [...board].sort((a, b) => (b.pnl?.[range] ?? 0) - (a.pnl?.[range] ?? 0))
        const idx = sorted.findIndex((a) => a.handle === agent.handle)
        const me2 = sorted[idx]
        if (me2) console.log(`  ${range}: rank ${idx + 1}/${sorted.length}  P&L $${(me2.pnl?.[range] ?? 0).toFixed(2)}  equity $${(me2.equityUsd ?? 0).toFixed(2)}`)
      }
    }
  } catch (e) {
    console.log(`familiars: unavailable (${errMsg(e)})`)
  }
} else {
  console.log('familiars: not registered')
}

const positions = Object.values(state.positions)
console.log(`\npositions (${positions.length}):`)
for (const p of positions) {
  console.log(`  ${p.symbol.padEnd(10)} qty ${p.qty.toPrecision(6)}  entry ${p.entryPrice.toPrecision(5)}  stop ${p.stop.toPrecision(5)}  cost $${p.costUsd.toFixed(2)}  ${p.setup}  opened ${new Date(p.openedAt).toISOString()}`)
}
if (state.paper) console.log(`paper cash: $${state.paper.cashUsd.toFixed(2)}`)
console.log(`last tick: ${state.lastTickAt ? new Date(state.lastTickAt).toISOString() : 'never'}`)
console.log(`\nlast trades:`)
for (const t of state.trades.slice(-10)) {
  console.log(`  ${new Date(t.time).toISOString()} ${t.side.padEnd(4)} ${t.symbol.padEnd(10)} $${t.usd.toFixed(2)}${t.pnlUsd !== undefined ? `  pnl ${t.pnlUsd.toFixed(2)}` : ''}  ${t.reason}`)
}
console.log(`\npending posts: ${state.pendingPosts.length}`)
