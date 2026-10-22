export const MOCK_SEARCH_PROVIDER = 'wakil-mock-search'
export const MOCK_SEARCH_NOTICE =
  'بيانات تجريبية ثابتة للاختبار فقط — ليست أسعارًا حقيقية أو نتائج بحث حية، ولا تصلح لاتخاذ قرار شراء أو بيع.'

export interface MockSearchResult {
  title: string
  url: string
  snippet: string
}

export interface MockSearchResponse {
  query: string
  results: MockSearchResult[]
  provider: typeof MOCK_SEARCH_PROVIDER
  synthetic: true
  disclaimer: typeof MOCK_SEARCH_NOTICE
}

/**
 * Build a deliberately synthetic search response for the local demo.
 * Never simulate a live market quote, "today" pricing, real-source coverage,
 * or an actual market forecast. The reserved .example host reinforces that
 * these are fixtures rather than actionable web evidence.
 */
export function mockSearchResponse(query: string, requestedCount: unknown = 5): MockSearchResponse {
  const q = String(query ?? '').trim()
  const n = Math.min(10, Math.max(1, Number(requestedCount) || 5))
  const subject = q || 'طلب بحث تجريبي'

  const results: MockSearchResult[] = [
    {
      title: `نتيجة تجريبية فقط — ${subject}`,
      url: `https://market-watch.example/demo/search?q=${encodeURIComponent(q)}`,
      snippet: `${MOCK_SEARCH_NOTICE} هذه بطاقة توضيحية ثابتة وليست نتيجة مسترجعة من الإنترنت.`,
    },
    {
      title: `مصدر توضيحي غير حقيقي — ${subject}`,
      url: `https://market-watch.example/demo/source?q=${encodeURIComponent(q)}`,
      snippet: `${MOCK_SEARCH_NOTICE} النطاق .example مخصص للأمثلة؛ لم يتم الاتصال بسوق أو مورد فعلي.`,
    },
    {
      title: `تحليل عرض تجريبي — ${subject}`,
      url: `https://market-watch.example/demo/analysis?q=${encodeURIComponent(q)}`,
      snippet: `${MOCK_SEARCH_NOTICE} لا يتضمن هذا المثال أسعارًا أو تاريخًا أو توقعًا مبنيًا على بيانات حقيقية.`,
    },
  ]

  return {
    query: q,
    results: results.slice(0, n),
    provider: MOCK_SEARCH_PROVIDER,
    synthetic: true,
    disclaimer: MOCK_SEARCH_NOTICE,
  }
}
