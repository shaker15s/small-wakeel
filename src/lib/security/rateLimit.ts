// وكيل — per-IP token-bucket rate limiting.
//
// The app is a single-tenant-per-request API with no login screen, so the
// cheapest meaningful abuse control is a per-IP budget. Limits are per route
// CLASS (a chat turn costs an LLM call; a bootstrap read is free) and are
// configurable through env vars.
//
// Scope note (documented, not accidental): the buckets live in this process'
// memory. With multiple server instances each one enforces its own budget —
// good enough to stop runaway clients and accidental loops; a shared store
// (Redis) is the next step if the app is ever horizontally scaled.

interface Bucket {
  /** Remaining tokens. */
  tokens: number
  /** Epoch ms of the last refill. */
  updatedAt: number
}

const buckets = new Map<string, Bucket>()
const MAX_TRACKED_KEYS = 10_000

export type RateClass = 'read' | 'write' | 'chat'

const DEFAULTS: Record<RateClass, { perMinute: number; burst: number }> = {
  read: { perMinute: 600, burst: 120 },
  write: { perMinute: 120, burst: 40 },
  chat: { perMinute: 40, burst: 12 },
}

function limitFor(cls: RateClass): { perMinute: number; burst: number } {
  const envRate = Number(process.env[cls === 'chat' ? 'WAKIL_RATE_LIMIT_CHAT' : 'WAKIL_RATE_LIMIT'])
  const base = DEFAULTS[cls]
  if (!Number.isFinite(envRate) || envRate <= 0) return base
  return { perMinute: envRate, burst: Math.max(4, Math.round(envRate / 3)) }
}

function prune(now: number) {
  if (buckets.size < MAX_TRACKED_KEYS) return
  for (const [key, bucket] of buckets) {
    // drop buckets untouched for over an hour
    if (now - bucket.updatedAt > 3_600_000) buckets.delete(key)
  }
  if (buckets.size >= MAX_TRACKED_KEYS) buckets.clear()
}

export interface RateResult {
  ok: boolean
  /** Seconds the caller should wait before retrying (only when ok === false). */
  retryAfter: number
  remaining: number
}

/** Consume one token for `key` (usually `${ip}:${cls}`). */
export function consumeRate(key: string, cls: RateClass): RateResult {
  const now = Date.now()
  prune(now)
  const { perMinute, burst } = limitFor(cls)
  const refillPerMs = perMinute / 60_000
  const bucket = buckets.get(key) ?? { tokens: burst, updatedAt: now }
  const elapsed = Math.max(0, now - bucket.updatedAt)
  bucket.tokens = Math.min(burst, bucket.tokens + elapsed * refillPerMs)
  bucket.updatedAt = now

  if (bucket.tokens < 1) {
    const deficit = 1 - bucket.tokens
    const waitMs = Math.ceil(deficit / refillPerMs)
    buckets.set(key, bucket)
    return { ok: false, retryAfter: Math.max(1, Math.ceil(waitMs / 1000)), remaining: 0 }
  }

  bucket.tokens -= 1
  buckets.set(key, bucket)
  return { ok: true, retryAfter: 0, remaining: Math.floor(bucket.tokens) }
}

/** Client IP as seen through the platform proxy (falls back to a stable key). */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }
  return (
    req.headers.get('x-real-ip')?.trim() ||
    req.headers.get('cf-connecting-ip')?.trim() ||
    'local'
  )
}

/** Test seam — resets all buckets. */
export function resetRateLimiter(): void {
  buckets.clear()
}
