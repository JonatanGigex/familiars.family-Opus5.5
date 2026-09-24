import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AgentDeps, AgentParams } from './agent.js'
import { loadConfig, type AppConfig } from './config.js'
import { LiveExecutor, PaperExecutor } from './executor.js'
import { FamiliarsClient } from './familiars.js'
import { JupiterClient, USDC_MINT } from './jupiter.js'
import { CandleSource } from './market.js'
import { DEFAULT_RISK } from './risk.js'
import { DEFAULT_SCREEN } from './screener.js'
import { SolanaClient } from './solana.js'
import { loadState, type AgentState } from './state.js'
import { DEFAULT_PARAMS } from './strategy.js'
import { keypairFromSecret } from './wallet.js'

interface ParamsFile {
  strategy?: Partial<AgentParams['strategy']>
  risk?: Partial<AgentParams['risk']>
  screen?: Partial<AgentParams['screen']>
  maxSwapLossPct?: number
  maxRoundTripPct?: number
  maxChasePct?: number
  maxCandidates?: number
  calloutsPerDay?: number
  coreMints?: string[]
}

export function loadParams(path = resolve(process.env.AGENT_PARAMS ?? 'config/agent.json')): AgentParams {
  const file: ParamsFile = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as ParamsFile) : {}
  return {
    strategy: { ...DEFAULT_PARAMS, ...file.strategy },
    risk: { ...DEFAULT_RISK, ...file.risk },
    screen: { ...DEFAULT_SCREEN, ...file.screen, denylist: [...DEFAULT_SCREEN.denylist, ...(file.screen?.denylist ?? [])] },
    maxSwapLossPct: file.maxSwapLossPct ?? 0.03,
    maxRoundTripPct: file.maxRoundTripPct ?? 0.015,
    maxChasePct: file.maxChasePct ?? 0.02,
    maxCandidates: file.maxCandidates ?? 25,
    calloutsPerDay: file.calloutsPerDay ?? 2,
    coreMints: file.coreMints ?? [],
  }
}

export function buildDeps(cfg: AppConfig = loadConfig(), state: AgentState): AgentDeps {
  const jup = new JupiterClient(cfg.jupiterBaseUrl, cfg.jupiterApiKey)
  const sol = new SolanaClient(cfg.rpcUrl)
  const fam = cfg.apiKey ? new FamiliarsClient(cfg.familiarsBaseUrl, cfg.apiKey) : null
  const candles = new CandleSource(cfg.cacheDir)
  const params = loadParams()
  if (cfg.mode === 'live') {
    if (!cfg.secretKey) throw new Error('TRADING_MODE=live needs AGENT_SECRET_KEY')
    if (!fam) throw new Error('TRADING_MODE=live needs FAMILIARS_API_KEY (owner limits must be readable)')
    const kp = keypairFromSecret(cfg.secretKey)
    return { cfg, jup, sol, fam, candles, executor: new LiveExecutor(jup, sol, kp), wallet: kp.publicKey.toBase58(), params }
  }
  if (!state.paper) {
    const start = Number(process.env.PAPER_START_USD ?? 1000)
    state.paper = { cashUsd: start, balances: {}, startUsd: start }
  }
  return { cfg, jup, sol, fam, candles, executor: new PaperExecutor(jup, state, USDC_MINT), wallet: null, params }
}

export function bootstrap(): { cfg: AppConfig; state: AgentState; deps: AgentDeps } {
  const cfg = loadConfig()
  const state = loadState(cfg.statePath)
  const deps = buildDeps(cfg, state)
  return { cfg, state, deps }
}
