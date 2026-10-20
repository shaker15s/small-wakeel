// R75 / PR-007 — الخطة النهائية v2 §7.1: onboarding state machine.
//
// The interview is STATE, not a form: one question at a time, answers are
// persisted as they arrive, an ANSWERED question is never asked again
// (the pending list is computed from stored state, not from step counters),
// and a skipped financial fact stays UNKNOWN — the system never converts
// «مش عارف» into 0, and never invents an answer the owner never gave.
//
// Stages: not_started → interviewing → proposed → confirmed.
//   • interviewing: first answer persisted;
//   • proposed: every REQUIRED non-financial question answered — the owner
//     reviews the summary (and may correct any value) before confirming;
//   • confirmed: the profile is live.
//
// Tenant rule: every function is addressed by businessId; the API guard
// has already proved the caller belongs to that business (zero cross-tenant).

import { db } from '@/lib/db'
import type { BusinessProfile } from '@prisma/client'

export type ProfileStage = 'not_started' | 'interviewing' | 'proposed' | 'confirmed'
export const PROFILE_STAGES: ProfileStage[] = ['not_started', 'interviewing', 'proposed', 'confirmed']

export interface ProfileAnswer {
  value: string | number | null
  source: 'owner'
  answeredAt: string
  skipped: boolean
  corrected?: boolean
}
export type ProfileAnswers = Record<string, ProfileAnswer>
export interface ProfileConsentEntry { granted: boolean; at: string }
export type ProfileConsents = Record<string, ProfileConsentEntry>

export interface ProfileQuestion {
  key: string
  label: string
  help?: string
  required: boolean
  financial: boolean // financial fact — owner-stated only; skip ⇒ unknown
  choices?: string[] // constrained chips (free text otherwise)
  skipAllowed: boolean
  /** prefilled from the business itself (never from a guess) */
  prefill?: 'businessName' | 'businessType'
}

const CORE_QUESTIONS: ProfileQuestion[] = [
  {
    key: 'recordedHow',
    label: 'دلوقتي بتسجل البيع والشراء والتحصيل إزاي؟',
    help: 'عشان أعرف أبدأ منين من غير ما افترض نظام عندك.',
    required: true,
    financial: false,
    choices: ['ورقة وقلم', 'نظام قائم', 'الاثنين', 'مفيش تسجيل لسه'],
    skipAllowed: false,
  },
  {
    key: 'paymentTerms',
    label: 'المبيعات عندها كاش ولا آجل؟',
    required: false,
    financial: false,
    choices: ['كاش', 'آجل', 'الاثنين'],
    skipAllowed: true,
  },
  {
    key: 'staffAccounts',
    label: 'مين بيشتغل على الحسابات؟',
    required: false,
    financial: false,
    choices: ['أنا بس', 'في كاشير', 'في محاسب', 'أنا وكاشير'],
    skipAllowed: true,
  },
  {
    key: 'openingCash',
    label: 'الخزنة بدأت بكام؟ (لو عارف — وإلا «تخطى» وهي تبقى غير مسجلة، مش صفر)',
    help: 'رقم حقيقي من عندك بس. لو سبتها هتظهر «غير مسجلة» في أي حساب كاش.',
    required: true,
    financial: true,
    skipAllowed: true,
  },
  {
    key: 'mainPain',
    label: 'أكبر مشكلة يومياً في شغلك؟ (اختياري)',
    required: false,
    financial: false,
    skipAllowed: true,
  },
]

/** Sector units (Arabic) for the units question. */
const UNITS_AR: Record<string, string[]> = {
  supermarket: ['قطعة', 'كيلو', 'لتر', 'كارتون', 'عبوة'],
  gym: ['جلسة', 'اشتراك', 'قطعة'],
  pharmacy: ['عبوة', 'شريط', 'قرص', 'قطعة'],
  attar: ['جرام', 'كيلو', 'قطعة', 'عبوة'],
  restaurant: ['طبق', 'قطعة', 'لتر'],
  clinic: ['خدمة', 'مستلزم'],
  electronics: ['قطعة', 'صندوق'],
  wholesale: ['قطعة', 'كرتونة', 'بالاته'],
  clothing: ['قطعة', 'عبوة', 'متر'],
  tools: ['قطعة', 'صندوق', 'كارتون', 'بكرة', 'متر'],
}

export function profileQuestionsFor(businessType: string): ProfileQuestion[] {
  const units = UNITS_AR[businessType] ?? ['قطعة', 'عبوة']
  const unitsQ: ProfileQuestion = {
    key: 'units',
    label: 'إيه الوحدات اللي بتتداول في شغلك؟ (اختار اللي يناسبك)',
    required: true,
    financial: false,
    choices: units,
    skipAllowed: false,
  }
  // units right after recordedHow — the interview order matters
  return [CORE_QUESTIONS[0], unitsQ, ...CORE_QUESTIONS.slice(1)]
}

export { PROFILE_CONSENTS, type ProfileConsentKey } from '@/lib/onboarding-constants'
import { PROFILE_CONSENTS, type ProfileConsentKey } from '@/lib/onboarding-constants'

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const v = JSON.parse(raw)
    return (v ?? fallback) as T
  } catch {
    return fallback
  }
}

export interface ProfileState {
  businessId: string
  stage: ProfileStage
  answers: ProfileAnswers
  consents: ProfileConsents
  /** required, NOT-yet-answered question keys, in interview order — an
   *  answered question never appears here again. */
  pending: string[]
  questions: ProfileQuestion[]
  openingCashStatedAt: string | null
}

async function loadProfile(businessId: string): Promise<BusinessProfile> {
  let p = await db.businessProfile.findUnique({ where: { businessId } })
  if (!p) {
    p = await db.businessProfile.create({ data: { businessId } })
  }
  return p
}

export async function getProfileState(businessId: string): Promise<ProfileState> {
  const p = await loadProfile(businessId)
  const business = await db.business.findUniqueOrThrow({ where: { id: businessId } })
  const answers = parseJson<ProfileAnswers>(p.answers, {})
  const questions = profileQuestionsFor(business.type)
  const pending = questions.filter((q) => q.required && !answers[q.key]).map((q) => q.key)
  return {
    businessId,
    stage: (PROFILE_STAGES.includes(p.stage as ProfileStage) ? p.stage : 'not_started') as ProfileStage,
    answers,
    consents: parseJson<ProfileConsents>(p.consents, {}),
    pending,
    questions,
    openingCashStatedAt: p.openingCashStatedAt ? p.openingCashStatedAt.toISOString() : null,
  }
}

async function nextStage(answers: ProfileAnswers, questions: ProfileQuestion[]): Promise<ProfileStage> {
  const allRequiredDone = questions.every((q) => !q.required || Boolean(answers[q.key]))
  if (allRequiredDone) return 'proposed'
  return 'interviewing'
}

/** Record ONE owner answer (or an explicit skip). Returns the new state. */
export async function answerProfile(
  businessId: string,
  key: string,
  value: string | number | null,
  opts?: { skip?: boolean },
): Promise<ProfileState> {
  const business = await db.business.findUnique({ where: { id: businessId } })
  if (!business) throw new Error('business not found')
  const questions = profileQuestionsFor(business.type)
  const q = questions.find((x) => x.key === key)
  if (!q) throw new Error(`سؤال غير معتمد: ${key}`)
  const skip = Boolean(opts?.skip)
  if (skip && !q.skipAllowed) throw new Error('السؤال ده لازم يجاب عشان نمشي في الإعداد')

  let norm: string | number | null = null
  if (!skip) {
    if (q.financial) {
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(n) || n < 0) throw new Error('المبلغ لازم يكون رقم حقيقي (جنيه) من عندك')
      norm = Math.round(n)
    } else {
      const s = String(value ?? '').trim()
      if (s.length === 0) throw new Error('اكتب إجابة أو استخدم التخطي')
      norm = s.slice(0, 200)
    }
  }

  const p = await loadProfile(businessId)
  const answers = parseJson<ProfileAnswers>(p.answers, {})
  const prior = answers[key]
  answers[key] = {
    value: norm,
    source: 'owner',
    answeredAt: new Date().toISOString(),
    skipped: skip,
    ...(prior ? { corrected: true } : {}),
  }
  const stage = await nextStage(answers, questions)

  // opening cash: a STATED number becomes the ledger's opening fact;
  // a skip leaves it unknown (business.openingCash untouched, statedAt null).
  let openingCashStatedAt = p.openingCashStatedAt
  if (q.financial && q.key === 'openingCash') {
    if (skip) {
      openingCashStatedAt = null
    } else {
      const piastres = Math.round((norm as number) * 100)
      await db.business.update({ where: { id: businessId }, data: { openingCash: piastres } })
      openingCashStatedAt = new Date()
    }
  }

  const updated = await db.businessProfile.update({
    where: { businessId },
    data: { answers: JSON.stringify(answers), stage, openingCashStatedAt, updatedAt: new Date() },
  })
  return stateFrom(updated, business.type)
}

/** Record a consent grant/denial. Returns the new state. */
export async function setProfileConsent(businessId: string, key: ProfileConsentKey, granted: boolean): Promise<ProfileState> {
  if (!PROFILE_CONSENTS.some((c) => c.key === key)) throw new Error(`موافقة غير معتمدة: ${key}`)
  const business = await db.business.findUniqueOrThrow({ where: { id: businessId } })
  const p = await loadProfile(businessId)
  const consents = parseJson<ProfileConsents>(p.consents, {})
  consents[key] = { granted, at: new Date().toISOString() }
  const updated = await db.businessProfile.update({
    where: { businessId },
    data: { consents: JSON.stringify(consents), updatedAt: new Date() },
  })
  return stateFrom(updated, business.type)
}

/** Owner confirms the proposed profile (review done, corrections made). */
export async function confirmProfile(businessId: string): Promise<ProfileState> {
  const business = await db.business.findUniqueOrThrow({ where: { id: businessId } })
  const state = await getProfileState(businessId)
  if (state.pending.length > 0) throw new Error('في أسئلة لازمة لسه — أكملها الأول')
  if (state.stage === 'confirmed') return state // idempotent
  const updated = await db.businessProfile.update({
    where: { businessId },
    data: { stage: 'confirmed', updatedAt: new Date() },
  })
  return stateFrom(updated, business.type)
}

/** The import routes consult this — a consent the owner never gave is a NO. */
export async function hasConsent(businessId: string, key: ProfileConsentKey): Promise<boolean> {
  const p = await db.businessProfile.findUnique({ where: { businessId } })
  if (!p) return false
  const consents = parseJson<ProfileConsents>(p.consents, {})
  return consents[key]?.granted === true
}

async function stateFrom(p: BusinessProfile, businessType: string): Promise<ProfileState> {
  const answers = parseJson<ProfileAnswers>(p.answers, {})
  const questions = profileQuestionsFor(businessType)
  const pending = questions.filter((q) => q.required && !answers[q.key]).map((q) => q.key)
  return {
    businessId: p.businessId,
    stage: (PROFILE_STAGES.includes(p.stage as ProfileStage) ? p.stage : 'not_started') as ProfileStage,
    answers,
    consents: parseJson<ProfileConsents>(p.consents, {}),
    pending,
    questions,
    openingCashStatedAt: p.openingCashStatedAt ? p.openingCashStatedAt.toISOString() : null,
  }
}
