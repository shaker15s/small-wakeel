// وكيل — Deep Research pipeline (R15 «البحث العميق»).
//
// Grounded in the real production patterns of ChatGPT Deep Research + Claude
// Code: PLAN FIRST (the first action is a visible plan, not a search), then
// GATHER from the business's own record (reusing the exact read-tool
// functions the registry uses — never re-implemented DB reads), then WEB
// (z-ai web_search, max 2 queries, failures never break the turn), then
// SYNTHESIZE a cited report (الخلاصة/التحليل/التوصيات with [١] [٢] citations
// matching the sources array), then SELF-VERIFY before the user sees a word.
// Every LLM step has a deterministic fallback — 429s happen.

import type { Business, User } from '@prisma/client'
import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'
import type { ResearchDTO, ResultCardDTO, SourceDTO, ThinkingStep, VerifyDTO } from '@/lib/types'
import { completeChat, type LLMMessage, type ModelInfo } from './llm'
import { runReadTool, type ReadTool } from './tools'
import { jotNote } from './scratchpad'
import { activeTools, runUserTool, userToolsPromptLine } from './userTools'
import { factsFromCards, verifyWithJudge, type VerifyFact } from './verify'
import { getVertical } from '@/lib/verticals'
import { normalizeAr } from './arabic'
import type { TurnEmit } from './harness'

/** Auto-detect trigger (explicit deepResearch flag OR these words). */
/**
 * Auto-research triggers — EGYPTIAN dialect aware, and deliberately
 * WORD-BOUNDED.
 *
 * Why the boundaries matter: «ليه» (why) is a substring of «عليه» / «إليه» /
 * «اللي عليه», which appear in the most ordinary shop sentences — «حسن دفع
 * ٥٠ من اللي عليه» used to be hijacked into a full deep-research report
 * (2.6 s, web queries, a sources card) instead of booking a collection.
 * Same for «سوق» inside «بيسوق» and «بحث» inside «مباحث». Only a standalone
 * word may trigger the expensive pipeline.
 */
export const RESEARCH_TRIGGER_RE =
  /(?:^| )(?:ابحث|بحث|حلّل|حلل|قارن|مقارنة|دراسة|ادرس|ليه|استراتيجية|إزاي أحسن|سوق|الأسواق)(?: |$|؟|\?)|بكام في السوق|أسعار المنافسين/i

/**
 * True when the message is a concrete business COMMAND (a write, or a read of
 * a named tool). Such messages must never be auto-hijacked by the research
 * pipeline: «بعت ٢ علبة لبن» is an instruction, not a research question.
 * Explicit toggles and genuine analysis questions still research.
 */
export function isActionableIntent(intent: { intent: string; tool?: string }): boolean {
  return intent.intent === 'write' || (intent.intent === 'read' && Boolean(intent.tool))
}

const AR_ORDINALS = ['١', '٢', '٣', '٤', '٥', '٦']

function toArabicNum(n: number): string {
  return String(n).replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)])
}

// ---------------------------------------------------------------------------
// Plan + gather selection — deterministic, adapted to the question's entities
// ---------------------------------------------------------------------------

/** A mentioned catalog item — only the name matters for planning queries. */
type MentionedItem = { name: string }

interface Gather {
  tool: ReadTool
  fields: Record<string, unknown>
  labelAr: string
  /** the app view acting as the internal evidence reference */
  refView: string
}

function chooseGathers(norm: string, mentionedItem: MentionedItem | null): Gather[] {
  // AUDIT FIX (R15-5): «نواقص» (plural) never matched «ناقص» — a stock-gap
  // question gathered sales data instead of the actual low-stock list.
  const wantsStock = /مخزون|نواقص|ناقص|سوق|سعر|اسعار|بكام|منافس|توفير|بضاعه/.test(norm)
  const wantsCustomers = /عميل|عملاء|مديون|تحصيل|اشتراك|عضو|فلوس\s*عليها|عليها\s*فلوس/.test(norm)
  const wantsCash = /خزنه|كاش|فلوس|سيوله/.test(norm)
  const out: Gather[] = []
  if (mentionedItem) {
    out.push({ tool: 'search_catalog', fields: { query: mentionedItem.name }, labelAr: `بيانات «${mentionedItem.name}»`, refView: 'المخزون' })
  }
  if (wantsStock) {
    out.push({ tool: 'list_low_stock', fields: {}, labelAr: 'النواقص من المخزون', refView: 'المخزون' })
  }
  out.push({ tool: 'get_daily_summary', fields: {}, labelAr: 'حركة البيع النهاردة', refView: 'الإحصائيات' })
  if (wantsCustomers) {
    out.push({ tool: 'list_receivables', fields: {}, labelAr: 'حسابات العملاء والمديونيات', refView: 'الحسابات' })
  }
  if (wantsCash) {
    out.push({ tool: 'get_cash_position', fields: {}, labelAr: 'وضع الخزنة', refView: 'لوحة اليوم' })
  }
  return out.slice(0, 3)
}

/** Deterministic 3-5 bullet plan shown BEFORE gathering — adapted to entities. */
function buildResearchPlan(norm: string, mentionedItem: MentionedItem | null): string[] {
  const bullets: string[] = []
  for (const g of chooseGathers(norm, mentionedItem)) {
    bullets.push(`أجمع ${g.labelAr} من سجلك`)
  }
  bullets.push('أدور في الويب على أسعار السوق والمنافسين')
  bullets.push('أحلل كل ده وأكتبلك تقرير بالتوصيات')
  return bullets.slice(0, 5).map((b, i) => `${AR_ORDINALS[i]}. ${b}`)
}

/** Topic extraction for web queries — strips the ask-verbs/fillers that
 *  poisoned relevance (AUDIT R15-5: «حلل النواقص عندي واقترح حلول في مصر»
 *  returned homework reels). Keeps the noun-topic and pairs it with the
 *  vertical so the search targets domain content. */
const ASK_FILLERS =
  /^(ابحث|بحث|حلل|حلّل|حلل|قارن|دراسه|ادرس|قولي|اقترح|شوف|رايك|رأيك|عايز|عاوز|ممكن|لو سمحت|من فضلك|ازاي|إزاي|ليه|كل|عندي|بتاعي|واقترح|وحلل|وقولي)\s*/g

function topicOf(text: string): string {
  return text
    .replace(/[؟?!.,،]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(ASK_FILLERS, '')
    .replace(/\b(واقترح|وحلل|وقولي|عندي|بتاعي)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 4)
    .join(' ')
}

/** 2 web queries max — crafted from the question's TOPIC + the vertical. */
function craftWebQueries(text: string, mentionedItem: MentionedItem | null, verticalLabel: string): string[] {
  if (mentionedItem) {
    return [`أسعار ${mentionedItem.name} في مصر`, `مقارنة أسعار ${mentionedItem.name} في السوق المصري`]
  }
  const topic = topicOf(text)
  const base = topic.length >= 6 ? topic : `${verticalLabel}`
  return [`${base} — نصايح ${verticalLabel} لمحلات مصر`, `سوق ${verticalLabel} في مصر 2025`]
}

// ---------------------------------------------------------------------------
// Web search — z-ai-web-dev-sdk (SERVER ONLY), max 5 results per query
// ---------------------------------------------------------------------------

interface WebHit {
  url: string
  name: string
  snippet: string
  host: string
}

async function webSearch(query: string, num: number): Promise<WebHit[]> {
  const zai = await ZAI.create()
  const results = await zai.functions.invoke('web_search', { query, num })
  if (!Array.isArray(results)) return []
  const hits: WebHit[] = []
  for (const r of results) {
    if (!r || typeof r.url !== 'string' || !/^https?:\/\//.test(r.url)) continue
    hits.push({
      url: r.url,
      name: String(r.name ?? r.url).trim() || r.url,
      snippet: String(r.snippet ?? '').trim(),
      host: String(r.host_name ?? '').trim(),
    })
  }
  return hits
}

// ---------------------------------------------------------------------------
// Compact per-source summary (numbers quoted verbatim for the citations)
// ---------------------------------------------------------------------------

function summarizeCards(cards: ResultCardDTO[]): string {
  return cards
    .map((c) => {
      if (c.kind === 'kv') {
        return `${c.title}: ${c.rows.slice(0, 4).map((r) => `${r.label} ${r.value}`).join('، ')}`
      }
      if (c.kind === 'table') {
        const foot = (c.footer ?? []).map((f) => `${f.label}: ${f.value}`).join('، ')
        return `${c.title} (${toArabicNum(c.rows.length)} صف)${foot ? ` — ${foot}` : ''}`
      }
      if (c.kind === 'sources') return c.title
      return `${c.title}: ${c.body.slice(0, 100)}`
    })
    .join('؛ ')
    .slice(0, 280)
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export interface DeepResearchParams {
  business: Business
  user: User
  conversationId: string
  text: string
  model: ModelInfo
  mode: 'auto' | 'forced'
  emit: TurnEmit
  /** «ورقة وكيل الحالية» block to keep the paper alive across research turns */
  notesSection?: string | null
  /** harness hook: count scratchpad jots for notes invalidation */
  onJot?: () => void
}

export interface DeepResearchResult {
  reportText: string
  research: ResearchDTO
  cards: ResultCardDTO[]
  facts: VerifyFact[]
  verified: VerifyDTO
  steps: ThinkingStep[]
  /** true when the LLM synthesis died and the deterministic report served */
  llmFallback: boolean
}

export async function runDeepResearch(p: DeepResearchParams): Promise<DeepResearchResult> {
  const { business, user, emit } = p
  const v = getVertical(business.type)
  const norm = normalizeAr(p.text)

  // Entities in the question (longest catalog name wins — specificity first)
  const items = await db.item.findMany({ where: { businessId: business.id }, select: { id: true, name: true, unit: true } })
  const mentionedItem =
    [...items]
      .sort((a, b) => b.name.length - a.name.length)
      .find((i) => i.name.length >= 3 && norm.includes(normalizeAr(i.name))) ?? null

  // ---- 1) PLAN FIRST (the first action is a plan, never a search) ----
  const plan = buildResearchPlan(norm, mentionedItem)
  const steps: ThinkingStep[] = [
    { label: 'بحضّط خطة البحث', detail: 'بحط خطواتي قبل ما أبدأ عشان مفيش حاجة تضيع', state: 'done', icon: 'plan' },
    { label: 'خطة البحث', detail: plan.join(' / '), state: 'done', icon: 'research' },
  ]
  emit({ event: 'thinking', steps: steps.map((s) => ({ ...s })) })
  emit({ event: 'step', label: 'بحضّط خطة البحث', state: 'done' })

  // ---- 2) GATHER — internal tools (the SAME functions the registry runs) ----
  const cards: ResultCardDTO[] = []
  const facts: VerifyFact[] = []
  const sources: SourceDTO[] = []
  let stepsCount = 0

  for (const g of chooseGathers(norm, mentionedItem)) {
    const label = `بجمع: ${g.labelAr}…`
    const step: ThinkingStep = { label, detail: `أداة ${g.tool}`, state: 'active', icon: 'research' }
    steps.push(step)
    emit({ event: 'thinking', steps: steps.map((s) => ({ ...s })) })
    emit({ event: 'step', label, state: 'active' })
    try {
      const subCards = await runReadTool(g.tool, business.id, g.fields)
      cards.push(...subCards)
      emit({ event: 'cards', cards: cards.map((c) => ({ ...c })) })
      facts.push(...factsFromCards(subCards))
      const summary = summarizeCards(subCards)
      sources.push({ title: `سجل وكيل — ${g.labelAr}`, ref: g.refView, snippet: summary })
      // paper&pen: every gathered fact lands on the scratchpad with its source
      void jotNote({
        businessId: business.id,
        userId: user.id,
        conversationId: p.conversationId,
        kind: 'fact',
        text: summary,
        source: g.tool,
      })
      p.onJot?.()
    } catch (e) {
      console.error('[research] gather failed (بتكمل باللي جمعته):', e)
    }
    step.state = 'done'
    emit({ event: 'thinking', steps: steps.map((s) => ({ ...s })) })
    emit({ event: 'step', label, state: 'done' })
    stepsCount++
  }

  // ---- 2.5) أدوات بتاعتك — the owner's own tools (R16), max 3 per run ----
  // The shop owner's own sources/webhooks, run SEQUENTIALLY right after the
  // internal gathers. A failed tool is a graceful step («ما ردتش — كمّلت من
  // غيرها») — a dead tool must never break the research turn.
  const tools = await activeTools(business.id)
  for (const tool of tools.slice(0, 3)) {
    const label = `أداة بتاعتك: ${tool.name} — بجربها`
    const step: ThinkingStep = { label, detail: 'أداة خاصة أضافها صاحب الشغل بنفسه', state: 'active', icon: 'research' }
    steps.push(step)
    emit({ event: 'thinking', steps: steps.map((s) => ({ ...s })) })
    emit({ event: 'step', label, state: 'active' })
    try {
      const r = await runUserTool(tool, p.text)
      if (r.ok && r.sources && r.sources.length > 0) {
        sources.push(...r.sources.slice(0, 5))
        step.detail = r.summary
        // paper&pen: the tool's results land on the scratchpad under ITS name
        void jotNote({
          businessId: business.id,
          userId: user.id,
          conversationId: p.conversationId,
          kind: 'citation',
          text: `أداة «${tool.name}»: ${r.summary} — ${r.sources.slice(0, 2).map((s) => s.title).join('؛ ')}`,
          source: tool.name,
        })
        p.onJot?.()
      } else if (r.ok) {
        step.detail = r.summary // the tool responded but had nothing to show
      } else {
        // graceful failure — the turn continues with the other sources
        step.label = `أداة ${tool.name} ما ردتش — كمّلت من غيرها`
        step.detail = r.summary
      }
    } catch (e) {
      console.error('[research] user tool failed (كمّلت من غيرها):', e)
      step.label = `أداة ${tool.name} ما ردتش — كمّلت من غيرها`
      step.detail = 'مشكلة في الأداة نفسها'
    }
    step.state = 'done'
    emit({ event: 'thinking', steps: steps.map((s) => ({ ...s })) })
    emit({ event: 'step', label: step.label, state: 'done' })
    stepsCount++
  }

  // ---- 3) WEB — max 2 queries × 5 results, NEVER fatal ----
  const webQueries = craftWebQueries(p.text, mentionedItem, v.label)
  const webSources: SourceDTO[] = []
  const seenUrls = new Set<string>()
  for (const q of webQueries) {
    const label = `بدور في الويب: ${q.slice(0, 44)}${q.length > 44 ? '…' : ''}`
    const step: ThinkingStep = { label, detail: `بحث ويب (${toArabicNum(5)} نتايج)`, state: 'active', icon: 'research' }
    steps.push(step)
    emit({ event: 'thinking', steps: steps.map((s) => ({ ...s })) })
    emit({ event: 'step', label, state: 'active' })
    try {
      const hits = await webSearch(q, 5)
      for (const h of hits) {
        if (seenUrls.has(h.url)) continue
        seenUrls.add(h.url)
        webSources.push({ title: h.name, url: h.url, snippet: h.snippet, host: h.host })
      }
      if (hits.length > 0) {
        void jotNote({
          businessId: business.id,
          userId: user.id,
          conversationId: p.conversationId,
          kind: 'citation',
          text: `الويب (${q}): ${hits.slice(0, 2).map((h) => h.name).join('؛ ')}`,
          source: 'web_search',
        })
        p.onJot?.()
      }
    } catch (e) {
      // web failure must NEVER break the turn — the report leans on DB sources
      console.error('[research] web_search failed (هكمل بمصادر السجل بس):', e)
    }
    step.state = 'done'
    emit({ event: 'thinking', steps: steps.map((s) => ({ ...s })) })
    emit({ event: 'step', label, state: 'done' })
    stepsCount++
  }
  sources.push(...webSources.slice(0, 6))

  // ---- 4) SOURCES CARD — numbered [١] [٢] chips, BEFORE any delta ----
  const sourcesCard: ResultCardDTO = { kind: 'sources', title: 'المصادر اللي اعتمدت عليها', sources }
  cards.push(sourcesCard)
  emit({ event: 'cards', cards: cards.map((c) => ({ ...c })) })

  // ---- 5) SYNTHESIZE — LLM report with a deterministic fallback ----
  const synthesizeStep: ThinkingStep = { label: 'بحلل وأكتب التقرير', detail: 'بركّب الخلاصة والتحليل والتوصيات', state: 'active', icon: 'plan' }
  steps.push(synthesizeStep)
  emit({ event: 'thinking', steps: steps.map((s) => ({ ...s })) })
  emit({ event: 'step', label: 'بحلل وأكتب التقرير', state: 'active' })
  stepsCount++

  let reportText = ''
  let llmFallback = false
  try {
    const messages: LLMMessage[] = [
      { role: 'system', content: buildResearchPrompt({ business, user, question: p.text, plan, facts, sources, notesSection: p.notesSection ?? null, userToolsLine: userToolsPromptLine(tools) }) },
      { role: 'user', content: 'اكتب التقرير النهائي دلوقتي بناءً على البيانات والمصادر فوق — بالأقسام الثلاثة المطلوبة بالظبط.' },
    ]
    reportText = (await completeChat(p.model, messages)).trim()
  } catch (e) {
    console.error('[research] synthesis failed → deterministic report:', e)
    llmFallback = true
  }
  if (reportText.length < 60) {
    // empty/truncated model output — the deterministic report takes over
    reportText = deterministicReport({ question: p.text, businessName: business.name, sources, facts, hadWeb: webSources.length > 0 })
    llmFallback = true
  }
  synthesizeStep.state = 'done'
  emit({ event: 'thinking', steps: steps.map((s) => ({ ...s })) })
  emit({ event: 'step', label: 'بحلل وأكتب التقرير', state: 'done' })

  // ---- 6) SELF-VERIFY — deterministic digits + ONE LLM-as-judge pass ----
  const verifyStep: ThinkingStep = { label: 'بتحقق من الأرقام', detail: 'كل رقم في التقرير بيتقابل بالبيانات المجمعة', state: 'active', icon: 'verify' }
  steps.push(verifyStep)
  emit({ event: 'thinking', steps: steps.map((s) => ({ ...s })) })
  emit({ event: 'step', label: 'بتحقق من الأرقام', state: 'active' })
  stepsCount++
  const vr = await verifyWithJudge(reportText, facts, p.model)
  reportText = vr.text
  verifyStep.state = 'done'
  verifyStep.detail = vr.verified.status === 'corrected' ? 'لقيت رقم غلط واتصلح' : vr.verified.status === 'verified' ? 'اتأكدت الأرقام — كلها مطابقة' : 'مفيش أرقام تتتحقق منها'
  emit({ event: 'thinking', steps: steps.map((s) => ({ ...s })) })
  emit({ event: 'step', label: 'بتحقق من الأرقام', state: 'done' })

  const research: ResearchDTO = { mode: p.mode, plan, sources, stepsCount }
  return { reportText, research, cards, facts, verified: vr.verified, steps, llmFallback }
}

// ---------------------------------------------------------------------------
// Prompt + deterministic report
// ---------------------------------------------------------------------------

function buildResearchPrompt(params: {
  business: Business
  user: User
  question: string
  plan: string[]
  facts: VerifyFact[]
  sources: SourceDTO[]
  notesSection: string | null
  /** R16: «أدوات بتاعتك» — one compact line about the owner's own tools */
  userToolsLine?: string
}): string {
  const { business, user, question, plan, facts, sources, notesSection, userToolsLine } = params
  const v = getVertical(business.type)
  const sourceLines = sources
    .map((s, i) => {
      const where = s.url ? s.host || s.url : s.ref || ''
      return `[${AR_ORDINALS[i] ?? i + 1}] ${s.title}${where ? ` (${where})` : ''}: ${(s.snippet ?? '').slice(0, 200)}`
    })
    .join('\n')
  const notesBlock = notesSection ? `\n${notesSection}\n` : ''
  const toolsBlock = userToolsLine ? `\n${userToolsLine}\n` : ''
  return `انت «وكيل» — موظف البحث والتحليل بتاع «${business.name}» (${v.label}). ${user.name} طلب منك بحث عميق في شغله.

## السؤال
${question}
## الخطة اللي مشيت عليها
${plan.join('\n')}

## البيانات المجمعة من سجلك الحقيقي (الأرقام الوحيدة المسموح بكتابتها — ممنوع أي رقم خارج القايمة دي نهائيًا)
${facts.map((f) => `- ${f.label}: ${f.value}`).join('\n') || '— مفيش بيانات داخلية للسؤال ده —'}

## المصادر (كل مصدر برقمه — لما تستشهد بيه في التحليل اكتب رقمه بين قوسين زي [١])
${sourceLines || '— مفيش مصادر ويب —'}${toolsBlock}${notesBlock}
## المطلوب
اكتب تقرير بالمصري بأقسام ثابتة بالعناوين دي بالظبط:
## الخلاصة
(٢-٣ جمل: إجابة مباشرة على السؤال بأهم الأرقام من البيانات فوق)
## التحليل
(٤-٦ نقط، كل نقطة تبدأ بـ«-»، كل رقم فيها من البيانات فوق، واقفل النقطة برقم المصدر اللي جبت منه زي [١])
## التوصيات
(٢-٤ توصيات عملية قابلة للتنفيذ في «${business.name}» بكرة الصبح)

قواعد صارمة: ممنوع تخترع أي رقم. لو رقم مش موجود في البيانات قول «مش متوفر عندي» بصراحة. اكتب الأرقام زي ما هي بالظبط. بلا JSON وبلا مقدمات تقنية.`.trim()
}

/** Numbered fallback report assembled 100% from the gathered facts + sources. */
function deterministicReport(params: {
  question: string
  businessName: string
  sources: SourceDTO[]
  facts: VerifyFact[]
  hadWeb: boolean
}): string {
  const { question, businessName, sources, facts, hadWeb } = params
  const topFacts = facts
    .filter((f) => /[\d٠-٩]/.test(f.value))
    .slice(0, 5)
    .map((f) => `${f.label} ${f.value}`)
    .join('، ')
  const analysis = sources
    .map((s, i) => `- ${s.title}${s.ref ? ` (${s.ref})` : ''}: ${(s.snippet ?? '').slice(0, 180)} [${AR_ORDINALS[i] ?? i + 1}]`)
    .join('\n')
  const recs = recommendationsFromFacts(facts)
  return `## الخلاصة
سؤالك: «${question.slice(0, 120)}» — جمعتلك البيانات من سجل «${businessName}»${hadWeb ? ' ومن الويب' : ''}. أهم الأرقام: ${topFacts || 'مفيش أرقام داخلية طالعة للسؤال ده'}.

## التحليل
${analysis || '- مفيش مصادر اتجمعة للسؤال ده — جرّب اصيغه بشكل أدق.'}

## التوصيات
${recs.map((r) => `- ${r}`).join('\n')}

المصادر مرقمة فوق ([١] [٢] …) — أرقام السجل متحققة من قاعدة بياناتك، ${hadWeb ? 'ومصادر الويب للمرجعية السوقية بترجع للروابط دي' : 'ومفيش مصادر ويب اتجمعت المرة دي'}.`
}

/** Practical recommendations derived ONLY from the gathered fact labels. */
function recommendationsFromFacts(facts: VerifyFact[]): string[] {
  const recs: string[] = []
  const low = facts.find((f) => /ناقص|نواقص/.test(f.label) && /[\d٠-٩]/.test(f.value))
  if (low && !/^\D*0\D*$/.test(low.value) && parseFirstNumber(low.value) !== 0) {
    recs.push(`رتّب أورد للنواقص (${low.label}: ${low.value}) قبل ما الموقف يسوء`)
  }
  const recv = facts.find((f) => /مديون/.test(f.label) && /[\d٠-٩]/.test(f.value))
  if (recv && parseFirstNumber(recv.value) !== 0) {
    recs.push(`اشتغل على تحصيل المديونيات (${recv.value}) — دي فلوس جوه الجيب`)
  }
  const cash = facts.find((f) => /خزن|رصيد/.test(f.label))
  if (cash) recs.push(`نظّم مصروفاتك على أساس الخزنة دلوقتي (${cash.value})`)
  const expiring = facts.find((f) => /صلاحي/.test(f.label) && /[\d٠-٩]/.test(f.value))
  if (expiring && parseFirstNumber(expiring.value) !== 0) {
    recs.push(`اعمل عرض على اللي صلاحيته قربت تخلص (${expiring.value}) عشان متخسرهاش`)
  }
  recs.push('قارن أسعار السوق بالمصادر المرقمة تحت قبل أي قرار شرا أو تسعير')
  return recs.slice(0, 4)
}

function parseFirstNumber(value: string): number | null {
  const m = toWesternDigitsLocal(value).match(/\d+(?:\.\d+)?/)
  return m ? Number(m[0]) : null
}

function toWesternDigitsLocal(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
}
