import { describe, expect, test } from 'bun:test'
import {
  assertSafeAcceptanceCredentialTarget,
  evaluateExpectedSaleCall,
  isLiveAcceptanceEndpoint,
  resolveChatCompletionsUrl,
  SALE_TOOL_ACCEPTANCE_SCHEMA,
} from '../../scripts/lib/model-acceptance-contract.mjs'
import { brainToolSchemas } from '@/lib/agent/tool-schemas'

describe('live model acceptance contract', () => {
  test('uses Google official OpenAI-compatible endpoint instead of the wrong route', () => {
    expect(resolveChatCompletionsUrl('https://generativelanguage.googleapis.com/v1beta'))
      .toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
  })

  test('does not duplicate an already-complete endpoint', () => {
    expect(resolveChatCompletionsUrl('https://api.example.com/v1/chat/completions'))
      .toBe('https://api.example.com/v1/chat/completions')
  })

  test('appends the chat-completions route to a generic OpenAI-compatible base', () => {
    expect(resolveChatCompletionsUrl('https://api.example.com/v1/'))
      .toBe('https://api.example.com/v1/chat/completions')
  })

  test('rejects missing keys, insecure endpoints, localhost and private IPv4 addresses as live evidence', () => {
    expect(isLiveAcceptanceEndpoint('https://api.example.com/v1', '', ['model-x'])).toBe(false)
    expect(isLiveAcceptanceEndpoint('http://api.example.com/v1', 'secret', ['model-x'])).toBe(false)
    expect(isLiveAcceptanceEndpoint('http://127.0.0.1:3031/v1', 'secret', ['model-x'])).toBe(false)
    expect(isLiveAcceptanceEndpoint('https://192.168.1.20/v1', 'secret', ['model-x'])).toBe(false)
    expect(isLiveAcceptanceEndpoint('https://[::ffff:7f00:1]/v1', 'secret', ['model-x'])).toBe(false)
    expect(isLiveAcceptanceEndpoint('https://localhost./v1', 'secret', ['model-x'])).toBe(false)
    expect(isLiveAcceptanceEndpoint('https://api.example.com/v1', 'secret', ['mock-model'])).toBe(false)
  })

  test('blocks credential transmission to insecure/private/mock endpoints before network access', () => {
    expect(() => assertSafeAcceptanceCredentialTarget('http://127.0.0.1:3031/v1', 'secret', ['model-x'])).toThrow(/Refusing to send/)
    expect(() => assertSafeAcceptanceCredentialTarget('https://192.168.1.10/v1', 'secret', ['model-x'])).toThrow(/Refusing to send/)
    expect(() => assertSafeAcceptanceCredentialTarget('https://api.example.com/v1', 'secret', ['mock-model'])).toThrow(/Refusing to send/)
    expect(() => assertSafeAcceptanceCredentialTarget('https://generativelanguage.googleapis.com/v1beta', 'secret', ['gemini-3.8-flash'])).not.toThrow()
    expect(() => assertSafeAcceptanceCredentialTarget('http://127.0.0.1:3031/v1', '', ['mock-model'])).not.toThrow()
  })

  test('acceptance sends the same record_sale schema as the real WAKIL tool registry', () => {
    const actual = brainToolSchemas().find((tool) => tool.function.name === 'record_sale')?.function
    expect(actual).toBeDefined()
    expect(SALE_TOOL_ACCEPTANCE_SCHEMA).toEqual(actual!)
  })

  test('checks the real sale fields: identity, quantity, invoice total, and amount paid', () => {
    expect(evaluateExpectedSaleCall([{
      name: 'record_sale',
      args: { name: 'علبة زيت عباد 1.5 لتر', qty: 3, total: 255, paid: 255 },
    }]).passed).toBe(true)

    expect(evaluateExpectedSaleCall([{
      name: 'record_sale',
      args: { name: 'علبة زيت عباد 1.5 لتر', qty: 3, total: 999, paid: 255 },
    }]).passed).toBe(false)

    expect(evaluateExpectedSaleCall([{
      name: 'record_sale',
      args: { name: 'علبة زيت عباد 1.5 لتر', qty: 3, total: 255 },
    }]).passed).toBe(false)

    expect(evaluateExpectedSaleCall([{
      name: 'record_sale',
      args: { name: 'علبة زيت عباد 1.5 لتر', qty: 3, total: '٢٥٥', paid: '٢٥٥' },
    }]).passed).toBe(true)

    expect(evaluateExpectedSaleCall([{
      name: 'record_sale',
      args: { name: 'علبة زيت عباد 1.5 لتر', total: 255, paid: 255 },
    }]).passed).toBe(false)
  })

  test('does not treat another write tool as the expected sale', () => {
    expect(evaluateExpectedSaleCall([{
      name: 'record_expense',
      args: { item: 'زيت عباد 1.5 لتر', qty: 3, amount: 255 },
    }]).passed).toBe(false)
  })
})
