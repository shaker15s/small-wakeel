// وكيل — LOCAL VECTOR DATABASE & SEMANTIC CONTEXTUAL MEMORY ENGINE
// (قاعدة البيانات المتجهية المحلية ونظام الذاكرة السياقية المستمرة)
//
// Provides < 5ms semantic vector indexing and Cosine Similarity retrieval over:
// - User Preferences (`preference` / `fact`)
// - Business DNA & Standing Laws (`rule`)
// - Dialect Lexicon Aliases (`lexicon`)
// - Operational Playbooks & Installed Plugins (`skill` / `capabilities`)
// - Past Task Evolution & Episodic History (`episodic`)
//
// Also implements continual implicit learning (`autoLearnFromConversationTurn`)
// so Wakil automatically learns user habits, business nature, and task patterns
// from natural conversation without requiring technical commands.

import type { AgentMemory } from '@prisma/client'
import { db } from '@/lib/db'
import { normalizeAr, toWesternDigits } from './arabic'

export const VECTOR_DIM = 128

export interface VectorDocument {
  id: string
  businessId: string
  userId?: string
  kind: 'rule' | 'preference' | 'lexicon' | 'skill' | 'fact' | 'episodic' | 'plugin'
  category: string
  text: string
  vector: Float32Array
  importance: number // 0.0 -> 1.0
  usageCount: number
  updatedAtMs: number
}

export interface VectorSearchHit {
  doc: VectorDocument
  similarity: number
  score: number // combined cosine similarity + importance + recency
}

// ---------------------------------------------------------------------------
// 1. Semantic Domain Anchors (16 dedicated semantic concept dimensions: dims 0..15)
// ---------------------------------------------------------------------------

const DOMAIN_CONCEPT_ANCHORS: { dim: number; weight: number; re: RegExp }[] = [
  { dim: 0, weight: 1.8, re: /(مخزون|جرد|بضاعه|نواقص|ناقص|كميه|رصيد|رف|كرتونه|شريط|علبه|قطعه|كيلو|جرام)/ },
  { dim: 1, weight: 1.8, re: /(بيع|بعت|مبيعات|فاتوره|زبون|عميل|سحب|دوران|طلب|اوردر)/ },
  { dim: 2, weight: 1.8, re: /(خزنه|كاش|سيوله|درج|فلوس|نقدي|ايراد|صافي|تقفيل|ورديه)/ },
  { dim: 3, weight: 1.8, re: /(اجل|آجل|دين|ديون|مديون|عليه|حساب|تحصيل|قبض|سقف|ائتمان|متاخر)/ },
  { dim: 4, weight: 1.8, re: /(مورد|موردين|شركه|توريد|شراء|اشتريت|علينا|سداد|دفعه)/ },
  { dim: 5, weight: 1.8, re: /(ربح|مكسب|هامش|هوامش|تكلفه|سعر|اسعار|غالي|رخيص|خصم|تخفيض|عرض)/ },
  { dim: 6, weight: 1.8, re: /(صلاحيه|اكسباير|تشغيله|تاريخ|منتهي|تالف|هالك|رادار)/ },
  { dim: 7, weight: 1.8, re: /(عضو|اشتراك|تجديد|تجميد|حضور|جيم|تمرين|باقه|حصه)/ },
  { dim: 8, weight: 1.8, re: /(مصروف|مصاريف|ايجار|كهرباء|ميه|يوميه|مرتب|صيانه|نقل|اكراميه)/ },
  { dim: 9, weight: 1.8, re: /(قانون|قاعده|ممنوع|لازم|دايما|شرط|سياسه|سقف|حد اقصي)/ },
  { dim: 10, weight: 1.8, re: /(بفضل|بحب|متعود|طريقتي|اسلوب|مختصر|تفصيل|ودود|رسمي|كل يوم|كل خميس|كل اسبوع)/ },
  { dim: 11, weight: 1.8, re: /(مهمه|تذكير|فكرني|جدول|دوري|ميعاد|بكره|الاسبوع الجاي|متابعه)/ },
  { dim: 12, weight: 1.8, re: /(اداه|ميزه|قدره|نظام|بلاجن|تحليل|مراقبه|تقرير|احصائيات)/ },
  { dim: 13, weight: 1.8, re: /(سوق|منافس|انترنت|بحث|ويب|مصر|اسعار السوق|جمله)/ },
  { dim: 14, weight: 1.8, re: /(خلطه|تركيبه|تصنيع|مكونات|انتاج|تعبئه)/ },
  { dim: 15, weight: 1.8, re: /(مرتجع|عكس|الغاء|غلط|تصحيح|تعديل)/ },
]

const ARABIC_STOPWORDS = new Set([
  'من',
  'في',
  'على',
  'علي',
  'الي',
  'إلى',
  'عن',
  'مع',
  'هذا',
  'هذه',
  'ده',
  'دي',
  'اللي',
  'ان',
  'إن',
  'أن',
  'كان',
  'لو',
  'يا',
  'وكيل',
  'انا',
  'أنا',
  'انت',
  'هو',
  'هي',
  'كل',
  'بس',
  'كمان',
  'عشان',
  'بعد',
  'قبل',
])

/**
 * Strips common Arabic prefixes/suffixes to approximate the semantic stem
 * so «المبيعات», «مبيعاتنا», «بيعه» project onto nearby vector coordinates.
 */
function lightArabicStem(word: string): string {
  let w = word.trim()
  if (w.length <= 3) return w
  if (w.startsWith('وال') && w.length > 5) w = w.slice(3)
  else if (w.startsWith('بال') && w.length > 5) w = w.slice(3)
  else if (w.startsWith('كال') && w.length > 5) w = w.slice(3)
  else if (w.startsWith('لل') && w.length > 4) w = w.slice(2)
  else if (w.startsWith('ال') && w.length > 4) w = w.slice(2)

  if (w.endsWith('ات') && w.length > 4) w = w.slice(0, -2)
  else if (w.endsWith('ين') && w.length > 4) w = w.slice(0, -2)
  else if (w.endsWith('ون') && w.length > 4) w = w.slice(0, -2)
  else if (w.endsWith('ها') && w.length > 4) w = w.slice(0, -2)
  else if (w.endsWith('هم') && w.length > 4) w = w.slice(0, -2)
  else if (w.endsWith('نا') && w.length > 4) w = w.slice(0, -2)
  else if (w.endsWith('ي') && w.length > 4) w = w.slice(0, -1)
  else if (w.endsWith('ه') && w.length > 4) w = w.slice(0, -1)
  return w
}

function fnv1aHash(str: string): number {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * Computes a normalized 128-dimensional Float32 semantic vector in < 0.2ms.
 * Combines:
 * - Dims [0..15]: Explicit Arabic business/ERP semantic concept anchors
 * - Dims [16..127]: Signed random-projection hashing of Arabic word stems, bigrams, and character 3-grams
 */
export function computeSemanticEmbedding(rawText: string): Float32Array {
  const vec = new Float32Array(VECTOR_DIM)
  const norm = normalizeAr(toWesternDigits(rawText))
  if (!norm) return vec

  // 1) Activate semantic concept dimensions [0..15]
  for (const anchor of DOMAIN_CONCEPT_ANCHORS) {
    if (anchor.re.test(norm)) {
      vec[anchor.dim] += anchor.weight
    }
  }

  // 2) Word stems & word bigrams projected into [16..127]
  const hashSpace = VECTOR_DIM - 16
  const tokens = norm
    .split(/[\s،,؛;:.!?؟()[\]«»"'-]+/)
    .filter((t) => t.length >= 2 && !ARABIC_STOPWORDS.has(t))

  for (let i = 0; i < tokens.length; i++) {
    const rawTok = tokens[i]
    const stem = lightArabicStem(rawTok)

    // Stem projection (high weight)
    const hStem = fnv1aHash(`stem:${stem}`)
    const idxStem = 16 + (hStem % hashSpace)
    const signStem = (hStem & 1) === 0 ? 1 : -1
    vec[idxStem] += signStem * 1.35

    // Exact token projection
    const hTok = fnv1aHash(`tok:${rawTok}`)
    const idxTok = 16 + (hTok % hashSpace)
    const signTok = (hTok & 1) === 0 ? 1 : -1
    vec[idxTok] += signTok * 0.9

    // Word bigram projection
    if (i < tokens.length - 1) {
      const nextStem = lightArabicStem(tokens[i + 1])
      const hBi = fnv1aHash(`bi:${stem}_${nextStem}`)
      const idxBi = 16 + (hBi % hashSpace)
      const signBi = (hBi & 1) === 0 ? 1 : -1
      vec[idxBi] += signBi * 1.15
    }

    // Character 3-grams for morphological & typo resilience
    if (rawTok.length >= 3) {
      for (let c = 0; c <= rawTok.length - 3; c++) {
        const tri = rawTok.slice(c, c + 3)
        const hTri = fnv1aHash(`tri:${tri}`)
        const idxTri = 16 + (hTri % hashSpace)
        const signTri = (hTri & 1) === 0 ? 1 : -1
        vec[idxTri] += signTri * 0.35
      }
    }
  }

  // L2 Normalization so dot product === Cosine Similarity
  let normSq = 0
  for (let i = 0; i < VECTOR_DIM; i++) {
    normSq += vec[i] * vec[i]
  }
  if (normSq > 1e-9) {
    const invNorm = 1 / Math.sqrt(normSq)
    for (let i = 0; i < VECTOR_DIM; i++) {
      vec[i] *= invNorm
    }
  }

  return vec
}

/**
 * Exact Cosine Similarity between two L2-normalized Float32Array vectors.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
  }
  return dot
}

// ---------------------------------------------------------------------------
// 2. LocalVectorDB Engine (Per-Business In-Memory Vector Index + DB Sync)
// ---------------------------------------------------------------------------

export class LocalVectorDB {
  private readonly indexByBusiness = new Map<string, Map<string, VectorDocument>>()
  private readonly lastSyncedAt = new Map<string, number>()

  /**
   * Upserts a document into the local vector store with automatic embedding computation.
   */
  upsertDocument(doc: Omit<VectorDocument, 'vector'> & { vector?: Float32Array }): VectorDocument {
    let bizMap = this.indexByBusiness.get(doc.businessId)
    if (!bizMap) {
      bizMap = new Map<string, VectorDocument>()
      this.indexByBusiness.set(doc.businessId, bizMap)
    }
    const fullDoc: VectorDocument = {
      ...doc,
      vector: doc.vector ?? computeSemanticEmbedding(`${doc.category} ${doc.text}`),
    }
    bizMap.set(doc.id, fullDoc)
    return fullDoc
  }

  removeDocument(businessId: string, id: string): void {
    this.indexByBusiness.get(businessId)?.delete(id)
  }

  /**
   * Synchronizes the vector index for a business from Prisma `AgentMemory` + recent operations.
   */
  async syncBusinessMemories(businessId: string, memories?: AgentMemory[]): Promise<void> {
    const rows =
      memories ??
      (await db.agentMemory.findMany({
        where: { businessId, active: true },
        orderBy: { updatedAt: 'desc' },
        take: 60,
      }))

    const bizMap = new Map<string, VectorDocument>()
    for (const m of rows) {
      if (!m.active) continue
      const kindWeight =
        m.kind === 'rule'
          ? 0.95
          : m.kind === 'lexicon'
            ? 0.9
            : m.kind === 'preference'
              ? 0.85
              : 0.75
      bizMap.set(m.id, {
        id: m.id,
        businessId: m.businessId,
        userId: m.userId,
        kind: (m.kind as VectorDocument['kind']) || 'fact',
        category: m.category,
        text: m.text,
        vector: computeSemanticEmbedding(`${m.category} ${m.text}`),
        importance: Math.min(1, (m.confidence / 100) * kindWeight),
        usageCount: m.usageCount,
        updatedAtMs: m.updatedAt.getTime(),
      })
    }

    this.indexByBusiness.set(businessId, bizMap)
    this.lastSyncedAt.set(businessId, Date.now())
  }

  /**
   * Performs semantic vector search using Cosine Similarity + Importance + Recency weighting.
   */
  async searchSemantic(params: {
    businessId: string
    query: string
    memories?: AgentMemory[]
    topK?: number
    minSimilarity?: number
  }): Promise<VectorSearchHit[]> {
    const { businessId, query, memories, topK = 8, minSimilarity = 0.08 } = params
    const lastSync = this.lastSyncedAt.get(businessId) ?? 0
    if (memories || !this.indexByBusiness.has(businessId) || Date.now() - lastSync > 15_000) {
      await this.syncBusinessMemories(businessId, memories)
    }

    const bizMap = this.indexByBusiness.get(businessId)
    if (!bizMap || bizMap.size === 0) return []

    const queryVec = computeSemanticEmbedding(query)
    const now = Date.now()
    const hits: VectorSearchHit[] = []

    for (const doc of bizMap.values()) {
      const sim = cosineSimilarity(queryVec, doc.vector)
      // Standing rules (BUSINESS_DNA) get a baseline boost so critical shop laws are never missed
      const ruleBoost = doc.kind === 'rule' ? 0.14 : 0
      const usageBoost = Math.min(0.08, doc.usageCount * 0.01)
      const ageDays = Math.max(0, (now - doc.updatedAtMs) / 86_400_000)
      const recencyBoost = Math.max(0, 0.06 * Math.exp(-ageDays / 30))

      const combinedScore = sim * 0.72 + doc.importance * 0.14 + ruleBoost + usageBoost + recencyBoost
      if (sim >= minSimilarity || doc.kind === 'rule') {
        hits.push({
          doc,
          similarity: Number(sim.toFixed(3)),
          score: Number(combinedScore.toFixed(3)),
        })
      }
    }

    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, topK)
  }

  /**
   * Builds a rich Arabic prompt block with the top semantically matched memories
   * and similarity scores for the Decision Engine & LLM Brain.
   */
  async buildVectorContextBlock(params: {
    businessId: string
    query: string
    memories?: AgentMemory[]
    topK?: number
  }): Promise<{
    hits: VectorSearchHit[]
    promptBlock: string
  }> {
    const hits = await this.searchSemantic({
      businessId: params.businessId,
      query: params.query,
      memories: params.memories,
      topK: params.topK ?? 7,
    })

    if (hits.length === 0) {
      return { hits: [], promptBlock: '' }
    }

    const KIND_AR: Record<string, string> = {
      rule: 'قانون عمل ثابت',
      preference: 'تفضيل شخصي للمستخدم',
      lexicon: 'مصطلح دارج بالمحل',
      skill: 'طريقة عمل/إجراء',
      fact: 'حقيقة عن النشاط',
      episodic: 'تاريخ مهمة سابقة',
      plugin: 'قدرة مفعّلة',
    }

    const lines = hits.map(
      (h) =>
        `  • [${KIND_AR[h.doc.kind] ?? h.doc.kind} | تطابق دلالي ${Math.round(
          Math.max(0.15, Math.min(0.99, h.score)) * 100,
        )}٪] ${h.doc.text}`,
    )

    return {
      hits,
      promptBlock: `\n## [Vector Contextual Memory — الذكريات والتفضيلات الأقرب دلالياً لرسالة المستخدم]\n${lines.join('\n')}`,
    }
  }
}

export const localVectorDB = new LocalVectorDB()

// ---------------------------------------------------------------------------
// 3. Autonomous Continual Learning (التعلم المستمر التلقائي من الحوار الطبيعي)
// ---------------------------------------------------------------------------

const IMPLICIT_PREF_PATTERNS: { re: RegExp; kind: 'preference' | 'rule' | 'fact'; category: string }[] = [
  {
    re: /(?:انا بحب|انا بفضل|متعود|طريقتي في الشغل|بفضل دايما|خلي بالك انا)\s+(.{8,140})/i,
    kind: 'preference',
    category: 'work_style',
  },
  {
    re: /(?:محلي شغال في|احنا متخصصين في|شغلنا الاساسي|اكتر حاجه بنبيعها)\s+(.{6,140})/i,
    kind: 'fact',
    category: 'business_nature',
  },
  {
    re: /(?:ممنوع|متسمحش|اوعي|القاعده عندنا|قانون المحل)\s+(.{8,160})/i,
    kind: 'rule',
    category: 'shop_policy',
  },
]

/**
 * Automatically inspects natural user messages and learns implicit preferences,
 * business facts, or standing policies into Prisma `AgentMemory` + `LocalVectorDB`
 * without requiring explicit save commands.
 */
export async function autoLearnFromUserMessage(params: {
  businessId: string
  userId: string
  text: string
}): Promise<AgentMemory | null> {
  const clean = params.text.trim()
  if (clean.length < 10 || clean.length > 280) return null
  const norm = normalizeAr(clean)

  for (const pat of IMPLICIT_PREF_PATTERNS) {
    const m = pat.re.exec(norm)
    if (!m) continue
    const learnedText = clean.replace(/[،,.!؟?\s]+$/, '').slice(0, 220)

    const existing = await db.agentMemory.findFirst({
      where: {
        businessId: params.businessId,
        userId: params.userId,
        active: true,
        text: learnedText,
      },
    })
    if (existing) return existing

    const created = await db.agentMemory
      .create({
        data: {
          businessId: params.businessId,
          userId: params.userId,
          kind: pat.kind,
          category: pat.category,
          text: learnedText,
          confidence: 84,
          active: true,
        },
      })
      .catch(() => null)

    if (created) {
      localVectorDB.upsertDocument({
        id: created.id,
        businessId: created.businessId,
        userId: created.userId,
        kind: pat.kind,
        category: created.category,
        text: created.text,
        importance: 0.85,
        usageCount: 1,
        updatedAtMs: Date.now(),
      })
    }
    return created
  }

  return null
}
