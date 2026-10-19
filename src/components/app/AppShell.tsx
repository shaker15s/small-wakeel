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
  Settings,
  Sun,
  Users,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import { api } from '@/lib/api'
import { ACCENTS, DEFAULT_WORKSPACE } from '@/lib/workspace-options'
import { AccountNotice } from './AccountNotice'
import { AccessGate } from './AccessGate'
import { QUERY_KEYS, useWakil, VIEW_LABELS, type ViewKey } from '@/lib/store'
import { getVertical } from '@/lib/verticals'
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
import { CommandPalette } from './CommandPalette'
import { BusinessBuilderModal } from './BusinessBuilderModal'
import { PluginAndTaskStudioModal } from './PluginAndTaskStudioModal'
import { sfx } from '@/lib/sound-effects'
import { Camera, Command, Cpu, PlusCircle, Volume2, VolumeX } from 'lucide-react'

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
  const {
    businessId,
    userId,
    view,
    setView,
    setSession,
    hydrate,
    onboardingDone,
    finishOnboarding,
    reopenOnboarding,
    soundEnabled,
    toggleSound,
    setCommandPaletteOpen,
    setBusinessBuilderOpen,
    setPluginStudioOpen,
  } = useWakil()
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

  const { data: bootstrap, error: bootstrapError, refetch: retryBootstrap } = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => api.bootstrap(),
    staleTime: 60_000,
  })

  useEffect(() => {
    const nextBusiness = bootstrap?.businesses.find((b) => b.id === businessId) ?? bootstrap?.businesses[0]
    const nextUser = nextBusiness?.users.find((u) => u.id === userId) ?? nextBusiness?.users[0]
    if (nextBusiness && nextUser && (businessId !== nextBusiness.id || userId !== nextUser.id)) {
      setSession(nextBusiness.id, nextUser.id)
    }
  }, [bootstrap, businessId, userId, setSession])

  // pending approvals count → notification badge
  const business = useMemo(
    () => bootstrap?.businesses.find((b) => b.id === businessId) ?? bootstrap?.businesses[0],
    [bootstrap, businessId],
  )
  const user = useMemo(
    () => business?.users.find((u) => u.id === userId) ?? business?.users[0],
    [business, userId],
  )

  const [deferredSetup, setDeferredSetup] = useState<string | null>(null)
  const actorKey = business && user ? `${business.id}|${user.id}` : null
  const workspace = useQuery({
    queryKey: ['workspace-preferences', business?.id, user?.id],
    queryFn: () => api.workspacePreferences(business!.id, user!.id),
    enabled: !!business && !!user,
  })
  const modelPreferenceRef = useRef<string | null>(null)
  useEffect(() => {
    const profile = workspace.data ?? DEFAULT_WORKSPACE
    document.documentElement.style.setProperty('--analytics-accent', ACCENTS[profile.accent])
    document.documentElement.dataset.workspaceDensity = profile.density
    const key = `${actorKey}|${profile.responseMode}`
    if (workspace.data && modelPreferenceRef.current !== key) {
      modelPreferenceRef.current = key
      useWakil.getState().setModel(profile.responseMode === 'deep' ? 'gemini-pro' : 'gemini-flash')
    }
    return () => {
      document.documentElement.style.removeProperty('--analytics-accent')
      delete document.documentElement.dataset.workspaceDensity
    }
  }, [workspace.data, actorKey])

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

  if (mounted && bootstrapError) {
    return <AccessGate error={bootstrapError} onRetry={() => { void retryBootstrap() }} />
  }

  // first run → onboarding
  if (mounted && bootstrap && bootstrap.businesses.length > 0 && deferredSetup !== actorKey && (!onboardingDone || workspace.data?.onboardingComplete === false)) {
    return <><AccountNotice onSettings={() => { setDeferredSetup(actorKey); finishOnboarding(); setView('settings') }} /><Onboarding key={actorKey} businesses={bootstrap.businesses} initial={workspace.data} onFinish={finishOnboarding} onPick={setSession} onDefer={() => { setDeferredSetup(actorKey); finishOnboarding(); setView('settings') }} /></>
  }

  if (!mounted || !bootstrap) {
    return (
      <div suppressHydrationWarning className="flex min-h-screen items-center justify-center bg-background">
        <div suppressHydrationWarning className="flex flex-col items-center gap-3">
          <AgentAvatar state="thinking" size="lg" />
          <p className="shimmer-text text-sm font-medium">وكيل بيجهز…</p>
        </div>
      </div>
    )
  }

  const activeBusiness = business ?? bootstrap.businesses[0]
  const activeUser = user ?? activeBusiness?.users[0]
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
        <AccountNotice onSettings={() => setView('settings')} />
        <CommandPalette business={activeBusiness} businesses={bootstrap.businesses} userId={activeUser.id} />
        <BusinessBuilderModal />
        <PluginAndTaskStudioModal />
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
                    className={`press focus-warm relative flex min-h-[52px] flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors active:scale-95 ${
                      active ? 'text-primary' : 'text-muted-foreground'
                    }`}
                  >
                    {active ? (
                      <motion.span
                        layoutId="mobile-tab-pill"
                        transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                        className="absolute top-1.5 flex h-7 items-center justify-center rounded-full bg-primary/10 px-3"
                        aria-hidden
                      />
                    ) : null}
                    <span className="relative flex h-7 items-center justify-center">
                      <Icon className={`relative size-5 transition-transform duration-200 ${active ? 'scale-110' : ''}`} />
                    </span>
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
        <AccountNotice onSettings={() => setView('settings')} />
      <CommandPalette business={activeBusiness} businesses={bootstrap.businesses} userId={activeUser.id} />
      <BusinessBuilderModal />
      <PluginAndTaskStudioModal />
      {/* ===== header ===== */}
      <header className="glass-strong relative z-40 shrink-0 border-b border-border/70">
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

          {/* Plugin Harness & Concurrent Background Tasks trigger */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPluginStudioOpen(true, 'plugins')}
            className="press h-9 gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-primary border-primary/25 bg-primary/5 hover:bg-primary/10"
            title="منصة البلاجنز الذكية والمهام الخلفية المتوازية"
          >
            <Cpu className="size-3.5 text-primary" />
            <span className="hidden lg:inline">البلاجنز والمهام المتوازية</span>
          </Button>

          {/* Superpower Command Palette trigger */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCommandPaletteOpen(true)}
            className="press h-9 gap-1.5 rounded-lg px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
            title="لوحة أوامر وكيل السريعة (Ctrl+K)"
          >
            <Command className="size-3.5 text-primary" />
            <span className="hidden md:inline">لوحة الأوامر</span>
            <kbd className="hidden sm:inline-block rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
          </Button>

          {/* Live Multimodal Onboarding Studio trigger */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              sfx.playPop(580, 0.03)
              reopenOnboarding()
            }}
            className="press h-9 gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-wakil-amber hover:bg-wakil-amber/10"
            title="جلسة التأسيس الحية (كاميرا مباشر + كشكول + صوت)"
          >
            <Camera className="size-3.5" />
            <span className="hidden md:inline">جلسة التأسيس الحية</span>
          </Button>

          {/* Dynamic Business Builder trigger */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setBusinessBuilderOpen(true)}
            className="press h-9 gap-1 rounded-lg px-2.5 text-xs font-semibold text-primary hover:bg-primary/10"
            title="إنشاء نشاط تجاري جديد"
          >
            <PlusCircle className="size-3.5" />
            <span className="hidden sm:inline">نشاط جديد</span>
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

          {/* sound effects mute/unmute toggle */}
          <Button
            variant="ghost"
            size="icon"
            className="size-10 rounded-full transition-transform active:scale-90"
            aria-label={soundEnabled ? 'كتم المؤثرات الصوتية' : 'تفعيل المؤثرات الصوتية'}
            title={soundEnabled ? 'كتم المؤثرات الصوتية' : 'تفعيل المؤثرات الصوتية'}
            onClick={() => {
              toggleSound()
              sfx.setEnabled(!soundEnabled)
            }}
          >
            {soundEnabled ? (
              <Volume2 className="size-4.5 text-wakil-amber" />
            ) : (
              <VolumeX className="size-4.5 text-muted-foreground" />
            )}
          </Button>

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
                    className="absolute inset-0 -z-10 rounded-full shadow-[0_4px_14px_-4px_rgb(24_47_82/0.5)] [background:linear-gradient(135deg,var(--primary),color-mix(in_oklab,var(--primary)_70%,var(--wakil-amber)))]"
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
          <motion.div
            key={view}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          >
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
          </motion.div>
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
                  className={`press focus-warm relative flex min-h-[52px] flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors active:scale-95 ${
                    active ? 'text-primary' : 'text-muted-foreground'
                  }`}
                >
                  {active ? (
                    <motion.span
                      layoutId="mobile-tab-pill"
                      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                      className="absolute top-1.5 flex h-7 items-center justify-center rounded-full bg-primary/10 px-3"
                      aria-hidden
                    />
                  ) : null}
                  <span className="relative flex h-7 items-center justify-center">
                    <Icon className={`relative size-5 transition-transform duration-200 ${active ? 'scale-110' : ''}`} />
                  </span>
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
