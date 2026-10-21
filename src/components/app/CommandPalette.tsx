'use client'

// وكيل — Universal Superpower Command Palette (Cmd+K / Ctrl+K)
// Instant keyboard-first navigation, employee superpowers, live catalog search,
// business switching, and direct natural-language execution.

import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { QUERY_KEYS, useWakil, type ViewKey } from '@/lib/store'
import { api } from '@/lib/api'
import { getVertical } from '@/lib/verticals'
import { egp } from '@/lib/format'
import type { BusinessLite } from '@/lib/types'
import {
  Activity,
  ArrowUpLeft,
  BarChart3,
  BookOpen,
  Boxes,
  Brain,
  Building2,
  Calendar,
  FileBarChart,
  Layers,
  MessageSquare,
  Play,
  PlusCircle,
  Radar,
  Search,
  Settings,
  Sparkles,
  TrendingUp,
  Users,
  Zap,
} from 'lucide-react'
import { useToast } from '@/hooks/use-toast'

interface PaletteAction {
  id: string
  group: 'superpowers' | 'quick' | 'views' | 'catalog' | 'businesses'
  title: string
  subtitle?: string
  badge?: string
  icon: React.ReactNode
  onSelect: () => void
}

export function CommandPalette({
  business,
  businesses,
  userId,
}: {
  business: BusinessLite
  businesses: BusinessLite[]
  userId: string
}) {
  const {
    commandPaletteOpen,
    setCommandPaletteOpen,
    setBusinessBuilderOpen,
    setPluginStudioOpen,
    setSession,
    setView,
    askAgent,
  } = useWakil()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [runningTasks, setRunningTasks] = useState(false)

  // Global Cmd+K / Ctrl+K listener
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCommandPaletteOpen(!commandPaletteOpen)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [commandPaletteOpen, setCommandPaletteOpen])

  const { data: items = [] } = useQuery({
    queryKey: QUERY_KEYS.items(business.id),
    queryFn: () => api.items(business.id),
    enabled: commandPaletteOpen,
  })

  const { data: quickCommands = [] } = useQuery({
    queryKey: QUERY_KEYS.quickCommands(business.id),
    queryFn: () => api.quickCommands(business.id),
    enabled: commandPaletteOpen,
  })

  useEffect(() => {
    if (commandPaletteOpen) {
      setQuery('')
      setSelectedIndex(0)
    }
  }, [commandPaletteOpen])

  const closeAndRun = (fn: () => void) => {
    setCommandPaletteOpen(false)
    setTimeout(fn, 40)
  }

  const handleRunDueTasks = async () => {
    if (runningTasks) return
    setRunningTasks(true)
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
        title: `تم تنفيذ ${res.jobs.length} مهام خلفية متوازية (${res.totalDurationMs}ms)`,
        description: 'تم تحديث السجلات وتحليل التقرير المالي وفحص رادار المخاطر والفرص في المحادثة',
      })
      setView('chat')
    } catch (e) {
      toast({
        variant: 'destructive',
        title: 'تعذر تشغيل المهام',
        description: (e as Error).message,
      })
    } finally {
      setRunningTasks(false)
      setCommandPaletteOpen(false)
    }
  }

  const actions = useMemo<PaletteAction[]>(() => {
    const list: PaletteAction[] = []

    // 1. Employee Superpowers
    list.push(
      {
        id: 'sp-plugin-harness',
        group: 'superpowers',
        title: 'معمارية Plugin Harness — إضافة وتوليد ميزات بالذكاء الاصطناعي',
        subtitle: 'إدارة المخزون، تحليل المبيعات، تدقيق الهوامش، أو بناء أي بلاجن جديد بالمحادثة',
        badge: 'Plugin Harness',
        icon: <Layers className="w-4 h-4 text-primary" />,
        onSelect: () => closeAndRun(() => setPluginStudioOpen(true, 'plugins')),
      },
      {
        id: 'sp-bg-tasks-studio',
        group: 'superpowers',
        title: 'مدير المهام الخلفية المتوازية (تحديث السجلات + تحليل مالي متزامن)',
        subtitle: 'ينفذ عدة عمليات خلفية في نفس اللحظة ويربطها بنظام التنبيهات الاستباقي',
        badge: 'متوازي لحظي',
        icon: <Play className="w-4 h-4 text-emerald-600" />,
        onSelect: () => closeAndRun(() => setPluginStudioOpen(true, 'background')),
      },
      {
        id: 'sp-proactive-radar-modal',
        group: 'superpowers',
        title: 'رادار المخاطر والفرص الاستباقي المربوط بالبلاجنز',
        subtitle: 'يراقب مخاطر السيولة والنواقص وتآكل الهوامش وفرص الربح لحظيًا',
        badge: 'رادار استباقي',
        icon: <Radar className="w-4 h-4 text-amber-600" />,
        onSelect: () => closeAndRun(() => setPluginStudioOpen(true, 'alerts')),
      },
      {
        id: 'sp-profit',
        group: 'superpowers',
        title: 'تحليل الربحية وهوامش الأصناف',
        subtitle: 'يحسب صافي الربح وتكلفة البضاعة وأعلى الأصناف مكسبًا',
        badge: 'تحليل ذكي',
        icon: <TrendingUp className="w-4 h-4 text-emerald-600" />,
        onSelect: () => closeAndRun(() => askAgent('حلل الربحية وهوامش الربح في المحل')),
      },
      {
        id: 'sp-forecast',
        group: 'superpowers',
        title: 'تنبؤ المخزون ومعدل السحب اليومي',
        subtitle: 'يتوقع امتى كل صنف هيخلص والكمية المقترحة للشرا',
        badge: 'تنبؤ',
        icon: <Activity className="w-4 h-4 text-amber-600" />,
        onSelect: () => closeAndRun(() => askAgent('توقع المخزون ومعدل السحب والأصناف اللي قربت تخلص')),
      },
      {
        id: 'sp-radar',
        group: 'superpowers',
        title: 'اسأل وكيل في الشات عن الفرص والمخاطر الفورية',
        subtitle: 'يفحص السيولة والمديونيات المتأخرة وتآكل الهوامش والنواقص',
        badge: 'استباقي',
        icon: <Radar className="w-4 h-4 text-primary" />,
        onSelect: () => closeAndRun(() => askAgent('قولي تنبيهات ذكية وفرص ومخاطر الشغل دلوقتي')),
      },
      {
        id: 'sp-research',
        group: 'superpowers',
        title: 'تشغيل وضع البحث العميق والخطة الاستراتيجية',
        subtitle: 'يجمع من السجل والويب ويكتب تقرير موثق بالأرقام',
        badge: 'بحث عميق',
        icon: <Sparkles className="w-4 h-4 text-purple-600" />,
        onSelect: () =>
          closeAndRun(() =>
            askAgent('اعمل بحث عميق وخطة عملية لزيادة أرباح النشاط وتقليل الهالك', {
              deepResearch: true,
            }),
          ),
      },
      {
        id: 'sp-tasks-run',
        group: 'superpowers',
        title: 'تشغيل حزمة المهام الخلفية المتوازية فورًا في الشات',
        subtitle: 'تحديث السجلات + تحليل التقرير المالي + تنبؤ المخزون + فحص المخاطر بالتوازي',
        badge: 'تشغيل فوري',
        icon: <Play className="w-4 h-4 text-emerald-600" />,
        onSelect: () => void handleRunDueTasks(),
      },
      {
        id: 'sp-new-biz',
        group: 'superpowers',
        title: 'إنشاء نشاط تجاري جديد أو تخصص مخصص',
        subtitle: 'صيدلية، مطعم، ملابس، إلكترونيات، عيادة، أو أي نشاط بالكلام',
        badge: 'محرك الأنشطة',
        icon: <PlusCircle className="w-4 h-4 text-primary" />,
        onSelect: () => closeAndRun(() => setBusinessBuilderOpen(true)),
      },
    )

    // 2. Quick Commands
    for (const qc of quickCommands) {
      list.push({
        id: `qc-${qc.id}`,
        group: 'quick',
        title: qc.label,
        subtitle: qc.prompt,
        badge: 'أمر سريع',
        icon: <Zap className="w-4 h-4 text-amber-500" />,
        onSelect: () => closeAndRun(() => askAgent(qc.prompt)),
      })
    }

    // 3. Views navigation
    const views: { key: ViewKey; label: string; sub: string; icon: React.ReactNode }[] = [
      { key: 'chat', label: 'محادثة وكيل', sub: 'الشات والتنفيذ المباشر مع الموظف الذكي', icon: <MessageSquare className="w-4 h-4" /> },
      { key: 'today', label: 'لوحة اليوم والخزنة', sub: 'نبض السيولة والمهام المجدولة ورادار الأمانة', icon: <Calendar className="w-4 h-4" /> },
      { key: 'journal', label: 'سجل العمليات والمسودات', sub: 'اعتماد العمليات ومراجعة القيود', icon: <BookOpen className="w-4 h-4" /> },
      { key: 'inventory', label: 'المخزون والكتالوج', sub: 'الأصناف والأسعار وتنبيهات النواقص', icon: <Boxes className="w-4 h-4" /> },
      { key: 'accounts', label: 'دفتر الحسابات والمديونيات', sub: 'العملاء والموردين والأعضاء', icon: <Users className="w-4 h-4" /> },
      { key: 'stats', label: 'الإحصائيات والرسوم البيانية', sub: 'مؤشرات الأداء والمبيعات', icon: <BarChart3 className="w-4 h-4" /> },
      { key: 'reports', label: 'التقارير المالية والمحاسبية', sub: 'تقارير ٧ و ٣٠ يوم وتصدير البيانات', icon: <FileBarChart className="w-4 h-4" /> },
      { key: 'memory', label: 'ذاكرة وكيل وقوانين الشغل', sub: 'القواعد والتفضيلات والقاموس اللي اتعلمه', icon: <Brain className="w-4 h-4" /> },
      { key: 'settings', label: 'إعدادات وكيل والموديلات', sub: 'Gemini الفعلي والمزودات والمهام المجدولة', icon: <Settings className="w-4 h-4" /> },
    ]
    for (const v of views) {
      list.push({
        id: `view-${v.key}`,
        group: 'views',
        title: v.label,
        subtitle: v.sub,
        badge: 'شاشة',
        icon: v.icon,
        onSelect: () => closeAndRun(() => setView(v.key)),
      })
    }

    // 4. Catalog items
    for (const it of items.slice(0, 25)) {
      list.push({
        id: `item-${it.id}`,
        group: 'catalog',
        title: `${it.name} (${it.category})`,
        subtitle: `سعر البيع: ${it.sellPrice == null ? 'غير مسجل' : egp(it.sellPrice)} · الرصيد: ${it.stockQty == null ? 'غير مسجل' : it.stockQty}`,
        badge: 'صنف',
        icon: <Layers className="w-4 h-4 text-muted-foreground" />,
        onSelect: () => closeAndRun(() => askAgent(`إيه رصيد وسعر وحركة صنف ${it.name}؟`)),
      })
    }

    // 5. Switch Businesses
    for (const b of businesses) {
      const vd = getVertical(b.type)
      list.push({
        id: `biz-${b.id}`,
        group: 'businesses',
        title: `تبديل إلى: ${b.name}`,
        subtitle: `${vd.icon} ${vd.label}`,
        badge: b.id === business.id ? 'الحالي' : 'نشاط',
        icon: <Building2 className="w-4 h-4 text-primary" />,
        onSelect: () =>
          closeAndRun(() => {
            const owner = b.users.find((u) => u.role === 'owner') ?? b.users[0]
            if (owner) setSession(b.id, owner.id)
          }),
      })
    }

    return list
  }, [quickCommands, items, businesses, business.id])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return actions.filter((a) => a.group !== 'catalog').slice(0, 14)
    return actions
      .filter(
        (a) =>
          a.title.toLowerCase().includes(q) ||
          (a.subtitle && a.subtitle.toLowerCase().includes(q)) ||
          (a.badge && a.badge.toLowerCase().includes(q)),
      )
      .slice(0, 16)
  }, [actions, query])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const total = filtered.length + (query.trim().length > 1 ? 1 : 0)
    if (total === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((prev) => (prev + 1) % total)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((prev) => (prev - 1 + total) % total)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (selectedIndex < filtered.length) {
        filtered[selectedIndex].onSelect()
      } else if (query.trim().length > 1) {
        const q = query.trim()
        closeAndRun(() => askAgent(q))
      }
    }
  }

  return (
    <Dialog open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen}>
      <DialogContent
        dir="rtl"
        className="max-w-2xl p-0 gap-0 overflow-hidden border-border/80 bg-card/95 backdrop-blur-xl shadow-2xl"
      >
        <DialogTitle className="sr-only">لوحة أوامر وكيل السريعة</DialogTitle>

        {/* Search input bar */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-border/70 bg-secondary/30">
          <Search className="w-5 h-5 text-primary shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="ابحث في الأوامر، الأصناف، الشاشات، أو اكتب طلب مباشر لوكيل..."
            className="flex-1 bg-transparent text-sm md:text-base text-foreground placeholder:text-muted-foreground focus:outline-none"
            autoFocus
          />
          <kbd className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono text-muted-foreground bg-background border border-border rounded-md">
            ESC
          </kbd>
        </div>

        {/* Results list */}
        <div className="max-h-[65vh] overflow-y-auto p-2 space-y-1">
          {filtered.map((item, idx) => {
            const active = idx === selectedIndex
            return (
              <button
                key={item.id}
                type="button"
                onMouseEnter={() => setSelectedIndex(idx)}
                onClick={item.onSelect}
                className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-right transition-all ${
                  active
                    ? 'bg-primary/12 text-foreground ring-1 ring-primary/30'
                    : 'hover:bg-secondary/60 text-foreground/90'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border ${
                      active
                        ? 'bg-primary/15 border-primary/40 text-primary'
                        : 'bg-secondary/70 border-border/60 text-muted-foreground'
                    }`}
                  >
                    {item.icon}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate">{item.title}</div>
                    {item.subtitle && (
                      <div className="text-xs text-muted-foreground truncate mt-0.5">{item.subtitle}</div>
                    )}
                  </div>
                </div>
                {item.badge && (
                  <span className="shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-md bg-secondary text-secondary-foreground border border-border/60">
                    {item.badge}
                  </span>
                )}
              </button>
            )
          })}

          {/* Direct Agent execution fallback */}
          {query.trim().length > 1 && (
            <button
              type="button"
              onMouseEnter={() => setSelectedIndex(filtered.length)}
              onClick={() => {
                const q = query.trim()
                closeAndRun(() => askAgent(q))
              }}
              className={`w-full flex items-center justify-between gap-3 px-3 py-3 rounded-xl text-right transition-all border border-dashed ${
                selectedIndex === filtered.length
                  ? 'bg-primary/15 border-primary text-foreground'
                  : 'border-border hover:bg-secondary/50 text-foreground'
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-8 h-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center shrink-0">
                  <Sparkles className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-bold truncate">
                    اطلب من وكيل فورًا: «{query.trim()}»
                  </div>
                  <div className="text-xs text-muted-foreground">
                    وكيل هيشغّل أدواته أو ينفذ العملية في الشات مباشرة
                  </div>
                </div>
              </div>
              <ArrowUpLeft className="w-4 h-4 text-primary shrink-0" />
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-border/70 bg-secondary/20 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-3">
            <span>↑↓ للتنقل</span>
            <span>↵ للتنفيذ</span>
          </div>
          <span>وكيل — لوحة التحكم الفورية (Ctrl+K)</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
