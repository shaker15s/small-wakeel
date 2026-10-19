'use client'

// وكيل — ActionCard: the draft-operation card the user approves or cancels.
// Renders fields, expected effects, risk ladder, R3 mandatory reason, and the
// post-execution verification (checks + verified effects + fail reason).

import { useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { motion } from 'framer-motion'
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Eye,
  Inbox,
  Info,
  Loader2,
  ShieldCheck,
  Sparkles,
  XCircle,
} from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { RISK_META } from '@/lib/domain/risk'
import { cn } from '@/lib/utils'
import type { ActionCardDTO } from '@/lib/types'

// NOTE: TYPE_AR / STATUS_AR are duplicated from lib/agent/tools.ts because
// tools.ts imports the Prisma client (server-only) and would break the client
// bundle. Keep the values in sync with tools.ts (single source: lib).
const TYPE_AR: Record<string, string> = {
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
  reversal: 'عكس عملية',
}

const STATUS_AR: Record<string, string> = {
  RECEIVED: 'مستلمة',
  AWAITING_APPROVAL: 'مستنية اعتماد',
  EXECUTING: 'بتتنفذ',
  SUCCEEDED: 'تم — موثّق ومتحقق',
  FAILED_SAFE: 'فشلت بأمان',
  OUTCOME_UNKNOWN: 'نتيجة غير محسومة',
  CANCELLED: 'ملغاة',
}

/** Post-execution verification payload (mirrors confirm API outcome). */
export interface ActionCardOutcome {
  ok: boolean
  checks: { label: string; expected: string; actual: string; pass: boolean }[]
  effects: { label: string; value: string; tone: string }[]
  failReason?: string
}

const STATUS_LOOK: Record<string, { icon: LucideIcon; cls: string; spin?: boolean }> = {
  SUCCEEDED: {
    icon: CheckCircle2,
    cls: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-400',
  },
  FAILED_SAFE: {
    icon: XCircle,
    cls: 'border-red-200 bg-red-50 text-destructive dark:border-destructive/40 dark:bg-destructive/10',
  },
  CANCELLED: { icon: Ban, cls: 'border-border bg-muted text-muted-foreground' },
  EXECUTING: {
    icon: Loader2,
    spin: true,
    cls: 'border-amber-300/60 bg-accent text-accent-foreground dark:border-amber-500/30',
  },
  OUTCOME_UNKNOWN: { icon: Info, cls: 'border-border bg-muted text-muted-foreground' },
  RECEIVED: { icon: Inbox, cls: 'border-border bg-muted text-muted-foreground' },
}

function toneClass(tone?: string): string {
  switch (tone) {
    case 'good':
      return 'text-emerald-700 dark:text-emerald-400'
    case 'bad':
      return 'text-destructive'
    default:
      return 'text-foreground'
  }
}

/** Wrap every digit-run in a .num span so numbers stay LTR inside RTL text. */
function withNums(text: string): React.ReactNode {
  if (!text) return text
  const parts = text.split(
    /([\u0660-\u0669\u066B\u066C\u06F0-\u06F9][\u0660-\u0669\u066B\u066C\u06F0-\u06F9.,]*|\d[\d.,]*)/g,
  )
  if (parts.length === 1) return text
  return parts.map((p, i) =>
    i % 2 === 1 && p ? <span key={i} className="num">{p}</span> : p,
  )
}

export function ActionCard({
  card,
  onApprove,
  onReject,
  busy,
  outcome,
}: {
  card: ActionCardDTO
  onApprove?: (reason?: string) => void
  onReject?: (reason?: string) => void
  busy?: boolean
  outcome?: ActionCardOutcome
}) {
  const [reason, setReason] = useState('')
  const risk = RISK_META[card.risk]
  const needsReason = card.risk === 'R3'
  const reasonOk = !needsReason || reason.trim().length >= 3
  const showActions = !outcome && card.status === 'AWAITING_APPROVAL' && !!onApprove

  const look = card.status !== 'AWAITING_APPROVAL' ? STATUS_LOOK[card.status] : undefined
  // «تأمل وكيل» flagged something dangerous → the card itself signals it.
  const hasDanger = (card.audit ?? []).some((f) => f.severity === 'danger')
  const StatusIcon = look?.icon

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="w-full"
    >
      {/* A draft whose audit found something dangerous breathes for attention:
          the owner should not approve a flagged draft by muscle memory. */}
      <Card
        className={cn(
          'w-full gap-3 py-4',
          hasDanger && 'attention border-destructive/40',
        )}
      >
        {StatusIcon && (
          <div
            role="status"
            className={cn(
              'mx-4 flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium',
              look?.cls,
            )}
          >
            <StatusIcon className={cn('size-4 shrink-0', look?.spin && 'animate-spin')} aria-hidden="true" />
            {STATUS_AR[card.status] ?? card.status}
          </div>
        )}

        <CardContent className="flex flex-col gap-3 px-4">
          {/* header: type + title + risk */}
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="text-xs">
              {TYPE_AR[card.type] ?? card.type}
            </Badge>
            <h3 className="min-w-0 flex-1 basis-24 text-sm font-semibold leading-6">{card.title}</h3>
            <Badge
              variant="outline"
              className={cn('text-[11px]', risk?.color)}
              title={risk?.hint}
            >
              <span className="num">{card.risk}</span>
              <span>{risk?.label}</span>
            </Badge>
          </div>

          {/* ref + summary */}
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="num rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              {card.ref}
            </span>
            <p className="min-w-0 flex-1 text-sm leading-6 text-muted-foreground">{card.summary}</p>
          </div>

          {/* fields */}
          {card.fields.length > 0 && (
            <dl className="flex flex-col">
              {card.fields.map((f, i) => (
                <div
                  key={`${f.label}-${i}`}
                  className={cn(
                    'grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-x-3 gap-y-1 py-2',
                    i < card.fields.length - 1 && 'border-b border-border/60',
                  )}
                >
                  <dt className="min-w-0 break-words text-sm text-muted-foreground">
                    {f.label}
                    {f.hint ? <span className="mt-1 block text-[11px] leading-5 opacity-70">{f.hint}</span> : null}
                  </dt>
                  <dd className="min-w-0 break-words text-end text-sm font-semibold">{/^\d{4}-\d{2}-\d{2}$/.test(f.value) ? <bdi dir="ltr" className="inline-block whitespace-nowrap">{f.value}</bdi> : withNums(f.value)}</dd>
                </div>
              ))}
            </dl>
          )}

          {/* expected effects */}
          {card.effects.length > 0 && (
            <div className="flex flex-col gap-1 rounded-lg bg-muted/50 p-2.5">
              <span className="text-xs font-medium text-muted-foreground">الأثر المتوقع</span>
              {card.effects.map((e, i) => (
                <div
                  key={`${e.label}-${i}`}
                  className="flex items-baseline justify-between gap-3 text-sm"
                >
                  <span className="text-muted-foreground">{e.label}</span>
                  <span className={cn('font-semibold', toneClass(e.tone))}>{withNums(e.value)}</span>
                </div>
              ))}
            </div>
          )}

          {/* danger note */}
          {card.dangerNote && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-amber-300/70 bg-accent p-2.5 text-sm text-accent-foreground dark:border-amber-500/30"
            >
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-[var(--wakil-amber)]"
                aria-hidden="true"
              />
              <p className="leading-6">{card.dangerNote}</p>
            </div>
          )}

          {/* «تأمل وكيل» — the deterministic self-critique, shown BEFORE approval.
              The owner should see the doubt at the moment he decides, not after
              the money moved. */}
          {card.audit && card.audit.length > 0 && (
            <section
              className="enter-rise rounded-lg border border-border/70 bg-muted/40 p-2.5"
              aria-label="تأمل وكيل على المسودة"
            >
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                <Sparkles className="size-3.5 text-wakil-amber" aria-hidden="true" />
                تأمل وكيل · <span className="num">{card.audit.length}</span> ملاحظة قبل الاعتماد
              </p>
              <ul className="flex flex-col gap-1.5">
                {card.audit.map((f, i) => (
                  <li
                    key={`${f.code}-${i}`}
                    className="finding-enter flex items-start gap-2 text-xs leading-5"
                    style={{ animationDelay: `${i * 45}ms` }}
                  >
                    <span
                      className={cn(
                        'mt-1 size-1.5 shrink-0 rounded-full',
                        f.severity === 'danger'
                          ? 'bg-destructive'
                          : f.severity === 'warn'
                            ? 'bg-[var(--wakil-amber)]'
                            : 'bg-muted-foreground/60',
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className={cn(f.severity === 'danger' && 'font-medium text-destructive')}>
                        {f.message}
                      </span>
                      {f.detail ? (
                        <span className="num block text-[11px] text-muted-foreground">{f.detail}</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
              {typeof card.confidence === 'number' && (
                <div className="mt-2 flex items-center gap-2" aria-label={`ثقة وكيل ${card.confidence} بالمئة`}>
                  <Eye className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="text-[11px] text-muted-foreground">ثقة وكيل</span>
                  <span className="confidence-track h-1.5 flex-1" aria-hidden="true">
                    <span
                      className={cn(
                        'confidence-fill',
                        card.confidence >= 85
                          ? 'bg-emerald-500'
                          : card.confidence >= 60
                            ? 'bg-[var(--wakil-amber)]'
                            : 'bg-destructive',
                      )}
                      style={{ ['--confidence' as string]: `${card.confidence}%` }}
                    />
                  </span>
                  <span className="num text-[11px] font-semibold">{card.confidence}%</span>
                </div>
              )}
            </section>
          )}

          {/* approval footer */}
          {showActions && (
            <div className="flex flex-col gap-2.5">
              {needsReason && (
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="السبب إلزامي للعمليات الحساسة"
                  aria-label="سبب اعتماد العملية الحساسة"
                  dir="rtl"
                  className="h-10 rounded-lg"
                />
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  className="magnetic ae-sweep press h-11 flex-1 rounded-lg sm:flex-none sm:min-w-44"
                  disabled={busy || !reasonOk}
                  onClick={() => onApprove?.(reason.trim() || undefined)}
                >
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <CheckCircle2 className="size-4" aria-hidden="true" />
                  )}
                  اعتماد العملية
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="press h-11 flex-1 rounded-lg border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive sm:flex-none"
                  disabled={busy}
                  onClick={() => onReject?.()}
                >
                  <XCircle className="size-4" aria-hidden="true" />
                  إلغاء المسودة
                </Button>
              </div>
            </div>
          )}

          {/* verification after execution */}
          {outcome && (
            <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <ShieldCheck className="size-4 text-[var(--success)]" aria-hidden="true" />
                التحقق بعد التنفيذ
              </div>

              {outcome.checks.map((c, i) => (
                <div
                  key={`${c.label}-${i}`}
                  className="flex flex-wrap items-start justify-between gap-x-3 gap-y-0.5 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    {c.pass ? (
                      <CheckCircle2
                        className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                        aria-hidden="true"
                      />
                    ) : (
                      <XCircle className="size-4 shrink-0 text-destructive" aria-hidden="true" />
                    )}
                    <span className="font-medium">{c.label}</span>
                  </span>
                  <span className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                    <span>
                      المتوقع <span className="num font-mono">{c.expected}</span>
                    </span>
                    <span>
                      الفعلي <span className="num font-mono">{c.actual}</span>
                    </span>
                  </span>
                </div>
              ))}

              {outcome.effects.length > 0 && (
                <div className="flex flex-col gap-1 border-t pt-2">
                  {outcome.effects.map((e, i) => (
                    <div
                      key={`${e.label}-${i}`}
                      className="finding-enter flex items-baseline justify-between gap-3 text-sm"
                      style={{ animationDelay: `${outcome.checks.length * 60 + 120 + i * 60}ms` }}
                    >
                      <span className="text-muted-foreground">{e.label}</span>
                      <span className={cn('font-semibold', toneClass(e.tone))}>
                        {withNums(e.value)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {!outcome.ok && outcome.failReason && (
                <Alert variant="destructive" className="mt-1">
                  <XCircle className="size-4" aria-hidden="true" />
                  <AlertTitle>سبب الفشل</AlertTitle>
                  <AlertDescription>{outcome.failReason}</AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  )
}
