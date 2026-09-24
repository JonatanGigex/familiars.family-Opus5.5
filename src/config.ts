import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { registerSecret } from './log.js'

export type TradingMode = 'paper' | 'live'

export interface AppConfig {
  familiarsBaseUrl: string
  jupiterBaseUrl: string
  jupiterApiKey?: string
  rpcUrl: string
  /** Base58 64-byte Solana secret key of the agent wallet. */
  secretKey?: string
  /** familiars agent API key (fam_…). */
  apiKey?: string
  mode: TradingMode
  /** Post to the public familiars feed. Off by default in paper mode. */
  posting: boolean
  statePath: string
  cacheDir: string
  secretsFile: string
}

/** Parses KEY=VALUE lines (dotenv subset). Quotes around values are stripped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

export function defaultSecretsFile(): string {
  return resolve(process.env.FAMILIARS_SECRETS_FILE ?? '.secrets/agent.env')
}

/**
 * Environment variables win; the secrets file only fills what is missing.
 * The file lives outside git (see .gitignore) and is written with mode 0600.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const secretsFile = resolve(env.FAMILIARS_SECRETS_FILE ?? '.secrets/agent.env')
  const fileVars = existsSync(secretsFile) ? parseEnvFile(readFileSync(secretsFile, 'utf8')) : {}
  const get = (k: string): string | undefined => {
    const v = env[k] ?? fileVars[k]
    return v === undefined || v === '' ? undefined : v
  }
  const mode: TradingMode = get('TRADING_MODE') === 'live' ? 'live' : 'paper'
  const cfg: AppConfig = {
    familiarsBaseUrl: (get('FAMILIARS_BASE_URL') ?? 'https://familiars.family').replace(/\/+$/, ''),
    jupiterBaseUrl: (get('JUPITER_API_BASE') ?? 'https://lite-api.jup.ag').replace(/\/+$/, ''),
    jupiterApiKey: get('JUPITER_API_KEY'),
    rpcUrl: get('SOLANA_RPC_URL') ?? 'https://api.mainnet-beta.solana.com',
    secretKey: get('AGENT_SECRET_KEY'),
    apiKey: get('FAMILIARS_API_KEY'),
    mode,
    posting: (get('POSTING') ?? (mode === 'live' ? 'on' : 'off')) === 'on',
    statePath: resolve(get('STATE_PATH') ?? `state/agent.${mode}.local.json`),
    cacheDir: resolve(get('CACHE_DIR') ?? '.cache'),
    secretsFile,
  }
  registerSecret(cfg.secretKey)
  registerSecret(cfg.apiKey)
  registerSecret(get('FAMILIARS_OWNER_KEY'))
  registerSecret(get('JUPITER_API_KEY'))
  registerSecret(get('FAMILIARS_LOGIN_URL'))
  // RPC URLs from paid providers embed the API key.
  if (/api[-_]?key=|\/v2\/[A-Za-z0-9]{20,}/i.test(cfg.rpcUrl)) registerSecret(cfg.rpcUrl)
  return cfg
}

export function requireValue<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${name} is not configured. Set it as an environment variable or in the secrets file.`)
  }
  return value
}
