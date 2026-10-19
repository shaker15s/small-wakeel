'use client'

// وكيل — shared plumbing for the 7 view screens.
// NOTE: TYPE_AR/STATUS_AR are client-safe copies of the maps in lib/agent/tools.
// Importing '@/lib/agent/tools' from a client component would drag Prisma into
// the browser bundle (verified empirically — index-browser.js shim leaks into
// the client chunk). Values are kept identical; see worklog deviation note.

import type { LucideIcon } from 'lucide-react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'

import { AgentAvatar } from '@/components/chat/AgentAvatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { OpStatus, OpType, Risk } from '@/lib/types'
import type { ViewKey } from '@/lib/store'
import { VIEW_LABELS } from '@/lib/store'
import { egp, egpPlain } from '@/lib/format'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Props contract
// ---------------------------------------------------------------------------

export interface ViewProps {
  businessId: string
  userId: string
  onNavigate?: (v: ViewKey) => void
}

/** Parse an alert action `view` string into a safe ViewKey (null if unknown). */
export function safeView(view?: string | null): ViewKey | null {
  if (!view) return null
  return view in VIEW_LABELS ? (view as ViewKey) : null
}

// ---------------------------------------------------------------------------
// Arabic label maps (client-safe)
// ---------------------------------------------------------------------------

export const TYPE_AR: Record<OpType, string> = {
  debt_promise: 'تعديل وعد السداد',
  cashbook: 'دفتر الكاش والآجل',
  sale: 'بيع',
  purchase: 'شرا',
  expense: 'مصروف',
  collection: 'تحصيل',
  payment: 'سداد',
  stock_adjustment: 'تسوية مخزون',
  membership: 'اشتراك',
  attendance: 'حضور',
  customer_add: 'عميل جديد',
  supplier_add: 'مورد جديد',
  price_change: 'تغيير سعر',
  reversal: 'عكس عملية',
}

export const STATUS_AR: Record<OpStatus, string> = {
  RECEIVED: 'مستلمة',
  AWAITING_APPROVAL: 'مستنية اعتماد',
  EXECUTING: 'بتتنفذ',
  SUCCEEDED: 'تم — موثّق ومتحقق',
  FAILED_SAFE: 'فشلت بأمان',
  OUTCOME_UNKNOWN: 'نتيجة غير محسومة',
  CANCELLED: 'ملغاة',
}

export const RISK_AR: Record<Risk, string> = {
  R0: 'آمنة',
  R1: 'بسيطة',
  R2: 'محتاجة اعتماد',
  R3: 'حساسة',
  R4: 'ممنوعة',
}

export const TIER_AR: Record<string, string> = {
  air: 'خفيف',
  balanced: 'متوازن',
  deep: 'عميق',
}

export const TASK_STATUS_AR: Record<string, string> = {
  pending: 'مستنية',
  done: 'تمت',
  failed: 'فشلت',
  cancelled: 'ملغاة',
}

/** Read tools the tasks API accepts (must match READ_TOOLS in api/tasks/route.ts). */
export const READ_TOOL_AR: Record<string, string> = {
  get_daily_summary: 'ملخص اليوم',
  get_cash_position: 'وضع الخزنة',
  list_low_stock: 'المخزون الناقص',
  list_expiring: 'الأصناف قربت تخلص',
  list_receivables: 'مديونيات العملاء',
  list_payables: 'مستحقات الموردين',
  get_activity_history: 'آخر الحركات',
  analyze_profitability: 'تحليل الربحية والهوامش',
  forecast_stock: 'تنبؤ المخزون ومعدل السحب',
  get_proactive_insights: 'رادار التنبيهات والفرص',
}

export const RECURRENCE_AR: Record<string, string> = {
  daily: 'يومي',
  weekly: 'أسبوعي',
  monthly: 'شهري',
}

export const arNum = (n: number): string => new Intl.NumberFormat('ar-EG').format(n)

// ---------------------------------------------------------------------------
// Count-up — a KPI number that MEASURES itself into place (easeOutQuart,
// ~650ms). Reduced-motion users get the final value instantly. Re-animates
// from the previous value when the target changes, so refetches read as
// «the number moved», not as a page repaint.
// ---------------------------------------------------------------------------
function useCountUp(target: number, duration = 650): number {
  const reduced = useReducedMotion()
  const [val, setVal] = useState(target)
  const fromRef = useRef(target)
  const first = useRef(true)
  useEffect(() => {
    if (reduced || duration <= 0) {
      fromRef.current = target
      setVal(target)
      return
    }
    // first paint starts from zero — the number is «counted in»
    const from = first.current ? 0 : fromRef.current
    first.current = false
    const t0 = performance.now()
    let raf = 0
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / duration)
      const e = 1 - Math.pow(1 - p, 4)
      const v = from + (target - from) * e
      setVal(v)
      if (p < 1) raf = requestAnimationFrame(tick)
      else fromRef.current = target
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, duration, reduced])
  return val
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export function Money({
  value,
  plain = false,
  className,
}: {
  value: number
  plain?: boolean
  className?: string
}) {
  return (
    <span className={cn('num tabular-nums', className)}>
      {plain ? egpPlain(value) : egp(value)}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

const RISK_TONE: Record<Risk, string> = {
  R0: 'bg-secondary text-secondary-foreground',
  R1: 'bg-wakil-teal/10 text-wakil-teal',
  R2: 'bg-wakil-amber/15 text-wakil-amber',
  R3: 'bg-destructive/10 text-destructive',
  R4: 'bg-destructive text-white',
}

export function RiskBadge({ risk, withLabel = false }: { risk: Risk; withLabel?: boolean }) {
  return (
    <Badge
      className={cn('font-mono text-[10px]', RISK_TONE[risk])}
      title={`درجة الخطورة: ${RISK_AR[risk] ?? risk}`}
    >
      {risk}
      {withLabel ? ` · ${RISK_AR[risk]}` : null}
    </Badge>
  )
}

export const STATUS_TONE: Record<OpStatus, string> = {
  SUCCEEDED: 'border-wakil-teal/25 bg-wakil-teal/10 text-wakil-teal',
  AWAITING_APPROVAL: 'border-wakil-amber/30 bg-wakil-amber/10 text-wakil-amber',
  EXECUTING: 'border-wakil-navy/25 bg-wakil-navy/10 text-wakil-navy',
  FAILED_SAFE: 'border-destructive/25 bg-destructive/10 text-destructive',
  OUTCOME_UNKNOWN: 'border-wakil-amber/30 bg-wakil-amber/10 text-wakil-amber',
  CANCELLED: 'border-border bg-muted text-muted-foreground',
  RECEIVED: 'border-border bg-muted text-muted-foreground',
}

export function StatusBadge({ status }: { status: OpStatus }) {
  return (
    <Badge variant="outline" className={cn('text-[10px]', STATUS_TONE[status])}>
      {STATUS_AR[status]}
    </Badge>
  )
}

export function TypeBadge({ type }: { type: OpType }) {
  return <Badge variant="secondary" className="text-[10px]">{TYPE_AR[type]}</Badge>
}

export function TierBadge({ tier }: { tier: string }) {
  const tone =
    tier === 'air'
      ? 'bg-wakil-amber/10 text-wakil-amber'
      : tier === 'deep'
        ? 'bg-wakil-teal/10 text-wakil-teal'
        : 'bg-wakil-navy/10 text-wakil-navy'
  return <Badge className={cn('text-[10px]', tone)}>{TIER_AR[tier] ?? tier}</Badge>
}

// ---------------------------------------------------------------------------
// KPI card — fixed h-24 so loading skeletons never shift the layout
// ---------------------------------------------------------------------------

export type KpiTone = 'teal' | 'amber' | 'navy' | 'red' | 'muted'

const KPI_ICON_BG: Record<KpiTone, string> = {
  teal: 'bg-wakil-teal/10',
  amber: 'bg-wakil-amber/10',
  navy: 'bg-wakil-navy/10',
  red: 'bg-destructive/10',
  muted: 'bg-muted',
}

const KPI_HAIRLINE: Record<KpiTone, string> = {
  teal: 'via-wakil-teal/50',
  amber: 'via-wakil-amber/60',
  navy: 'via-wakil-navy/40',
  red: 'via-destructive/50',
  muted: 'via-border',
}

const KPI_TONE_TEXT: Record<KpiTone, string> = {
  teal: 'text-wakil-teal',
  amber: 'text-wakil-amber',
  navy: 'text-wakil-navy',
  red: 'text-destructive',
  muted: 'text-muted-foreground',
}

export function KpiCard({
  label,
  value,
  icon: Icon,
  tone = 'navy',
  title,
  index,
  rawValue,
  formatValue,
}: {
  label: string
  value: React.ReactNode
  icon: LucideIcon
  tone?: KpiTone
  title?: string
  /** position in the grid — staggers the enter animation by 40ms */
  index?: number
  /** when given (with formatValue), the number counts itself into place */
  rawValue?: number
  formatValue?: (n: number) => string
}) {
  const animated = rawValue != null && formatValue
  const counted = useCountUp(rawValue ?? 0)
  return (
    <div
      className={cn(
        'surface surface-lift group relative flex h-24 flex-col justify-between overflow-hidden rounded-xl p-4 sm:h-28 sm:p-5',
        index != null ? 'list-enter' : 'card-enter',
      )}
      style={index != null ? { animationDelay: `${index * 40}ms` } : undefined}
      title={title}
    >
      <span
        aria-hidden
        className={cn('pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-l from-transparent to-transparent', KPI_HAIRLINE[tone])}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground sm:text-[13px]">{label}</span>
        <span
          className={cn(
            'icon-wiggle icon-seat-tinted size-8 shrink-0 transition-transform duration-200 group-hover:scale-110',
            KPI_ICON_BG[tone],
          )}
        >
          <Icon className={cn('size-4', KPI_TONE_TEXT[tone])} aria-hidden />
        </span>
      </div>
      <div
        className={cn(
          'num truncate text-xl font-bold leading-none tracking-tight tabular-nums sm:text-[1.7rem]',
          KPI_TONE_TEXT[tone],
        )}
      >
        {animated ? formatValue!(counted) : value}
      </div>
    </div>
  )
}

export function LoadingKpis({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4" aria-busy="true" aria-label="بيتحمّل">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skel h-24 rounded-xl sm:h-28" />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Error / empty states — never blank, always friendly Arabic
// ---------------------------------------------------------------------------

export function ErrorState({
  message,
  onRetry,
}: {
  message?: string
  onRetry?: () => void
}) {
  return (
    <Card className="border-destructive/30">
      <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertCircle className="size-5" aria-hidden />
        </span>
        <div className="space-y-1">
          <p className="font-semibold">مش قادرين نجيب البيانات</p>
          <p className="text-sm text-muted-foreground">{message ?? 'حصلت مشكلة في الاتصال'}</p>
        </div>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry} className="min-h-10">
            <RefreshCw aria-hidden /> جرّب تاني
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

export function EmptyState({
  icon: Icon,
  title = 'مفيش لحد دلوقتي',
  hint,
  mascot = false,
  className,
}: {
  icon: LucideIcon
  title?: string
  hint?: string
  /** render the وكيل mascot (idle) instead of the icon bubble */
  mascot?: boolean
  className?: string
}) {
  const reduced = useReducedMotion()
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/30 px-4 py-8 text-center',
        className,
      )}
    >
      {mascot ? (
        <MascotBubble />
      ) : (
        <motion.span
          animate={reduced ? undefined : { y: [0, -3, 0] }}
          transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
          className="flex size-11 items-center justify-center rounded-full bg-accent text-wakil-amber"
        >
          <Icon className="size-5" aria-hidden />
        </motion.span>
      )}
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
        {hint ?? 'قول لوكيل في المحادثة وهو يجهزهالك'}
      </p>
    </motion.div>
  )
}

/** وكيل himself, idling in the empty state — a gentle float, no spin. */
function MascotBubble() {
  const reduced = useReducedMotion()
  return (
    <motion.span
      animate={reduced ? undefined : { y: [0, -4, 0] }}
      transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
      className="flex items-center justify-center rounded-full"
    >
      <AgentAvatar state="idle" size="sm" />
    </motion.span>
  )
}

// ---------------------------------------------------------------------------
// Section card — titled block used across views
// ---------------------------------------------------------------------------

const ACCENT_HAIRLINE: Record<Accent, string> = {
  amber: 'from-wakil-amber/70',
  teal: 'from-wakil-teal/70',
  danger: 'from-destructive/70',
}

export type Accent = 'amber' | 'teal' | 'danger'

export function SectionCard({
  title,
  subtitle,
  icon: Icon,
  action,
  accent,
  children,
  className,
}: {
  title: string
  /** optional muted line under the title (e.g. radar exclusivity note) */
  subtitle?: string
  icon?: LucideIcon
  action?: React.ReactNode
  /** optional gradient hairline on the card's top edge */
  accent?: Accent
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        'card-enter card-sheen surface rounded-xl',
        accent && 'relative overflow-hidden',
        className,
      )}
    >
      {accent && (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-l to-transparent',
            ACCENT_HAIRLINE[accent],
          )}
        />
      )}
      <div className="flex items-start justify-between gap-2 border-b px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            {Icon ? (
              <span className="icon-seat-tinted size-6 shrink-0 bg-wakil-amber/10 text-wakil-amber">
                <Icon className="size-3.5" aria-hidden />
              </span>
            ) : null}
            <h2 className="truncate text-[15px] font-bold tracking-tight">{title}</h2>
          </div>
          {subtitle && (
            <p className="mt-0.5 ps-6 text-xs leading-relaxed text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {action}
      </div>
      <div className="p-4 sm:p-6">{children}</div>
    </section>
  )
}

/**
 * The one page container.
 *
 * The app shell is full-bleed (`h-dvh`, no max-width), but every screen used to
 * cap itself at `max-w-5xl` — so on a laptop the owner got a phone-sized column
 * with two dead gutters. One shared container means the content uses the whole
 * screen on a 27" monitor and still breathes on a phone, and no screen can drift
 * out of alignment with the others.
 */
export const PAGE = 'mx-auto w-full max-w-[1800px] space-y-4 px-3 pb-10 pt-2 sm:space-y-5 sm:px-6 xl:space-y-6 xl:px-10'
export const PAGE_PLAIN = 'mx-auto w-full max-w-[1800px] px-3 pb-10 pt-2 sm:px-6 xl:px-10'

export function ViewHeader({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle?: string
  action?: React.ReactNode
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3 pb-1">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="h-7 w-1 shrink-0 rounded-full bg-gradient-to-b from-wakil-amber to-wakil-amber/30 sm:h-8"
          />
          <h1 className="text-[1.6rem] font-bold leading-tight tracking-tight sm:text-3xl">{title}</h1>
        </div>
        {subtitle && <p className="mt-1.5 ps-3.5 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {action}
    </header>
  )
}
