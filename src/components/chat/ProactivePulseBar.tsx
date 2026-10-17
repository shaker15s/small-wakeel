'use client'

// وكيل — Proactive Employee Pulse Bar
// Surfaces live employee awareness inside ChatView:
// - Pending drafts awaiting approval
// - Proactive Risk & Opportunity Radar alerts
// - Dynamic AI Plugin Harness quick launcher & active plugin count
// - Concurrent Multi-Task Background Worker (simultaneous record updates + financial report analysis + proactive radar)

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { QUERY_KEYS, useWakil, type ViewKey } from '@/lib/store'
import { api } from '@/lib/api'
import type { BusinessLite } from '@/lib/types'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Command,
  Cpu,
  Layers,
  Loader2,
  PlusCircle,
  Radar,
  Sparkles,
  TrendingUp,
} from 'lucide-react'
import { useToast } from '@/hooks/use-toast'

export function ProactivePulseBar({
  business,
  userId,
  onRunPrompt,
  onNavigate,
  disabled,
}: {
  business: BusinessLite
  userId: string
  onRunPrompt: (prompt: string) => void
  onNavigate?: (view: ViewKey) => void
  disabled?: boolean
}) {
  const { setCommandPaletteOpen, setBusinessBuilderOpen, setPluginStudioOpen } = useWakil()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [runningBatch, setRunningBatch] = useState(false)

  const { data: overview } = useQuery({
    queryKey: QUERY_KEYS.overview(business.id, userId),
    queryFn: () => api.overview(business.id, userId),
    staleTime: 30_000,
  })

  const { data: pluginsData } = useQuery({
    queryKey: QUERY_KEYS.plugins(business.id),
    queryFn: () => api.plugins(business.id),
    staleTime: 30_000,
  })

  const { data: bgData } = useQuery({
    queryKey: QUERY_KEYS.backgroundTasks(business.id),
    queryFn: () => api.backgroundTasks(business.id),
    staleTime: 30_000,
  })

  const pendingCount = overview?.pendingOps.length ?? 0
  const lowStockCount = overview?.lowStock.length ?? 0
  const activePluginsCount = (Array.isArray(pluginsData) ? pluginsData : []).filter((p) => p.active).length
  const proactiveAlerts = bgData?.proactiveAlerts ?? []
  const criticalRisks = proactiveAlerts.filter((a) => a.category === 'risk' && (a.level === 'danger' || a.level === 'warning'))
  const opportunities = proactiveAlerts.filter((a) => a.category === 'opportunity')

  const handleDispatchConcurrentJobs = async () => {
    if (runningBatch || disabled) return
    setRunningBatch(true)
    try {
      const res = await api.dispatchBackgroundTasks({
        businessId: business.id,
        userId,
        jobKinds: [
          'sync_and_audit_records',
          'analyze_financial_report',
          'forecast_inventory_velocity',
          'scan_risks_and_opportunities',
          'run_active_plugins',
        ],
        postToChat: true,
      })
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.backgroundTasks(business.id) })
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.overview(business.id, userId) })
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.chatConversation(business.id, userId, null) })
      toast({
        title: `راجعت الشغل بالكامل في ${res.totalDurationMs}ms ✅`,
        description: `فحصت الحسابات + حللت التقرير المالي + رصدت ${res.proactiveAlerts.length} تنبيه مخاطر وفرص`,
      })
    } catch (e) {
      toast({
        variant: 'destructive',
        title: 'تعذر إتمام الفحص الشامل',
        description: (e as Error).message,
      })
    } finally {
      setRunningBatch(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl mb-1">
      <div className="glass flex items-center justify-between gap-2 rounded-2xl px-3.5 py-2 overflow-x-auto scroll-warm shadow-sm">
        {/* Left: Live Employee Status & Proactive Risk/Opportunity Radar */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setPluginStudioOpen(true, 'alerts')}
            className="press inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20 text-[11px] font-semibold transition-colors"
            title="حالة متابعة وكيل لشغلك لحظة بلحظة"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span>موظفك صاحي ومتابع</span>
          </button>

          {pendingCount > 0 && (
            <button
              type="button"
              onClick={() => onNavigate?.('journal')}
              className="press inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-amber-500/12 hover:bg-amber-500/20 text-amber-800 dark:text-amber-300 border border-amber-500/25 text-[11px] font-medium transition-colors"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>{pendingCount} مسودة للاعتماد</span>
            </button>
          )}

          {criticalRisks.length > 0 && (
            <button
              type="button"
              onClick={() => setPluginStudioOpen(true, 'alerts')}
              className="press inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-destructive/10 hover:bg-destructive/15 text-destructive border border-destructive/25 text-[11px] font-medium transition-colors"
              title="تنبيهات ومخاطر رصدها وكيل في الشغل"
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>{criticalRisks.length} تنبيه مهم</span>
            </button>
          )}

          {opportunities.length > 0 && (
            <button
              type="button"
              onClick={() => setPluginStudioOpen(true, 'alerts')}
              className="press inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/25 text-[11px] font-medium transition-colors"
              title="فرص ربح ونمو مكتشفة تلقائيًا"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{opportunities.length} فرص مكسب</span>
            </button>
          )}

          {lowStockCount > 0 && criticalRisks.length === 0 && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onRunPrompt('توقع المخزون ومعدل السحب والأصناف اللي قربت تخلص')}
              className="press inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-secondary hover:bg-secondary/80 text-foreground/85 border border-border/70 text-[11px] transition-colors"
            >
              <Activity className="w-3.5 h-3.5 text-amber-600" />
              <span>{lowStockCount} نواقص — توقع السحب</span>
            </button>
          )}
        </div>

        {/* Right: Capabilities & Instant Comprehensive Review */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setPluginStudioOpen(true, 'plugins')}
            title="قدرات وأنظمة المتابعة الذكية اللي وكيل بيشغلها لشغلك"
            className="press inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-primary/10 hover:bg-primary/15 text-primary border border-primary/25 text-[11px] font-semibold transition-all"
          >
            <Cpu className="w-3.5 h-3.5" />
            <span>قدرات المتابعة ({activePluginsCount})</span>
          </button>

          <button
            type="button"
            disabled={disabled || runningBatch}
            onClick={() => void handleDispatchConcurrentJobs()}
            title="مراجعة شاملة للحسابات والمخزون والتقرير المالي والمخاطر في نفس اللحظة"
            className="press inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-card/80 hover:bg-accent text-foreground border border-border/70 text-[11px] font-medium transition-all disabled:opacity-50"
          >
            {runningBatch ? (
              <Loader2 className="w-3.5 h-3.5 text-amber-600 animate-spin" />
            ) : (
              <Layers className="w-3.5 h-3.5 text-amber-600" />
            )}
            <span>فحص شامل فوري</span>
          </button>

          <button
            type="button"
            disabled={disabled}
            onClick={() => onRunPrompt('حلل الربحية وهوامش الربح في المحل')}
            title="تحليل الربحية وهوامش الأصناف"
            className="press inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-card/80 hover:bg-accent text-foreground border border-border/70 text-[11px] font-medium transition-all"
          >
            <TrendingUp className="w-3.5 h-3.5 text-emerald-600" />
            <span className="hidden sm:inline">تحليل الربحية</span>
          </button>

          <button
            type="button"
            onClick={() => setPluginStudioOpen(true, 'alerts')}
            title="رادار المخاطر والفرص الاستباقي"
            className="press inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-card/80 hover:bg-accent text-foreground border border-border/70 text-[11px] font-medium transition-all"
          >
            <Radar className="w-3.5 h-3.5 text-primary" />
            <span className="hidden md:inline">رادار اليقظة</span>
          </button>

          <button
            type="button"
            onClick={() => setBusinessBuilderOpen(true)}
            title="إنشاء نشاط تجاري جديد"
            className="press inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-card/80 hover:bg-accent text-foreground border border-border/70 text-[11px] font-medium transition-all"
          >
            <PlusCircle className="w-3.5 h-3.5 text-primary" />
            <span className="hidden lg:inline">نشاط جديد</span>
          </button>

          <button
            type="button"
            onClick={() => setCommandPaletteOpen(true)}
            title="لوحة الأوامر السريعة (Ctrl+K)"
            className="press inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-primary/12 hover:bg-primary/20 text-primary border border-primary/25 text-[11px] font-semibold transition-all"
          >
            <Command className="w-3.5 h-3.5" />
            <span className="hidden md:inline">⌘K</span>
          </button>
        </div>
      </div>
    </div>
  )
}
