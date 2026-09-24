// Logger with secret redaction. Every line goes through redact() so a key that
// ends up in an error message or a response body never reaches stdout.

const secrets = new Set<string>()

export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) secrets.add(value)
}

export function redact(text: string): string {
  let out = text
  for (const s of secrets) out = out.split(s).join('[REDACTED]')
  // Defense in depth for familiars keys we were never told about.
  return out.replace(/fam_(owner_)?[A-Za-z0-9_-]{6,}/g, (m) => `${m.startsWith('fam_owner_') ? 'fam_owner_' : 'fam_'}[REDACTED]`)
}

type Level = 'debug' | 'info' | 'warn' | 'error'
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function threshold(): number {
  const lvl = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level
  return ORDER[lvl] ?? ORDER.info
}

function safeJson(data: unknown): string {
  try {
    return JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  } catch {
    return String(data)
  }
}

function emit(level: Level, msg: string, data?: unknown): void {
  if (ORDER[level] < threshold()) return
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${data === undefined ? '' : ` ${safeJson(data)}`}`
  const clean = redact(line)
  if (level === 'warn' || level === 'error') console.error(clean)
  else console.log(clean)
}

export const log = {
  debug: (msg: string, data?: unknown) => emit('debug', msg, data),
  info: (msg: string, data?: unknown) => emit('info', msg, data),
  warn: (msg: string, data?: unknown) => emit('warn', msg, data),
  error: (msg: string, data?: unknown) => emit('error', msg, data),
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
