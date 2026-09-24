import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { loadParams } from '../bootstrap.js'
import { HttpError, requestJson } from '../http.js'
import { SOL_MINT } from '../jupiter.js'
import { errMsg } from '../log.js'
import { bestPairs } from '../market.js'

// Downloads hourly OHLCV for the core universe (plus SOL for the regime filter)
// from GeckoTerminal, paging back in time. The public API allows ~30 calls/min.
// Usage: npm run fetch-data -- --out data/ohlcv --bars 4000

const { values } = parseArgs({ options: { out: { type: 'string', default: 'data/ohlcv' }, bars: { type: 'string', default: '4000' } } })
const out = values.out!
const target = Number(values.bars)
mkdirSync(out, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const mints = [SOL_MINT, ...loadParams().coreMints.filter((m) => m !== SOL_MINT)]
const pairs = await bestPairs(mints)
for (const mint of mints) {
  const file = join(out, `${mint}.json`)
  const pair = pairs[mint]
  if (existsSync(file) || !pair) continue
  const rows: number[][] = []
  let before: number | null = null
  while (rows.length < target) {
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pair.pairAddress}/ohlcv/hour?aggregate=1&limit=1000&currency=usd&token=${mint}${before ? `&before_timestamp=${before}` : ''}`
    let page: number[][] = []
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const res = await requestJson<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(url, { retries: 0 })
        page = res?.data?.attributes?.ohlcv_list ?? []
        break
      } catch (e) {
        const wait = e instanceof HttpError && e.status === 429 ? 20_000 * (attempt + 1) : 4_000 * (attempt + 1)
        console.error(`  ${errMsg(e).slice(0, 60)}; retry in ${wait / 1000}s`)
        await sleep(wait)
      }
    }
    await sleep(2500)
    if (!page.length) break
    rows.push(...page)
    before = Math.min(...page.map((r) => r[0]!))
    if (page.length < 1000) break
  }
  writeFileSync(file, JSON.stringify({ mint, sym: pair.symbol, pair: pair.pairAddress, dex: pair.dexId, hour1: rows }))
  console.log(`${mint}: ${rows.length} hourly bars`)
}
