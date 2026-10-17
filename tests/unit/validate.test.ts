// وكيل — request validation contracts.
import { describe, expect, test } from 'bun:test'
import { chatPostSchema, confirmOpSchema, providerCreateSchema, parseBody } from '../../src/lib/security/validate'

function jsonReq(body: unknown, method = 'POST'): Request {
  return new Request('http://x/api', { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
}

describe('validate.chatPostSchema', () => {
  test('accepts a normal turn', () => {
    const parsed = chatPostSchema.safeParse({ businessId: 'b1', userId: 'u1', text: 'بعت ٢ علبة' })
    expect(parsed.success).toBe(true)
  })

  test('rejects an empty message', () => {
    const parsed = chatPostSchema.safeParse({ businessId: 'b1', userId: 'u1', text: '   ' })
    expect(parsed.success).toBe(false)
  })

  test('rejects an oversized message (prompt-injection / cost guard)', () => {
    const parsed = chatPostSchema.safeParse({ businessId: 'b1', userId: 'u1', text: 'ا'.repeat(5000) })
    expect(parsed.success).toBe(false)
  })

  test('strips control characters', () => {
    const parsed = chatPostSchema.parse({ businessId: 'b1', userId: 'u1', text: 'بيع\u0007 ٢' })
    expect(parsed.text).not.toContain('\u0007')
  })
})

describe('validate.confirmOpSchema', () => {
  test('only approve/reject/cancel are accepted', () => {
    expect(confirmOpSchema.safeParse({ action: 'approve', userId: 'u1' }).success).toBe(true)
    expect(confirmOpSchema.safeParse({ action: 'delete-everything', userId: 'u1' }).success).toBe(false)
  })
})

describe('validate.providerCreateSchema', () => {
  test('baseUrl must be http(s)', () => {
    expect(providerCreateSchema.safeParse({ name: 'مزود', baseUrl: 'javascript:alert(1)', apiKey: 'k' }).success).toBe(false)
    expect(providerCreateSchema.safeParse({ name: 'مزود', baseUrl: 'http://localhost:3031/v1', apiKey: 'k' }).success).toBe(true)
  })
})

describe('validate.parseBody', () => {
  test('bad JSON becomes a friendly Arabic failure, never a throw', async () => {
    const req = new Request('http://x/api', { method: 'POST', body: 'not json' })
    const result = await parseBody(req, chatPostSchema)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0)
  })

  test('schema violations name the offending field', async () => {
    const result = await parseBody(jsonReq({ businessId: 'b', userId: 'u' }), chatPostSchema)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('text')
  })
})
