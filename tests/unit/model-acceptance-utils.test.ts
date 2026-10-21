import { describe, expect, test } from 'bun:test'
import {
  allAcceptanceChecksPass,
  buildChatCompletionsUrl,
  classifyEndpoint,
  extractToolCalls,
  matchesExpectedSaleCall,
} from '../../scripts/model-acceptance-utils.mjs'

describe('model acceptance: endpoint routing', () => {
  test('uses the documented Gemini OpenAI-compatible route', () => {
    expect(buildChatCompletionsUrl('https://generativelanguage.googleapis.com/v1beta'))
      .toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
  })

  test('does not duplicate the OpenAI compatibility path', () => {
    expect(buildChatCompletionsUrl('https://generativelanguage.googleapis.com/v1beta/openai/'))
      .toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
    expect(buildChatCompletionsUrl('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'))
      .toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
  })

  test('keeps standard OpenAI-compatible providers on /chat/completions', () => {
    expect(buildChatCompletionsUrl('https://api.example.com/v1'))
      .toBe('https://api.example.com/v1/chat/completions')
  })

  test('refuses missing, malformed, credential-bearing, and non-HTTP endpoints', () => {
    expect(() => buildChatCompletionsUrl('')).toThrow()
    expect(() => buildChatCompletionsUrl('not a URL')).toThrow()
    expect(() => buildChatCompletionsUrl('ftp://example.com/v1')).toThrow()
    expect(() => buildChatCompletionsUrl('https://user:secret@example.com/v1')).toThrow()
  })

  test('distinguishes unconfigured, mock, and live providers', () => {
    expect(classifyEndpoint('', ['gemini-3-flash'])).toBe('unconfigured')
    expect(classifyEndpoint('http://127.0.0.1:3031/v1', ['gemini-3-flash'])).toBe('mock')
    expect(classifyEndpoint('https://api.example.com/v1', ['mock-model'])).toBe('mock')
    expect(classifyEndpoint('https://api.example.com/v1', ['real-model'])).toBe('live')
  })
})

describe('model acceptance: tool contracts', () => {
  test('extracts a native tool call and validates the exact expected money fields', () => {
    const calls = extractToolCalls({
      choices: [{ message: { tool_calls: [{
        type: 'function',
        function: { name: 'record_sale', arguments: JSON.stringify({ item: 'زيت عباد 1.5 لتر', qty: 3, amount: 255 }) },
      }] } }],
    })
    expect(calls).toHaveLength(1)
    expect(matchesExpectedSaleCall(calls[0])).toBe(true)
  })

  test('rejects the right tool name if the quantity or amount is wrong or missing', () => {
    for (const args of [
      { item: 'زيت عباد 1.5 لتر', qty: 2, amount: 255 },
      { item: 'زيت عباد 1.5 لتر', qty: 3, amount: 250 },
      { item: 'زيت عباد 1.5 لتر', qty: 3 },
      { item: 'زيت عباد 1.5 لتر', qty: 3, amount: 255.5 },
      { item: 'زيت ذرة', qty: 3, amount: 255 },
    ]) {
      expect(matchesExpectedSaleCall({ name: 'record_sale', args })).toBe(false)
    }
  })

  test('extracts the JSON-in-text fallback with the same semantic result', () => {
    const calls = extractToolCalls({
      choices: [{ message: { content: JSON.stringify({ tool_calls: [{
        tool: 'record_sale', args: { item: 'زيت عباد', qty: 3, amount: 255 },
      }] }) } }],
    })
    expect(matchesExpectedSaleCall(calls[0])).toBe(true)
  })

  test('does not consider empty or failed non-cost check results as a pass', () => {
    expect(allAcceptanceChecksPass([])).toBe(false)
    expect(allAcceptanceChecksPass([{ checks: [] }])).toBe(false)
    expect(allAcceptanceChecksPass([{ checks: [{ id: 'A1', pass: false }, { id: 'A5', pass: true }] }])).toBe(false)
    expect(allAcceptanceChecksPass([{ checks: [{ id: 'A1', pass: true }, { id: 'A5', pass: false }] }])).toBe(true)
  })
})
