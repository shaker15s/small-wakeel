'use client'

// وكيل — Dynamic Plugin Harness & Concurrent Background Task Studio Modal
// Provides:
// 1. AI-Powered Dynamic Plugin Harness: build & install new features via natural
//    language or 1-click starter catalog, inspect pipelines, and run plugins.
// 2. Concurrent Background Task Manager: execute multiple operations simultaneously
//    (e.g. updating catalog records while analyzing a financial report & scanning radar).
// 3. Proactive Risk & Opportunity Monitor: live alerts & growth opportunities
//    linked directly to one-click agent actions.

import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { QUERY_KEYS, useWakil, type PluginStudioTab } from '@/lib/store'
import { api } from '@/lib/api'
import type { AgentPluginDTO, BackgroundJobKind, ProactiveAlertDTO } from '@/lib/types'
import { useToast } from '@/hooks/use-toast'
import {
  AlertTriangle,
  Check,
  Cpu,
  Layers,
  Lightbulb,
  Loader2,
  Play,
  Power,
  Radar,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'

const CONCURRENT_JOB_OPTIONS: { kind: BackgroundJobKind; label: string; desc: string }[] = [
  {
    kind: 'sync_and_audit_records',
    label: 'تحديث ومراجعة السجلات والأرصدة',
    desc: 'مزامنة أرصدة المخزون ومعايرة حدود الأمان التلقائية ومطابقة دفاتر العملاء والموردين',
  },
  {
    kind: 'analyze_financial_report',
    label: 'تحليل التقرير المالي والربحية (٣٠ يوم)',
    desc: 'حساب الإيرادات وتكلفة البضاعة المباعة وصافي الربح التشغيلي وهوامش الأصناف',
  },
  {
    kind: 'forecast_inventory_velocity',
    label: 'توقع دوران المخزون وخطة الشراء',
    desc: 'حساب معدل السحب اليومي والأيام المتبقية للنفاد وميزانية الطلبية المقترحة',
  },
  {
    kind: 'scan_risks_and_opportunities',
    label: 'فحص رادار المخاطر والفرص الاستباقي',
    desc: 'كشف مخاطر الهوامش والعكس المتأخر والسيولة بالتوازي مع فرص الأصناف الرابحة',
  },
  {
    kind: 'run_active_plugins',
    label: 'تشغيل كافة البلاجنز المفعّلة بالتوازي',
    desc: 'تنفيذ جميع أنابيب التحليل للبلاجنز المثبتة في نفس الدفعة الخلفية',
  },
]

const QUICK_PLUGIN_IDEAS = [
  'إدارة المخزون الذكية وتصنيف ABC',
  'تحليل المبيعات وسرعة الدوران',
  'درع الهوامش ورقابة التسعير',
  'مدير التحصيلات والائتمان الذكي',
  'رادار الصلاحيات وحماية التشغيلات',
  'مراقبة الأصناف الراكدة واقتراح عروض ترويجية',
]

export function PluginAndTaskStudioModal() {
  const {
    businessId,
    userId,
    pluginStudioOpen,
    pluginStudioTab,
    setPluginStudioOpen,
    askAgent,
    setView,
  } = useWakil()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [promptInput, setPromptInput] = useState('')
  const [customPluginName, setCustomPluginName] = useState('')
  const [synthesizing, setSynthesizing] = useState(false)
  const [runningPluginSlug, setRunningPluginSlug] = useState<string | null>(null)

  // Concurrent background job state
  const [selectedJobs, setSelectedJobs] = useState<BackgroundJobKind[]>([
    'sync_and_audit_records',
    'analyze_financial_report',
    'forecast_inventory_velocity',
    'scan_risks_and_opportunities',
  ])
  const [recordItemName, setRecordItemName] = useState('')
  const [recordSellPrice, setRecordSellPrice] = useState('')
  const [recordStockQty, setRecordStockQty] = useState('')
  const [dispatchingBatch, setDispatchingBatch] = useState(false)

  const { data: plugins = [], isLoading: loadingPlugins } = useQuery({
    queryKey: QUERY_KEYS.plugins(businessId ?? ''),
    queryFn: () => (businessId ? api.plugins(businessId) : Promise.resolve([])),
    enabled: Boolean(businessId) && pluginStudioOpen,
  })

  const { data: bgData, isLoading: loadingBg } = useQuery({
    queryKey: QUERY_KEYS.backgroundTasks(businessId ?? ''),
    queryFn: () =>
      businessId
        ? api.backgroundTasks(businessId)
        : Promise.resolve({ jobs: [], proactiveAlerts: [] }),
    enabled: Boolean(businessId) && pluginStudioOpen,
  })

  const jobs = bgData?.jobs ?? []
  const proactiveAlerts = bgData?.proactiveAlerts ?? []
  const risks = proactiveAlerts.filter((a) => a.category === 'risk')
  const opportunities = proactiveAlerts.filter((a) => a.category === 'opportunity')

  const invalidateAll = () => {
    if (!businessId || !userId) return
    void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.plugins(businessId) })
    void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.backgroundTasks(businessId) })
    void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.quickCommands(businessId) })
    void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.overview(businessId, userId) })
    void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.items(businessId) })
    void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.chatConversation(businessId, userId, null) })
  }

  const handleSynthesizePlugin = async (overridePrompt?: string, overrideSlug?: string) => {
    if (!businessId || !userId || synthesizing) return
    const targetPrompt = overridePrompt ?? promptInput.trim()
    if (!targetPrompt && !overrideSlug) return

    setSynthesizing(true)
    try {
      const res = await api.installPlugin({
        businessId,
        userId,
        prompt: targetPrompt || undefined,
        slug: overrideSlug,
        name: customPluginName.trim() || undefined,
        runImmediately: true,
      })
      invalidateAll()
      setPromptInput('')
      setCustomPluginName('')
      toast({
        title: `تم تثبيت وتشغيل بلاجن «${res.plugin.name}»`,
        description: res.summaryText || 'تمت إضافة الميزة لنظام Plugin Harness وربطها بالأوامر السريعة.',
      })
    } catch (e) {
      toast({
        variant: 'destructive',
        title: 'تعذر تثبيت البلاجن',
        description: (e as Error).message,
      })
    } finally {
      setSynthesizing(false)
    }
  }

  const handleRunPluginInChat = async (plugin: AgentPluginDTO) => {
    if (!businessId || runningPluginSlug) return
    setRunningPluginSlug(plugin.slug)
    try {
      setPluginStudioOpen(false)
      askAgent(plugin.quickPrompt || `شغّل بلاجن ${plugin.name}`)
    } finally {
      setRunningPluginSlug(null)
    }
  }

  const handleTogglePlugin = async (plugin: AgentPluginDTO) => {
    if (!plugin.installed) {
      await handleSynthesizePlugin(undefined, plugin.slug)
      return
    }
    try {
      await api.togglePlugin(plugin.id, !plugin.active)
      invalidateAll()
      toast({
        title: !plugin.active ? `تم تفعيل «${plugin.name}»` : `تم إيقاف «${plugin.name}» مؤقتاً`,
      })
    } catch (e) {
      toast({
        variant: 'destructive',
        title: 'تعذر تحديث حالة البلاجن',
        description: (e as Error).message,
      })
    }
  }

  const handleDeletePlugin = async (plugin: AgentPluginDTO) => {
    try {
      await api.deletePlugin(plugin.id)
      invalidateAll()
      toast({ title: `تم حذف البلاجن «${plugin.name}»` })
    } catch (e) {
      toast({
        variant: 'destructive',
        title: 'تعذر الحذف',
        description: (e as Error).message,
      })
    }
  }

  const toggleJobKind = (kind: BackgroundJobKind) => {
    setSelectedJobs((prev) =>
      prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind],
    )
  }

  const handleDispatchConcurrentBatch = async () => {
    if (!businessId || !userId || dispatchingBatch) return
    setDispatchingBatch(true)
    try {
      const catalogUpdates =
        recordItemName.trim().length > 0
          ? [
              {
                name: recordItemName.trim(),
                ...(Number(recordSellPrice) > 0 ? { sellPriceEgp: Number(recordSellPrice) } : {}),
                ...(recordStockQty !== '' && Number(recordStockQty) >= 0
                  ? { stockQty: Number(recordStockQty) }
                  : {}),
              },
            ]
          : undefined

      const jobKinds: BackgroundJobKind[] = [
        ...(catalogUpdates ? (['upsert_catalog_batch'] as BackgroundJobKind[]) : []),
        ...selectedJobs,
      ]

      const res = await api.dispatchBackgroundTasks({
        businessId,
        userId,
        jobKinds,
        catalogUpdates,
        postToChat: true,
      })

      setRecordItemName('')
      setRecordSellPrice('')
      setRecordStockQty('')
      invalidateAll()

      toast({
        title: `اكتملت ${res.jobs.length} عمليات خلفية متوازية (${res.totalDurationMs}ms)`,
        description: `تم تحديث السجلات ونشر التقرير المالي ورادار المخاطر والفرص في المحادثة.`,
      })
    } catch (e) {
      toast({
        variant: 'destructive',
        title: 'تعذر تنفيذ المهام المتوازية',
        description: (e as Error).message,
      })
    } finally {
      setDispatchingBatch(false)
    }
  }

  const handleActOnAlert = (alert: ProactiveAlertDTO) => {
    setPluginStudioOpen(false)
    askAgent(alert.actionPrompt)
  }

  return (
    <AnimatePresence>
      {pluginStudioOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4" dir="rtl">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            className="fixed inset-0 bg-black/55 backdrop-blur-xs"
            onClick={() => setPluginStudioOpen(false)}
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.18 }}
            className="relative z-10 flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
              <div>
                <h2 className="text-base font-bold text-foreground">
                  معمارية Plugin Harness ومحرك المهام الخلفية المتوازية
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  أضف ميزات وبلاجنز جديدة بالذكاء الاصطناعي، ونفّذ عدة عمليات متوازية مع مراقبة استباقية للمخاطر والفرص
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPluginStudioOpen(false)}
                className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="إغلاق"
              >
                <X className="size-4" />
              </button>
            </div>

            {/* Segmented Tab Bar */}
            <div className="flex items-center gap-1 border-b border-border bg-muted/30 px-5 py-2.5 overflow-x-auto">
              {(
                [
                  {
                    key: 'plugins' as PluginStudioTab,
                    label: `البلاجنز الذكية (${plugins.filter((p) => p.installed).length}/${plugins.length})`,
                    icon: Cpu,
                  },
                  {
                    key: 'background' as PluginStudioTab,
                    label: 'المهام الخلفية المتوازية',
                    icon: Layers,
                  },
                  {
                    key: 'alerts' as PluginStudioTab,
                    label: `رادار المخاطر والفرص (${proactiveAlerts.length})`,
                    icon: Radar,
                  },
                ] as const
              ).map((t) => {
                const Icon = t.icon
                const isActive = pluginStudioTab === t.key
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setPluginStudioOpen(true, t.key)}
                    className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                      isActive
                        ? 'bg-primary text-primary-foreground shadow-xs'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                  >
                    <Icon className="size-3.5" />
                    <span>{t.label}</span>
                  </button>
                )
              })}
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-5 space-y-6">
              {/* TAB 1: DYNAMIC AI PLUGIN HARNESS */}
              {pluginStudioTab === 'plugins' && (
                <div className="space-y-6">
                  {/* AI Plugin Synthesizer Box */}
                  <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-bold text-foreground">
                          بناء وإضافة ميزة جديدة بالذكاء الاصطناعي (Plugin Synthesizer)
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          اكتب أي ميزة تريد إضافتها لنظامك (مثل: «إدارة المخزون»، «تحليل المبيعات»، «مراقبة الديون المتأخرة») وسيقوم المحرك ببنائها وتثبيتها فوراً
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                      <input
                        type="text"
                        value={promptInput}
                        onChange={(e) => setPromptInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleSynthesizePlugin()
                        }}
                        placeholder="مثال: ضيف ميزة إدارة المخزون وتصنيف الأصناف الراكدة..."
                        className="sm:col-span-2 rounded-lg border border-border bg-background px-3.5 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
                      />
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={customPluginName}
                          onChange={(e) => setCustomPluginName(e.target.value)}
                          placeholder="اسم مختصر (اختياري)"
                          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
                        />
                        <button
                          type="button"
                          disabled={synthesizing || !promptInput.trim()}
                          onClick={() => void handleSynthesizePlugin()}
                          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 whitespace-nowrap shrink-0"
                        >
                          {synthesizing ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Sparkles className="size-3.5" />
                          )}
                          <span>توليد وتثبيت</span>
                        </button>
                      </div>
                    </div>

                    {/* Quick 1-click idea buttons */}
                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      <span className="text-[11px] text-muted-foreground ml-1">تثبيت سريع بضغطة:</span>
                      {QUICK_PLUGIN_IDEAS.map((idea) => (
                        <button
                          key={idea}
                          type="button"
                          disabled={synthesizing}
                          onClick={() => void handleSynthesizePlugin(idea)}
                          className="rounded-md border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent whitespace-nowrap shrink-0"
                        >
                          + {idea}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Plugins Grid */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-bold text-foreground">
                        البلاجنز والميزات المتاحة في النظام
                      </h3>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {plugins.filter((p) => p.installed && p.active).length} مفعّل · {plugins.length} إجمالي
                      </span>
                    </div>

                    {loadingPlugins ? (
                      <div className="py-10 text-center text-xs text-muted-foreground">
                        جاري تحميل معمارية البلاجنز...
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        {plugins.map((plugin) => (
                          <div
                            key={plugin.slug}
                            className={`flex flex-col justify-between rounded-xl border p-4 transition-colors ${
                              plugin.installed && plugin.active
                                ? 'border-primary/40 bg-card'
                                : 'border-border bg-muted/15'
                            }`}
                          >
                            <div className="space-y-2">
                              <div className="flex items-start justify-between gap-2">
                                <div>
                                  <h4 className="text-sm font-bold text-foreground">
                                    {plugin.name}
                                  </h4>
                                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
                                    <span>v{plugin.version}</span>
                                    <span aria-hidden="true">·</span>
                                    <span>{plugin.author === 'ai-synthesized' ? 'توليد ذكاء اصطناعي' : 'نواة وكيل'}</span>
                                    <span aria-hidden="true">·</span>
                                    <span>استُخدم {plugin.usageCount} مرة</span>
                                  </div>
                                </div>

                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => void handleTogglePlugin(plugin)}
                                    className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors whitespace-nowrap shrink-0 ${
                                      plugin.installed && plugin.active
                                        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                        : 'bg-muted text-muted-foreground hover:text-foreground'
                                    }`}
                                  >
                                    <Power className="size-3" />
                                    <span>
                                      {plugin.installed && plugin.active
                                        ? 'مفعّل'
                                        : plugin.installed
                                          ? 'متوقف'
                                          : 'تثبيت'}
                                    </span>
                                  </button>
                                  {plugin.installed && plugin.author === 'ai-synthesized' && (
                                    <button
                                      type="button"
                                      onClick={() => void handleDeletePlugin(plugin)}
                                      className="rounded-lg p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                      title="حذف البلاجن"
                                    >
                                      <Trash2 className="size-3.5" />
                                    </button>
                                  )}
                                </div>
                              </div>

                              <p className="text-xs leading-relaxed text-muted-foreground">
                                {plugin.description}
                              </p>

                              {/* Capabilities */}
                              <ul className="space-y-1 pt-1 text-[11px] text-foreground/85">
                                {plugin.capabilities.slice(0, 3).map((cap, idx) => (
                                  <li key={idx} className="flex items-center gap-1.5">
                                    <Check className="size-3 text-emerald-600 shrink-0" />
                                    <span className="truncate">{cap}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>

                            <div className="mt-4 flex items-center justify-between gap-2 border-t border-border/60 pt-3">
                              <div className="text-[11px] text-muted-foreground truncate">
                                الأمر: «{plugin.triggers[0] ?? plugin.name}»
                              </div>
                              <button
                                type="button"
                                disabled={runningPluginSlug === plugin.slug}
                                onClick={() => void handleRunPluginInChat(plugin)}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 whitespace-nowrap shrink-0"
                              >
                                <Play className="size-3" />
                                <span>تشغيل البلاجن الآن</span>
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 2: CONCURRENT BACKGROUND TASK ENGINE */}
              {pluginStudioTab === 'background' && (
                <div className="space-y-6">
                  <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-4">
                    <div>
                      <h3 className="text-sm font-bold text-foreground">
                        تشغيل دفعة عمليات خلفية متوازية (Parallel Worker Pool)
                      </h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        حدد المهام التي تريد من المساعد تنفيذها في نفس اللحظة (مثل تحديث سجل صنف في الكتالوج أثناء تحليل التقرير المالي وفحص المخاطر والفرص)
                      </p>
                    </div>

                    {/* Checklist of concurrent jobs */}
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {CONCURRENT_JOB_OPTIONS.map((opt) => {
                        const checked = selectedJobs.includes(opt.kind)
                        return (
                          <button
                            key={opt.kind}
                            type="button"
                            onClick={() => toggleJobKind(opt.kind)}
                            className={`flex items-start gap-3 rounded-xl border p-3 text-right transition-colors ${
                              checked
                                ? 'border-primary bg-primary/5'
                                : 'border-border bg-background hover:bg-muted/40'
                            }`}
                          >
                            <div
                              className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border ${
                                checked
                                  ? 'border-primary bg-primary text-primary-foreground'
                                  : 'border-muted-foreground/40'
                              }`}
                            >
                              {checked && <Check className="size-3" />}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="text-xs font-bold text-foreground">{opt.label}</div>
                              <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                                {opt.desc}
                              </div>
                            </div>
                          </button>
                        )
                      })}
                    </div>

                    {/* Optional simultaneous record update while financial report runs */}
                    <div className="rounded-lg border border-border bg-background p-3 space-y-2">
                      <div className="text-xs font-semibold text-foreground">
                        تحديث سجل صنف بالتوازي مع التحليل المالي (اختياري):
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <input
                          type="text"
                          value={recordItemName}
                          onChange={(e) => setRecordItemName(e.target.value)}
                          placeholder="اسم الصنف (مثال: بنادول إكسترا)"
                          className="rounded-lg border border-border bg-muted/20 px-3 py-1.5 text-xs focus:border-primary focus:outline-none"
                        />
                        <input
                          type="number"
                          value={recordSellPrice}
                          onChange={(e) => setRecordSellPrice(e.target.value)}
                          placeholder="سعر البيع الجديد بالجنيه"
                          className="rounded-lg border border-border bg-muted/20 px-3 py-1.5 text-xs tabular-nums focus:border-primary focus:outline-none"
                        />
                        <input
                          type="number"
                          value={recordStockQty}
                          onChange={(e) => setRecordStockQty(e.target.value)}
                          placeholder="الرصيد المحدث"
                          className="rounded-lg border border-border bg-muted/20 px-3 py-1.5 text-xs tabular-nums focus:border-primary focus:outline-none"
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 pt-1">
                      <span className="text-xs text-muted-foreground tabular-nums">
                        سيتم تشغيل {selectedJobs.length + (recordItemName.trim() ? 1 : 0)} عمليات متوازية في وقت واحد
                      </span>
                      <button
                        type="button"
                        disabled={dispatchingBatch || (selectedJobs.length === 0 && !recordItemName.trim())}
                        onClick={() => void handleDispatchConcurrentBatch()}
                        className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 whitespace-nowrap shrink-0"
                      >
                        {dispatchingBatch ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Play className="size-3.5" />
                        )}
                        <span>تشغيل العمليات المتوازية الآن</span>
                      </button>
                    </div>
                  </div>

                  {/* Recent Background Worker Jobs Table */}
                  <div className="space-y-2.5">
                    <h3 className="text-sm font-bold text-foreground">
                      سجل العمليات الخلفية المنفذة مؤخراً
                    </h3>
                    {loadingBg ? (
                      <div className="py-8 text-center text-xs text-muted-foreground">
                        جاري تحميل سجل المهام الخلفية...
                      </div>
                    ) : jobs.length === 0 ? (
                      <div className="rounded-xl border border-border p-8 text-center text-xs text-muted-foreground">
                        لم يتم تشغيل دفعات متوازية بعد — اضغط «تشغيل العمليات المتوازية الآن» بالأعلى لتجربة التنفيذ المتزامن.
                      </div>
                    ) : (
                      <div className="overflow-x-auto rounded-xl border border-border">
                        <table className="w-full text-right text-xs">
                          <thead className="border-b border-border bg-muted/40 text-muted-foreground">
                            <tr>
                              <th className="px-3.5 py-2.5 font-semibold">المهمة الخلفية</th>
                              <th className="px-3.5 py-2.5 font-semibold">الحالة</th>
                              <th className="px-3.5 py-2.5 font-semibold">النتيجة</th>
                              <th className="px-3.5 py-2.5 font-semibold">زمن التنفيذ</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {jobs.map((job) => (
                              <tr key={job.id} className="hover:bg-muted/25">
                                <td className="px-3.5 py-2.5 font-semibold text-foreground">
                                  {job.title}
                                </td>
                                <td className="px-3.5 py-2.5 text-muted-foreground">
                                  {job.status === 'done' ? 'مكتملة (١٠٠٪)' : job.status === 'failed' ? 'فشلت' : 'قيد التنفيذ'}
                                </td>
                                <td className="px-3.5 py-2.5 text-muted-foreground">
                                  {job.summary || job.stepLabel}
                                </td>
                                <td className="px-3.5 py-2.5 font-mono tabular-nums text-muted-foreground">
                                  {job.durationMs != null ? `${job.durationMs}ms` : '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 3: PROACTIVE RISK & OPPORTUNITY MONITOR */}
              {pluginStudioTab === 'alerts' && (
                <div className="space-y-6">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    {/* Risks Column */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between border-b border-border pb-2">
                        <h3 className="text-sm font-bold text-destructive flex items-center gap-1.5">
                          <AlertTriangle className="size-4" />
                          <span>المخاطر المرصودة ({risks.length})</span>
                        </h3>
                        <span className="text-[11px] text-muted-foreground">مراقبة لحظية للسجلات</span>
                      </div>

                      {risks.length === 0 ? (
                        <div className="rounded-xl border border-border p-6 text-center text-xs text-muted-foreground">
                          لا توجد مخاطر حرجة حالياً — السجلات والهوامش في النطاق الآمن.
                        </div>
                      ) : (
                        <div className="space-y-2.5">
                          {risks.map((risk) => (
                            <div
                              key={risk.id}
                              className="rounded-xl border border-border bg-card p-3.5 space-y-2"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <h4 className="text-xs font-bold text-foreground">{risk.title}</h4>
                                <span className="text-[11px] text-muted-foreground whitespace-nowrap shrink-0 tabular-nums">
                                  {risk.sourcePlugin ?? 'رادار اليقظة'}
                                </span>
                              </div>
                              <p className="text-xs leading-relaxed text-muted-foreground">
                                {risk.detail}
                              </p>
                              <div className="flex items-center justify-between pt-1">
                                <span className="text-[11px] font-mono tabular-nums text-destructive">
                                  {risk.metricValue ?? 'تنبيه وقائي'}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => handleActOnAlert(risk)}
                                  className="inline-flex items-center gap-1 rounded-lg border border-border bg-secondary px-3 py-1 text-[11px] font-semibold text-foreground transition-colors hover:bg-accent"
                                >
                                  <span>{risk.actionLabel}</span>
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Opportunities Column */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between border-b border-border pb-2">
                        <h3 className="text-sm font-bold text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
                          <Lightbulb className="size-4" />
                          <span>فرص النمو والربحية ({opportunities.length})</span>
                        </h3>
                        <span className="text-[11px] text-muted-foreground">مقترحات ذكية فورية</span>
                      </div>

                      {opportunities.length === 0 ? (
                        <div className="rounded-xl border border-border p-6 text-center text-xs text-muted-foreground">
                          شغّل تحليل المبيعات أو المخزون لاكتشاف فرص جديدة.
                        </div>
                      ) : (
                        <div className="space-y-2.5">
                          {opportunities.map((opp) => (
                            <div
                              key={opp.id}
                              className="rounded-xl border border-border bg-card p-3.5 space-y-2"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <h4 className="text-xs font-bold text-foreground">{opp.title}</h4>
                                <span className="text-[11px] text-muted-foreground whitespace-nowrap shrink-0 tabular-nums">
                                  {opp.sourcePlugin ?? 'محرك الفرص'}
                                </span>
                              </div>
                              <p className="text-xs leading-relaxed text-muted-foreground">
                                {opp.detail}
                              </p>
                              <div className="flex items-center justify-between pt-1">
                                <span className="text-[11px] font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                                  {opp.metricValue ?? 'فرصة مباشرة'}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => handleActOnAlert(opp)}
                                  className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1 text-[11px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
                                >
                                  <span>{opp.actionLabel}</span>
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
