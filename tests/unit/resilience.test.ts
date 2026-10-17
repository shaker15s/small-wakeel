// وكيل — reliability layer: retry, fail-fast, and the circuit breaker.
//
// These rules decide how many SECONDS the owner loses when a provider dies.
// They were tuned against live evidence: a dead provider used to cost 7s of
// «بفهم طلبك» (three retries with 0/800/2500ms backoff against a refused port)
// before the fallback ladder was even consulted.
import { describe, expect, test } from 'bun:test'
import { breakerIsOpen, breakerRecord, breakerStats, isConnectFailure, isUnreachable, withBreaker, withRetry } from '../../src/lib/agent/resilience'

/** undici's shape for a refused socket. */
function refused(): TypeError {
  const err = new TypeError('fetch failed')
  ;(err as unknown as { cause: { code: string } }).cause = { code: 'ECONNREFUSED' }
  return err
}

describe('resilience.failFast', () => {
  test('connect-level failures are recognised (code, message, and bare TypeError)', () => {
    expect(isUnreachable(refused())).toBe(true)
    expect(isUnreachable(Object.assign(new Error('nope'), { code: 'EAI_AGAIN' }))).toBe(true)
    // `isUnreachable` demands EVIDENCE (a connect code). A bare undici
    // «fetch failed» keeps the weaker, broader classification — it fails fast
    // and trips the breaker, but it is not claimed as a proven dead host.
    expect(isUnreachable(new TypeError('fetch failed'))).toBe(false)
    expect(isConnectFailure(new TypeError('fetch failed'))).toBe(true)
    // a 500 is NOT a connect failure: the provider is alive and may recover
    expect(isConnectFailure(new Error('المزوّد رجع 500'))).toBe(false)
    expect(isUnreachable(new Error('المزوّد رجع 500'))).toBe(false)
  })

  test('an unreachable host is attempted ONCE — no 3.3s of backoff', async () => {
    let attempts = 0
    const started = Date.now()
    await expect(
      withRetry(async () => {
        attempts++
        throw refused()
      }),
    ).rejects.toThrow()
    expect(attempts).toBe(1)
    expect(Date.now() - started).toBeLessThan(250)
  })

  test('a bare «fetch failed» (undici, no code) is also attempted ONCE', async () => {
    // Live evidence: the models were dead and every turn burned 3.3s of
    // 800/2500ms backoff on `TypeError: fetch failed` before the ladder ran.
    let attempts = 0
    const started = Date.now()
    await expect(
      withRetry(async () => {
        attempts++
        throw new TypeError('fetch failed')
      }),
    ).rejects.toThrow()
    expect(attempts).toBe(1)
    expect(Date.now() - started).toBeLessThan(250)
  })

  test('a 5xx is retried with graduated backoff (the provider may hiccup)', async () => {
    let attempts = 0
    await expect(
      withRetry(
        async () => {
          attempts++
          throw new Error('المزوّد رجع 503')
        },
        { delays: [0, 5, 5], budgetMs: 2_000 },
      ),
    ).rejects.toThrow()
    expect(attempts).toBeGreaterThan(1)
  })

  test('a deterministic error (bad request) is never retried', async () => {
    let attempts = 0
    await expect(
      withRetry(async () => {
        attempts++
        throw new Error('الموديل الخارجي مش موجود')
      }),
    ).rejects.toThrow()
    expect(attempts).toBe(1)
  })
})

describe('resilience.breaker', () => {
  test('one connect failure opens the circuit — the next call fails instantly', async () => {
    const key = `test:open:${Math.random()}`
    await expect(withBreaker(key, async () => Promise.reject(refused()))).rejects.toThrow()
    expect(breakerIsOpen(key)).toBe(true)

    let called = false
    const started = Date.now()
    await expect(
      withBreaker(key, async () => {
        called = true
        return 'should not run'
      }),
    ).rejects.toThrow(/circuit-breaker/)
    expect(called).toBe(false)
    expect(Date.now() - started).toBeLessThan(50)
  })

  test('transient failures accumulate and a success resets the streak', async () => {
    const key = `test:count:${Math.random()}`
    for (let i = 0; i < 4; i++) breakerRecord(key, false)
    expect(breakerIsOpen(key)).toBe(false)
    expect(breakerStats()[key].failures).toBe(4)
    breakerRecord(key, true)
    expect(breakerStats()[key].failures).toBe(0)
  })

  test('a fatal record is enough on its own', () => {
    const key = `test:fatal:${Math.random()}`
    breakerRecord(key, false, true)
    expect(breakerIsOpen(key)).toBe(true)
  })
})
