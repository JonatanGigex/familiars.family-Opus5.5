import { log } from './log.js'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} ${url.split('?')[0]}: ${body.slice(0, 300)}`)
  }
}

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
  /** Extra attempts after the first one. */
  retries?: number
  /** Statuses worth retrying. Defaults to 429 and 5xx. */
  retryOn?: (status: number) => boolean
  /**
   * Retry timeouts and network errors. Off for requests that must not be
   * repeated when the server may already have acted on them (e.g. posts).
   */
  retryNetwork?: boolean
}

const USER_AGENT = 'familiars-agent/0.1 (+https://familiars.family)'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function requestJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', headers = {}, body, timeoutMs = 20_000, retries = 3 } = opts
  const retryOn = opts.retryOn ?? ((s: number) => s === 429 || s >= 500)
  const retryNetwork = opts.retryNetwork ?? true
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      })
      const text = await res.text()
      if (!res.ok) {
        const err = new HttpError(res.status, url, text)
        if (attempt < retries && retryOn(res.status)) {
          const retryAfter = Number(res.headers.get('retry-after'))
          const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt
          log.debug(`retrying ${method} ${url.split('?')[0]} after HTTP ${res.status}`, { wait })
          await sleep(Math.min(wait, 30_000))
          lastErr = err
          continue
        }
        throw err
      }
      return (text ? JSON.parse(text) : null) as T
    } catch (e) {
      if (e instanceof HttpError) throw e
      lastErr = e
      if (attempt < retries && retryNetwork) {
        await sleep(1000 * 2 ** attempt)
        continue
      }
      break
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
