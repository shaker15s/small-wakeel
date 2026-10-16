// وكيل — retry policy: the difference between «wait it out» and «move on».
//
// A refused socket (dead provider, wrong port) is not a hiccup: retrying it
// only delays the fallback ladder, and the owner pays for it in seconds of
// «بفهم طلبك». 429/5xx stay on the graduated ladder; connection failures fail
// fast after ONE attempt.
import { describe, expect, test } from 'bun:test'
import { isUnreachable, withRetry } from '../../src/lib/agent/resilience'

describe('resilience.withRetry', () => {
  test('a connection-refused error is not retried at all', async () => {
    let attempts = 0
    await expect(
      withRetry(
        async () => {
          attempts++
          const err = new Error('fetch failed') as Error & { cause?: { code?: string } }
          err.cause = { code: 'ECONNREFUSED' }
          throw err
        },
        { delays: [0, 50, 100] },
      ),
    ).rejects.toThrow('fetch failed')
    expect(attempts).toBe(1)
  })

  test('a plain timeout keeps the graduated ladder', async () => {
    let attempts = 0
    await expect(
      withRetry(
        async () => {
          attempts++
          throw new Error('request timed out')
        },
        { delays: [0, 10] },
      ),
    ).rejects.toThrow('timed out')
    expect(attempts).toBeGreaterThan(1)
  })

  test('a deterministic error (bad schema) is never retried', async () => {
    let attempts = 0
    await expect(
      withRetry(
        async () => {
          attempts++
          throw new Error('الرد مش JSON صالح')
        },
        { delays: [0, 10] },
      ),
    ).rejects.toThrow()
    expect(attempts).toBe(1)
  })

  test('success on the second attempt is returned transparently', async () => {
    let attempts = 0
    const value = await withRetry(
      async () => {
        attempts++
        if (attempts === 1) throw new Error('status 503')
        return 'ok'
      },
      { delays: [0, 5] },
    )
    expect(value).toBe('ok')
    expect(attempts).toBe(2)
  })

  test('unreachable detection covers the undici shapes', () => {
    const withCause = new Error('fetch failed') as Error & { cause?: { code?: string } }
    withCause.cause = { code: 'ENOTFOUND' }
    expect(isUnreachable(withCause)).toBe(true)
    expect(isUnreachable(new Error('connect ECONNREFUSED 127.0.0.1:9999'))).toBe(true)
    expect(isUnreachable(new Error('status 429'))).toBe(false)
  })
})
