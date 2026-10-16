'use client'

// وكيل — شاشة «الحسابات»: مديونيات العملاء (اللي ليّا عليهم) ومستحقات الموردين (اللي عليّا).

import { motion } from 'framer-motion'
import { HandCoins, Phone, Truck, UsersRound } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { egp } from '@/lib/format'
import { QUERY_KEYS } from '@/lib/store'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import type { CustomerDTO, SupplierDTO } from '@/lib/types'
import { EmptyState, ErrorState, Money, ViewHeader, ViewProps, arNum } from './shared'

function PersonRow({ name, phone, plan }: { name: string; phone?: string | null; plan?: string | null }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate text-sm font-medium">{name}</span>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {plan && <span className="rounded bg-muted px-1.5 py-0.5">{plan}</span>}
        {phone ? (
          <a
            href={`tel:${phone}`}
            dir="ltr"
            className="focus-warm num group inline-flex items-center gap-1 rounded-sm transition-colors hover:text-foreground"
            aria-label={`اتصل بـ ${name}`}
          >
            <Phone
              className="size-3 transition-transform duration-200 group-hover:rotate-[20deg]"
              aria-hidden
            />
            {phone}
          </a>
        ) : (
          !plan && <span>مفيش تليفون مسجّل</span>
        )}
      </span>
    </span>
  )
}

export default function AccountsView({ businessId, userId }: ViewProps) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: QUERY_KEYS.overview(businessId, userId),
    queryFn: () => api.overview(businessId, userId),
  })

  if (isError) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 pb-8 pt-2 sm:px-6">
        <ViewHeader title="الحسابات" />
        <div className="mt-4">
          <ErrorState message={error.message} onRetry={() => refetch()} />
        </div>
      </div>
    )
  }

  const receivables: CustomerDTO[] = data?.receivables ?? []
  const payables: SupplierDTO[] = data?.payables ?? []
  const receivablesTotal = receivables.reduce((s, c) => s + c.balance, 0)
  const payablesTotal = payables.reduce((s, x) => s + x.balance, 0)

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="mx-auto w-full max-w-5xl space-y-4 px-4 pb-8 pt-2 sm:px-6"
    >
      <ViewHeader
        title="الحسابات"
        subtitle="اللي ليّا عليهم واللي عليّا للموردين — أرقام واضحة من غير ورق ضايع"
      />

      <div className="grid gap-4 lg:grid-cols-2">
        {/* اللي ليّا عليهم */}
        <Card className="card-enter border-wakil-teal/25">
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2 text-sm">
              <HandCoins className="size-4 text-wakil-teal" aria-hidden />
              اللي ليّا عليهم
            </CardTitle>
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-muted-foreground">
                {isPending ? '...' : `${arNum(receivables.length)} عميل`}
              </span>
              <Money
                value={receivablesTotal}
                className="num text-2xl font-bold text-wakil-teal"
              />
            </div>
          </CardHeader>
          <CardContent>
            {isPending ? (
              <div className="space-y-2" aria-busy="true">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-5/6" />
                <Skeleton className="h-12 w-2/3" />
              </div>
            ) : receivables.length === 0 ? (
              <EmptyState
                icon={UsersRound}
                title="مفيش حد مدين ليك"
                hint="كل العملاء صافي — أول ما تبيع بالآجل هتلاقي المديونية هنا"
              />
            ) : (
              <ul className="divide-y">
                {receivables.map((c) => (
                  <li
                    key={c.id}
                    className="chip-lift flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-muted/50"
                  >
                    <PersonRow name={c.name} phone={c.phone} plan={c.plan} />
                    <span
                      className={cn(
                        'num shrink-0 text-sm font-bold text-wakil-teal tabular-nums',
                      )}
                    >
                      {egp(c.balance)}
                    </span>
                  </li>
                ))}
                <li className="flex items-center justify-between gap-2 px-2 pt-3 text-sm">
                  <span className="font-semibold">إجمالي المديونيات</span>
                  <Money value={receivablesTotal} className="font-bold text-wakil-teal" />
                </li>
              </ul>
            )}
          </CardContent>
        </Card>

        {/* اللي علينا للموردين */}
        <Card className="card-enter border-wakil-amber/30">
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Truck className="size-4 text-wakil-amber" aria-hidden />
              اللي علينا للموردين
            </CardTitle>
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-muted-foreground">
                {isPending ? '...' : `${arNum(payables.length)} مورد`}
              </span>
              <Money
                value={payablesTotal}
                className="num text-2xl font-bold text-wakil-amber"
              />
            </div>
          </CardHeader>
          <CardContent>
            {isPending ? (
              <div className="space-y-2" aria-busy="true">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-3/4" />
              </div>
            ) : payables.length === 0 ? (
              <EmptyState
                icon={Truck}
                title="مفيش مستحقات على الموردين"
                hint="خلاصك مع كل الموردين سليم — أول ما تشتري بالآجل هيظهر هنا"
              />
            ) : (
              <ul className="divide-y">
                {payables.map((s) => (
                  <li
                    key={s.id}
                    className="chip-lift flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-muted/50"
                  >
                    <PersonRow name={s.name} phone={s.phone} />
                    <span className="num shrink-0 text-sm font-bold text-wakil-amber tabular-nums">
                      {egp(s.balance)}
                    </span>
                  </li>
                ))}
                <li className="flex items-center justify-between gap-2 px-2 pt-3 text-sm">
                  <span className="font-semibold">إجمالي المستحقات</span>
                  <Money value={payablesTotal} className="font-bold text-wakil-amber" />
                </li>
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </motion.div>
  )
}
