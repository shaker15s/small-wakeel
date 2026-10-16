// وكيل — THE 5-LAYER MEMORY ENGINE.
//
// Layers (per the master research PDF):
//   1. BUSINESS_DNA rules   (kind='rule')    — permanent shop laws from the owner:
//        «لما أقولك أوجمنتين اكتبها على حساب الحاج عبد الفتاح بس متزودش عن 457»
//        Injected in the system prompt («قوانين المحل — لازم تتبع») AND enforced
//        in write resolution (credit-limit danger notes on drafts).
//   2. LEXICON aliases      (kind='lexicon') — dialect names the user calls
//        entities: ««ود المسك» = مسك غزال». Checked FIRST in entity resolution.
//   3. PREFERENCES          (kind='preference') — «احفظ إني بحب أسدد كل خميس».
//   4. FACTS                (kind='fact')    — seeded business facts.
//   5. EPISODIC/insight     (kind='insight') — reserved.
//
// Also owns: FORGET («انسى …»), usageCount tracking, and the live business
// snapshot the advisory mode + suggestions engine are grounded in.
// Every number here comes from the REAL database — zero hallucination.

import type { AgentMemory, Business } from '@prisma/client'
import { db } from '@/lib/db'
import { egp } from '@/lib/format'
import { normalizeAr, toWesternDigits, matchEntity, wordBoundedAt } from './arabic'
import { startOfCairoDay } from '@/app/api/_lib/dates'

// ---------------------------------------------------------------------------
// Detection regexes — Egyptian Arabic, tolerant of hamza/diacritics via
// normalizeAr (regexes run on NORMALIZED text: no أ/إ/آ, no ة, no tashkeel).
// ---------------------------------------------------------------------------

/** «احفظ …» / «خليك فاكر …» / «أنا بفضل …» — the R13 preference path (verbatim). */
// «افتكر إن أم حسن بتسدد كل أول شهر» — the owner names a THIRD PARTY, so the
// trigger is «افتكر إن …», not only the first-person «افتكر إني …» (live R29:
// this fell to free chat and nothing was remembered).
export const MEMORY_SAVE_RE = /(احفظ|خليك فاكر|افتكر|اتعلم|خد بالك من|مانساش)/

/** R18 hijack guard: a message carrying BOTH a write verb and a number is
 *  WORK («حسن اشترى بـ١٠٠ دفع ٤٠ والباقي... خليك فاكر الميعاد وذكرني») —
 *  the BRAIN LOOP owns it: the model itself splits the tasks (record_sale /
 *  memory_save / schedule_task). Only PURE save requests («احفظ إني بحب أسدد
 *  كل خميس» — a verb but zero digits) stay on the deterministic memory path. */
const WORK_BEARING_RE = /(اشتر[ىي]|بعت|بع |بيع|دفع|سدد|حصل|قبض|استلم|سلم|خد)/
const DIGIT_RE = /[\d٠-٩]/

const FORGET_KEYWORDS = ['انسى', 'انسي', 'امسح من ذاكرتك', 'امسحها من ذاكرتك', 'بطل فاكر', 'بطل تفكر', 'انسها', 'امسح الكلام ده', 'امسح الذكرى دي']
const FORGET_RE = /(انسى|انسي|امسح من ذاكرتك|بطل فاكر|بطل تفكر|انسها|امسحها)/

/** Conditional trigger words that mark a PERMANENT shop rule (not a one-off op). */
const RULE_CONDITION_RE = /(^|\s)(لما|لو|اي حد|اي زبون|اي عميل|اي واحد|عموما|دايما|دائما|عمر|ممنوع|مستحيل|قانون)/
/** Consequence words — what the rule demands/forbids. */
const RULE_CONSEQUENCE_RE = /(اعمل|قول|اكتب|سيب|متزودش|متبعتش|متخصمش|متسيبش|متخليش|خصم|سقف|حد اقصي|اجل|ازود|تزود|تسلف|سلفه|نسيون|امسح|اعتمد)/

/** Interrogative shapes — «اعمل ايه», «اقول ايه», a trailing ؟… A QUESTION is
 * never a shop rule, even when it carries لو + اعمل («اعمل ايه لو العميل
 * متأخر في السداد؟» is advisory, NOT a law). */
const QUESTION_SHAPE_RE = /اعمل ايه|اعمل ايه|اقول ايه|قول ايه|ايه اعمل|هل |ايه رأي|ايه رايك|؟|\?/

/** A text is a BUSINESS_DNA rule when it has BOTH a condition and a consequence. */
export function isRuleText(norm: string): boolean {
  if (QUESTION_SHAPE_RE.test(norm)) return false
  return RULE_CONDITION_RE.test(norm) && RULE_CONSEQUENCE_RE.test(norm)
}

/** Direct prohibitions are rules even without a conditional («متزودش آجل لحد كذا»). */
const RULE_STANDALONE_RE = /(متزودش|متبعتش|متخصمش|ممنوع|الحد الاقصي|سقف|متخليش)/

/** Classify a rule into a category (drives the MemoryView grouping). */
export function ruleCategory(norm: string): string {
  if (/(زود|تزود|سقف|حد اقصي|رصيد|مديون|اجل|نسيون|خصم)/.test(norm)) return 'credit_limits'
  if (/(اشتراك|عضويه|تجديد|تجميد|تجميد)/.test(norm)) return 'membership_policies'
  if (/(سعر|اسعار|غلي|رخيص|خصم|تخفيض)/.test(norm)) return 'pricing'
  if (/(فتح|اقفل|ورديه|صبح|بالليل)/.test(norm)) return 'working_hours'
  return 'general'
}

/** Category for plain preferences («بحب أسدد كل خميس» → billing). */
export function preferenceCategory(norm: string): string {
  if (/(سداد|سدد|مورد|فاتوره|خميس|جمعه|كل شهر|دفعة)/.test(norm)) return 'billing'
  if (/(اشتراك|عضويه|تجديد)/.test(norm)) return 'membership_policies'
  if (/(سعر|اسعار|خصم|تخفيض)/.test(norm)) return 'pricing'
  if (/(زبون|عميل|خدمه|كلام|تعامل)/.test(norm)) return 'customer_service'
  return 'general'
}

const DIACRITICS = '[\\u064B-\\u0652\\u0670\\u0640]*'
const CHAR_ALTS: Record<string, string> = { ا: '[اأإآٱ]', ي: '[يى]', ه: '[هة]' }

/** Keyword → regex that tolerates diacritics/hamza variants in the ORIGINAL text. */
function flexiblePattern(kw: string): RegExp {
  const parts = Array.from(kw).map((c) => CHAR_ALTS[c] ?? c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(parts.join(DIACRITICS))
}

export interface SaveRequest {
  kind: 'preference' | 'rule'
  category: string
  text: string
  confidence: number
}

/**
 * Extract a to-remember text from «احفظ اني…» / «خليك فاكر…» style requests,
 * keeping the user's own words. Classifies rule vs preference + category.
 * Returns null when nothing memorable follows the keyword.
 */
export function extractSaveRequest(text: string, norm: string): SaveRequest | null {
  if (!MEMORY_SAVE_RE.test(norm) || norm.length > 260) return null
  // R18: compound work + memory ask → the brain handles the memory itself
  if (WORK_BEARING_RE.test(norm) && DIGIT_RE.test(toWesternDigits(norm))) return null
  // A QUESTION that merely starts with «افتكر» («افتكر إن أم حسن بتسدد إمتى؟») is
  // a lookup, not a save.
  if (/[؟?]/.test(text) && /(امتي|امتى|إمتى|كام|قد\s*ايه|قدايه|مين|فين|ازاي|إزاي|ليه|ليش|هو كام)/.test(norm)) return null
  for (const kw of ['خليك فاكر اني', 'خليك فاكر', 'افتكر اني', 'افتكر', 'احفظ', 'انا بفضل', 'بستحب', 'اتعلم']) {
    const m = flexiblePattern(kw).exec(text)
    if (!m) continue
    const raw = text.slice(m.index + m[0].length)
    const cleaned = raw
      .replace(/^[،,.\s]+/, '')
      .replace(/^(?:لي\s+)?(?:اني|إني|أني|ان|إن)\s+/, '')
      .replace(/[،,.!؟?\s]+$/, '')
      .trim()
      .slice(0, 200)
    if (cleaned.length < 3) return null
    const cleanedNorm = normalizeAr(cleaned)
    if (isRuleText(cleanedNorm) || RULE_STANDALONE_RE.test(cleanedNorm)) {
      return { kind: 'rule', category: ruleCategory(cleanedNorm), text: cleaned, confidence: 85 }
    }
    return { kind: 'preference', category: preferenceCategory(cleanedNorm), text: cleaned, confidence: 80 }
  }
  return null
}

/** Strong research IMPERATIVES — asking the agent to GO STUDY something. Kept
 * local & narrow (strong verbs only, no weak triggers like «سوق/ليه») so a real
 * rule containing «سوق» («أي حاجة من السوق العتيق متزودش فيها آجل») is still
 * saved as a rule, while «ادرسلي الأسعار وقولي…» routes to deep research. */
const RESEARCH_IMPERATIVE_RE = /(ادرس|ابحث|حلل|قارن|دراسه|استراتيجيه|مقارنه)/

/**
 * Detect a bare rule declaration without an explicit «احفظ»:
 * «لما أقولك أوجمنتين اكتبها على حساب الحاج عبد الفتاح بس متزودش عن 457».
 * Gated hard (condition + consequence in the SAME message) so real writes
 * («اكتب 2 أوجمنتين على حساب الحاج عبد الفتاح») never fire it.
 */
export function extractRuleRequest(text: string, norm: string): SaveRequest | null {
  if (QUESTION_SHAPE_RE.test(norm)) return null
  // R16 fix: a research request («ادرسلي أسعار المنظفات وقولي لو في فرصة
  // توفير») carries «لو» (condition) + «وقولي» (→ «قول» consequence substring)
  // and USED to be hijacked into a saved shop rule — killing the deep-research
  // pass and the owner's tools with it. A research imperative means the owner
  // is ASKING for work, not declaring a standing law; an explicit
  // «احفظ/خليك فاكر» still wins because extractSaveRequest runs FIRST in the
  // harness (?? chain) before this bare-rule detector.
  if (RESEARCH_IMPERATIVE_RE.test(norm)) return null
  if (!isRuleText(norm) && !RULE_STANDALONE_RE.test(norm)) return null
  if (norm.length > 260) return null
  // A rule never contains an actual quantity-bearing sale command («بعت 5 …»)
  if (/(بعت|بع |بيع|خرج|سدد|حصل|قبض)/.test(norm)) return null
  const cleaned = text.trim().replace(/[،,.!؟?\s]+$/, '').slice(0, 200)
  if (cleaned.length < 10) return null
  return { kind: 'rule', category: ruleCategory(norm), text: cleaned, confidence: 85 }
}

export interface ForgetRequest {
  reference: string
}

/** «انسى إنك …» / «امسح من ذاكرتك …» — returns the reference to forget. */
export function extractForgetRequest(text: string, norm: string): ForgetRequest | null {
  if (!FORGET_RE.test(norm) || norm.length > 200) return null
  for (const kw of FORGET_KEYWORDS) {
    const m = flexiblePattern(kw).exec(text)
    if (!m) continue
    const raw = text
      .slice(m.index + m[0].length)
      .replace(/^[،,.\s]+/, '')
      .replace(/^(?:انك|اني|إنك|إني|اللي|كلام|حاجة|الذكرى دي|ذكرى|من ذاكرتك)?[،,\s]*/, '')
      .replace(/[،,.!؟?\s]+$/, '')
      .trim()
    const reference = raw.length >= 2 ? raw.slice(0, 120) : 'آخر حاجة'
    return { reference }
  }
  return null
}

/** Filler words in a forget-reference that carry NO entity signal —
 * «انسى اللي قلته عن كمبودي» is about كمبودي, not about عن. */
const REFERENCE_FILLER_RE = /^(قلته|قاله|قالتها|كلامك|كلامي|حاجة|حاجه|عن|علي|عليها|عليه|في|من|مع|اللي|التي|دي|ده|انك|اني|بتاع|كدا)$/i

/** Find the active memory the forget-reference points at (fuzzy, tolerant). */
export function findMemoryByReference(
  reference: string,
  memories: AgentMemory[],
): AgentMemory | null {
  if (reference === 'آخر حاجة' || reference === '') return memories[0] ?? null
  const q = normalizeAr(reference)
  // 1) direct containment — «انسى اللي قلته عن الخميس» hits a memory mentioning الخميس
  for (const m of memories) {
    const t = normalizeAr(m.text)
    if (t.includes(q) || q.includes(t)) return m
  }
  // 1.5) significant-token containment — the reference's meaningful word
  // appears INSIDE a memory's text («كمبودي» → ««كمبودي» = عود كمبودي»)
  const bare = (w: string) => (w.startsWith('ال') && w.length > 4 ? w.slice(2) : w)
  const refTokens = q
    .split(' ')
    .filter((w) => w.length >= 3 && !REFERENCE_FILLER_RE.test(bare(w)))
    .map(bare)
  if (refTokens.length > 0) {
    for (const m of memories) {
      const t = normalizeAr(m.text)
      if (refTokens.some((tok) => t.includes(tok))) return m
    }
  }
  // 2) fuzzy entity-style match
  const best = matchEntity(reference, memories.map((m) => ({ name: m.text })))
  if (best && best.score >= 0.5) return memories.find((m) => m.text === best.entity.name) ?? null
  // 3) token overlap — any 2 significant shared words (ال-prefix tolerant:
  // «الخميس» matches a memory that says «خميس» — Arabs glue the article on)
  if (refTokens.length > 0) {
    for (const m of memories) {
      const tTokens = new Set(normalizeAr(m.text).split(' ').filter((w) => w.length >= 3).map(bare))
      let hits = 0
      for (const t of refTokens) if (tTokens.has(t)) hits++
      if (hits >= Math.min(2, refTokens.length)) return m
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// LEXICON — dialect aliases resolve to canonical entities FIRST
// ---------------------------------------------------------------------------

export interface LexiconEntry {
  id: string
  alias: string // «ود المسك»
  entityRef: string
  displayName: string // «مسك غزال»
}

/** Parse lexicon memories (««alias» = canonical») into lookup entries. */
export function parseLexicon(memories: AgentMemory[]): LexiconEntry[] {
  const out: LexiconEntry[] = []
  for (const m of memories) {
    if (m.kind !== 'lexicon' || !m.active) continue
    const aliasMatch = m.text.match(/«([^»]+)»/)
    const alias = (aliasMatch?.[1] ?? m.text.split('=')[0]).trim()
    const display = (m.text.split('=')[1] ?? '').trim() || m.text
    if (alias.length >= 2 && m.entityRef) {
      out.push({ id: m.id, alias: normalizeAr(alias), entityRef: m.entityRef, displayName: display })
    }
  }
  return out
}

/* ---------------------------------------------------------------- lexicon QA */
/**
 * Words that name a CATEGORY of goods, never one specific item. A learned alias
 * like «شوكولاتة» = «كوكاكولا 1 لتر» is not a dialect shortcut, it is a wrong
 * sale: the owner says chocolate, the draft bills a cola (live R29 — the demo DB
 * shipped exactly that row). Category words are refused at learn time and
 * pruned at load time.
 */
const ALIAS_CATEGORY_WORDS = new Set([
  'شوكولاته', 'شوكولاطه', 'بسكوت', 'شيبسي', 'شيبس', 'حلوي', 'حلويات', 'سكاكر', 'لبان', 'ايس كريم', 'ايسكريم',
  'مياه', 'ميه', 'عصير', 'مشروب', 'مشروبات', 'مشروب غازي', 'كولا', 'صودا', 'شاي', 'قهوه', 'سكر', 'ملح', 'دقيق',
  'رز', 'مكرونه', 'زيت', 'سمن', 'زبده', 'جبن', 'جبنه', 'البن', 'لبن', 'زبادي', 'بيض', 'عيش', 'خبز', 'فينو',
  'لحمه', 'فراخ', 'سمك', 'معلبات', 'تونة', 'صلصه', 'مكرونة', 'بهارات', 'توابل', 'فلفل', 'كمون', 'كركم', 'قرفه',
  'صابون', 'مناديل', 'معجون', 'فرشه', 'شامبو', 'مطهر', 'كلور', 'مسحوق', 'منظف', 'حفاضات', 'فوط',
  'دوا', 'دواء', 'ادويه', 'شراب', 'اقراص', 'كبسولات', 'فيتامين', 'فيتامينات', 'مسكن', 'مضاد', 'مضاد حيوي',
  'مرهم', 'قطره', 'بخاخ', 'مستلزمات', 'اكسسوار', 'بروتين', 'كرياتين', 'مكمل',
  'ورد', 'زهور', 'بخور', 'دهن', 'عطر', 'زيوت', 'اعشاب', 'مطحون', 'مجفف', 'بودره', 'خلطه',
])

/** First `n` characters shared by both normalized strings. */
function commonPrefix(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

/**
 * «Does this alias plausibly belong to THIS entity name?» — the single rule that
 * keeps a dirty/legacy lexicon from turning into a wrong sale. True when the
 * name contains the alias (≥4 chars), the alias contains the name, or the two
 * share a ≥4-char head («جهينه» ↔ «جهينة ١ لتر», «كوكا» ↔ «كوكاكولا»).
 */
export function aliasFitsEntity(aliasRaw: string, entityNameRaw: string): boolean {
  const a = normalizeAr(aliasRaw).trim()
  const n = normalizeAr(entityNameRaw).trim()
  if (a.length < 3 || n.length < 3) return false
  if (ALIAS_CATEGORY_WORDS.has(a)) return false
  if (a === n) return true
  if (n.includes(a) && a.length >= 4) return true
  if (a.includes(n)) return true
  if (commonPrefix(a, n) >= 4) return true
  // multi-word name whose HEAD is the alias («شيبسي» → «شيبسي عائلي 150 جم»)
  const head = n.split(' ')[0]
  return head === a || (head.length >= 4 && commonPrefix(a, head) >= 4)
}

/**
 * Load-time verification: keep a lexicon row only if its alias still fits the
 * entity's CURRENT name, no other catalog entity competes for it, and it is not
 * a person's name. Self-healing on a legacy DB — the bad row never resolves
 * again, even before a human deletes it.
 */
export function pruneLexicon(
  entries: LexiconEntry[],
  entities: { id: string; name: string; aliases?: string | null }[],
  partyNames: string[] = [],
): LexiconEntry[] {
  const flat = (x: string) => normalizeAr(x).replace(/\s+/g, ' ').trim()
  const parties = new Set(partyNames.map(flat))
  const out: LexiconEntry[] = []
  for (const e of entries) {
    const entity = entities.find((x) => x.id === e.entityRef)
    if (!entity) continue
    if (!aliasFitsEntity(e.alias, entity.name)) continue
    // a person's name is never an item alias: exact, or the alias is the FIRST
    // word of a party name («أحمد» → «أحمد عبد الرحمن» — the demo DB shipped
    // «أحمد» = «قهوة أحمد» and it captured the owner's own customer)
    if (parties.has(flat(e.alias))) continue
    const aliasNorm = flat(e.alias)
    if (!aliasNorm.includes(' ') && aliasNorm.length >= 4 && [...parties].some((p) => p.split(' ')[0] === aliasNorm)) continue
    // ambiguity: ≥2 catalog entities answer to the same alias → ask, never guess
    const claims = entities.filter((x) => {
      const names = [x.name, ...(x.aliases ? x.aliases.split(',').map((a) => a.trim()) : [])]
      return names.some((nm) => flat(nm).includes(flat(e.alias)))
    })
    if (claims.length > 1) continue
    out.push(e)
  }
  return out
}

/** Lexicon-first resolution: does the user's normalized text contain a known alias? */
export function lexiconResolve<T extends { id: string; name?: string; aliases?: string | null }>(
  norm: string,
  lexicon: LexiconEntry[],
  candidates: T[],
): { entity: T; entry: LexiconEntry } | null {
  for (const entry of lexicon) {
    if (entry.alias.length < 3) continue
    // word-bounded: «شوكولاتة» contains «كولا» — a raw includes() turned a
    // chocolate sentence into a Coca-Cola sale (live R29)
    if (wordBoundedAt(norm, entry.alias) < 0) continue
    const entity = candidates.find((c) => c.id === entry.entityRef)
    if (!entity) continue
    // Defence in depth: even an un-pruned entry may not claim an entity it does
    // not describe («شوكولاتة» ↛ «كوكاكولا 1 لتر»).
    if (entity.name && !aliasFitsEntity(entry.alias, entity.name)) continue
    return { entity, entry }
  }
  return null
}

/** Tokens that are NEVER a dialect alias (sale verbs, units, money words). */
const ALIAS_STOPWORDS = /^(بعت|بعته|بيع|سجل|اكتب|قول|جم|جرام|كيلو|مللي|لتر|علبه|علب|قطعه|شريط|للعميل|عميل|زبون|من|علي|للحاج|الحاج|مدام|الدكتور|كابتن|بجنيه|جنيه|جنيهات|ج|بالاجل|اجل|آجل|نقدا|بس|فقط|تمام)$/ 

/**
 * Learn a dialect alias: a user token that strongly overlaps a canonical name
 * (inclusion) without being an exact known name/alias.
 * «شيبسي عائلي» → «شيبسي عائلي 150جم», «كركم المطحون» → «كركم».
 * Tokens carrying digits (the «ب20» of a reverse-sell price) and money words
 * are junk — never learned.
 */
export function learnableAlias(
  userText: string,
  entity: { name: string; aliases?: string | null },
  opts?: { others?: string[]; partyNames?: string[] },
): string | null {
  const flat = (x: string) => normalizeAr(x).replace(/\s+/g, ' ').trim()
  const otherNames = (opts?.others ?? []).map(flat).filter((x) => x.length >= 3)
  const partyNames = (opts?.partyNames ?? []).map(flat).filter((x) => x.length >= 3)
  const clashes = (t: string): boolean => {
    const tn = flat(t)
    if (ALIAS_CATEGORY_WORDS.has(tn)) return true
    if (partyNames.some((p) => p === tn || p.includes(tn) || tn.includes(p))) return true
    return otherNames.some((o) => o === tn)
  }
  const known = [entity.name, ...(entity.aliases ? entity.aliases.split(',').map((a) => a.trim()) : '')]
    .map((n) => normalizeAr(String(n)))
    .filter((n) => n.length >= 3)
  if (known.length === 0) return null
  // candidates keep the user's ORIGINAL spelling («جهينة» not «جهينه») — the
  // lexicon text is displayed to the user; matching happens post-normalizeAr
  const rawTokens = toWesternDigits(userText)
    .split(/[\s،,؛;]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !/[0-9]/.test(w) && !ALIAS_STOPWORDS.test(normalizeAr(w)))
  // single words + adjacent pairs («شيبسي عائلي»)
  const candidates = [...rawTokens]
  for (let i = 0; i < rawTokens.length - 1; i++) candidates.push(`${rawTokens[i]} ${rawTokens[i + 1]}`)
  for (const t of candidates) {
    const tn = normalizeAr(t)
    if (tn.length < 2 || known.includes(tn)) continue
    // A category word, a person's name or a token another item already answers
    // to is never learned as this item's alias (live R29 bug class).
    if (clashes(t)) continue
    for (const kn of known) {
      if (kn === tn) continue
      if (kn.includes(tn) && tn.length >= 4) return t
      if (tn.includes(kn) && tn.length - kn.length <= 6) return t
      if (commonPrefix(kn, tn) >= 4) return t
    }
  }
  return null
}

/** Which lexicon rows are junk for this catalog? (used by scripts/db-prune-lexicon) */
export function staleLexiconRows(
  rows: { id: string; text: string; entityRef: string | null }[],
  entities: { id: string; name: string; aliases?: string | null }[],
  partyNames: string[] = [],
): string[] {
  const entries: LexiconEntry[] = rows
    .filter((r) => r.entityRef)
    .map((r) => ({
      id: r.id,
      alias: normalizeAr((r.text.match(/«([^»]+)»/)?.[1] ?? r.text.split('=')[0]).trim()),
      entityRef: r.entityRef as string,
      displayName: (r.text.split('=')[1] ?? '').trim(),
    }))
  const keep = new Set(pruneLexicon(entries, entities, partyNames).map((e) => e.id))
  return rows.filter((r) => !keep.has(r.id)).map((r) => r.id)
}

/** Persist a learned lexicon memory (deduped by entityRef + alias text). */
export async function saveLexiconMemory(
  params: { businessId: string; userId: string },
  alias: string,
  entity: { id: string; name: string },
): Promise<void> {
  const text = `«${alias}» = ${entity.name}`
  const existing = await db.agentMemory.findFirst({
    where: { businessId: params.businessId, kind: 'lexicon', entityRef: entity.id },
  })
  if (existing && normalizeAr(existing.text).includes(normalizeAr(alias))) return
  if (existing) {
    // same entity, new dialect name → keep one row with both names
    await db.agentMemory.update({
      where: { id: existing.id },
      data: { text: `${existing.text} / «${alias}»`, active: true, updatedAt: new Date() },
    })
    return
  }
  await db.agentMemory.create({
    data: {
      businessId: params.businessId,
      userId: params.userId,
      kind: 'lexicon',
      category: 'aliases',
      text,
      entityRef: entity.id,
      confidence: 70,
    },
  })
}

// ---------------------------------------------------------------------------
// BUSINESS_DNA rules → credit-limit enforcement on drafts
// ---------------------------------------------------------------------------

export interface CreditLimitCheck {
  rule: AgentMemory
  limitPiastres: number
  projectedPiastres: number
  warning: string
}

const NAME_STOPWORDS = new Set(['اللي', 'التي', 'بتاع', 'دي', 'ده', 'على', 'علي', 'حساب', 'بس', 'متزودش', 'عن', 'لحد', 'اقصي', 'كدا', 'قول', 'اكتب'])

/**
 * If an active rule caps what the named party may owe, return the parsed limit.
 * The rule must MENTION the party (name words) and contain a money number —
 * the LAST number in the rule is the cap (Egyptian users state the cap last:
 * «… بس متزودش عن 457»).
 */
export function creditLimitFor(
  rules: AgentMemory[],
  party: { name: string },
  projectedPiastres: number,
): CreditLimitCheck | null {
  const partyWords = normalizeAr(party.name)
    .split(' ')
    .flatMap((w) => (w.startsWith('ال') && w.length > 4 ? [w.slice(2), w] : [w]))
    .filter((w) => w.length >= 3 && !NAME_STOPWORDS.has(w))
  if (partyWords.length === 0) return null
  for (const rule of rules) {
    const t = normalizeAr(rule.text)
    // party mentioned?
    const mentionsParty = partyWords.some((w) => t.includes(w))
    if (!mentionsParty) continue
    if (!/(زود|سقف|حد اقصي|رصيد|مديون|اجل|نسيون)/.test(t)) continue
    // last number = the cap, in EGP (users never state piastres in laws)
    const nums = toWesternDigits(t).match(/\d+(?:[.,]\d+)?/g)
    if (!nums || nums.length === 0) continue
    const capEgp = parseFloat(nums[nums.length - 1].replace(',', '.'))
    if (!Number.isFinite(capEgp) || capEgp <= 0) continue
    const limitPiastres = Math.round(capEgp * 100)
    if (projectedPiastres <= limitPiastres) continue
    return {
      rule,
      limitPiastres,
      projectedPiastres,
      warning: `⚠️ قانونك: «${rule.text.slice(0, 90)}${rule.text.length > 90 ? '…' : ''}» — العملية دي هتوصل رصيد ${party.name} لـ${egp(projectedPiastres)} (القانون: ${egp(limitPiastres)})`,
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// usageCount tracking — every memory actually referenced in a reply gets hit
// ---------------------------------------------------------------------------

export async function bumpMemoryUsage(ids: string[]): Promise<void> {
  const unique = [...new Set(ids)].filter(Boolean)
  if (unique.length === 0) return
  await Promise.all(
    unique.map((id) => db.agentMemory.update({ where: { id }, data: { usageCount: { increment: 1 } } }).catch(() => null)),
  )
}

// ---------------------------------------------------------------------------
// Live business snapshot — REAL numbers for advisory + suggestions + radar
// ---------------------------------------------------------------------------

export interface BusinessSnapshot {
  salesToday: number // piastres
  collectionsToday: number
  expensesToday: number
  netToday: number // sales + collections - expenses
  cash: number // current drawer balance
  lowStockCount: number
  lowStockTop?: string | null
  receivablesTotal: number
  receivablesTop?: { name: string; balance: number } | null
  pendingCount: number
  expiringCount: number
  expiringTop?: string | null
  expiringMembers: { name: string; daysLeft: number }[] // gym
}

export async function getSnapshot(business: Business): Promise<BusinessSnapshot> {
  const today = startOfCairoDay(0)
  const [opsToday, cashEntries, items, customers, pendingCount] = await Promise.all([
    db.operation.findMany({ where: { businessId: business.id, status: 'SUCCEEDED', createdAt: { gte: today } }, select: { type: true, payload: true } }),
    db.cashEntry.findMany({ where: { businessId: business.id }, select: { direction: true, amount: true } }),
    db.item.findMany({ where: { businessId: business.id }, select: { name: true, stockQty: true, lowStockThreshold: true, expiresAt: true } }),
    db.customer.findMany({ where: { businessId: business.id }, select: { name: true, balance: true, expiresAt: true } }),
    db.operation.count({ where: { businessId: business.id, status: 'AWAITING_APPROVAL' } }),
  ])
  const sumOf = (type: string) =>
    opsToday
      .filter((o) => o.type === type)
      .reduce((s, o) => {
        try {
          const p = JSON.parse(o.payload) as Record<string, unknown>
          const key = 'total' in p ? 'total' : 'amount'
          return s + Number(p[key] ?? 0)
        } catch {
          return s
        }
      }, 0)
  const salesToday = sumOf('sale') + sumOf('membership')
  const collectionsToday = sumOf('collection')
  const expensesToday = sumOf('expense')
  const inn = cashEntries.filter((e) => e.direction === 'in').reduce((s, e) => s + e.amount, 0)
  const out = cashEntries.filter((e) => e.direction === 'out').reduce((s, e) => s + e.amount, 0)
  const low = items.filter((it) => it.stockQty <= it.lowStockThreshold)
  const receivables = customers.filter((c) => c.balance > 0).sort((a, b) => b.balance - a.balance)
  const expiring = items.filter((it) => {
    if (!it.expiresAt) return false
    return Math.ceil((it.expiresAt.getTime() - Date.now()) / 86400000) <= 30
  })
  const expiringMembers = customers
    .filter((c) => c.expiresAt)
    .map((c) => ({ name: c.name, daysLeft: Math.ceil((c.expiresAt!.getTime() - Date.now()) / 86400000) }))
    .filter((c) => c.daysLeft <= 5)
    .sort((a, b) => a.daysLeft - b.daysLeft)
  return {
    salesToday,
    collectionsToday,
    expensesToday,
    netToday: salesToday + collectionsToday - expensesToday,
    cash: business.openingCash + inn - out,
    lowStockCount: low.length,
    lowStockTop: low[0]?.name ?? null,
    receivablesTotal: receivables.reduce((s, c) => s + c.balance, 0),
    receivablesTop: receivables[0] ? { name: receivables[0].name, balance: receivables[0].balance } : null,
    pendingCount,
    expiringCount: expiring.length,
    expiringTop: expiring[0]?.name ?? null,
    expiringMembers,
  }
}

/** Active memories for the prompt/identity (newest first, like R13). */
export async function getActiveMemories(businessId: string, userId: string): Promise<AgentMemory[]> {
  return db.agentMemory.findMany({
    where: { businessId, userId, active: true },
    orderBy: { createdAt: 'desc' },
    take: 12,
  })
}

/** Memories referenced in a reply, as human quotes for the advisory prompt. */
export function memoryQuotesForAdvisory(memories: AgentMemory[]): { rules: string[]; preferences: string[]; lexicon: string[] } {
  const rules: string[] = []
  const preferences: string[] = []
  const lexicon: string[] = []
  for (const m of memories) {
    if (m.kind === 'rule') rules.push(m.text)
    else if (m.kind === 'preference') preferences.push(m.text)
    else if (m.kind === 'fact') preferences.push(m.text)
    else if (m.kind === 'lexicon') lexicon.push(m.text)
  }
  return { rules: rules.slice(0, 5), preferences: preferences.slice(0, 6), lexicon: lexicon.slice(0, 6) }
}
