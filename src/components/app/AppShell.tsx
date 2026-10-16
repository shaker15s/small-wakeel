// وكيل — AppShell: the app frame. Sticky footer, header with business/user
// switchers + dark mode + notifications badge, nav for the 8 views, mobile
// bottom tab bar, and the cinematic first-run onboarding.

'use client'

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  BarChart3,
  Bell,
  BookOpen,
  Boxes,
  ChevronDown,
  FileText,
  LayoutGrid,
  MessageCircle,
  Moon,
  Settings,
  Sun,
  Users,
  Wallet,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import { api } from '@/lib/api'
import { QUERY_KEYS, useWakil, VIEW_LABELS, type ViewKey } from '@/lib/store'
import { getVertical } from '@/lib/verticals'
import type { BusinessLite } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { ChatView } from '@/components/chat/ChatView'
import TodayView from '@/components/views/TodayView'
import InventoryView from '@/components/views/InventoryView'
import JournalView from '@/components/views/JournalView'
import AccountsView from '@/components/views/AccountsView'
import StatsView from '@/components/views/StatsView'
import ReportsView from '@/components/views/ReportsView'
import SettingsView from '@/components/views/SettingsView'
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
  { key: 'settings', icon: Settings },
]

const MOBILE_NAV: ViewKey[] = ['chat', 'today', 'inventory', 'journal', 'settings']

export function AppShell() {
  const { businessId, userId, view, setView, setSession, hydrate, onboardingDone, finishOnboarding } = useWakil()
  const { theme, setTheme } = useTheme()
  // SSR-safe mounted flag without setState-in-effect
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  )

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
  const alertsCount = (overview?.pendingOps.length ?? 0) + (overview?.alerts.filter((a) => a.level !== 'info').length ?? 0)

  // first run → onboarding
  if (mounted && !onboardingDone && bootstrap && bootstrap.businesses.length > 0) {
    return <Onboarding businesses={bootstrap.businesses} onFinish={finishOnboarding} onPick={setSession} />
  }

  if (!mounted || !bootstrap) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <AgentAvatar state="thinking" size="lg" />
          <p className="text-sm text-muted-foreground">وكيل بيجهز…</p>
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
    <div className="flex min-h-screen flex-col bg-background">
      {/* ===== header ===== */}
      <header className="sticky top-0 z-30 border-b border-border/70 bg-card/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-3 sm:px-4">
          {/* business switcher */}
          <div className="relative" data-business-switcher>
            <BusinessSwitcher businesses={bootstrap.businesses} active={activeBusiness} onPick={(b, u) => setSession(b, u)} />
          </div>

          <div className="ms-1 hidden min-w-0 flex-col sm:flex">
            <span className="truncate text-[11px] text-muted-foreground">{vertical.label}</span>
          </div>

          <div className="flex-1" />

          {/* notifications */}
          <Button
            variant="ghost"
            size="icon"
            className="relative size-10 rounded-full"
            aria-label={`${alertsCount} تنبيهات`}
            onClick={() => setView('today')}
          >
            <Bell className="size-4.5" />
            {alertsCount > 0 && (
              <span className="absolute -end-0.5 -top-0.5 flex size-5 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-white">
                {alertsCount > 9 ? '٩+' : alertsCount}
              </span>
            )}
          </Button>

          {/* dark mode */}
          <Button
            variant="ghost"
            size="icon"
            className="size-10 rounded-full"
            aria-label="تبديل الوضع الليلي"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? <Sun className="size-4.5" /> : <Moon className="size-4.5" />}
          </Button>
        </div>

        {/* desktop nav */}
        <nav aria-label="التنقل الرئيسي" className="mx-auto hidden max-w-5xl gap-1 px-3 pb-2 sm:flex sm:px-4">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const active = view === item.key
            return (
              <button
                key={item.key}
                onClick={() => setView(item.key)}
                aria-current={active ? 'page' : undefined}
                className={`press flex h-9 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium transition-colors ${
                  active
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                }`}
              >
                <Icon className="size-3.5" />
                {VIEW_LABELS[item.key]}
              </button>
            )
          })}
        </nav>
      </header>

      {/* ===== main ===== */}
      <main className="mx-auto w-full max-w-5xl flex-1 px-0 pb-20 pt-0 sm:px-4 sm:pb-4 sm:pt-4">
        {/* chat is edge-to-edge on mobile with its own padding */}
        <div className={view === 'chat' ? 'h-[calc(100dvh-56px-64px)] sm:h-[calc(100dvh-56px-44px-1rem)]' : ''}>
          {view === 'chat' && <ChatView business={activeBusiness} userId={activeUser.id} />}
        </div>
        {view !== 'chat' && (
          <div className="px-3 sm:px-0">
            {view === 'today' && <TodayView businessId={activeBusiness.id} userId={activeUser.id} onNavigate={setView} />}
            {view === 'inventory' && <InventoryView businessId={activeBusiness.id} userId={activeUser.id} onNavigate={setView} />}
            {view === 'journal' && <JournalView businessId={activeBusiness.id} userId={activeUser.id} onNavigate={setView} />}
            {view === 'accounts' && <AccountsView businessId={activeBusiness.id} userId={activeUser.id} onNavigate={setView} />}
            {view === 'stats' && <StatsView businessId={activeBusiness.id} userId={activeUser.id} onNavigate={setView} />}
            {view === 'reports' && <ReportsView businessId={activeBusiness.id} userId={activeUser.id} businessName={activeBusiness.name} />}
            {view === 'settings' && <SettingsView businessId={activeBusiness.id} userId={activeUser.id} onNavigate={setView} />}
          </div>
        )}
      </main>

      {/* ===== footer (sticky bottom) ===== */}
      <footer className="mt-auto border-t border-border/70 bg-card/80 py-2 backdrop-blur-md sm:hidden">
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
                className={`press flex min-h-[52px] flex-col items-center justify-center gap-0.5 text-[10px] font-medium ${
                  active ? 'text-primary' : 'text-muted-foreground'
                }`}
              >
                <Icon className="size-5" />
                {VIEW_LABELS[key]}
              </button>
            )
          })}
        </nav>
        <p className="sr-only">وكيل — مساعد شغلك اليومي</p>
      </footer>

      {/* desktop footer line */}
      <div className="hidden border-t border-border/60 bg-background py-3 text-center text-[11px] text-muted-foreground sm:block">
        وكيل — مساعد شغلك اليومي · كل عملية بتتحقق قبل ما تتسجل
      </div>
    </div>
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
        className="h-10 gap-2 rounded-full px-2.5 font-bold"
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
                      className="flex w-full items-center gap-2.5 px-3 py-2.5 text-start transition-colors hover:bg-accent"
                    >
                      <AgentAvatar state="idle" size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">{b.name}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">{v.shortLabel} · {v.description}</span>
                      </span>
                    </button>
                    <div className="flex flex-wrap gap-1 px-3 pb-2">
                      {b.users.map((u) => (
                        <button
                          key={u.id}
                          onClick={() => {
                            onPick(b.id, u.id)
                            setOpen(false)
                          }}
                          className="press rounded-full border border-border bg-card px-2.5 py-1 text-[10px] hover:bg-accent"
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
