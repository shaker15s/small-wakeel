// وكيل — AppShell: the app frame. Sticky footer, header with business/user
// switchers + dark mode + notification center, nav for the 8 views (sliding
// active pill), mobile bottom tab bar, and the cinematic first-run onboarding.

'use client'

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion, useAnimationControls } from 'framer-motion'
import {
  BarChart3,
  Bell,
  BookOpen,
  Boxes,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  CircleAlert,
  FileText,
  Info,
  LayoutGrid,
  MessageCircle,
  Moon,
  Settings,
  Sun,
  TriangleAlert,
  Users,
  Wallet,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import { api } from '@/lib/api'
import { QUERY_KEYS, useWakil, VIEW_LABELS, type ViewKey } from '@/lib/store'
import { getVertical } from '@/lib/verticals'
import type { AlertDTO, BusinessLite } from '@/lib/types'
import { arNum, safeView } from '@/components/views/shared'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { ChatView } from '@/components/chat/ChatView'
import TodayView from '@/components/views/TodayView'
import InventoryView from '@/components/views/InventoryView'
import JournalView from '@/components/views/JournalView'
import AccountsView from '@/components/views/AccountsView'
import StatsView from '@/components/views/StatsView'
import ReportsView from '@/components/views/ReportsView'
import SettingsView from '@/components/views/SettingsView'
import MemoryView from '@/components/views/MemoryView'
import { Onboarding } from './Onboarding'
import { AgentAvatar } from '@/components/chat/AgentAvatar'

const NAV_ITEMS: { key: ViewKey; icon: typeof MessageCircle }[] = [
  { key: 'chat', icon: MessageCircle },
  { key: 'today', icon: LayoutGrid },
  { key: 'inventory', icon: Boxes },
  { key: 'journal', icon: BookOpen },
  { key: 'accounts', icon: Users },
  { key: 'stats', icon: BarChart3 },
  { key: 'reports', icon: FileText },
  { key: 'memory', icon: Brain },
  { key: 'settings', icon: Settings },
]

const MOBILE_NAV: ViewKey[] = ['chat', 'today', 'inventory', 'journal', 'settings']

export function AppShell() {
  const { businessId, userId, view, setView, setSession, hydrate, onboardingDone, finishOnboarding } = useWakil()
  const { theme, setTheme } = useTheme()
  const { toast } = useToast()
  // SSR-safe mounted flag without setState-in-effect
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  )

  const [notifOpen, setNotifOpen] = useState(false)
  // imperative framer controls — the effect below drives the one-time badge
  // pulse without any setState-in-effect
  const badgeControls = useAnimationControls()
  // alert-diffing memory (badge pulse only on count growth; toasts on unseen texts)
  const prevCountRef = useRef<number | null>(null)
  const prevSessionRef = useRef<string | null>(null)
  const seenTextsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    hydrate()
  }, [hydrate])

  const { data: bootstrap } = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => api.bootstrap(),
    staleTime: 60_000,
  })

  // pending approvals count → notification badge
  const business = useMemo(
    () => bootstrap?.businesses.find((b) => b.id === businessId) ?? bootstrap?.businesses[0],
    [bootstrap, businessId],
  )
  const user = useMemo(
    () => business?.users.find((u) => u.id === userId) ?? business?.users[0],
    [business, userId],
  )

  const { data: overview } = useQuery({
    queryKey: business && user ? QUERY_KEYS.overview(business.id, user.id) : ['overview', 'none'],
    queryFn: () => api.overview(business!.id, user!.id),
    enabled: !!business && !!user,
    refetchInterval: 30_000,
  })

  const alerts = useMemo(() => overview?.alerts ?? [], [overview])
  // badge = danger + warning alerts (info lives inside the popover)
  const alertCount = useMemo(
    () => alerts.filter((a) => a.level === 'danger' || a.level === 'warning').length,
    [alerts],
  )
  const hasDanger = useMemo(() => alerts.some((a) => a.level === 'danger'), [alerts])

  // — notification diffing: first load / business switch seeds silently; a
  // count INCREASE pulses the badge once, and a genuinely-new danger alert
  // (unseen text) fires a destructive toast.
  useEffect(() => {
    if (!overview) return
    const sessionKey = `${businessId ?? '~'}|${userId ?? '~'}`
    const sessionChanged = prevSessionRef.current !== null && prevSessionRef.current !== sessionKey
    prevSessionRef.current = sessionKey

    if (prevCountRef.current === null || sessionChanged) {
      prevCountRef.current = alertCount
      for (const a of alerts) seenTextsRef.current.add(a.text)
      return
    }

    const prev = prevCountRef.current
    prevCountRef.current = alertCount

    // one-time badge pulse (scale 1 → 1.3 → 1, 400ms) — only on count GROWTH
    if (alertCount > prev) {
      badgeControls.start({ scale: [1, 1.3, 1] }, { duration: 0.4, ease: 'easeInOut' })
    }

    // genuinely-new danger alert (unseen text) → destructive toast.
    // Independent of the count: a warning that escalates to danger (same
    // total) must still announce itself.
    const newDangers = alerts.filter(
      (a) => a.level === 'danger' && !seenTextsRef.current.has(a.text),
    )
    for (const a of newDangers.slice(0, 2)) {
      toast({ title: 'تنبيه مهم', description: a.text, variant: 'destructive' })
    }

    for (const a of alerts) seenTextsRef.current.add(a.text)
  }, [overview, alertCount, alerts, businessId, userId, toast, badgeControls])

  // first run → onboarding
  if (mounted && !onboardingDone && bootstrap && bootstrap.businesses.length > 0) {
    return <Onboarding businesses={bootstrap.businesses} onFinish={finishOnboarding} onPick={setSession} />
  }

  if (!mounted || !bootstrap) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <AgentAvatar state="thinking" size="lg" />
          <p className="shimmer-text text-sm font-medium">وكيل بيجهز…</p>
        </div>
      </div>
    )
  }

  const activeBusiness = business ?? bootstrap.businesses[0]
  const activeUser = user ?? activeBusiness.users[0]
  if (!activeBusiness || !activeUser) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6 text-center">
        <p className="text-sm text-muted-foreground">مفيش منشآت — شغّل الـ seed الأول</p>
      </div>
    )
  }

  const vertical = getVertical(activeBusiness.type)

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      {/* ===== header ===== */}
      <header className="shrink-0 border-b border-border/70 bg-card/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-3 sm:px-4">
          {/* business switcher */}
          <div className="relative" data-business-switcher>
            <BusinessSwitcher businesses={bootstrap.businesses} active={activeBusiness} onPick={(b, u) => setSession(b, u)} />
          </div>

          <div className="ms-1 hidden min-w-0 flex-col sm:flex">
            <span className="truncate text-[11px] text-muted-foreground">{vertical.label}</span>
          </div>

          <div className="flex-1" />

          {/* ذاكرة وكيل — mobile shortcut (the bottom bar stays 5 tabs) */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setView('memory')}
            aria-label="ذاكرة وكيل"
            aria-current={view === 'memory' ? 'page' : undefined}
            className={cn(
              'relative size-10 rounded-full transition-transform active:scale-90 sm:hidden',
              view === 'memory' && 'badge-breathe bg-accent',
            )}
          >
            <Brain className={cn('size-4.5', view === 'memory' ? 'text-wakil-amber' : undefined)} />
          </Button>

          {/* notifications — popover center fed by the 30s-polled overview */}
          <Popover open={notifOpen} onOpenChange={setNotifOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="relative size-10 rounded-full transition-transform active:scale-90"
                aria-label={
                  alertCount > 0 ? `${arNum(alertCount)} تنبيهات محتاجة نظرة` : 'التنبيهات — كل حاجة تمام'
                }
              >
                <Bell className="size-4.5" />
                {alertCount > 0 && (
                  <motion.span
                    animate={badgeControls}
                    className={cn(
                      'num absolute -end-0.5 -top-0.5 flex size-5 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-white tabular-nums',
                      hasDanger && 'pulse-ring',
                    )}
                  >
                    {alertCount > 9 ? '٩+' : arNum(alertCount)}
                  </motion.span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              side="bottom"
              align="end"
              className="w-[22rem] max-h-[26rem] overflow-y-auto scroll-warm p-0"
            >
              <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b bg-popover/95 px-4 py-3 backdrop-blur-sm">
                <span className="text-sm font-bold">التنبيهات</span>
                {alerts.length > 0 && (
                  <span className="num rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-semibold text-muted-foreground tabular-nums">
                    {arNum(alerts.length)}
                  </span>
                )}
              </div>
              <NotificationList
                alerts={alerts}
                onNavigate={(v) => {
                  setNotifOpen(false)
                  setView(v)
                }}
              />
            </PopoverContent>
          </Popover>

          {/* dark mode */}
          <Button
            variant="ghost"
            size="icon"
            className="size-10 rounded-full transition-transform active:scale-90"
            aria-label="تبديل الوضع الليلي"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            <motion.span
              key={theme ?? 'system'}
              initial={{ rotate: -90, opacity: 0 }}
              animate={{ rotate: 0, opacity: 1 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className="flex"
            >
              {theme === 'dark' ? <Sun className="size-4.5" /> : <Moon className="size-4.5" />}
            </motion.span>
          </Button>
        </div>

        {/* desktop nav — active pill slides between views (scrolls safely
            between sm and lg now that it carries 9 items) */}
        <nav
          aria-label="التنقل الرئيسي"
          className="scroll-warm mx-auto hidden max-w-5xl gap-1 overflow-x-auto px-3 pb-2 sm:flex sm:px-4"
        >
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const active = view === item.key
            return (
              <button
                key={item.key}
                onClick={() => setView(item.key)}
                aria-current={active ? 'page' : undefined}
                className={`press focus-warm ${active ? 'relative isolate' : 'relative z-10'} flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium transition-colors ${
                  active
                    ? 'text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                }`}
              >
                {active && (
                  <motion.span
                    layoutId="nav-active-pill"
                    transition={{ type: 'spring', stiffness: 400, damping: 34 }}
                    className="absolute inset-0 -z-10 rounded-full bg-primary shadow-sm"
                    aria-hidden
                  />
                )}
                <Icon className="size-3.5" aria-hidden />
                {VIEW_LABELS[item.key]}
              </button>
            )
          })}
        </nav>
      </header>

      {/* ===== main — chat fills it exactly; other views scroll inside ===== */}
      <main className="mx-auto min-h-0 w-full max-w-5xl flex-1 overflow-hidden">
        {view === 'chat' ? (
          <ChatView business={activeBusiness} userId={activeUser.id} onNavigate={setView} />
        ) : (
          <div className="scroll-warm h-full overflow-y-auto px-3 pb-24 pt-4 sm:px-0 sm:pb-10">
            {view === 'today' && <TodayView businessId={activeBusiness.id} userId={activeUser.id} onNavigate={setView} />}
            {view === 'inventory' && <InventoryView businessId={activeBusiness.id} userId={activeUser.id} onNavigate={setView} />}
            {view === 'journal' && <JournalView businessId={activeBusiness.id} userId={activeUser.id} onNavigate={setView} />}
            {view === 'accounts' && <AccountsView businessId={activeBusiness.id} userId={activeUser.id} onNavigate={setView} />}
            {view === 'stats' && <StatsView businessId={activeBusiness.id} userId={activeUser.id} onNavigate={setView} />}
            {view === 'reports' && <ReportsView businessId={activeBusiness.id} userId={activeUser.id} businessName={activeBusiness.name} />}
            {view === 'memory' && <MemoryView businessId={activeBusiness.id} userId={activeUser.id} onNavigate={setView} />}
            {view === 'settings' && <SettingsView businessId={activeBusiness.id} userId={activeUser.id} onNavigate={setView} />}
            <p className="hidden pt-8 text-center text-[11px] text-muted-foreground sm:block">
              وكيل — مساعد شغلك اليومي · كل عملية بتتحقق قبل ما تتسجل
            </p>
          </div>
        )}
      </main>

      {/* ===== footer (always pinned bottom via h-dvh flex) ===== */}
      <footer
        className="shrink-0 border-t border-border/70 bg-card/95 pb-[max(0.25rem,env(safe-area-inset-bottom))] backdrop-blur-md sm:hidden"
      >
        <nav aria-label="التنقل السريع" className="mx-auto grid max-w-5xl grid-cols-5">
          {MOBILE_NAV.map((key) => {
            const item = NAV_ITEMS.find((n) => n.key === key)!
            const Icon = item.icon
            const active = view === key
            return (
              <button
                key={key}
                onClick={() => setView(key)}
                aria-current={active ? 'page' : undefined}
                className={`press focus-warm flex min-h-[52px] flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-transform active:scale-95 ${
                  active ? 'text-primary' : 'text-muted-foreground'
                }`}
              >
                <Icon className={`size-5 transition-transform ${active ? 'scale-110' : ''}`} />
                {VIEW_LABELS[key]}
              </button>
            )
          })}
        </nav>
        <p className="sr-only">وكيل — مساعد شغلك اليومي</p>
      </footer>

      {/* desktop footer line */}
      <div className="hidden shrink-0 border-t border-border/60 bg-background py-2.5 text-center text-[11px] text-muted-foreground sm:block">
        وكيل — مساعد شغلك اليومي · كل عملية بتتحقق قبل ما تتسجل
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Notification list — overview.alerts rendered as actionable rows
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<AlertDTO['level'], number> = { danger: 0, warning: 1, info: 2 }

const NOTIF_META: Record<AlertDTO['level'], { icon: typeof Bell; circle: string; pulse: boolean }> = {
  danger: { icon: CircleAlert, circle: 'bg-destructive/10 text-destructive', pulse: true },
  warning: { icon: TriangleAlert, circle: 'bg-wakil-amber/15 text-wakil-amber', pulse: false },
  info: { icon: Info, circle: 'bg-wakil-navy/10 text-wakil-navy', pulse: false },
}

function NotificationList({
  alerts,
  onNavigate,
}: {
  alerts: AlertDTO[]
  onNavigate: (v: ViewKey) => void
}) {
  const sorted = useMemo(
    () => [...alerts].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]),
    [alerts],
  )

  if (sorted.length === 0) {
    return (
      <div className="list-enter flex flex-col items-center gap-2 px-6 py-10 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-wakil-teal/10 text-wakil-teal">
          <CheckCircle2 className="size-6" aria-hidden />
        </span>
        <p className="text-sm font-semibold">كل حاجة تمام</p>
        <p className="text-xs leading-relaxed text-muted-foreground">هنا هلاقي أي حاجة محتاجة انتباهك</p>
      </div>
    )
  }

  return (
    <ul className="space-y-1 p-2" aria-label="قائمة التنبيهات">
      {sorted.map((a, i) => {
        const meta = NOTIF_META[a.level] ?? NOTIF_META.info
        const Icon = meta.icon
        const view = safeView(a.action?.view)
        return (
          <motion.li
            key={`${a.level}-${a.text}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, delay: Math.min(i, 8) * 0.04, ease: 'easeOut' }}
            className="rounded-xl transition-colors hover:bg-muted/50"
          >
            <div className="flex items-start gap-3 px-3 py-2.5">
              <span
                className={cn(
                  'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full',
                  meta.circle,
                  meta.pulse && 'pulse-ring',
                )}
              >
                <Icon className="size-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs leading-5">{a.text}</p>
                {view && (
                  <button
                    type="button"
                    onClick={() => onNavigate(view)}
                    className="press focus-warm mt-1.5 inline-flex h-7 items-center gap-1 rounded-full border border-border px-2.5 text-[11px] font-medium transition-colors hover:bg-accent"
                  >
                    {a.action?.label}
                    <ChevronLeft className="size-3" aria-hidden />
                  </button>
                )}
              </div>
            </div>
          </motion.li>
        )
      })}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Business + user switcher dropdown
// ---------------------------------------------------------------------------
function BusinessSwitcher({
  businesses,
  active,
  onPick,
}: {
  businesses: BusinessLite[]
  active: BusinessLite
  onPick: (businessId: string, userId: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-10 gap-2 rounded-full px-2.5 font-bold transition-transform active:scale-95"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`تبديل المنشأة — الحالي ${active.name}`}
      >
        <AgentAvatar state="idle" size="sm" />
        <span className="max-w-32 truncate text-sm">{active.name}</span>
        <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </Button>
      {open && (
            <>
              <button className="fixed inset-0 z-40 cursor-default" aria-label="اقفل" onClick={() => setOpen(false)} />
              <motion.div
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 150 }}
              className="absolute start-3 z-50 mt-1.5 w-72 overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
            >
              {businesses.map((b) => {
                const v = getVertical(b.type)
                const isActive = b.id === active.id
                return (
                  <div key={b.id} className={`border-b border-border/50 last:border-0 ${isActive ? 'bg-accent/60' : ''}`}>
                    <button
                      onClick={() => {
                        onPick(b.id, b.users[0].id)
                        setOpen(false)
                      }}
                      className="focus-warm flex w-full items-center gap-2.5 px-3 py-2.5 text-start transition-colors hover:bg-accent"
                    >
                      <AgentAvatar state="idle" size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">{b.name}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">{v.shortLabel} · {v.description}</span>
                      </span>
                      {isActive && <Check className="size-4 shrink-0 text-wakil-amber" aria-hidden />}
                    </button>
                    <div className="flex flex-wrap gap-1 px-3 pb-2">
                      {b.users.map((u) => (
                        <button
                          key={u.id}
                          onClick={() => {
                            onPick(b.id, u.id)
                            setOpen(false)
                          }}
                          className="press focus-warm rounded-full border border-border bg-card px-2.5 py-1 text-[10px] hover:bg-accent"
                        >
                          {u.name} — {u.role === 'owner' ? 'صاحب المنشأة' : u.title ?? u.role}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </motion.div>
          </>
      )}
    </>
  )
}
