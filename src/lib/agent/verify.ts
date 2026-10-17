// وكيل — self-verification of replies («اتأكدت الأرقام»).
//
// Reflexion + LLM-as-judge literature: an agent that CHECKS its own numbers
// before the user sees them hallucinates materially less. This module is
// deterministic-first:
//   1. verifyReply — extracts numeric claims (Arabic-Indic ٠-٩ AND Latin 0-9,
//      thousands separators, decimals) and cross-checks each one against the
//      values the tools/cards actually produced this turn. A mismatch tied to
//      a matching fact label is REPLACED in place with the correct formatted
//      number (status 'corrected'). Pure string math — zero LLM, sub-ms.
//   2. judgeVerify — ONE LLM-as-judge call, ONLY for deep-research turns
//      («راجع: هل كل رقم في الرد النهائي مطابق للبيانات؟»); a «لا» answer
//      re-runs the deterministic fix. Non-research turns never pay for it
//      (hard contract: verification adds <600ms there — it's just regex).

import type { ResultCardDTO, VerifyDTO } from '@/lib/types'
import { completeChat, type ModelInfo } from './llm'
import { normalizeAr } from './arabic'

/** One ground-truth value from this turn's cards/tool results. */
export interface VerifyFact {
  label: string
  value: string
}

export interface VerifyResult {
  verified: VerifyDTO
  /** the (possibly fixed) text — use THIS as the reply text */
  text: string
}

// ---------------------------------------------------------------------------
// Arabic-Indic ↔ Latin digit normalization + tolerant number parsing
// ---------------------------------------------------------------------------

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩'

function toWesternDigitsLocal(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
}

function hasArabicDigits(s: string): boolean {
  return /[٠-٩]/.test(s)
}

/** «١٬٢٣٤٫٥» / «1,234.5» / «1.234,5» → 1234.5 (null when not a clean number). */
function parseNumber(raw: string): number | null {
  const t = toWesternDigitsLocal(raw)
    .replace(/[\u066C٬]/g, '') // Arabic thousands separator + ٬
    .replace(/[,،\u060C]/g, '') // Latin comma / Arabic comma as thousands
    .replace(/[\u066B٫]/g, '.') // Arabic decimal separator
  if (!/^\d+(?:\.\d+)?$/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** Format a corrected number in the SAME script the claim was written in. */
function formatLike(value: number, arabicStyle: boolean): string {
  const rounded = Math.round(value * 100) / 100
  const formatted = new Intl.NumberFormat(arabicStyle ? 'ar-EG' : 'en-US', {
    maximumFractionDigits: 2,
  }).format(Math.abs(rounded))
  return (rounded < 0 ? '−' : '') + formatted
}

/** Every number inside a value string («٥٧ علبة @ ٤٥ ج.م» → [57, 45]). */
function allNumbers(value: string): number[] {
  const out: number[] = []
  const re = /[٠-٩0-9][٠-٩0-9\u066C٬,،\u066B٫.]*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(value)) != null) {
    const n = parseNumber(m[0])
    if (n != null) out.push(n)
  }
  return out
}

// ---------------------------------------------------------------------------
// Claim extraction — digit runs, minus citations [١], WKL refs, list ordinals
// ---------------------------------------------------------------------------

interface Claim {
  raw: string
  value: number
  at: number
  context: string
}

const CLAIM_RE = /[٠-٩0-9][٠-٩0-9\u066C٬,،\u066B٫.]*/g

function extractClaims(text: string): Claim[] {
  const out: Claim[] = []
  let m: RegExpExecArray | null
  CLAIM_RE.lastIndex = 0
  while ((m = CLAIM_RE.exec(text)) != null) {
    const at = m.index
    const raw = m[0]
    const prevCh = at > 0 ? text[at - 1] : ''
    const nextCh = at + raw.length < text.length ? text[at + raw.length] : ''
    // citation markers [١] [٢] — never claims
    if (prevCh === '[' || nextCh === ']') continue
    // WKL-2027 operation refs — identifiers, not numbers
    if (text.slice(Math.max(0, at - 4), at).includes('WKL-')) continue
    // bare list ordinals at line start (١. ٢- ٣) — structure, not claims
    const lineStart = text.lastIndexOf('\n', at - 1) + 1
    if (at === lineStart && /^[.)\-–،]/.test(nextCh)) continue
    const value = parseNumber(raw)
    if (value == null) continue
    const context = text.slice(Math.max(0, at - 45), at) + ' ' + text.slice(at + raw.length, at + raw.length + 45)
    out.push({ raw, value, at, context })
  }
  return out
}

// ---------------------------------------------------------------------------
// Label ↔ context word matching (ties a claim to the fact it talks about)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'اللي', 'على', 'من', 'في', 'الى', 'عنه', 'عنها', 'لها', 'له', 'فيه', 'فيها',
  'ده', 'دي', 'دول', 'زي', 'كده', 'كل', 'او', 'أو', 'بس', 'برضه', 'كمان',
  'دلوقتي', 'الحالي', 'الحالية', 'النهارده', 'اليوم', 'بعد', 'قبل', 'لحد', 'لدى', 'عند',
])

/** Distinctive words of a fact label («وضع الخزنة الرصيد دلوقتي» → [وضع, خزنة, رصيد]). */
function labelWords(label: string): string[] {
  return normalizeAr(label)
    .split(/[\s:：،]+/)
    .map((w) => w.replace(/^(ال)/, ''))
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^[\d٠-٩]+$/.test(w))
}

// ---------------------------------------------------------------------------
// The deterministic verifier
// ---------------------------------------------------------------------------

/** Minimum total matched-word length before a claim is tied to a fact. */
const MATCH_MIN_SCORE = 6

export function verifyReply(text: string, facts: VerifyFact[]): VerifyResult {
  const claims = extractClaims(text)
  const checks: VerifyDTO['checks'] = []
  let fixed = text
  let corrected = false

  if (claims.length === 0 || facts.length === 0) {
    return {
      verified: { status: 'skipped', checks: [], note: 'مفيش أرقام تتتحقق منها' },
      text,
    }
  }

  // fact index: every number in every value + the label's primary number
  const entries = facts
    .map((f) => {
      const nums = allNumbers(f.value)
      return { label: f.label, value: f.value, nums, primary: nums.length > 0 ? nums[0] : null }
    })
    .filter((e) => e.nums.length > 0)
  const universe = new Map<number, string>()
  for (const e of entries) for (const n of e.nums) if (!universe.has(n)) universe.set(n, e.value)
  // …and the LABELS are ground truth too. `brainFacts` carries card row labels
  // («إجمالي الطلبات») and table row names, and the agent's own text quotes card
  // titles like «قراءة شغلك — آخر 30 يوم»: without this, rule (b) below could
  // "correct" that 30 into a neighbouring fact's first number (live R29: the
  // advisor title came out as «آخر 0 يوم»). A number the agent itself rendered
  // from the DB may never be rewritten.
  for (const f of facts) for (const n of allNumbers(f.label)) if (!universe.has(n)) universe.set(n, f.label)

  // Walk claims RIGHT-TO-LEFT so replacements never invalidate earlier offsets
  // AUDIT FIX (R15-5): money/percent claims that match NO fact must not hide
  // behind a green badge — they're exactly what the badge vouches for.
  const unverifiableMoney: string[] = []
  for (let i = claims.length - 1; i >= 0; i--) {
    const c = claims[i]
    // (a) the number exists verbatim somewhere in the ground truth → ok
    if (universe.has(c.value)) {
      checks.unshift({ claim: c.raw, expected: universe.get(c.value) ?? c.raw, actual: c.raw, ok: true })
      continue
    }
    // (a0) the claim is a PERIOD («آخر 30 يوم», «كل ١٠ أيام») — a duration can
    // never be a money figure, so it is not the verifier's business to rewrite
    // it. Live R29: the advisor's card title «قراءة شغلك — آخر 30 يوم» came out
    // of the badge as «آخر 0 يوم» because rule (b) below reached forward and
    // tied the 30 to «المبيعات = ٠ ج.م».
    const afterClaim = text.slice(c.at + c.raw.length, c.at + c.raw.length + 10)
    if (/^\s*(?:يوم|أيام|ايام|شهر|شهور|سنه|سنة|سنين|أسبوع|اسبوع|أسابيع|اسابيع|ساعه|ساعة|دقيقه|دقيقة|ثانيه|ثانية)/.test(afterClaim)) {
      checks.unshift({ claim: c.raw, expected: c.raw, actual: c.raw, ok: true })
      continue
    }
    // (a1) a claim inside «quotes» is a LABEL the agent itself rendered (a card
    // title / a policy name) — ground truth, not a number to be corrected.
    const before40 = text.slice(Math.max(0, c.at - 40), c.at)
    if (before40.includes('«') && !before40.slice(before40.lastIndexOf('«')).includes('»') && text.slice(c.at + c.raw.length).includes('»')) {
      checks.unshift({ claim: c.raw, expected: c.raw, actual: c.raw, ok: true })
      continue
    }
    // (b) tie the claim to a fact via shared label/context words
    let best: (typeof entries)[number] | null = null
    let bestScore = 0
    for (const e of entries) {
      const words = labelWords(e.label)
      const hitLen = words
        .filter((w) => normalizeAr(c.context).includes(w))
        .reduce((s, w) => s + w.length, 0)
      if (hitLen > bestScore) {
        bestScore = hitLen
        best = e
      }
    }
    if (best && bestScore >= MATCH_MIN_SCORE && best.primary != null) {
      if (best.primary === c.value) {
        checks.unshift({ claim: c.raw, expected: best.value, actual: c.raw, ok: true })
      } else {
        // mismatch → deterministic digit replacement in the SAME script style
        const replacement = formatLike(best.primary, hasArabicDigits(c.raw))
        fixed = fixed.slice(0, c.at) + replacement + fixed.slice(c.at + c.raw.length)
        checks.unshift({ claim: c.raw, expected: best.value, actual: c.raw, ok: false })
        corrected = true
      }
      continue // handled by (b) — not unverifiable
    }
    // (c) no matching fact → unverifiable. Money/percent claims degrade the
    // final status honestly (no false «اتأكدت» confidence on derived numbers)
    if (/ج\.م|جنيه|٪|%|مستحق|ديون|نسبة/.test(c.context + ' ' + c.raw)) {
      unverifiableMoney.push(c.raw)
    }
  }

  if (corrected) {
    const note =
      unverifiableMoney.length > 0
        ? 'لقيت رقم مش مطابق للسجل — اتصلح قبل ما يوصلك؛ وفيه أرقام تانية مش من السجل — راجعها'
        : 'لقيت رقم مش مطابق للسجل — اتصلح قبل ما يوصلك'
    return {
      verified: { status: 'corrected', checks, note },
      text: fixed,
    }
  }
  if (checks.length > 0 && unverifiableMoney.length === 0) {
    return { verified: { status: 'verified', checks, note: 'اتأكدت الأرقام — كلها مطابقة لسجلك' }, text }
  }
  if (checks.length > 0 && unverifiableMoney.length > 0) {
    // some claims matched but money claims are unverifiable → honest skip:
    // the badge stays OFF instead of vouching for numbers we couldn't check
    return {
      verified: {
        status: 'skipped',
        checks,
        note: `فيه أرقام في الرد (${unverifiableMoney.length}) مش من السجل — مينفعش أقول اتحققت`,
      },
      text,
    }
  }
  return {
    verified: { status: 'skipped', checks: [], note: 'مفيش أرقام تتتحقق منها' },
    text,
  }
}

// ---------------------------------------------------------------------------
// LLM-as-judge — ONE call, research turns only (Reflexion second look)
// ---------------------------------------------------------------------------

/** Parse the judge's one-line verdict: نعم → true, لا → false, else null. */
function parseJudgeVerdict(raw: string): boolean | null {
  const t = raw.trim()
  if (/(^|\s)نعم(\s|$|،|:|!|！)/.test(t)) return true
  if (/(^|\s)لا(\s|$|،|:|!|！)/.test(t)) return false
  return null
}

/**
 * «راجع: هل كل رقم في الرد النهائي مطابق للبيانات؟ رد بنعم أو لا مع السبب»
 * Returns null when the judge itself is unreachable — fail-open (the
 * deterministic check already ran; a dead judge must never kill the report).
 */
export async function judgeVerify(text: string, facts: VerifyFact[], model: ModelInfo): Promise<boolean | null> {
  if (facts.length === 0 || !/[\d٠-٩]/.test(text)) return null
  try {
    const raw = await completeChat(model, [
      {
        role: 'system',
        content:
          'انت فاحص أرقام دقيق بتشتغل مع وكيل. عندك البيانات الصحيحة من السجل والرد النهائي بتاع الموظف. راجع: هل كل رقم في الرد النهائي مطابق للبيانات؟ رد بنعم أو لا مع السبب في سطر واحد بس.',
      },
      {
        role: 'user',
        content: `البيانات الصحيحة من السجل:\n${facts.map((f) => `- ${f.label}: ${f.value}`).join('\n')}\n\nالرد النهائي:\n${text}`,
      },
    ])
    return parseJudgeVerdict(raw)
  } catch (e) {
    console.error('[verify] judge call failed (تجاهل):', e)
    return null
  }
}

/**
 * Full research-grade verification: deterministic pass first, then ONE judge
 * call; a «لا» verdict re-runs the deterministic fix (the judge catches what
 * context-word matching missed, the regex catches what the judge misses).
 */
export async function verifyWithJudge(text: string, facts: VerifyFact[], model: ModelInfo): Promise<VerifyResult> {
  const first = verifyReply(text, facts)
  if (facts.length === 0) return first
  const judge = await judgeVerify(first.text, facts, model)
  if (judge === false) {
    const second = verifyReply(first.text, facts)
    if (second.verified.status === 'corrected') return second
    return {
      // deterministic is clean; the judge was over-cautious — keep it honest in the note
      verified: {
        ...first.verified,
        note: `${first.verified.note ?? 'اتأكدت الأرقام'} — وراجعتها بفحص تاني كمان`,
      },
      text: first.text,
    }
  }
  return first
}

// ---------------------------------------------------------------------------
// Fact collection from this turn's cards («الأرقام الوحيدة المسموحة»)
// ---------------------------------------------------------------------------

/** kv rows + table footers + table row values → the ground-truth fact list. */
export function factsFromCards(cards: ResultCardDTO[]): VerifyFact[] {
  const out: VerifyFact[] = []
  for (const c of cards) {
    if (c.kind === 'kv') {
      for (const r of c.rows) out.push({ label: r.label, value: r.value })
    } else if (c.kind === 'table') {
      for (const f of c.footer ?? []) out.push({ label: f.label, value: f.value })
      for (const r of c.rows.slice(0, 8)) {
        const name = r.name ?? Object.values(r)[0] ?? ''
        const rest = Object.entries(r)
          .filter(([k]) => k !== 'name')
          .map(([, v]) => v)
          .filter(Boolean)
          .join(' · ')
        if (name && rest) out.push({ label: name, value: rest })
      }
    }
    // sources cards carry no numbers — nothing to verify against
  }
  return out.slice(0, 40)
}
