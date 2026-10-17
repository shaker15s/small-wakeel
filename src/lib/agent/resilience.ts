// وكيل — production resilience for LLM calls (R15).
// The reliability research is unambiguous: 70–95% of agent failures in
// production come from compounding transient errors (429/5xx/timeouts) that
// never get retried. This module gives every LLM call:
//   1. withRetry  — graduated backoff (0ms → 800ms → 2500ms + jitter) BEFORE
//                   any fallback fires, exactly the immediate/+3s/+10s ladder
//                   recommended in the 2025-2026 reliability literature.
//   2. withBreaker — per-provider circuit breaker: after N consecutive
//                   failures the circuit OPENS for a cooldown window and
//                   calls fail fast (protecting tail latency) until it
//                   half-opens to probe again.
//   3. prefixCache — stable-prompt assembly memoization: the invariant
//                   system+DNA prefix per business is built ONCE and reused
//                   (byte-identical prefix → provider-side KV-cache hits,
//                   lower TTFT and cost).
// All state is in-module (sandbox: single process, local memory caching —
// no Redis by design). Everything is synchronous Map lookups — zero latency.

/** Retryable HTTP-ish statuses. 429 = rate limit, 5xx = provider hiccup. */
function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  // NOTE: the providers throw `المزوّد رجع 503` — an Arabic message with a bare
  // status NUMBER, no «status» word. The old regex only matched the English
  // form, so a real 503 was treated as deterministic and never retried (found
  // by tests/unit/resilience.test.ts). Match the number in an error-ish context.
  const code = msg.match(/\b(429|5\d\d)\b/)
  const numericTransient = !!code && /provider|status|http|رجع|المزوّد|gateway|upstream|timeout/i.test(msg)
  return (
    numericTransient ||
    /status 429/i.test(msg) ||
    /timeout|timed out|ECONNRESET|fetch failed|network/i.test(msg)
  )
}

/**
 * Connection-level failures: the socket never reached the provider.
 *
 * WHY this is separate from «transient»: a refused connection cannot be waited
 * out. In the live preview a dead provider cost the owner 7 seconds of
 * «بفهم طلبك» — three retries with 0ms/800ms/2500ms backoff against a port
 * nobody is listening on — before the fallback ladder was even consulted.
 * Unreachable hosts now fail FAST (one attempt, no backoff) so the ladder can
 * move to a healthy model in milliseconds.
 */
function unreachableCode(err: unknown): string {
  const e = err as { code?: string; cause?: { code?: string } } | null
  return e?.cause?.code ?? e?.code ?? ''
}

export function isUnreachable(err: unknown): boolean {
  const code = unreachableCode(err)
  if (code && ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return true
  const msg = err instanceof Error ? `${err.message} ${(err.cause as Error | undefined)?.message ?? ''}` : String(err ?? '')
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/i.test(msg)
}

/**
 * Transport-level failure: the request never produced an HTTP response.
 *
 * `TypeError: fetch failed` (undici) is how Node reports a refused socket, a
 * DNS miss or a TLS reset. Historically we retried it like a 5xx — three
 * attempts, 3.3s of backoff, and only THEN the model ladder. In a live preview
 * with a dead provider that is the difference between «بفهم طلبك 1ms» and a
 * 7-second stare. A host that cannot be reached is not going to become
 * reachable 800ms later, so it fails fast and trips the breaker at once.
 */
export function isConnectFailure(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return false
    const cause = (err as { cause?: Error }).cause
    if (cause && (cause.name === 'AbortError' || cause.name === 'TimeoutError' || /timeout|timed out|abort/i.test(cause.message))) {
      return false
    }
  }
  if (isUnreachable(err)) return true
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return true
  return false
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface RetryOpts {
  /** label for observability (appears in dev.log lines) */
  label?: string
  /** graduated delays in ms — default ladder [0, 800, 2500] (3 attempts + initial) */
  delays?: number[]
  /** max total wall-clock budget before giving up (default 12s) */
  budgetMs?: number
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void
}

/**
 * Run an async fn with graduated-backoff retries on transient errors.
 * Non-transient errors (4xx logic errors, parse failures) throw immediately —
 * retrying a deterministic failure just wastes the user's time.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const delays = opts.delays ?? [0, 800, 2500]
  const budgetMs = opts.budgetMs ?? 12_000
  const started = Date.now()
  let lastErr: unknown

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) {
      const base = delays[Math.min(attempt - 1, delays.length - 1)]
      // ±20% jitter avoids thundering-herd sync on shared rate limits
      const jitter = Math.round(base * (0.8 + Math.random() * 0.4))
      if (Date.now() - started + jitter > budgetMs) break
      if (opts.onRetry) opts.onRetry(attempt, jitter, lastErr)
      if (jitter > 0) await sleep(jitter)
    }
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      // dead host → straight to the model ladder (no backoff, no second attempt)
      if (isConnectFailure(err)) break
      if (!isTransient(err)) break // deterministic failure — don't retry
    }
  }
  throw lastErr
}

// ---------------------------------------------------------------------------
// Circuit breaker — per provider/model key.

interface BreakerState {
  failures: number
  openedAt: number
}

const BREAKER_THRESHOLD = 5 // consecutive failures before opening (transient)
const BREAKER_COOLDOWN_MS = 15_000 // stay open for 15s max (was 60s)
const BREAKER_HALF_OPEN_MS = 5_000 // allow a probe after 5s (half-open)

const breakers = new Map<string, BreakerState>()

export function breakerIsOpen(key: string): boolean {
  const st = breakers.get(key)
  if (!st || st.failures < BREAKER_THRESHOLD) return false
  const age = Date.now() - st.openedAt
  if (age >= BREAKER_COOLDOWN_MS) {
    breakers.delete(key)
    return false
  }
  if (age >= BREAKER_HALF_OPEN_MS) {
    // half-open: allow a probe through to test if provider recovered
    return false
  }
  return true
}

/**
 * Record the outcome of a call; a success resets the failure streak.
 *
 * `fatal` (a connect-level failure) opens the circuit on the FIRST failure.
 * Waiting for five refusals means four wasted round trips on every turn, and a
 * dead provider is never the model the owner is waiting for.
 */
export function breakerRecord(key: string, ok: boolean, fatal = false): void {
  const st = breakers.get(key) ?? { failures: 0, openedAt: 0 }
  if (ok) {
    breakers.set(key, { failures: 0, openedAt: 0 })
    return
  }
  st.failures += fatal ? BREAKER_THRESHOLD : 1
  if (st.failures >= BREAKER_THRESHOLD) st.openedAt = Date.now()
  breakers.set(key, st)
}

/**
 * Wrap a call with the circuit breaker. When OPEN the call is skipped
 * entirely (fail fast) and the error is thrown without invoking fn — the
 * harness's deterministic fallback then serves the user instantly instead of
// burning 5s on a dead provider.
 */
export async function withBreaker<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (breakerIsOpen(key)) {
    throw new Error(`circuit-breaker open: ${key} (فشل متكرر — بستخدم المسار الاحتياطي فوراً)`)
  }
  try {
    const out = await fn()
    breakerRecord(key, true)
    return out
  } catch (err) {
    breakerRecord(key, false, isConnectFailure(err))
    throw err
  }
}

// ---------------------------------------------------------------------------
// Stable prefix cache — assemble the invariant prompt prefix once per
// business and reuse the EXACT same string across turns (byte-identical
// prefixes hit provider KV caches → materially lower TTFT/cost).

const prefixCache = new Map<string, { value: string; at: number }>()
const PREFIX_TTL_MS = 5 * 60_000

/**
 * Memoize `build()` under `key`. TTL refreshes the DNA snapshot every 5 min
 * so memory edits eventually flow in, while staying byte-stable within the
 * window (the whole point).
 */
export function stablePrefix(key: string, build: () => string): string {
  const hit = prefixCache.get(key)
  if (hit && Date.now() - hit.at < PREFIX_TTL_MS) return hit.value
  const value = build()
  prefixCache.set(key, { value, at: Date.now() })
  return value
}

/** Test/observability hook: live breaker snapshot. */
export function breakerStats(): Record<string, { failures: number; open: boolean }> {
  const out: Record<string, { failures: number; open: boolean }> = {}
  for (const [k, st] of breakers) out[k] = { failures: st.failures, open: breakerIsOpen(k) }
  return out
}
