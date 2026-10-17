// وكيل — INTELLIGENT NLU MIDDLEWARE & AUTONOMOUS DECISION ENGINE
// (الوسيط الذكي لتحليل اللغة الطبيعية ومحرك اتخاذ القرار التلقائي)
//
// Implements the architecture from the Wakil Master Research Blueprint:
// 1. Speculative Entity Prefetching (< 15ms): Scans natural Arabic input against
//    the business catalog, LEXICON_GRAPH dialect aliases, customers, and suppliers,
//    injecting `[Prefetched System Entities]` into the Dynamic Tail so the LLM
//    executes in a single turn without extra search round-trips.
// 2. Natural-Language Intent & Implicit Plugin Routing: Analyzes everyday Egyptian
//    Arabic speech and routes it to the Decision Engine, which automatically selects
//    required tools/plugins (even auto-installing starter capabilities when needed)
//    without exposing any technical jargon to the user.
// 3. Task DAG Decomposition Hints: Detects compound multi-command sentences and
//    guides the Brain to execute all steps in parallel/sequence.
// 4. Immediate System Context Synchronization (`syncSystemOnMutation`): Immediately
//    updates contextual memory and system prompt state when a new feature/plugin is
//    added or a business rule (`BUSINESS_DNA`) is modified.

import type { AgentMemory, Business, Customer, Item, Supplier } from '@prisma/client'
import { db } from '@/lib/db'
import { egp, qty as fmtQty } from '@/lib/format'
import { arUnit } from '@/lib/verticals'
import type { AgentPluginDTO, ProactiveAlertDTO, ResultCardDTO } from '@/lib/types'
import { normalizeAr, toWesternDigits } from './arabic'
import {
  getTaskEvolutionContext,
  parseLexicon,
  type LexiconEntry,
  type TaskEvolutionSnapshot,
} from './memory'
import {
  executePlugin,
  getBusinessPlugins,
  pluginRegistry,
  synthesizePluginWithAI,
} from './plugin-harness'
import {
  autoLearnFromUserMessage,
  localVectorDB,
  type VectorSearchHit,
} from './vector-memory'

// ---------------------------------------------------------------------------
// 1. Speculative Entity Prefetcher (الجلب الاستباقي المتوازي للكيانات — < 15ms)
// ---------------------------------------------------------------------------

export interface PrefetchedEntitiesResult {
  matchedItems: {
    id: string
    name: string
    matchedVia: 'canonical' | 'alias' | 'lexicon'
    spokenAlias?: string
    unit: string
    sellPricePiastres: number
    costPricePiastres: number
    stockQty: number
    lowStockThreshold: number
    batchNo?: string | null
    expiresAt?: string | null
  }[]
  matchedCustomers: {
    id: string
    name: string
    balancePiastres: number
    plan?: string | null
    expiresAt?: string | null
  }[]
  matchedSuppliers: {
    id: string
    name: string
    balancePiastres: number
  }[]
  promptBlock: string
}

/**
 * Scans the user's message in memory (< 15ms) to prefetch exact matching catalog items,
 * dialect lexicon aliases, customers, and suppliers for single-turn execution.
 */
export function speculativePrefetchEntities(params: {
  text: string
  items: Item[]
  customers: Customer[]
  suppliers: Supplier[]
  lexicon: LexiconEntry[]
}): PrefetchedEntitiesResult {
  const norm = normalizeAr(toWesternDigits(params.text))
  const tokens = norm.split(/[\s،,؛;+.]+/).filter((w) => w.length >= 2)

  const matchedItems: PrefetchedEntitiesResult['matchedItems'] = []
  const seenItemIds = new Set<string>()

  // 1a) Check LEXICON_GRAPH first (highest priority learned dialect aliases)
  for (const lex of params.lexicon) {
    if (lex.alias.length >= 2 && norm.includes(lex.alias)) {
      const item = params.items.find((i) => i.id === lex.entityRef)
      if (item && !seenItemIds.has(item.id)) {
        seenItemIds.add(item.id)
        matchedItems.push({
          id: item.id,
          name: item.name,
          matchedVia: 'lexicon',
          spokenAlias: lex.alias,
          unit: item.unit,
          sellPricePiastres: item.sellPrice,
          costPricePiastres: item.costPrice,
          stockQty: item.stockQty,
          lowStockThreshold: item.lowStockThreshold,
          batchNo: item.batchNo,
          expiresAt: item.expiresAt ? item.expiresAt.toISOString().slice(0, 10) : null,
        })
      }
    }
  }

  // 1b) Check Item canonical names & comma-separated aliases
  for (const item of params.items) {
    if (seenItemIds.has(item.id)) continue
    const itemNorm = normalizeAr(item.name)
    const aliases = item.aliases
      ? item.aliases
          .split(',')
          .map((a) => normalizeAr(a.trim()))
          .filter((a) => a.length >= 2)
      : []

    const directHit =
      (itemNorm.length >= 3 && norm.includes(itemNorm)) ||
      tokens.some((tok) => tok.length >= 3 && itemNorm.split(/\s+/).some((w) => w === tok))
    const aliasHit = aliases.find((al) => al.length >= 3 && norm.includes(al))

    if (directHit || aliasHit) {
      seenItemIds.add(item.id)
      matchedItems.push({
        id: item.id,
        name: item.name,
        matchedVia: aliasHit && !directHit ? 'alias' : 'canonical',
        spokenAlias: aliasHit,
        unit: item.unit,
        sellPricePiastres: item.sellPrice,
        costPricePiastres: item.costPrice,
        stockQty: item.stockQty,
        lowStockThreshold: item.lowStockThreshold,
        batchNo: item.batchNo,
        expiresAt: item.expiresAt ? item.expiresAt.toISOString().slice(0, 10) : null,
      })
    }
  }

  // 2) Check Customers
  const matchedCustomers: PrefetchedEntitiesResult['matchedCustomers'] = []
  for (const c of params.customers) {
    const cNorm = normalizeAr(c.name)
    const cWords = cNorm.split(/\s+/).filter((w) => w.length >= 3 && w !== 'الحاج' && w !== 'مدام' && w !== 'كابتن' && w !== 'استاذ')
    if (
      (cNorm.length >= 3 && norm.includes(cNorm)) ||
      cWords.some((w) => tokens.some((tok) => tok === w || tok === `ل${w}` || tok === `ب${w}`))
    ) {
      matchedCustomers.push({
        id: c.id,
        name: c.name,
        balancePiastres: c.balance,
        plan: c.plan,
        expiresAt: c.expiresAt ? c.expiresAt.toISOString().slice(0, 10) : null,
      })
    }
  }

  // 3) Check Suppliers
  const matchedSuppliers: PrefetchedEntitiesResult['matchedSuppliers'] = []
  for (const s of params.suppliers) {
    const sNorm = normalizeAr(s.name)
    const sWords = sNorm.split(/\s+/).filter((w) => w.length >= 3 && w !== 'شركه' && w !== 'شركة' && w !== 'مؤسسه' && w !== 'الحاج')
    if (
      (sNorm.length >= 3 && norm.includes(sNorm)) ||
      sWords.some((w) => tokens.some((tok) => tok === w || tok === `من${w}` || tok === `ل${w}`))
    ) {
      matchedSuppliers.push({
        id: s.id,
        name: s.name,
        balancePiastres: s.balance,
      })
    }
  }

  const lines: string[] = []
  for (const it of matchedItems.slice(0, 6)) {
    lines.push(
      `  • Item "${it.name}" (id: ${it.id}, stock: ${fmtQty(it.stockQty, arUnit(it.unit))}, sell_price: ${egp(it.sellPricePiastres)}, cost_price: ${egp(it.costPricePiastres)}${
        it.matchedVia === 'lexicon' ? `, matched_lexicon_alias: "${it.spokenAlias}"` : ''
      }${it.expiresAt ? `, expires: ${it.expiresAt}` : ''})`,
    )
  }
  for (const c of matchedCustomers.slice(0, 4)) {
    lines.push(
      `  • Customer "${c.name}" (id: ${c.id}, current_balance_owed_to_us: ${egp(c.balancePiastres)}${
        c.plan ? `, gym_plan: "${c.plan}"` : ''
      }${c.expiresAt ? `, membership_expires: ${c.expiresAt}` : ''})`,
    )
  }
  for (const s of matchedSuppliers.slice(0, 4)) {
    lines.push(
      `  • Supplier "${s.name}" (id: ${s.id}, current_balance_we_owe: ${egp(s.balancePiastres)})`,
    )
  }

  const promptBlock =
    lines.length > 0
      ? `\n## [Prefetched System Entities — كيانات مطابقة استباقياً من قاعدة البيانات]\n${lines.join('\n')}`
      : ''

  return {
    matchedItems,
    matchedCustomers,
    matchedSuppliers,
    promptBlock,
  }
}

// ---------------------------------------------------------------------------
// 2. Natural-Language Implicit Plugin & Capability Detector
// ---------------------------------------------------------------------------

export interface ImplicitPluginRoute {
  action: 'run_existing' | 'auto_activate_starter' | 'synthesize_custom'
  slug?: string
  pluginName?: string
  reasonAr: string
}

const IMPLICIT_STARTER_PATTERNS: { slug: string; name: string; re: RegExp; reasonAr: string }[] = [
  {
    slug: 'plugin_inventory_optimizer',
    name: 'إدارة المخزون الذكية وتصنيف ABC',
    re: /(تصنيف\s*abc|الاصناف الراكده|البضاعه الراكده|بضاعه نايمه|فلوس متجمده في المخزن|جرد ذكي|تحليل المخزون الذكي|نظملي المخزن|اداره المخزون)/i,
    reasonAr: 'المستخدم يطلب تحليل المخزون وكشف الأصناف الراكدة وتصنيف أهميتها',
  },
  {
    slug: 'plugin_sales_velocity',
    name: 'تحليل المبيعات وسرعة الدوران',
    re: /(سرعه المبيعات|سرعه الدوران|ايه اكتر حاجه بتتباع|الاصناف الحصان الرابح|تحليل المبيعات|تقرير المبيعات المتقدم|حركه السحب والبيع)/i,
    reasonAr: 'المستخدم يطلب تحليل سرعة دوران المبيعات والأصناف الأعلى سحباً وربحاً',
  },
  {
    slug: 'plugin_margin_shield',
    name: 'درع الهوامش ورقابة التسعير',
    re: /(درع الهوامش|رقابه الاسعار|فروق الاسعار|الاصناف اللي بتخسر|هامش ربح ضعيف|تعديل الاسعار المقترح|حمايه الربحيه)/i,
    reasonAr: 'المستخدم يطلب فحص هوامش الربح ورقابة التسعير لحماية المكسب',
  },
  {
    slug: 'plugin_receivables_collector',
    name: 'مدير التحصيلات والائتمان الذكي',
    re: /(خطه تحصيل|اداره التحصيلات|مدير التحصيلات|تحليل مديونيات العملاء|جدول تحصيل الديون|اعمار الديون)/i,
    reasonAr: 'المستخدم يطلب خطة تحصيل ذكية وتحليل مديونيات العملاء',
  },
  {
    slug: 'plugin_expiry_shield',
    name: 'رادار الصلاحيات وحماية التشغيلات',
    re: /(رادار الصلاحيات|حمايه التشغيلات|البضاعه اللي قربت تنتهي|خساير الصلاحيه|تصريف الادويه القريبه)/i,
    reasonAr: 'المستخدم يطلب فحص تواريخ الصلاحية وحماية البضاعة من التلف',
  },
]

/**
 * Analyzes natural Arabic user input to see if it maps to an installed plugin,
 * a starter capability, or a custom capability request—without requiring technical terms.
 */
export function detectImplicitPluginRoute(
  text: string,
  plugins: AgentPluginDTO[],
): ImplicitPluginRoute | null {
  const norm = normalizeAr(text)

  // 1) Check active installed plugins by their natural triggers
  for (const p of plugins) {
    if (!p.installed || !p.active) continue
    for (const trig of p.triggers) {
      const tNorm = normalizeAr(trig)
      if (tNorm.length >= 4 && norm.includes(tNorm)) {
        return {
          action: 'run_existing',
          slug: p.slug,
          pluginName: p.name,
          reasonAr: `تطابق طبيعي مع قدرة «${p.name}» المفعّلة في النظام`,
        }
      }
    }
  }

  // 2) Check implicit natural requests matching starter catalog capabilities
  for (const pat of IMPLICIT_STARTER_PATTERNS) {
    if (pat.re.test(norm)) {
      const existing = plugins.find((p) => p.slug === pat.slug)
      return {
        action: existing?.installed && existing.active ? 'run_existing' : 'auto_activate_starter',
        slug: pat.slug,
        pluginName: pat.name,
        reasonAr: pat.reasonAr,
      }
    }
  }

  // 3) Check natural capability creation requests («عايز أتابع ... دايماً», «اعمل نظام يراقب ...»)
  if (
    /(عايز اتابع|عايز اراقب|اعمل نظام|ابني نظام|خصصلي اداه|ضيف ميزه|ضيف قدره)/.test(norm) &&
    norm.length >= 12
  ) {
    return {
      action: 'synthesize_custom',
      reasonAr: 'المستخدم يطلب بناء قدرة متابعة مخصصة جديدة من خلال الحوار الطبيعي',
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// 3. Compound Multi-Intent / Task DAG Detector
// ---------------------------------------------------------------------------

export interface TaskDAGAnalysis {
  isMultiStep: boolean
  estimatedSteps: number
  detectedClauses: string[]
  directiveAr: string
}

export function analyzeTaskDAG(text: string): TaskDAGAnalysis {
  const norm = normalizeAr(toWesternDigits(text))
  // Split on natural Egyptian Arabic compound connectors when followed by action/query verbs
  const actionBoundaryRe =
    /\s+(?:و\s*(?:كمان|بعدين|بالمره|برضه)|،\s*و?|؛\s*|\+\s*|و(?=(?:بعت|اشتريت|سجل|حصلت|قبضت|سدد|صرفت|قولي|شوفلي|اعرض|هات|ضيف|عدل|فكرني|ذكرني|احسب|حلل|توقع|ارسم|افتح)))\s*/g

  const parts = norm
    .split(actionBoundaryRe)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4)

  const isMultiStep = parts.length >= 2
  if (!isMultiStep) {
    return {
      isMultiStep: false,
      estimatedSteps: 1,
      detectedClauses: [text.trim()],
      directiveAr: '',
    }
  }

  return {
    isMultiStep: true,
    estimatedSteps: parts.length,
    detectedClauses: parts.slice(0, 6),
    directiveAr: `\n## [توجيه محرك تفكيك المهام المركبة (Task DAG Engine — ${parts.length} خطوات مرصودة)]\n- رسالة المستخدم مركبة وتحتوي على ${parts.length} طلبات مترابطة:\n${parts
      .slice(0, 6)
      .map((c, idx) => `  ${idx + 1}. «${c}»`)
      .join('\n')}\n- **إلزامي**: استدعِ جميع الأدوات اللازمة لتنفيذ كل هذه الخطوات معاً في مصفوفة \`tool_calls\` واحدة دون إهمال أي شق، ولا تعطّل الخطوات الواضحة إذا كانت إحدى الخطوات تحتاج استفساراً.`,
  }
}

// ---------------------------------------------------------------------------
// 4. Decision Engine & Middleware Orchestrator (`DecisionEngine`)
// ---------------------------------------------------------------------------

export interface DecisionMiddlewareContext {
  prefetched: PrefetchedEntitiesResult
  implicitPlugin: ImplicitPluginRoute | null
  dag: TaskDAGAnalysis
  taskEvolution: TaskEvolutionSnapshot
  vectorHits: VectorSearchHit[]
  wantsWebSearch: boolean
  dynamicTailPrompt: string
}

const LIVE_WEB_SEARCH_RE =
  /(في السوق|اسعار السوق|سعر السوق|في الانترنت|علي النت|على النت|ابحث في جوجل|دور في النت|بكام بره|المنافسين|اسعار الجمله اليوم|اخبار السوق|سعر الدولار|سعر الذهب|موردين في مصر)/i

export class DecisionEngine {
  /**
   * Analyzes raw natural user input through the NLU Middleware, prefetches entities
   * in < 15ms, retrieves semantic memories from the Local Vector Database via Cosine Similarity,
   * evaluates implicit plugin/tool matches, tracks task evolution, and constructs the
   * enriched Dynamic Tail for the LLM Brain.
   */
  async analyzeAndRoute(params: {
    business: Business
    user: { id: string; name: string; role: string }
    text: string
    items: Item[]
    customers: Customer[]
    suppliers: Supplier[]
    memories: AgentMemory[]
    plugins: AgentPluginDTO[]
  }): Promise<DecisionMiddlewareContext> {
    const lexicon = parseLexicon(params.memories)

    // Continual background learning of implicit user preferences & habits
    void autoLearnFromUserMessage({
      businessId: params.business.id,
      userId: params.user.id,
      text: params.text,
    }).catch(() => null)

    const [prefetched, taskEvolution, vectorCtx] = await Promise.all([
      Promise.resolve(
        speculativePrefetchEntities({
          text: params.text,
          items: params.items,
          customers: params.customers,
          suppliers: params.suppliers,
          lexicon,
        }),
      ),
      getTaskEvolutionContext(params.business.id),
      localVectorDB.buildVectorContextBlock({
        businessId: params.business.id,
        query: params.text,
        memories: params.memories,
        topK: 7,
      }),
    ])

    const implicitPlugin = detectImplicitPluginRoute(params.text, params.plugins)
    const dag = analyzeTaskDAG(params.text)
    const normText = normalizeAr(params.text)
    const wantsWebSearch = LIVE_WEB_SEARCH_RE.test(normText)

    const decisionLines: string[] = []
    if (implicitPlugin) {
      if (implicitPlugin.action === 'run_existing' && implicitPlugin.slug) {
        decisionLines.push(
          `- **توجيه محرك اتخاذ القرار (Decision Engine)**: طلب المستخدم الطبيعي يطابق قدرة «${implicitPlugin.pluginName}» المفعّلة في سجل الأدوات (Plugin Registry). يمكنك استدعاء \`run_plugin({"slug": "${implicitPlugin.slug}"})\` فوراً لتنفيذها وعرض جداولها بدون أي تعقيد برمجي.`,
        )
      } else if (implicitPlugin.action === 'auto_activate_starter' && implicitPlugin.slug) {
        decisionLines.push(
          `- **توجيه محرك اتخاذ القرار (Decision Engine)**: طلب المستخدم الطبيعي يحتاج قدرة «${implicitPlugin.pluginName}» (${implicitPlugin.reasonAr}). استدعِ \`install_plugin({"prompt": "${implicitPlugin.pluginName}", "name": "${implicitPlugin.pluginName}"})\` لتفعيلها وتشغيلها فوراً في خطوة واحدة شفافة.`,
        )
      } else if (implicitPlugin.action === 'synthesize_custom') {
        decisionLines.push(
          `- **توجيه محرك اتخاذ القرار (Decision Engine)**: المستخدم يطلب بناء أداة أو نظام متابعة مستمر جديد بكلامه الطبيعي في نص المحادثة. استدعِ \`install_plugin({"prompt": "${params.text.replace(/"/g, "'").slice(0, 120)}"})\` لبنائه برمجياً وتسجيله في PluginRegistry وإضافته للواجهة والذاكرة فوراً.`,
        )
      }
    }

    if (wantsWebSearch) {
      decisionLines.push(
        `- **توجيه بحث الإنترنت الحي (Google Search Grounding)**: المستخدم يسأل عن معلومات سوقية حية أو بيانات من الإنترنت. استدعِ أداة \`search_web_live({"query": "${params.text.replace(/"/g, "'").slice(0, 100)}"})\` لجلب أحدث النتائج والمصادر الموثقة عبر بحث جيميناي الحي.`,
      )
    }

    const decisionBlock =
      decisionLines.length > 0
        ? `\n## [توجيهات محرك اتخاذ القرار الذكي — Decision Engine Middleware]\n${decisionLines.join('\n')}`
        : ''

    const dynamicTailPrompt = [
      vectorCtx.promptBlock,
      taskEvolution.promptSummary,
      prefetched.promptBlock,
      decisionBlock,
      dag.directiveAr,
    ]
      .filter(Boolean)
      .join('\n')

    return {
      prefetched,
      implicitPlugin,
      dag,
      taskEvolution,
      vectorHits: vectorCtx.hits,
      wantsWebSearch,
      dynamicTailPrompt,
    }
  }

  /**
   * Executes a matched plugin or auto-synthesizes a capability transparently when
   * invoked by the Decision Engine or Brain.
   */
  async executePluginTransparently(params: {
    businessId: string
    userId: string
    route: ImplicitPluginRoute
    rawText: string
  }): Promise<{
    plugin: AgentPluginDTO
    cards: ResultCardDTO[]
    alerts: ProactiveAlertDTO[]
    summaryText: string
    autoInstalled: boolean
  }> {
    if (params.route.action === 'run_existing' && params.route.slug) {
      const res = await pluginRegistry.execute(params.businessId, params.route.slug)
      return { ...res, autoInstalled: false }
    }

    const promptToUse = params.route.pluginName || params.rawText
    const installed = await synthesizePluginWithAI({
      businessId: params.businessId,
      userId: params.userId,
      prompt: promptToUse,
      preferredName: params.route.pluginName,
    })
    const res = await executePlugin({
      businessId: params.businessId,
      pluginOrSlug: installed,
    })
    return { ...res, autoInstalled: true }
  }

  /**
   * High-level entry point called by the Agent Brain loop (`harness.ts`):
   * Analyzes raw natural input, prefetches entities in < 15ms, retrieves semantic
   * vector memories, auto-executes/installs implicit plugins when requested in
   * natural speech, and returns the enriched `dynamicRuntimeTail` + `thinkingDetail`.
   */
  async routeAndPrepare(params: {
    text: string
    business: Business
    userId: string
    items: Item[]
    customers: Customer[]
    suppliers: Supplier[]
    memories: AgentMemory[]
  }): Promise<{
    analysis: DecisionMiddlewareContext
    dynamicRuntimeTail: string
    thinkingDetail: string
    autoExecutedPlugin?: {
      plugin: AgentPluginDTO
      cards: ResultCardDTO[]
      alerts: ProactiveAlertDTO[]
      summaryText: string
      autoInstalled: boolean
    }
  }> {
    const plugins = await getBusinessPlugins(params.business.id)
    const analysis = await this.analyzeAndRoute({
      business: params.business,
      user: { id: params.userId, name: 'صاحب الشغل', role: 'owner' },
      text: params.text,
      items: params.items,
      customers: params.customers,
      suppliers: params.suppliers,
      memories: params.memories,
      plugins,
    })

    let autoExecutedPlugin:
      | {
          plugin: AgentPluginDTO
          cards: ResultCardDTO[]
          alerts: ProactiveAlertDTO[]
          summaryText: string
          autoInstalled: boolean
        }
      | undefined

    // If the user's natural speech matches an existing active plugin or a starter capability,
    // execute it directly from the Plugin Registry so the user gets real-time execution with zero friction!
    if (analysis.implicitPlugin) {
      if (analysis.implicitPlugin.action === 'run_existing' || analysis.implicitPlugin.action === 'auto_activate_starter') {
        try {
          autoExecutedPlugin = await this.executePluginTransparently({
            businessId: params.business.id,
            userId: params.userId,
            route: analysis.implicitPlugin,
            rawText: params.text,
          })
        } catch (err) {
          console.error('[DecisionEngine] direct plugin execution failed:', err)
        }
      }
    }

    const matchedCount =
      analysis.prefetched.matchedItems.length +
      analysis.prefetched.matchedCustomers.length +
      analysis.prefetched.matchedSuppliers.length

    const thinkingBits: string[] = []
    if (matchedCount > 0) {
      thinkingBits.push(`جهزت ${matchedCount} كيانات مطابقة من السجل`)
    }
    if (analysis.vectorHits.length > 0) {
      thinkingBits.push(`استرجعت ${analysis.vectorHits.length} ذكريات دلالية مرتبطة`)
    }
    if (analysis.dag.isMultiStep) {
      thinkingBits.push(`فككت رسالتك لـ ${analysis.dag.estimatedSteps} خطوات مترابطة`)
    }
    if (analysis.implicitPlugin) {
      thinkingBits.push(`وجهت الطلب لـ «${analysis.implicitPlugin.pluginName ?? 'قدرة متخصصة'}»`)
    }
    if (analysis.wantsWebSearch) {
      thinkingBits.push('فعّلت بحث الإنترنت الحي عبر Gemini')
    }

    return {
      analysis,
      dynamicRuntimeTail: analysis.dynamicTailPrompt,
      thinkingDetail: thinkingBits.join(' · ') || 'عقلي بيحلل كلامك ويختار أنسب خطوة',
      autoExecutedPlugin,
    }
  }

  /**
   * Immediately synchronizes contextual vector memory, plugin registry, and audit log
   * whenever a new feature/plugin is added, a business rule (`BUSINESS_DNA`) is
   * created/patched, or business nature/settings change.
   */
  async syncSystemOnMutation(params: {
    businessId: string
    userId: string
    mutationKind?: 'plugin_added' | 'rule_changed' | 'lexicon_learned' | 'business_configured' | 'playbook_saved' | 'system_updated'
    mutationType?: string
    summaryAr?: string
    title?: string
    detail?: string
  }): Promise<{
    refreshedMemories: AgentMemory[]
    refreshedPlugins: AgentPluginDTO[]
  }> {
    const kind = params.mutationKind || params.mutationType || 'system_updated'
    const summary = params.summaryAr || `${params.title ?? ''}: ${params.detail ?? ''}`.trim()

    // Log an audit event for immediate system traceability
    await db.auditEvent
      .create({
        data: {
          businessId: params.businessId,
          actor: params.userId ?? 'system',
          action: `system.${kind}`,
          detail: JSON.stringify({
            summary,
            timestamp: new Date().toISOString(),
          }),
        },
      })
      .catch(() => null)

    // Reload fresh memories and plugins so the running turn and UI have zero staleness
    const [refreshedMemories, refreshedPlugins] = await Promise.all([
      db.agentMemory.findMany({
        where: {
          businessId: params.businessId,
          ...(params.userId ? { userId: params.userId } : {}),
          active: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 36,
      }),
      getBusinessPlugins(params.businessId),
    ])

    // Sync LocalVectorDB immediately
    await localVectorDB.syncBusinessMemories(params.businessId, refreshedMemories)

    // Sync in-memory PluginRegistry
    for (const p of refreshedPlugins) {
      if (p.installed && p.active) {
        pluginRegistry.register(params.businessId, new (await import('./plugin-harness')).BasePlugin(p))
      }
    }

    return {
      refreshedMemories,
      refreshedPlugins,
    }
  }
}

export const decisionEngine = new DecisionEngine()

