import { requirePermission } from '@/lib/security/permissions'
// وكيل — DYNAMIC AI-POWERED PLUGIN HARNESS (معمارية البلاجنز الذكية الديناميكية)
//
// Inspired by DeepSeek Harness & Claude Tool Plugins:
// Every capability (Inventory Management, Sales Velocity Analytics, Margin Shield,
// VIP Debt Collector, Cashflow Guard, Expiry Shield, or any custom feature the
// user describes in conversation) is packaged as a dynamic PluginSpec stored in
// the database (`CustomTool` with `kind = 'plugin'`).
//
// Capabilities:
// 1. `synthesizePluginWithAI`: Uses Google Gemini (`gemini-3.8-flash` with
//    structured JSON schema) + a deterministic domain compiler fallback to
//    turn any natural-language Arabic request (e.g., «ضيف ميزة إدارة المخزون»,
//    «اعمل بلاجن لتحليل المبيعات والخصومات») into an executable multi-step
//    PluginSpec with proactive risk/opportunity rules and quick-command chips.
// 2. `executePlugin`: Executes all pipeline modules of a plugin concurrently
//    against real Prisma business data, returning structured ResultCardDTO[]
//    and proactive alerts.
// 3. `matchPluginByTrigger`: Matches user chat messages against active plugin
//    triggers for zero-latency execution.

import { Type } from '@google/genai'
import { db } from '@/lib/db'
import type {
  AgentPluginDTO,
  PluginCategory,
  PluginPipelineModule,
  PluginProactiveRule,
  PluginStepSpec,
  ProactiveAlertDTO,
  ResultCardDTO,
} from '@/lib/types'
import { egp, qty as fmtQty, arDate } from '@/lib/format'
import { arUnit } from '@/lib/verticals'
import { startOfCairoDay } from '@/app/api/_lib/dates'
import { normalizeAr } from './arabic'
import { getGeminiClient } from './llm'


const SUPPORTED_PLUGIN_MODULES = new Set(['inventory_audit', 'sales_analytics', 'margin_audit', 'receivables_aging', 'supplier_payables', 'expiry_shield'])
function validatePluginPipeline(pipeline: PluginStepSpec[]): void {
  if (!Array.isArray(pipeline) || !pipeline.length || pipeline.length > 6 || pipeline.some((step) => !SUPPORTED_PLUGIN_MODULES.has(step.module))) throw new Error('unsupported_capability: الإضافة لازم تكون من وحدات التحليل المتاحة؛ مفيش كود حر أو استعلام وهمي')
  for (const step of pipeline) {
    for (const [key, max] of [['daysWindow', 365], ['limit', 100], ['minMarginPct', 99]] as const) {
      const value = step.params?.[key]
      if (value != null && (!Number.isFinite(value) || value < 0 || value > max)) throw new Error('إعداد تحليل خارج الحدود المسموحة')
    }
  }
}
// ---------------------------------------------------------------------------
// Built-in Starter Plugin Catalog (available to install in 1 click or via chat)
// ---------------------------------------------------------------------------

export const STARTER_PLUGIN_CATALOG: Omit<AgentPluginDTO, 'id' | 'active' | 'installed' | 'usageCount' | 'lastUsedAt'>[] = [
  {
    slug: 'plugin_inventory_optimizer',
    name: 'إدارة المخزون الذكية وتصنيف ABC',
    description: 'يحلل قيمة المخزون، يصنّف الأصناف حسب الأهمية (A/B/C)، يكشف الأصناف الراكدة، ويحسب كميات وتكلفة إعادة الطلب بدقة.',
    category: 'inventory',
    icon: 'boxes',
    version: '2.1.0',
    author: 'wakil-core',
    triggers: ['إدارة المخزون', 'بلاجن المخزون', 'تصنيف المخزون', 'تحليل المخزون الذكي', 'جرد ذكي', 'الأصناف الراكدة'],
    capabilities: [
      'تصنيف الأصناف A/B/C حسب القيمة المالية وحركة السحب',
      'كشف رأس المال المجمد في الأصناف الراكدة',
      'حساب ميزانية إعادة الطلب التلقائية لتغطية ١٤ يوم',
      'تنبيه استباقي عند انخفاض الأمان المخزني',
    ],
    pipeline: [
      { module: 'inventory_audit', label: 'فحص المخزون وتصنيف ABC المالي', params: { sortBy: 'stock', limit: 12 } },
      { module: 'margin_audit', label: 'مراجعة تكلفة وربحية المخزون الحالي', params: { sortBy: 'margin', limit: 8 } },
    ],
    proactiveRules: [
      {
        kind: 'risk',
        metric: 'low_stock_ratio',
        threshold: 15,
        title: 'نسبة النواقص تجاوزت حد الأمان (١٥٪ من الكتالوج)',
        recommendation: 'راجع خطة إعادة الطلب في بلاجن إدارة المخزون لتفادي ضياع مبيعات محققة.',
      },
      {
        kind: 'opportunity',
        metric: 'dead_stock_value',
        threshold: 50000,
        title: 'فرصة تحرير سيولة من أصناف بطيئة الحركة',
        recommendation: 'اعمل عرض مجمع أو خصم ١٠٪ على الأصناف الأعلى تكدساً لتحويلها إلى كاش سريع.',
      },
    ],
    quickPrompt: 'شغّل بلاجن إدارة المخزون الذكية وتصنيف ABC',
  },
  {
    slug: 'plugin_sales_velocity',
    name: 'تحليل المبيعات وسرعة الدوران',
    description: 'يرصد سرعة دوران المبيعات اليومية والأسبوعية، يكشف الأصناف الحصان الرابح (Stars)، ويقارن الإيرادات بصافي الربح الحقيقي.',
    category: 'sales',
    icon: 'chart',
    version: '2.0.0',
    author: 'wakil-core',
    triggers: ['تحليل المبيعات', 'بلاجن المبيعات', 'سرعة المبيعات', 'تقرير المبيعات المتقدم', 'الأصناف الأكثر مبيعاً', 'حركة البيع'],
    capabilities: [
      'تحليل سرعة دوران الأصناف ومعدل السحب اليومي',
      'ترتيب الأصناف الأعلى مساهمة في الإيراد وصافي الربح',
      'مقارنة أداء المبيعات خلال آخر ٧ أيام بمتوسط الشهر',
      'اكتشاف فرص رفع المبيعات للأصناف ذات الهامش المرتفع',
    ],
    pipeline: [
      { module: 'sales_analytics', label: 'تحليل سرعة المبيعات والأصناف الرابحة', params: { daysWindow: 30, sortBy: 'revenue', limit: 10 } },
      { module: 'margin_audit', label: 'تحليل مساهمة الهوامش في صافي الربح', params: { sortBy: 'margin', limit: 8 } },
    ],
    proactiveRules: [
      {
        kind: 'opportunity',
        metric: 'high_velocity_star',
        threshold: 1,
        title: 'فرصة تعظيم ربح من الأصناف الأعلى طلباً (Stars)',
        recommendation: 'الأصناف الأكثر سحباً تحقق هامشاً ممتازاً — تأكد من وفرة رصيدها وعرضها في الصدارة.',
      },
    ],
    quickPrompt: 'شغّل بلاجن تحليل المبيعات وسرعة الدوران',
  },
  {
    slug: 'plugin_margin_shield',
    name: 'درع الهوامش ورقابة التسعير',
    description: 'يراقب فروق أسعار التكلفة والبيع، يكشف أي عملية بيع تمت بخصم يأكل الهامش، ويقترح تعديلات تسعير ذكية لحماية ربحية المنشأة.',
    category: 'finance',
    icon: 'wallet',
    version: '1.8.0',
    author: 'wakil-core',
    triggers: ['درع الهوامش', 'رقابة الأسعار', 'تحليل التسعير', 'فروق الأسعار', 'حماية الربحية'],
    capabilities: [
      'فحص كافة الأصناف التي يقل هامش ربحها عن ٢٠٪',
      'رصد عمليات البيع بسعر مخصص أقل من التكلفة أو السعر الرسمي',
      'حساب السعر المقترح للوصول لهامش ربح مستهدف ٢٥٪',
    ],
    pipeline: [
      { module: 'margin_audit', label: 'فحص شامل لهوامش الأصناف والتسعير المقترح', params: { minMarginPct: 22, sortBy: 'margin', limit: 12 } },
    ],
    proactiveRules: [
      {
        kind: 'risk',
        metric: 'low_margin_items',
        threshold: 2,
        title: 'أصناف تُباع بهامش ربح ضعيف يهدد صافي المكسب',
        recommendation: 'راجع جدول التسعير المقترح في درع الهوامش لتعديل أسعار البيع.',
      },
    ],
    quickPrompt: 'شغّل بلاجن درع الهوامش ورقابة التسعير',
  },
  {
    slug: 'plugin_receivables_collector',
    name: 'مدير التحصيلات والائتمان الذكي',
    description: 'يرتب مديونيات العملاء حسب الأولوية والخطورة، يحسب نسبة تغطية الديون للسيولة، ويجهز خطة تحصيل فورية.',
    category: 'customers',
    icon: 'users',
    version: '1.9.0',
    author: 'wakil-core',
    triggers: ['إدارة التحصيلات', 'بلاجن الديون', 'خطة التحصيل', 'تحليل مديونيات العملاء', 'متابعة الآجل'],
    capabilities: [
      'تصنيف العملاء المدينين حسب حجم المديونية والأولوية',
      'مقارنة إجمالي المديونيات برصيد الخزنة ومستحقات الموردين',
      'اقتراح جدول تحصيل يومي لتحسين التدفق النقدي',
    ],
    pipeline: [
      { module: 'receivables_aging', label: 'تحليل أعمار وتركز مديونيات العملاء', params: { sortBy: 'balance', limit: 10 } },
      { module: 'supplier_payables', label: 'موازنة التحصيلات مع التزامات الموردين', params: { sortBy: 'balance', limit: 8 } },
    ],
    proactiveRules: [
      {
        kind: 'risk',
        metric: 'overdue_receivables',
        threshold: 100000,
        title: 'تركز مديونيات لدى العملاء يؤثر على دورة الكاش',
        recommendation: 'ابدأ بخطة التحصيل لأكبر ٣ عملاء مدينين لرفع سيولة الخزنة.',
      },
    ],
    quickPrompt: 'شغّل بلاجن مدير التحصيلات والائتمان الذكي',
  },
  {
    slug: 'plugin_expiry_shield',
    name: 'رادار الصلاحيات وحماية التشغيلات',
    description: 'يتابع تواريخ صلاحية الأصناف والتشغيلات، يحسب القيمة المعرضة للتلف، ويقترح عروض تصريف مبكرة قبل انتهاء الصلاحية.',
    category: 'operations',
    icon: 'alert',
    version: '1.5.0',
    author: 'wakil-core',
    triggers: ['رادار الصلاحيات', 'إدارة الصلاحيات', 'حماية التشغيلات', 'الأصناف قريبة الانتهاء'],
    capabilities: [
      'جرد الأصناف التي تنتهي صلاحيتها خلال ٣٠ و٦٠ يوماً',
      'حساب التكلفة المالية المعرضة للهالك',
      'توصيات تصريف وعروض سريعة قبل فوات الأوان',
    ],
    pipeline: [
      { module: 'expiry_shield', label: 'فحص تواريخ الصلاحية والتشغيلات الحرجة', params: { daysWindow: 60, limit: 12 } },
      { module: 'inventory_audit', label: 'مراجعة أرصدة الأصناف الحرجة', params: { limit: 8 } },
    ],
    proactiveRules: [],
    quickPrompt: 'شغّل بلاجن رادار الصلاحيات وحماية التشغيلات',
  },
]

// ---------------------------------------------------------------------------
// Parsing & Serialization of Plugin Rows stored in `CustomTool` (kind='plugin')
// ---------------------------------------------------------------------------

interface StoredPluginConfig {
  slug?: string
  description?: string
  category?: PluginCategory
  icon?: AgentPluginDTO['icon']
  version?: string
  author?: AgentPluginDTO['author']
  triggers?: string[]
  capabilities?: string[]
  pipeline?: PluginStepSpec[]
  proactiveRules?: PluginProactiveRule[]
  quickPrompt?: string
}

function parsePluginConfig(raw: string, fallbackName: string): StoredPluginConfig {
  try {
    const parsed = JSON.parse(raw) as StoredPluginConfig
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed
  } catch {
    return {
      slug: `plugin_${Date.now()}`,
      description: `بلاجن مخصص لـ ${fallbackName}`,
      category: 'operations',
      icon: 'spark',
      version: '1.0.0',
      author: 'ai-synthesized',
      triggers: [fallbackName],
      capabilities: [`تشغيل وتحليل ${fallbackName}`],
      pipeline: [{ module: 'inventory_audit', label: `تحليل ${fallbackName}` }],
      proactiveRules: [],
      quickPrompt: `شغّل بلاجن ${fallbackName}`,
    }
  }
}

export async function getBusinessPlugins(businessId: string): Promise<AgentPluginDTO[]> {
  const rows = await db.customTool.findMany({
    where: { businessId, kind: 'plugin' },
    orderBy: { createdAt: 'desc' },
  })

  const installedBySlug = new Map<string, AgentPluginDTO>()
  const customInstalled: AgentPluginDTO[] = []

  for (const row of rows) {
    const cfg = parsePluginConfig(row.config, row.name)
    const slug = cfg.slug || `plugin_${row.id.slice(0, 8)}`
    const dto: AgentPluginDTO = {
      id: row.id,
      slug,
      name: row.name,
      description: cfg.description || `ميزة ذكية مخصصة لـ ${row.name}`,
      category: cfg.category || 'operations',
      icon: cfg.icon || 'spark',
      version: cfg.version || '1.0.0',
      author: cfg.author || 'ai-synthesized',
      active: row.active,
      installed: true,
      usageCount: row.usageCount,
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
      triggers: Array.isArray(cfg.triggers) && cfg.triggers.length > 0 ? cfg.triggers : [row.name],
      capabilities: Array.isArray(cfg.capabilities) && cfg.capabilities.length > 0 ? cfg.capabilities : [`تحليل وتشغيل ${row.name}`],
      pipeline: Array.isArray(cfg.pipeline) && cfg.pipeline.length > 0
        ? cfg.pipeline
        : [{ module: 'inventory_audit', label: `تشغيل ${row.name}` }],
      proactiveRules: Array.isArray(cfg.proactiveRules) ? cfg.proactiveRules : [],
      quickPrompt: cfg.quickPrompt || `شغّل بلاجن ${row.name}`,
    }
    installedBySlug.set(slug, dto)
    if (!STARTER_PLUGIN_CATALOG.some((s) => s.slug === slug)) {
      customInstalled.push(dto)
    }
  }

  // Merge custom installed plugins first, then starter catalog (showing installed status)
  const mergedStarter: AgentPluginDTO[] = STARTER_PLUGIN_CATALOG.map((starter) => {
    const existing = installedBySlug.get(starter.slug)
    if (existing) return existing
    return {
      ...starter,
      id: `catalog:${starter.slug}`,
      active: false,
      installed: false,
      usageCount: 0,
      lastUsedAt: null,
    }
  })

  return [...customInstalled, ...mergedStarter]
}

export async function getActivePlugins(businessId: string): Promise<AgentPluginDTO[]> {
  const all = await getBusinessPlugins(businessId)
  return all.filter((p) => p.installed && p.active)
}

/** Builds a compact section injected into the Agent Brain System Prompt so the LLM knows all installed plugins. */
export function pluginsPromptSection(plugins: AgentPluginDTO[]): string {
  const active = plugins.filter((p) => p.installed && p.active)
  if (active.length === 0) {
    return `\n## قدرات وإضافات النظام الذكية (Dynamic Capabilities / Plugins)\n- يمكن تثبيت تجميع وحدات التحليل المعتمدة عبر install_plugin({prompt, name?}) بعد طلب تثبيت صريح والتحقق من tools.manage؛ لا تثبيت تلقائي من سؤال قراءة ولا كود حر (مثل متابعة الأصناف الراكدة، تحليل المبيعات، مراقبة الهوامش، متابعة الديون، أو أي قدرة مخصصة).`
  }
  const lines = active
    .map((p) => `- ميزة «${p.name}» (معرّف الأداة: "${p.slug}"): ${p.description} — تُشغّل عند طلب: ${p.triggers.slice(0, 4).join('، ')}`)
    .join('\n')
  return `\n## القدرات والميزات المفعّلة حالياً في النظام (جاهزة للتشغيل الفوري)\n${lines}\n- لتشغيل أي ميزة مفعّلة استخدم run_plugin({slug})، ولإضافة أو بناء ميزة/قدرة جديدة يطلبها المستخدم بكلامه الطبيعي استخدم install_plugin({prompt, name?}).`
}

// ---------------------------------------------------------------------------
// Formal PluginInterface & PluginRegistry (DeepSeek / Modular Harness Pattern)
// ---------------------------------------------------------------------------

export interface PluginExecutionContext {
  businessId: string
  userId?: string
  args?: Record<string, unknown>
}

export interface PluginExecutionResult {
  plugin: AgentPluginDTO
  cards: ResultCardDTO[]
  alerts: ProactiveAlertDTO[]
  summaryText: string
}

/**
 * Base contract for all modular capabilities & external tools in the Plugin Harness.
 */
export interface PluginInterface {
  readonly slug: string
  readonly name: string
  readonly description: string
  readonly category: PluginCategory
  readonly icon: AgentPluginDTO['icon']
  readonly version: string
  readonly author: AgentPluginDTO['author']
  readonly triggers: string[]
  readonly capabilities: string[]
  readonly pipeline: PluginStepSpec[]
  readonly proactiveRules: PluginProactiveRule[]
  readonly quickPrompt: string
  execute(ctx: PluginExecutionContext): Promise<PluginExecutionResult>
  toDTO(state?: {
    id?: string
    active?: boolean
    installed?: boolean
    usageCount?: number
    lastUsedAt?: string | null
  }): AgentPluginDTO
}

export class BasePlugin implements PluginInterface {
  readonly slug: string
  readonly name: string
  readonly description: string
  readonly category: PluginCategory
  readonly icon: AgentPluginDTO['icon']
  readonly version: string
  readonly author: AgentPluginDTO['author']
  readonly triggers: string[]
  readonly capabilities: string[]
  readonly pipeline: PluginStepSpec[]
  readonly proactiveRules: PluginProactiveRule[]
  readonly quickPrompt: string

  constructor(spec: Omit<AgentPluginDTO, 'id' | 'active' | 'installed' | 'usageCount' | 'lastUsedAt'>) {
    this.slug = spec.slug
    this.name = spec.name
    this.description = spec.description
    this.category = spec.category
    this.icon = spec.icon
    this.version = spec.version
    this.author = spec.author
    this.triggers = spec.triggers
    this.capabilities = spec.capabilities
    this.pipeline = spec.pipeline
    this.proactiveRules = spec.proactiveRules
    this.quickPrompt = spec.quickPrompt
  }

  toDTO(state?: {
    id?: string
    active?: boolean
    installed?: boolean
    usageCount?: number
    lastUsedAt?: string | null
  }): AgentPluginDTO {
    return {
      id: state?.id ?? `catalog:${this.slug}`,
      slug: this.slug,
      name: this.name,
      description: this.description,
      category: this.category,
      icon: this.icon,
      version: this.version,
      author: this.author,
      active: state?.active ?? true,
      installed: state?.installed ?? true,
      usageCount: state?.usageCount ?? 0,
      lastUsedAt: state?.lastUsedAt ?? null,
      triggers: this.triggers,
      capabilities: this.capabilities,
      pipeline: this.pipeline,
      proactiveRules: this.proactiveRules,
      quickPrompt: this.quickPrompt,
    }
  }

  async execute(ctx: PluginExecutionContext): Promise<PluginExecutionResult> {
    if (this.slug.startsWith('app_cli_')) throw new Error('not_connected: موصل خارجي غير موثّق')
    validatePluginPipeline(this.pipeline)
    const dto = this.toDTO({ active: true, installed: true })
    const stepResults = await Promise.all(
      this.pipeline.map((step) => runPluginStep(ctx.businessId, step, dto)),
    )
    const cards: ResultCardDTO[] = []
    const alerts: ProactiveAlertDTO[] = []
    for (const res of stepResults) {
      cards.push(...res.cards)
      alerts.push(...res.alerts)
    }
    const summaryText = `تم فحص وتشغيل «${this.name}» بنجاح — استخرجت ${cards.length} تقارير تفصيلية${
      alerts.length > 0 ? ` مع ${alerts.length} تنبيهات وفرص استباقية` : ''
    }.`
    return { plugin: dto, cards, alerts, summaryText }
  }
}

/**
 * Dynamic PluginRegistry managing built-in and AI-synthesized plugins per business.
 */
export class PluginRegistry {
  private readonly builtins = new Map<string, PluginInterface>()
  private readonly tenantPlugins = new Map<string, Map<string, PluginInterface>>()

  constructor(starters: Omit<AgentPluginDTO, 'id' | 'active' | 'installed' | 'usageCount' | 'lastUsedAt'>[] = []) {
    for (const s of starters) {
      this.registerBuiltIn(new BasePlugin(s))
    }
  }

  registerBuiltIn(plugin: PluginInterface): void {
    this.builtins.set(plugin.slug, plugin)
  }

  register(businessId: string, plugin: PluginInterface): void {
    let map = this.tenantPlugins.get(businessId)
    if (!map) {
      map = new Map<string, PluginInterface>()
      this.tenantPlugins.set(businessId, map)
    }
    map.set(plugin.slug, plugin)
  }

  unregister(businessId: string, slug: string): boolean {
    return this.tenantPlugins.get(businessId)?.delete(slug) ?? false
  }

  get(businessId: string, slugOrQuery: string): PluginInterface | undefined {
    const tenantMap = this.tenantPlugins.get(businessId)
    const direct = tenantMap?.get(slugOrQuery) ?? this.builtins.get(slugOrQuery)
    if (direct) return direct

    const qNorm = normalizeAr(slugOrQuery)
    const all = [
      ...(tenantMap ? [...tenantMap.values()] : []),
      ...this.builtins.values(),
    ]
    return all.find(
      (p) =>
        p.slug === slugOrQuery ||
        normalizeAr(p.name).includes(qNorm) ||
        p.triggers.some((t) => normalizeAr(t).includes(qNorm)),
    )
  }

  listBuiltIns(): PluginInterface[] {
    return [...this.builtins.values()]
  }

  async syncFromDatabase(businessId: string): Promise<AgentPluginDTO[]> {
    const dtos = await getBusinessPlugins(businessId)
    this.tenantPlugins.delete(businessId) // no stale enabled plugins after toggle/delete
    for (const dto of dtos) {
      if (dto.installed && dto.active) {
        this.register(businessId, new BasePlugin(dto))
      }
    }
    return dtos
  }

  async execute(
    businessId: string,
    pluginOrSlug: AgentPluginDTO | string,
    args?: Record<string, unknown>,
  ): Promise<PluginExecutionResult> {
    const available = await this.syncFromDatabase(businessId)
    const slug = typeof pluginOrSlug === 'string' ? pluginOrSlug : pluginOrSlug.slug
    if (available.some((p) => p.slug === slug && p.installed && !p.active)) throw new Error('الإضافة متوقفة')
    const registered = this.get(businessId, slug)
    if (registered) {
      return registered.execute({ businessId, args })
    }
    if (typeof pluginOrSlug !== 'string') {
      const dynamicPlugin = new BasePlugin(pluginOrSlug)
      this.register(businessId, dynamicPlugin)
      return dynamicPlugin.execute({ businessId, args })
    }
    throw new Error('الأداة المطلوبة غير موجودة')
  }
}

export const pluginRegistry = new PluginRegistry(STARTER_PLUGIN_CATALOG)

// ---------------------------------------------------------------------------
// AI-Powered Dynamic Plugin Synthesizer (Gemini 3 Flash + Deterministic Compiler)
// ---------------------------------------------------------------------------

export async function synthesizePluginWithAI(params: {
  businessId: string
  userId: string
  prompt: string
  preferredName?: string
}): Promise<AgentPluginDTO> {
  await requirePermission(params.businessId, params.userId, 'tools.manage')
  const { businessId, userId, prompt, preferredName } = params
  const norm = normalizeAr(prompt)

  // 1. Check if the user is asking for one of our Starter Catalog plugins directly
  for (const starter of STARTER_PLUGIN_CATALOG) {
    const matchesTrigger = starter.triggers.some((t) => norm.includes(normalizeAr(t)))
    const matchesSlug = prompt.toLowerCase().includes(starter.slug)
    if (matchesTrigger || matchesSlug) {
      const isDirectStarter =
        norm.length < 45 ||
        /(اداره المخزون|تحليل المبيعات|درع الهوامش|مدير التحصيلات|رادار الصلاحيات)/.test(norm)
      if (isDirectStarter) {
        return installOrUpdatePlugin({
          businessId,
          userId,
          spec: {
            ...starter,
            ...(preferredName ? { name: preferredName } : {}),
          },
        })
      }
    }
  }

  // 2. Try synthesizing a bespoke PluginSpec via Gemini (`gemini-3-flash-preview` / `gemini-2.5-flash`)
  const biz = await db.business.findUnique({ where: { id: businessId } })
  let synthesized: Omit<AgentPluginDTO, 'id' | 'active' | 'installed' | 'usageCount' | 'lastUsedAt'> | null = null

  const ai = getGeminiClient()
  if (ai) {
    for (const modelName of ['gemini-3-flash-preview', 'gemini-2.5-flash']) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: `صمم أداة/ميزة تحليلية ذكية (Plugin) لنظام إدارة الأعمال "وكيل" لمنشأة "${biz?.name ?? 'النشاط'}" (النوع: ${biz?.type ?? 'عام'}).
طلب المستخدم: "${prompt}"
${preferredName ? `الاسم المفضل: "${preferredName}"` : ''}

اختر وحدات التنفيذ (pipeline modules) الأنسب من هذه القائمة فقط:
- inventory_audit (جرد المخزون، تصنيف ABC، الأصناف الراكدة، وخطة الشراء)
- sales_analytics (تحليل المبيعات، سرعة الدوران، والأصناف الرابحة)
- margin_audit (تحليل الهوامش، فروق التكلفة والبيع، واقتراح الأسعار)
- receivables_aging (تحليل مديونيات العملاء وخطة التحصيل)
- supplier_payables (تحليل مستحقات الموردين والتدفق النقدي)
- expiry_shield (مراقبة الصلاحيات والتشغيلات)
لو الطلب خارج الوحدات دي ارجع modules فارغة؛ لا تدعي بناء تكامل أو حجز أو دفع أو تعديل كود.`,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                slug: { type: Type.STRING, description: 'English snake_case identifier starting with plugin_' },
                name: { type: Type.STRING, description: 'Arabic feature title (short, natural, and clear)' },
                description: { type: Type.STRING, description: 'Arabic description of what this capability does for the business owner' },
                category: {
                  type: Type.STRING,
                  description: 'One of: inventory, sales, finance, customers, operations',
                },
                icon: {
                  type: Type.STRING,
                  description: 'One of: boxes, chart, wallet, users, spark, alert, today, book',
                },
                triggers: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: '3 to 5 natural Arabic phrases that trigger this feature in chat',
                },
                capabilities: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: '3 to 4 Arabic bullet points describing features',
                },
                modules: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      module: {
                        type: Type.STRING,
                        description: 'One of: inventory_audit, sales_analytics, margin_audit, receivables_aging, supplier_payables, expiry_shield, custom_query',
                      },
                      label: { type: Type.STRING, description: 'Arabic step label' },
                      sortBy: { type: Type.STRING, description: 'margin | stock | velocity | balance | revenue' },
                      daysWindow: { type: Type.INTEGER, description: 'Number of days window (e.g. 7, 14, 30)' },
                    },
                    required: ['module', 'label'],
                  },
                },
                proactiveRuleTitle: { type: Type.STRING, description: 'Arabic proactive alert title' },
                proactiveRuleRecommendation: { type: Type.STRING, description: 'Arabic recommendation for the owner' },
                proactiveRuleKind: { type: Type.STRING, description: 'risk or opportunity' },
              },
              required: ['slug', 'name', 'description', 'category', 'icon', 'triggers', 'capabilities', 'modules'],
            },
          },
        })

        const rawJson = response.text?.trim()
        if (rawJson) {
          const parsed = JSON.parse(rawJson) as {
            slug?: string
            name?: string
            description?: string
            category?: string
            icon?: string
            triggers?: string[]
            capabilities?: string[]
            modules?: { module: string; label: string; sortBy?: string; daysWindow?: number }[]
            proactiveRuleTitle?: string
            proactiveRuleRecommendation?: string
            proactiveRuleKind?: string
          }

          const validModules: ReadonlySet<string> = new Set([
            'inventory_audit',
            'sales_analytics',
            'margin_audit',
            'receivables_aging',
            'supplier_payables',
            'expiry_shield',
          ])
          const validCategories: ReadonlySet<string> = new Set(['inventory', 'sales', 'finance', 'customers', 'operations'])
          const validIcons: ReadonlySet<string> = new Set(['spark', 'boxes', 'users', 'wallet', 'chart', 'book', 'today', 'alert'])

          const pipeline: PluginStepSpec[] = (parsed.modules ?? [])
            .filter((m) => validModules.has(m.module))
            .map((m) => ({
              module: m.module as PluginPipelineModule,
              label: m.label || 'تحليل البيانات',
              params: {
                sortBy: (m.sortBy as 'margin' | 'stock' | 'velocity' | 'balance' | 'revenue') || 'revenue',
                daysWindow: m.daysWindow || 30,
                limit: 10,
              },
            }))

          validatePluginPipeline(pipeline)

          const cleanSlug =
            'plugin_' +
            String(parsed.slug || 'custom')
              .toLowerCase()
              .replace(/^plugin_/, '')
              .replace(/[^a-z0-9_]/g, '_')
              .replace(/_+/g, '_')
              .slice(0, 32)

          const name = (preferredName || parsed.name || 'متابعة ذكية مخصصة').trim().slice(0, 60)
          synthesized = {
            slug: cleanSlug,
            name,
            description: (parsed.description || `ميزة ذكية لـ ${name}`).slice(0, 220),
            category: (validCategories.has(parsed.category ?? '') ? parsed.category : 'operations') as PluginCategory,
            icon: (validIcons.has(parsed.icon ?? '') ? parsed.icon : 'spark') as AgentPluginDTO['icon'],
            version: '1.0.0',
            author: 'ai-synthesized',
            triggers: Array.from(new Set([name, ...(parsed.triggers ?? []).slice(0, 5)])),
            capabilities: (parsed.capabilities ?? [`تحليل ومتابعة آلية لـ ${name}`]).slice(0, 5),
            pipeline,
            proactiveRules: parsed.proactiveRuleTitle
              ? [
                  {
                    kind: parsed.proactiveRuleKind === 'risk' ? 'risk' : 'opportunity',
                    metric: 'high_velocity_star',
                    threshold: 1,
                    title: parsed.proactiveRuleTitle,
                    recommendation: parsed.proactiveRuleRecommendation || `افتح تقرير «${name}» لمراجعة التفاصيل.`,
                  },
                ]
              : [],
            quickPrompt: `اعرض تقرير ${name}`,
          }
          break
        }
      } catch (err) {
        console.warn(`[plugin-harness] Gemini synthesis (${modelName}) fell back:`, err instanceof Error ? err.message : err)
      }
    }
  }

  // 3. Deterministic Domain Compiler Fallback (when Gemini is unavailable or offline)
  if (!synthesized) {
    synthesized = compilePluginDeterministically(prompt, preferredName)
  }

  return installOrUpdatePlugin({
    businessId,
    userId,
    spec: synthesized,
  })
}

/** Deterministic composition of supported analysis modules, NOT simulated AI/code generation. */
function compilePluginDeterministically(
  prompt: string,
  preferredName?: string,
): Omit<AgentPluginDTO, 'id' | 'active' | 'installed' | 'usageCount' | 'lastUsedAt'> {
  const norm = normalizeAr(prompt)

  const isInventory = /(مخزون|جرد|اصناف|نواقص|طلبيه|توريد|راكد|صلاحيه)/.test(norm)
  const isSales = /(مبيعات|بيع|حركه|سحب|دوران|عروض|خصومات|ايراد)/.test(norm)
  const isFinance = /(ربح|هامش|هوامش|مالي|تكلفه|تسعير|مصروف|خزنه|سيوله)/.test(norm)
  const isCustomers = /(عملاء|زبائن|ديون|مديونيات|تحصيل|ائتمان|كبار العملاء|عضويات)/.test(norm)
  const isSuppliers = /(مورد|موردين|مستحقات|شرا|مشتريات)/.test(norm)

  const pipeline: PluginStepSpec[] = []
  const capabilities: string[] = []
  const proactiveRules: PluginProactiveRule[] = []

  if (isInventory) {
    pipeline.push({ module: 'inventory_audit', label: 'فحص صحة المخزون وتصنيف القيمة ABC', params: { sortBy: 'stock', limit: 12 } })
    capabilities.push('تصنيف الأصناف A/B/C وحساب قيمة البضاعة وتكلفة الاستعاضة')
    proactiveRules.push({
      kind: 'risk',
      metric: 'low_stock_ratio',
      threshold: 15,
      title: 'تنبيه مخزني: أصناف تقترب من النفاد وتحتاج طلبية',
      recommendation: 'راجع جدول الكميات المقترح شراؤها لتغطية أسبوعين.',
    })
  }
  if (isSales) {
    pipeline.push({ module: 'sales_analytics', label: 'تحليل سرعة المبيعات والأصناف الأعلى طلباً', params: { daysWindow: 30, sortBy: 'revenue', limit: 10 } })
    capabilities.push('تحليل سرعة دوران المبيعات اليومية والأصناف الحصان الرابح')
    proactiveRules.push({
      kind: 'opportunity',
      metric: 'high_velocity_star',
      threshold: 1,
      title: 'فرصة نمو مبيعات: أصناف سريعة الدوران ذات ربحية عالية',
      recommendation: 'وفّر كميات إضافية من الأصناف الأعلى سحباً لتعظيم الإيراد اليومي.',
    })
  }
  if (isFinance) {
    pipeline.push({ module: 'margin_audit', label: 'فحص الهوامش والربحية واقتراح التسعير', params: { minMarginPct: 20, sortBy: 'margin', limit: 10 } })
    capabilities.push('مراقبة هوامش ربح الأصناف واكتشاف فرص تحسين التسعير')
  }
  if (isCustomers) {
    pipeline.push({ module: 'receivables_aging', label: 'تحليل مديونيات العملاء وأولوية التحصيل', params: { sortBy: 'balance', limit: 10 } })
    capabilities.push('ترتيب مديونيات العملاء وخطة التحصيل الذكية')
  }
  if (isSuppliers) {
    pipeline.push({ module: 'supplier_payables', label: 'تحليل مستحقات الموردين وتغطية الكاش', params: { sortBy: 'balance', limit: 10 } })
    capabilities.push('موازنة مستحقات الموردين مع السيولة النقدية المتاحة')
  }

  validatePluginPipeline(pipeline) // Unsupported requests must not masquerade as inventory reports.

  const extractedName =
    preferredName?.trim() ||
    prompt
      .replace(/^(يا وكيل|وكيل|لو سمحت|ممكن|عايزك?|اريد|قم بـ?|اعمل|ابني|انشئ|ضيف|اضف|ركب|فعل)\s+/g, '')
      .replace(/^(بلاجن|ميزة|ميزه|اداه|أداة|نظام|برنامج)\s+(لـ?|عشان|عن)?\s*/g, '')
      .trim()
      .slice(0, 45) ||
    'متابعة ذكية مخصصة'

  const category: PluginCategory = isInventory
    ? 'inventory'
    : isSales
      ? 'sales'
      : isFinance
        ? 'finance'
        : isCustomers
          ? 'customers'
          : 'operations'

  const icon: AgentPluginDTO['icon'] = isInventory
    ? 'boxes'
    : isSales
      ? 'chart'
      : isFinance
        ? 'wallet'
        : isCustomers
          ? 'users'
          : 'spark'

  const slug = `plugin_custom_${Math.abs(
    Array.from(norm).reduce((acc, ch) => ((acc << 5) - acc + ch.charCodeAt(0)) | 0, 0),
  )
    .toString(36)
    .slice(0, 8)}`

  return {
    slug,
    name: extractedName,
    description: `نظام متابعة وتحليل ذكي لـ «${extractedName}» مرتبط مباشرة بالسجلات ورادار المخاطر والفرص.`,
    category,
    icon,
    version: '1.0.0',
    author: 'wakil-deterministic-compiler',
    triggers: [extractedName, `تقرير ${extractedName}`, `متابعة ${extractedName}`],
    capabilities,
    pipeline,
    proactiveRules,
    quickPrompt: `اعرض تقرير ${extractedName}`,
  }
}

// ---------------------------------------------------------------------------
// Persist / Toggle / Delete Plugins + Sync QuickCommand + Persist AgentMemory
// ---------------------------------------------------------------------------

export async function installOrUpdatePlugin(params: {
  businessId: string
  userId: string
  spec: Omit<AgentPluginDTO, 'id' | 'active' | 'installed' | 'usageCount' | 'lastUsedAt'>
}): Promise<AgentPluginDTO> {
  await requirePermission(params.businessId, params.userId, 'tools.manage')
  const { businessId, userId, spec } = params

  validatePluginPipeline(spec.pipeline)

  const installed = await db.$transaction(async (tx) => {
    await requirePermission(businessId, userId, 'tools.manage', tx)
    // Persist plugin and its real actor-owned shortcut atomically.
    const existingRows = await tx.customTool.findMany({
      where: { businessId, kind: 'plugin' },
    })
    const existing = existingRows.find((r) => {
      const cfg = parsePluginConfig(r.config, r.name)
      return cfg.slug === spec.slug || normalizeAr(r.name) === normalizeAr(spec.name)
    })

    const configJson = JSON.stringify({
      slug: spec.slug,
      description: spec.description,
      category: spec.category,
      icon: spec.icon,
      version: spec.version,
      author: spec.author,
      triggers: spec.triggers,
      capabilities: spec.capabilities,
      pipeline: spec.pipeline,
      proactiveRules: spec.proactiveRules,
      quickPrompt: spec.quickPrompt,
    } satisfies StoredPluginConfig)

    const row = existing
      ? await tx.customTool.update({
          where: { id: existing.id },
          data: {
            name: spec.name,
            config: configJson,
            active: true,
          },
        })
      : await tx.customTool.create({
          data: {
            businessId,
            userId,
            name: spec.name,
            kind: 'plugin',
            config: configJson,
            active: true,
          },
        })

    // 3. Ensure a 1-click QuickCommand chip exists so the owner sees it right under the chat composer
    const existingCmd = await tx.quickCommand.findFirst({
      where: { businessId, userId, label: spec.name.slice(0, 36) },
    })
    if (!existingCmd) {
      await tx.quickCommand
        .create({
          data: {
            businessId,
            userId,
            label: spec.name.slice(0, 36),
            prompt: spec.quickPrompt,
            icon: spec.icon,
            sortOrder: 1,
          },
        })
    }

    await tx.auditEvent.create({ data: { businessId, actor: userId, action: 'plugin.installed', detail: JSON.stringify({ slug: spec.slug, modules: spec.pipeline.map((p) => p.module) }) } })
    return {
      ...spec,
      id: row.id,
      active: row.active,
      installed: true,
      usageCount: row.usageCount,
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    }
  })
  pluginRegistry.register(businessId, new BasePlugin(spec))
  return installed
}

export async function togglePluginActive(pluginId: string, active: boolean, businessId: string, userId: string): Promise<AgentPluginDTO | null> {
  await requirePermission(businessId, userId, 'tools.manage')
  const row = await db.customTool.findFirst({ where: { id: pluginId, businessId } })
  if (!row || row.kind !== 'plugin') return null
  await db.customTool.update({
    where: { id: pluginId, businessId },
    data: { active },
  })
  const all = await getBusinessPlugins(row.businessId)
  return all.find((p) => p.id === pluginId) ?? null
}

export async function deletePlugin(pluginId: string, businessId: string, userId: string): Promise<boolean> {
  await requirePermission(businessId, userId, 'tools.manage')
  const row = await db.customTool.findFirst({ where: { id: pluginId, businessId } })
  if (!row || row.kind !== 'plugin') return false
  const cfg = parsePluginConfig(row.config, row.name)
  if (cfg.slug) pluginRegistry.unregister(row.businessId, cfg.slug)
  await db.customTool.delete({ where: { id: pluginId, businessId } })
  await db.quickCommand.deleteMany({ where: { businessId: row.businessId, label: row.name } }).catch(() => {})
  return true
}

// ---------------------------------------------------------------------------
// Match User Message to an Active Plugin
// ---------------------------------------------------------------------------

export async function matchPluginByTrigger(businessId: string, text: string): Promise<AgentPluginDTO | null> {
  const norm = normalizeAr(text)
  const active = await getActivePlugins(businessId)

  for (const plugin of active) {
    if (norm.includes(normalizeAr(plugin.name)) || text.toLowerCase().includes(plugin.slug)) {
      return plugin
    }
    for (const trig of plugin.triggers) {
      const tNorm = normalizeAr(trig)
      if (tNorm.length >= 4 && norm.includes(tNorm)) {
        return plugin
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Execute Plugin Pipeline Concurrently against Real Business Data
// ---------------------------------------------------------------------------

export async function executePlugin(params: {
  businessId: string
  pluginOrSlug: AgentPluginDTO | string
}): Promise<PluginExecutionResult> {
  const { businessId, pluginOrSlug } = params
  let plugin: AgentPluginDTO | undefined

  if (typeof pluginOrSlug === 'string') {
    const all = await getBusinessPlugins(businessId)
    const qNorm = normalizeAr(pluginOrSlug)
    plugin =
      all.find((p) => p.slug === pluginOrSlug || p.id === pluginOrSlug) ??
      all.find((p) => normalizeAr(p.name).includes(qNorm) || p.triggers.some((t) => normalizeAr(t).includes(qNorm)))
    // A read must never impersonate the first/owner user to install a tool.
    // Uninstalled starter capabilities run transiently; installation is an
    // explicit, capability-checked mutation through installOrUpdatePlugin.

  } else {
    plugin = pluginOrSlug
  }

  if (!plugin) {
    throw new Error('الميزة المطلوبة غير موجودة')
  }
  if (plugin.installed && !plugin.active) throw new Error('الإضافة متوقفة')

  // Block legacy persisted bridges before any pipeline step can read the ledger.
  if (plugin.slug.startsWith('app_cli_')) {
    throw new Error('not_connected: لا يوجد موصل خارجي موثّق؛ لم تتم مزامنة بيانات')
  }
  validatePluginPipeline(plugin.pipeline)

  // Increment usage count if persisted in CustomTool
  if (plugin.installed && !plugin.id.startsWith('catalog:')) {
    void db.customTool
      .update({
        where: { id: plugin.id },
        data: { usageCount: { increment: 1 }, lastUsedAt: new Date() },
      })
      .catch(() => {})
  }

  // Register & execute through PluginRegistry
  const instance = new BasePlugin(plugin)
  pluginRegistry.register(businessId, instance)
  const res = await instance.execute({ businessId })
  return {
    ...res,
    plugin,
  }
}

async function runPluginStep(
  businessId: string,
  step: PluginStepSpec,
  plugin: AgentPluginDTO,
): Promise<{ cards: ResultCardDTO[]; alerts: ProactiveAlertDTO[] }> {
  const cards: ResultCardDTO[] = []
  const alerts: ProactiveAlertDTO[] = []
  const since30d = new Date(Date.now() - (step.params?.daysWindow ?? 30) * 86400000)

  switch (step.module) {
    case 'inventory_audit': {
      const [items, sales] = await Promise.all([
        db.item.findMany({ where: { businessId }, orderBy: { name: 'asc' } }),
        db.operation.findMany({
          where: { businessId, type: 'sale', status: 'SUCCEEDED', createdAt: { gte: since30d } },
        }),
      ])

      const soldMap = new Map<string, number>()
      for (const s of sales) {
        try {
          const p = JSON.parse(s.payload) as Record<string, unknown>
          if (Array.isArray(p.lines)) {
            for (const l of p.lines as Record<string, unknown>[]) {
              const id = String(l.itemId ?? '')
              soldMap.set(id, (soldMap.get(id) ?? 0) + Number(l.qty ?? 0))
            }
          } else {
            const id = String(p.itemId ?? '')
            soldMap.set(id, (soldMap.get(id) ?? 0) + Number(p.qty ?? 0))
          }
        } catch {
          // ignore
        }
      }

      const totalStockCost = items.reduce((s, i) => s + Math.round(i.stockQty * i.costPrice), 0)
      const totalStockRetail = items.reduce((s, i) => s + Math.round(i.stockQty * i.sellPrice), 0)
      const lowItems = items.filter((i) => i.stockQty <= i.lowStockThreshold)
      const deadItems = items.filter((i) => i.stockQty > i.lowStockThreshold && (soldMap.get(i.id) ?? 0) === 0)
      const deadCapital = deadItems.reduce((s, i) => s + Math.round(i.stockQty * i.costPrice), 0)

      // ABC classification by stock value + sales velocity
      const enriched = items
        .map((it) => {
          const stockVal = Math.round(it.stockQty * it.costPrice)
          const sold30 = soldMap.get(it.id) ?? 0
          const rev30 = Math.round(sold30 * it.sellPrice)
          const score = rev30 * 2 + stockVal
          return { it, stockVal, sold30, rev30, score }
        })
        .sort((a, b) => b.score - a.score)

      cards.push(
        {
          kind: 'kv',
          title: `${plugin.name} — ملخص صحة المخزون وتصنيف ABC`,
          rows: [
            { label: 'إجمالي قيمة المخزون بالتكلفة', value: egp(totalStockCost) },
            { label: 'القيمة البيعية المتوقعة للمخزون', value: egp(totalStockRetail), tone: 'good' },
            { label: 'الأصناف تحت حد الأمان (نواقص)', value: `${fmtQty(lowItems.length)} من ${fmtQty(items.length)}`, tone: lowItems.length > 0 ? 'bad' : 'good' },
            { label: 'رأس المال المجمد في أصناف راكدة', value: deadCapital > 0 ? `${egp(deadCapital)} (${fmtQty(deadItems.length)} صنف)` : 'لا يوجد ركود', tone: deadCapital > 0 ? 'neutral' : 'good' },
          ],
        },
        {
          kind: 'table',
          title: 'تصنيف الأصناف (A/B/C) وخطة الإمداد الذكية',
          columns: [
            { key: 'name', label: 'الصنف' },
            { key: 'class', label: 'الفئة' },
            { key: 'stock', label: 'الرصيد' },
            { key: 'sold30', label: 'مبيعات ٣٠ يوم' },
            { key: 'stockVal', label: 'قيمة المخزون' },
            { key: 'status', label: 'التوصية' },
          ],
          rows: enriched.slice(0, step.params?.limit ?? 10).map((row, idx) => {
            const abc = idx < Math.ceil(enriched.length * 0.25) ? 'فئة A (حيوي)' : idx < Math.ceil(enriched.length * 0.65) ? 'فئة B (متوسط)' : 'فئة C'
            const isLow = row.it.stockQty <= row.it.lowStockThreshold
            const isDead = row.sold30 === 0 && row.it.stockQty > row.it.lowStockThreshold
            return {
              name: row.it.name,
              class: abc,
              stock: fmtQty(row.it.stockQty, arUnit(row.it.unit)),
              sold30: fmtQty(row.sold30, arUnit(row.it.unit)),
              stockVal: egp(row.stockVal),
              status: isLow ? 'اطلب فوراً' : isDead ? 'روّج بعرض خاص' : 'رصيد مثالي',
            }
          }),
        },
      )

      if (lowItems.length > 0) {
        alerts.push({
          id: `plugin-alert-low-${plugin.slug}`,
          category: 'risk',
          level: 'warning',
          title: `${lowItems.length} أصناف تحت حد الأمان المخزني`,
          detail: `بلاجن «${plugin.name}» رصد أصنافاً تحتاج إعادة طلب عاجلة: ${lowItems.slice(0, 3).map((i) => i.name).join('، ')}.`,
          metricValue: `${lowItems.length} نواقص`,
          sourcePlugin: plugin.name,
          actionLabel: 'اطلب خطة التوريد',
          actionPrompt: 'توقع المخزون ومعدل السحب والأصناف اللي قربت تخلص',
          view: 'inventory',
        })
      }
      if (deadItems.length > 0 && deadCapital > 0) {
        alerts.push({
          id: `plugin-alert-dead-${plugin.slug}`,
          category: 'opportunity',
          level: 'info',
          title: `فرصة تسييل ${egp(deadCapital)} من أصناف بطيئة الحركة`,
          detail: `الأصناف (${deadItems.slice(0, 3).map((i) => i.name).join('، ')}) لم تسجل سحباً مؤخراً وبها رصيد متاح — تصلح لعروض ترويجية مجمعة.`,
          metricValue: egp(deadCapital),
          sourcePlugin: plugin.name,
          actionLabel: 'اقترح خطة ترويج',
          actionPrompt: `اقترح خطة عروض لتصريف الأصناف الراكدة: ${deadItems.slice(0, 3).map((i) => i.name).join('، ')}`,
          view: 'inventory',
        })
      }
      break
    }

    case 'sales_analytics': {
      const today = startOfCairoDay(0)
      const since7d = new Date(Date.now() - 7 * 86400000)
      const [items, ops30] = await Promise.all([
        db.item.findMany({ where: { businessId } }),
        db.operation.findMany({
          where: { businessId, type: 'sale', status: 'SUCCEEDED', createdAt: { gte: since30d } },
          orderBy: { createdAt: 'desc' },
        }),
      ])
      const itemMap = new Map(items.map((i) => [i.id, i]))

      let revToday = 0
      let rev7d = 0
      let rev30d = 0
      let profit30d = 0
      const itemStats = new Map<string, { name: string; unit: string; qty: number; rev: number; profit: number }>()

      for (const op of ops30) {
        try {
          const p = JSON.parse(op.payload) as Record<string, unknown>
          const total = Number(p.total ?? 0)
          rev30d += total
          if (op.createdAt >= since7d) rev7d += total
          if (op.createdAt >= today) revToday += total

          const lines: Record<string, unknown>[] = Array.isArray(p.lines)
            ? (p.lines as Record<string, unknown>[])
            : [{ itemId: p.itemId, itemName: p.itemName, qty: p.qty, unitPrice: p.unitPrice, total: p.total }]

          for (const l of lines) {
            const id = String(l.itemId ?? '')
            const it = itemMap.get(id)
            const q = Number(l.qty ?? 0)
            const lineRev = Number(l.total ?? (q * Number(l.unitPrice ?? it?.sellPrice ?? 0)))
            const lineCost = it ? Math.round(q * it.costPrice) : 0
            const lineProfit = lineRev - lineCost
            profit30d += lineProfit

            if (it && q > 0) {
              const prev = itemStats.get(id) ?? { name: it.name, unit: it.unit, qty: 0, rev: 0, profit: 0 }
              prev.qty += q
              prev.rev += lineRev
              prev.profit += lineProfit
              itemStats.set(id, prev)
            }
          }
        } catch {
          // ignore
        }
      }

      const ranked = [...itemStats.values()].sort((a, b) => b.rev - a.rev)
      const topStar = ranked[0]

      cards.push(
        {
          kind: 'kv',
          title: `${plugin.name} — مؤشرات سرعة المبيعات والربحية`,
          rows: [
            { label: 'مبيعات اليوم', value: egp(revToday), tone: 'good' },
            { label: 'مبيعات آخر ٧ أيام', value: egp(rev7d) },
            { label: 'إجمالي مبيعات ٣٠ يوم', value: egp(rev30d), tone: 'good' },
            { label: 'مجمل الربح المحقق (٣٠ يوم)', value: egp(profit30d), tone: profit30d > 0 ? 'good' : 'neutral' },
            { label: 'عدد الفواتير المنفذة', value: `${fmtQty(ops30.length)} عملية بيع` },
          ],
        },
        {
          kind: 'table',
          title: 'الأصناف الحصان الرابح (الأعلى إيراداً ومساهمة في الربح)',
          columns: [
            { key: 'name', label: 'الصنف' },
            { key: 'qty', label: 'الكمية المباعة' },
            { key: 'rev', label: 'الإيراد' },
            { key: 'profit', label: 'صافي المكسب' },
            { key: 'velocity', label: 'معدل السحب' },
          ],
          rows: ranked.slice(0, step.params?.limit ?? 10).map((r) => ({
            name: r.name,
            qty: fmtQty(r.qty, arUnit(r.unit)),
            rev: egp(r.rev),
            profit: egp(r.profit),
            velocity: r.qty >= 10 ? 'سريع جداً (Star)' : r.qty >= 4 ? 'نشط' : 'هادئ',
          })),
        },
      )

      if (topStar) {
        alerts.push({
          id: `plugin-star-${plugin.slug}`,
          category: 'opportunity',
          level: 'info',
          title: `«${topStar.name}» يتصدر المبيعات بـ ${egp(topStar.rev)}`,
          detail: `بلاجن «${plugin.name}» يوصي بتأمين مخزون إضافي من «${topStar.name}» لأنه يحقق أعلى مساهمة ربحية (${egp(topStar.profit)}).`,
          metricValue: egp(topStar.rev),
          sourcePlugin: plugin.name,
          actionLabel: 'فحص رصيد الصنف',
          actionPrompt: `رصيد وسعر ${topStar.name}`,
          view: 'stats',
        })
      }
      break
    }

    case 'margin_audit': {
      const items = await db.item.findMany({ where: { businessId }, orderBy: { name: 'asc' } })
      const minMargin = step.params?.minMarginPct ?? 20

      const rows = items
        .filter((it) => it.sellPrice > 0)
        .map((it) => {
          const spread = it.sellPrice - it.costPrice
          const marginPct = Math.round((spread / it.sellPrice) * 100)
          const targetSell = it.costPrice > 0 ? Math.ceil(it.costPrice / (1 - 0.25) / 50) * 50 : it.sellPrice
          return {
            it,
            spread,
            marginPct,
            targetSell,
            isLowMargin: marginPct < minMargin,
          }
        })
        .sort((a, b) => a.marginPct - b.marginPct)

      const lowMarginCount = rows.filter((r) => r.isLowMargin).length

      cards.push({
        kind: 'table',
        title: `${plugin.name} — فحص الهوامش والتسعير المقترح`,
        columns: [
          { key: 'name', label: 'الصنف' },
          { key: 'cost', label: 'التكلفة' },
          { key: 'sell', label: 'سعر البيع' },
          { key: 'margin', label: 'الهامش الحالي' },
          { key: 'suggested', label: 'السعر المقترح (هامش ٢٥٪)' },
        ],
        rows: rows.slice(0, step.params?.limit ?? 10).map((r) => ({
          name: r.it.name,
          cost: egp(r.it.costPrice),
          sell: egp(r.it.sellPrice),
          margin: `${r.marginPct}%`,
          suggested: r.isLowMargin && r.targetSell > r.it.sellPrice ? egp(r.targetSell) : 'تسعير ممتاز',
        })),
        footer: [{ label: 'أصناف تحت الهامش المستهدف', value: `${fmtQty(lowMarginCount)} صنف` }],
      })

      if (lowMarginCount > 0) {
        const worst = rows[0]
        alerts.push({
          id: `plugin-margin-${plugin.slug}`,
          category: 'risk',
          level: 'warning',
          title: `${lowMarginCount} أصناف بهامش ربح أقل من ${minMargin}%`,
          detail: `أقلها هامشاً «${worst.it.name}» (${worst.marginPct}%) — تعديل السعر إلى ${egp(worst.targetSell)} يرفع هامش الربح إلى ٢٥٪.`,
          metricValue: `${worst.marginPct}% هامش`,
          sourcePlugin: plugin.name,
          actionLabel: 'تحديث السعر بالمحادثة',
          actionPrompt: `حدث سعر بيع ${worst.it.name} إلى ${Math.round(worst.targetSell / 100)} جنيه`,
          view: 'inventory',
        })
      }
      break
    }

    case 'receivables_aging': {
      const customers = await db.customer.findMany({
        where: { businessId, balance: { gt: 0 } },
        orderBy: { balance: 'desc' },
      })
      const totalDebt = customers.reduce((s, c) => s + c.balance, 0)

      cards.push({
        kind: 'table',
        title: `${plugin.name} — أولويات تحصيل مديونيات العملاء`,
        columns: [
          { key: 'name', label: 'العميل' },
          { key: 'phone', label: 'التليفون' },
          { key: 'balance', label: 'المديونية' },
          { key: 'share', label: 'نسبته من الديون' },
          { key: 'priority', label: 'الأولوية' },
        ],
        rows: customers.slice(0, step.params?.limit ?? 10).map((c) => {
          const share = totalDebt > 0 ? Math.round((c.balance / totalDebt) * 100) : 0
          return {
            name: c.name,
            phone: c.phone ?? '—',
            balance: egp(c.balance),
            share: `${share}%`,
            priority: share >= 35 ? 'تحصيل فوري (حرج)' : share >= 15 ? 'متوسط' : 'عادي',
          }
        }),
        footer: [{ label: 'إجمالي المديونيات بالخارج', value: egp(totalDebt) }],
      })

      if (customers.length > 0 && totalDebt > 0) {
        const topCust = customers[0]
        alerts.push({
          id: `plugin-debt-${plugin.slug}`,
          category: 'opportunity',
          level: 'warning',
          title: `فرصة تحصيل سيولة فورية: ${egp(totalDebt)} عند ${customers.length} عملاء`,
          detail: `أكبر مديونية عند «${topCust.name}» بقيمة ${egp(topCust.balance)} — تحصيل ٥٠٪ منها يرفع كاش الخزنة فوراً.`,
          metricValue: egp(totalDebt),
          sourcePlugin: plugin.name,
          actionLabel: 'تسجيل تحصيل',
          actionPrompt: `حصلت دفعة من ${topCust.name}`,
          view: 'accounts',
        })
      }
      break
    }

    case 'supplier_payables': {
      const [suppliers, biz, entries] = await Promise.all([
        db.supplier.findMany({ where: { businessId, balance: { gt: 0 } }, orderBy: { balance: 'desc' } }),
        db.business.findUniqueOrThrow({ where: { id: businessId } }),
        db.cashEntry.findMany({ where: { businessId }, select: { direction: true, amount: true } }),
      ])
      const inn = entries.filter((e) => e.direction === 'in').reduce((s, e) => s + e.amount, 0)
      const out = entries.filter((e) => e.direction === 'out').reduce((s, e) => s + e.amount, 0)
      const cashNow = biz.openingCash + inn - out
      const totalPayables = suppliers.reduce((s, x) => s + x.balance, 0)
      const coveragePct = totalPayables > 0 ? Math.round((cashNow / totalPayables) * 100) : 100

      cards.push({
        kind: 'table',
        title: `${plugin.name} — التزامات الموردين وتغطية السيولة`,
        columns: [
          { key: 'name', label: 'المورد' },
          { key: 'balance', label: 'المستحق له' },
          { key: 'coverage', label: 'حالة التغطية من الخزنة' },
        ],
        rows: suppliers.map((s) => ({
          name: s.name,
          balance: egp(s.balance),
          coverage: cashNow >= s.balance ? 'مغطى بالكامل' : 'يحتاج تحصيل أولاً',
        })),
        footer: [
          { label: 'إجمالي مستحقات الموردين', value: egp(totalPayables) },
          { label: 'نسبة تغطية الخزنة الحالية', value: `${coveragePct}%` },
        ],
      })
      break
    }

    case 'expiry_shield': {
      const items = await db.item.findMany({
        where: { businessId, expiresAt: { not: null } },
        orderBy: { expiresAt: 'asc' },
      })
      const windowDays = step.params?.daysWindow ?? 60
      const expiring = items.filter((it) => {
        if (!it.expiresAt) return false
        const days = Math.ceil((it.expiresAt.getTime() - Date.now()) / 86400000)
        return days <= windowDays
      })
      const atRiskCost = expiring.reduce((s, it) => s + Math.round(it.stockQty * it.costPrice), 0)

      cards.push({
        kind: 'table',
        title: `${plugin.name} — الأصناف قريبة الصلاحية (${windowDays} يوم)`,
        columns: [
          { key: 'name', label: 'الصنف' },
          { key: 'batch', label: 'التشغيلة' },
          { key: 'expiry', label: 'تاريخ الانتهاء' },
          { key: 'stock', label: 'الرصيد' },
          { key: 'riskValue', label: 'القيمة المعرضة' },
        ],
        rows: expiring.map((it) => ({
          name: it.name,
          batch: it.batchNo ?? '—',
          expiry: it.expiresAt ? arDate(it.expiresAt) : '—',
          stock: fmtQty(it.stockQty, arUnit(it.unit)),
          riskValue: egp(Math.round(it.stockQty * it.costPrice)),
        })),
        footer: [{ label: 'إجمالي القيمة المعرضة لانتهاء الصلاحية', value: egp(atRiskCost) }],
      })
      break
    }

    default: throw new Error('unsupported_capability: وحدة تحليل غير متاحة')
  }

  return { cards, alerts }
}
