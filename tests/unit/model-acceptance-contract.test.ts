import { describe, expect, test } from 'bun:test'
import {
  evaluateExpectedSaleCall,
  isLiveAcceptanceEndpoint,
  resolveChatCompletionsUrl,
} from '../../scripts/lib/model-acceptance-contract.mjs'

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
    expect(isLiveAcceptanceEndpoint('https://api.example.com/v1', 'secret', ['mock-model'])).toBe(false)
  })

  test('accepts only a sale call with the expected product identity, quantity and amount', () => {
    expect(evaluateExpectedSaleCall([{
      name: 'record_sale',
      args: { item: 'علبة زيت عباد 1.5 لتر', qty: 3, amount: 255 },
    }]).passed).toBe(true)

    expect(evaluateExpectedSaleCall([{
      name: 'record_sale',
      args: { item: 'علبة زيت عباد 1.5 لتر', qty: 3, amount: 999 },
    }]).passed).toBe(false)

    expect(evaluateExpectedSaleCall([{
      name: 'record_sale',
      args: { item: 'زيت عباد 1.5 لتر', amount: 255 },
    }]).passed).toBe(false)
  })

  test('does not treat another write tool as the expected sale', () => {
    expect(evaluateExpectedSaleCall([{
      name: 'record_expense',
      args: { item: 'زيت عباد 1.5 لتر', qty: 3, amount: 255 },
    }]).passed).toBe(false)
  })
})
