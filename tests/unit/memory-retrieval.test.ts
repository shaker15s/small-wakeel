// R76 / PR-008 — الخطة النهائية v2 §7.2 + PR table: memory & matching.
//
// «مقارنة تقيس الجودة ولا تسرب» — a FIXED retrieval benchmark (known
// corpus, known expected answers), a forget contract (memory AND index
// removed), a secrets contract (credentials never become memory), and
// cross-tenant scope on the vector search itself.
import { describe, expect, test } from 'bun:test'
import type { AgentMemory } from '@prisma/client'
import { findMemoryByReference } from '@/lib/agent/memory'
import { upsertBusinessRule } from '@/lib/agent/memory'
import { containsMemorySecret } from '@/lib/agent/memory-policy'
import { LocalVectorDB, type VectorDocument } from '@/lib/agent/vector-memory'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
function mem(id: string, text: string, kind: AgentMemory['kind'] = 'preference'): AgentMemory {
  return {
    id, businessId: 'biz-fix', userId: 'user-fix', kind, category: 'test',
    text, confidence: 80, usageCount: 0, active: true, entityRef: null,
    createdAt: new Date(), updatedAt: new Date(),
  } as unknown as AgentMemory
}

const CORPUS: AgentMemory[] = [
  mem('m1', 'أم حسن بتسدد كل خميس'),
  mem('m2', '«كمبودي» = عود كمبودي', 'lexicon'),
  mem('m3', 'الخزنة بتتقفل آخر اليوم وعدّها الكاشير'),
  mem('m4', 'ممنوع نبيّع آجل أكتر من 500 للعميل', 'rule'),
]

describe('retrieval benchmark — findMemoryByReference (fixed corpus)', () => {
  test('direct containment: «خميس» finds the paying-day memory', () => {
    expect(findMemoryByReference('خميس', CORPUS)?.id).toBe('m1')
  })
  test('article-tolerant: «الخميس» matches a memory that says «خميس»', () => {
    expect(findMemoryByReference('الخميس', CORPUS)?.id).toBe('m1')
  })
  test('significant-token containment: «كمبودي» finds the lexicon alias', () => {
    expect(findMemoryByReference('كمبودي', CORPUS)?.id).toBe('m2')
  })
  test('multi-token reference: «سداد أم حسن» finds the right memory', () => {
    expect(findMemoryByReference('سداد أم حسن', CORPUS)?.id).toBe('m1')
  })
  test('rule memory is reachable by its content: «آجل 500»', () => {
    expect(findMemoryByReference('آجل 500', CORPUS)?.id).toBe('m4')
  })
  test('NO false positive: an absent entity is not matched', () => {
    expect(findMemoryByReference('طائر نادر مش موجود', CORPUS)).toBeNull()
  })
  test('«آخر حاجة» points at the most recent memory (head of the list)', () => {
    expect(findMemoryByReference('آخر حاجة', CORPUS)?.id).toBe('m1')
  })
})

describe('vector search benchmark — fixed corpus, top-1 quality', () => {
  // fact-only corpus for the top-1 tests: the RULE baseline boost (rules are
  // never missed) is a deliberate product decision, measured in its own test.
  const FCORPUS: AgentMemory[] = [
    mem('v1', 'رصيد الخزنة الكاش وعدّ آخر اليوم', 'fact'),
    mem('v2', 'المخزون الناقص والبضاعة في الرفوف', 'fact'),
    mem('v3', 'مستحقات الموردين ومواعيد السداد', 'fact'),
    mem('v4', 'اشتراكات الأعضاء وتجديد الاشتراك', 'fact'),
    mem('v5', 'مصاريف الإيجار والكهرباء والمياه', 'fact'),
  ]

  // The fair retrieval metric is the RAW cosine similarity (true semantic
  // proximity). The combined `score` intentionally adds a rule baseline boost
  // so standing shop laws are never missed — that is a separate, deliberate
  // ranking decision measured in its own test below.
  const bestSim = (hits: { similarity: number }[]) =>
    hits.reduce((a, b) => (b.similarity > a.similarity ? b : a))

  test('«كام في الخزنة» — the cash memory is retrieved with the top similarity', async () => {
    const fresh = new LocalVectorDB()
    const hits = await fresh.searchSemantic({ businessId: 'biz-fix', userId: 'user-fix', query: 'كام في الخزنة دلوقتي؟', memories: FCORPUS, topK: 5 })
    const best = bestSim(hits)
    expect(best.doc.id).toBe('v1')
  })
  test('«إيه النواقص في المخزون» — the stock memory has the top similarity', async () => {
    const fresh = new LocalVectorDB()
    const hits = await fresh.searchSemantic({ businessId: 'biz-fix', userId: 'user-fix', query: 'إيه النواقص في المخزون؟', memories: FCORPUS, topK: 5 })
    const best = bestSim(hits)
    expect(best.doc.id).toBe('v2')
  })
  test('«اللي علينا للموردين» — the suppliers memory has the top similarity', async () => {
    const fresh = new LocalVectorDB()
    const hits = await fresh.searchSemantic({ businessId: 'biz-fix', userId: 'user-fix', query: 'اللي علينا للموردين كام؟', memories: FCORPUS, topK: 5 })
    const best = bestSim(hits)
    expect(best.doc.id).toBe('v3')
  })
  test('a standing RULE is never missed by its topic (rule baseline boost)', async () => {
    const fresh = new LocalVectorDB()
    const withRule: AgentMemory[] = [
      ...FCORPUS,
      mem('v6', 'ممنوع البيع الآجل بدون اعتماد المالك', 'rule'),
    ]
    const hits = await fresh.searchSemantic({ businessId: 'biz-fix', userId: 'user-fix', query: 'بيع آجل', memories: withRule, topK: 3 })
    expect(hits.some((h) => h.doc.id === 'v6')).toBe(true)
  })

  test('CROSS-TENANT: a query scoped to business B never returns business A docs', async () => {
    const fresh = new LocalVectorDB()
    // seed business A's scope
    await fresh.searchSemantic({ businessId: 'biz-A', userId: 'user-A', query: 'خزنة', memories: FCORPUS.map((m) => ({ ...m, businessId: 'biz-A', userId: 'user-A' })), topK: 3 })
    // business B, different user, same question
    const hits = await fresh.searchSemantic({ businessId: 'biz-B', userId: 'user-B', query: 'خزنة', topK: 8 })
    expect(hits).toEqual([])
  })
})

describe('forget contract — the index is removed, not just the row', () => {
  test('a removed document stops being retrieved', async () => {
    const fresh = new LocalVectorDB()
    const docs: Array<Omit<VectorDocument, 'vector'>> = [
      { id: 'f1', businessId: 'biz-fix', userId: 'user-fix', kind: 'preference', category: 't', text: 'أم حسن بتسدد كل خميس', importance: 0.8, usageCount: 0, updatedAtMs: Date.now() },
      { id: 'f2', businessId: 'biz-fix', userId: 'user-fix', kind: 'preference', category: 't', text: 'المصاريف بتتحسب آخر الشهر', importance: 0.8, usageCount: 0, updatedAtMs: Date.now() },
    ]
    for (const d of docs) fresh.upsertDocument(d)
    // before: the index is rebuilt over BOTH rows (as the harness does after
    // a learning pass) — f1 is retrievable.
    const rows = [mem('f1', 'أم حسن بتسدد كل خميس', 'preference'), mem('f2', 'المصاريف بتتحسب آخر الشهر', 'preference')]
    const before = await fresh.searchSemantic({ businessId: 'biz-fix', userId: 'user-fix', query: 'أم حسن بتسدد كل خميس', memories: rows, topK: 5 })
    expect(before.some((h) => h.doc.id === 'f1')).toBe(true)

    fresh.removeDocument('biz-fix', 'f1')
    // after: forget ⇒ the ACTIVE row set no longer contains f1, and the
    // removal must hold — a rebuild over the active rows never resurrects it.
    const after = await fresh.searchSemantic({ businessId: 'biz-fix', userId: 'user-fix', query: 'أم حسن بتسدد كل خميس', memories: [rows[1]], topK: 5 })
    expect(after.some((h) => h.doc.id === 'f1')).toBe(false)
    expect(after.every((h) => h.doc.id !== 'f1')).toBe(true)
  })
})

describe('secrets contract — credentials never become memory', () => {
  test('the detector catches credentials, not business talk', () => {
    expect(containsMemorySecret('كلمة السر هي 123456')).toBe(true)
    expect(containsMemorySecret('api key: sk-abcdef1234567890')).toBe(true)
    expect(containsMemorySecret('Bearer eyJhbGciOi.abc.def-123')).toBe(true)
    expect(containsMemorySecret('رمز التحقق هو 492913')).toBe(true)
    // business talk is NOT a secret
    expect(containsMemorySecret('سعر السكر ٣٠ جنيه من الموردين')).toBe(false)
    expect(containsMemorySecret('بحب الأسلوب المختصر في الردود')).toBe(false)
    expect(containsMemorySecret('أم حسن بتسدد كل خميس')).toBe(false)
  })

  test('upsertBusinessRule refuses a credential-shaped rule BEFORE it is stored', async () => {
    await expect(
      upsertBusinessRule({ businessId: 'biz-fix', userId: 'user-fix', text: 'كلمة السر الخاصة بالحساب البنكي 987654' }),
    ).rejects.toThrow()
  })
})
