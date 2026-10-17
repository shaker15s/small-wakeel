// وكيل — security primitives.
import { describe, expect, test } from 'bun:test'
import { originAllowed, safeEqual, tokenAccepted } from '../../src/lib/security/auth'
import { consumeRate, clientIp, resetRateLimiter } from '../../src/lib/security/rateLimit'

describe('security.safeEqual', () => {
  test('equal strings match, different strings never do', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true)
    expect(safeEqual('abc123', 'abc124')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
  })
})

describe('security.tokens', () => {
  test('open mode accepts everything when no token is configured', () => {
    const prev = process.env.WAKIL_ACCESS_TOKEN
    delete process.env.WAKIL_ACCESS_TOKEN
    expect(tokenAccepted(new Request('http://x/api'))).toBe(true)
    if (prev !== undefined) process.env.WAKIL_ACCESS_TOKEN = prev
  })

  test('configured token must be presented (header, query or cookie)', () => {
    const prev = process.env.WAKIL_ACCESS_TOKEN
    process.env.WAKIL_ACCESS_TOKEN = 's3cret'
    expect(tokenAccepted(new Request('http://x/api'))).toBe(false)
    expect(tokenAccepted(new Request('http://x/api', { headers: { authorization: 'Bearer s3cret' } }))).toBe(true)
    expect(tokenAccepted(new Request('http://x/api', { headers: { 'x-wakil-token': 's3cret' } }))).toBe(true)
    expect(tokenAccepted(new Request('http://x/api?token=s3cret'))).toBe(true)
    expect(tokenAccepted(new Request('http://x/api', { headers: { cookie: 'wakil_token=s3cret' } }))).toBe(true)
    expect(tokenAccepted(new Request('http://x/api', { headers: { authorization: 'Bearer wrong' } }))).toBe(false)
    if (prev === undefined) delete process.env.WAKIL_ACCESS_TOKEN
    else process.env.WAKIL_ACCESS_TOKEN = prev
  })
})

describe('security.origin', () => {
  test('GET is always allowed (no CSRF surface)', () => {
    expect(originAllowed(new Request('http://x/api', { method: 'GET' }))).toBe(true)
  })

  test('same-origin POST is allowed, cross-origin is not', () => {
    const same = new Request('http://shop.local/api/chat', {
      method: 'POST',
      headers: { origin: 'http://shop.local', host: 'shop.local' },
    })
    const cross = new Request('http://shop.local/api/chat', {
      method: 'POST',
      headers: { origin: 'http://evil.example', host: 'shop.local' },
    })
    expect(originAllowed(same)).toBe(true)
    expect(originAllowed(cross)).toBe(false)
  })

  test('non-browser clients without Origin are allowed', () => {
    expect(originAllowed(new Request('http://shop.local/api/tasks/tick', { method: 'POST' }))).toBe(true)
  })
})

describe('security.rateLimit', () => {
  test('a burst is eventually refused and reports a retry delay', () => {
    resetRateLimiter()
    let blocked = 0
    for (let i = 0; i < 200; i++) {
      const res = consumeRate('test-ip:write', 'write')
      if (!res.ok) {
        blocked += 1
        expect(res.retryAfter).toBeGreaterThan(0)
      }
    }
    expect(blocked).toBeGreaterThan(0)
  })

  test('read budget is more generous than the chat budget', () => {
    resetRateLimiter()
    let reads = 0
    let chats = 0
    for (let i = 0; i < 60; i++) {
      if (consumeRate('ip-a:read', 'read').ok) reads += 1
      if (consumeRate('ip-b:chat', 'chat').ok) chats += 1
    }
    expect(reads).toBeGreaterThan(chats)
  })

  test('clientIp prefers the first forwarded address', () => {
    const req = new Request('http://x/api', { headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' } })
    expect(clientIp(req)).toBe('9.9.9.9')
  })
})
