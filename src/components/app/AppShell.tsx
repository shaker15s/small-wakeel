// وكيل — AppShell: the app frame. Sticky footer, header with business/user
// switchers + dark mode + notification center, nav for the 9 views (sliding
// active pill), mobile bottom tab bar, and the cinematic first-run onboarding.
//
// R18 «آبل جلاس»: the CHAT view now goes FULL-BLEED — no header, no nav, no
// desktop footer line. The whole screen belongs to the conversation; its
// floating glass pill (inside ChatView) carries the business switcher, the
// quick actions, and a jump back to the app. All other views keep the
// classic chrome, now built from the shared BusinessMenu / NotificationBell
// (instant portal popovers — the «slow, covered dropdown» bug is gone).

'use client'

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  BarChart3,
  BookOpen,
  Boxes,
  Brain,
  FileText,
  LayoutGrid,
  MessageCircle,
  Moon,
  Search,
  Settings,
  Sun,
  Users,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import { api } from '@/lib/api'
import { QUERY_KEYS, useWakil, VIEW_LABELS, type ViewKey } from '@/lib/store'
import { getVertical } from '@/lib/verticals'
import type { BusinessLite } from '@/lib/types'
import { Button } from '@/components/ui/button'
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
import { BusinessMenu } from './BusinessMenu'
import { NotificationBell } from './NotificationBell'
import { openCommandPalette } from './CommandPalette'

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

  // alert-diffing memory (toasts on unseen danger texts)
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

  // — notification diffing: first load / business switch seeds silently; a
  // genuinely-new danger alert (unseen text) fires a destructive toast.
  useEffect(() => {
    if (!overview) return
    const sessionKey = `${businessId ?? '~'}|${userId ?? '~'}`
    const sessionChanged = prevSessionRef.current !== null && prevSessionRef.current !== sessionKey
    prevSessionRef.current = sessionKey
    if (sessionChanged) {
      for (const a of alerts) seenTextsRef.current.add(a.text)
      return
    }
    // genuinely-new danger alert (unseen text) → destructive toast.
    const newDangers = alerts.filter(
      (a) => a.level === 'danger' && !seenTextsRef.current.has(a.text),
    )
    for (const a of newDangers.slice(0, 2)) {
      toast({ title: 'تنبيه مهم', description: a.text, variant: 'destructive' })
    }
    for (const a of alerts) seenTextsRef.current.add(a.text)
  }, [overview, alerts, businessId, userId, toast])

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
  const isChat = view === 'chat'

  // ======================= CHAT — FULL BLEED =======================
  // No header / nav / desktop footer: the conversation owns the screen; its
  // floating glass pill carries the chrome. The mobile tab bar stays for
  // navigation (compact, at the very bottom).
  if (isChat) {
    return (
      <div className="flex h-dvh flex-col overflow-hidden bg-background">
        <main className="min-h-0 w-full flex-1 overflow-hidden">
          <ChatView
            business={activeBusiness}
            businesses={bootstrap.businesses}
            userId={activeUser.id}
            onNavigate={setView}
          />
        </main>

        <footer className="glass-strong shrink-0 border-t border-border/60 pb-[max(0.25rem,env(safe-area-inset-bottom))] sm:hidden">
          <nav aria-label="التنقل السريع" className="mx-auto grid w-full grid-cols-5">
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
      </div>
    )
  }

  // ======================= APP VIEWS (classic chrome) =======================
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      {/* ===== header ===== */}
      <header className="relative z-40 shrink-0 border-b border-border/70 bg-card/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-none items-center gap-2 px-3 sm:px-4">
          {/* business switcher — instant portal popover (R18) */}
          <BusinessMenu
            businesses={bootstrap.businesses}
            active={activeBusiness}
            onPick={(b, u) => setSession(b, u)}
          />

          <div className="ms-1 hidden min-w-0 flex-col sm:flex">
            <span className="truncate text-[11px] text-muted-foreground">{vertical.label}</span>
          </div>

          <div className="flex-1" />

          {/* بحث سريع — نفس البحث بيشتغل من أي شاشة (⌘K كمان) */}
          <Button
            variant="outline"
            onClick={openCommandPalette}
            className="h-9 gap-2 rounded-full px-3 text-xs text-muted-foreground"
            aria-label="بحث سريع في كل حاجة"
            title="بحث سريع (⌘K)"
          >
            <Search className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">بحث سريع</span>
            <span className="num hidden rounded bg-muted px-1.5 py-0.5 text-[10px] md:inline">⌘K</span>
          </Button>

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

          {/* notifications — shared bell (portal popover) */}
          <NotificationBell alerts={alerts} onNavigate={setView} className="size-10" />

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

        {/* desktop nav — active pill slides between views */}
        <nav
          aria-label="التنقل الرئيسي"
          className="scroll-warm mx-auto hidden w-full max-w-none gap-1 overflow-x-auto px-3 pb-2 sm:flex sm:px-4"
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

      {/* ===== main — other views scroll inside ===== */}
      <main className="mx-auto min-h-0 w-full max-w-none flex-1 overflow-hidden">
        <div className="scroll-warm h-full overflow-y-auto overflow-x-clip px-3 pb-24 pt-4 sm:px-0 sm:pb-10">
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
      </main>

      {/* ===== footer (always pinned bottom via h-dvh flex) ===== */}
      <footer className="glass-strong shrink-0 border-t border-border/60 pb-[max(0.25rem,env(safe-area-inset-bottom))] sm:hidden">
        <nav aria-label="التنقل السريع" className="mx-auto grid w-full grid-cols-5">
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
