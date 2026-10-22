import { describe, expect, test } from 'bun:test'
import { MOCK_SEARCH_NOTICE, MOCK_SEARCH_PROVIDER, mockSearchResponse } from '../../mini-services/mock-provider/search-fixture'

describe('mock search cannot masquerade as live market information', () => {
  test('explicitly marks the payload and every card as synthetic', () => {
    const out = mockSearchResponse('سعر زيت', 5)
    expect(out.provider).toBe(MOCK_SEARCH_PROVIDER)
    expect(out.synthetic).toBe(true)
    expect(out.disclaimer).toBe(MOCK_SEARCH_NOTICE)
    expect(out.results.length).toBe(3)
    for (const result of out.results) {
      expect(result.title).toMatch(/تجريب|توضيحي/)
      expect(result.snippet).toContain(MOCK_SEARCH_NOTICE)
      expect(new URL(result.url).hostname).toBe('market-watch.example')
      expect(result.snippet).not.toMatch(/تحديث يومي|أسعار الجملة اليوم|متوسط الأسعار/)
    }
  })

  test('bounds result count and safely encodes the query', () => {
    expect(mockSearchResponse('  شاي  ', 1).results).toHaveLength(1)
    expect(mockSearchResponse('شاي', 20).results).toHaveLength(3)
    expect(mockSearchResponse('شاي', 0).results).toHaveLength(3)
    expect(mockSearchResponse('شاي & زيت', 2).results[0].url).toContain('q=%D8%B4%D8%A7%D9%8A%20%26%20%D8%B2%D9%8A%D8%AA')
    expect(mockSearchResponse('  شاي  ', 1).query).toBe('شاي')
  })
})
