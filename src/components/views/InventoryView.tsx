'use client'

// وكيل — شاشة «المخزون»: كتالوج الأصناف مع بحث وتصنيفات وتنبيهات النقص والصلاحية.

import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Boxes, Search, SearchX, TriangleAlert } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import { egp, qty as fmtQty } from '@/lib/format'
import { arUnit } from '@/lib/verticals'
import { QUERY_KEYS } from '@/lib/store'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import type { ItemDTO } from '@/lib/types'
import { EmptyState, ErrorState, Money, ViewHeader, ViewProps, arNum, PAGE, PAGE_PLAIN
} from './shared'
import { ImportItemsDialog } from './ImportItemsDialog'

function itemValue(it: ItemDTO): number {
  return it.valueAtCost ?? it.costPrice * it.stockQty
}

function isLow(it: ItemDTO): boolean {
  return it.stockQty <= it.lowStockThreshold
}

/** Expiry state: null = not tracked / fine, 'expired' | 'soon' = needs a badge. */
function expiryState(it: ItemDTO): 'expired' | 'soon' | null {
  if (it.daysToExpiry == null) return null
  if (it.daysToExpiry <= 0) return 'expired'
  if (it.daysToExpiry <= 30) return 'soon'
  return null
}

function ItemBadges({ it }: { it: ItemDTO }) {
  const exp = expiryState(it)
  return (
    <span className="flex flex-wrap items-center gap-1">
      {isLow(it) && <Badge className="bg-wakil-amber/15 text-wakil-amber">ناقص</Badge>}
      {exp === 'expired' && (
        <Badge variant="destructive">
          <span className="me-1 size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
          منتهية
        </Badge>
      )}
      {exp === 'soon' && <Badge className="bg-wakil-amber/15 text-wakil-amber">قربت</Badge>}
    </span>
  )
}

export default function InventoryView({ businessId, userId }: ViewProps) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('__all')

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: QUERY_KEYS.items(businessId),
    queryFn: () => api.items(businessId),
  })

  const items = data ?? []
  const categories = useMemo(
    () => Array.from(new Set(items.map((i) => i.category))).filter(Boolean),
    [items],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((it) => {
      if (category !== '__all' && it.category !== category) return false
      if (!q) return true
      const haystack = `${it.name} ${it.aliases}`.toLowerCase()
      return haystack.includes(q)
    })
  }, [items, query, category])

  const totalValue = useMemo(
    () => filtered.reduce((sum, it) => sum + itemValue(it), 0),
    [filtered],
  )
  const allValue = useMemo(
    () => items.reduce((sum, it) => sum + itemValue(it), 0),
    [items],
  )
  const lowCount = filtered.filter(isLow).length

  if (isError) {
    return (
      <div className={PAGE_PLAIN}>
        <ViewHeader title="المخزون" />
        <div className="mt-4">
          <ErrorState message={error.message} onRetry={() => refetch()} />
        </div>
      </div>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className={PAGE}
    >
      <ViewHeader
        title="المخزون"
        subtitle={
          isPending
            ? 'بنجهّز الكتالوج...'
            : `${arNum(items.length)} صنف${lowCount > 0 ? ` — ${arNum(lowCount)} ناقص` : ''} · القيمة: ${egp(allValue)}`
        }
        action={<ImportItemsDialog businessId={businessId} userId={userId} />}
      />

      {/* بحث + تصنيفات */}
      <div className="space-y-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="دوّر على صنف بالاسم أو اللقب..."
            className="h-11 ps-9 focus-visible:border-wakil-amber/50 focus-visible:ring-wakil-amber/40"
            aria-label="بحث في المخزون"
            inputMode="search"
          />
        </div>

        {isPending ? (
          <Skeleton className="h-11 w-full" />
        ) : categories.length > 0 ? (
          <Tabs value={category} onValueChange={setCategory} dir="rtl">
            <TabsList className="h-auto w-full flex-wrap justify-start gap-1 p-1">
              <TabsTrigger value="__all" className="min-h-9 rounded-md px-3">
                الكل ({arNum(items.length)})
              </TabsTrigger>
              {categories.map((c) => (
                <TabsTrigger key={c} value={c} className="min-h-9 rounded-md px-3">
                  {c}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ) : null}
      </div>

      {/* القائمة */}
      {isPending ? (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="الكتالوج فاضي لسه"
          hint="أضف أصنافك من المحادثة — قول لوكيل: «عندي صنف جديد اسمه كذا وسعره كذا»"
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="ملقيناش صنف بالمواصفات دي"
          hint="جرّب كلمة تانية، أو ارجع لتبويب «الكل» وشوف كل الأصناف"
        />
      ) : (
        <div className="card-enter rounded-xl border bg-card shadow-sm">
          {/* جدول — شاشات متوسطة وطبعاً أكبر */}
          <div className="hidden max-h-[480px] overflow-y-auto scroll-war md:block">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-start">الصنف</TableHead>
                  <TableHead className="text-start">الرصيد</TableHead>
                  <TableHead className="text-start">الوحدة</TableHead>
                  <TableHead className="text-start">سعر البيع</TableHead>
                  <TableHead className="text-start">قيمة المخزون</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((it) => {
                  const low = isLow(it)
                  return (
                    <TableRow
                      key={it.id}
                      className={cn(
                        'hover:bg-muted/40',
                        low && 'bg-wakil-amber-soft/50 hover:bg-wakil-amber-soft/60',
                      )}
                    >
                      <TableCell className="max-w-[220px] py-2.5">
                        <span className="flex flex-wrap items-center gap-1.5">
                          {low && (
                            <TriangleAlert
                              className="size-3.5 shrink-0 text-wakil-amber"
                              aria-label="تحت حد التنبيه"
                            />
                          )}
                          <span className="truncate font-medium">{it.name}</span>
                          <ItemBadges it={it} />
                        </span>
                      </TableCell>
                      <TableCell
                        className={cn(
                          'num py-2.5 font-semibold tabular-nums',
                          low && 'text-wakil-amber',
                        )}
                      >
                        {fmtQty(it.stockQty)}
                      </TableCell>
                      <TableCell className="py-2.5 text-muted-foreground">
                        {arUnit(it.unit)}
                      </TableCell>
                      <TableCell className="py-2.5">
                        <Money value={it.sellPrice} />
                      </TableCell>
                      <TableCell className="py-2.5">
                        <Money value={itemValue(it)} className="font-medium" />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>

          {/* كروت — موبايل */}
          <ul className="divide-y md:hidden" aria-label="قائمة الأصناف">
            {filtered.map((it, i) => {
              const low = isLow(it)
              return (
                <li
                  key={it.id}
                  className={cn('list-enter space-y-2 p-4', low && 'bg-wakil-amber-soft/50')}
                  style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                      {low && (
                        <TriangleAlert
                          className="size-3.5 shrink-0 text-wakil-amber"
                          aria-label="تحت حد التنبيه"
                        />
                      )}
                      <span className="font-medium">{it.name}</span>
                      <ItemBadges it={it} />
                    </span>
                  </div>
                  <dl className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <dt className="text-muted-foreground">الرصيد ({arUnit(it.unit)})</dt>
                      <dd
                        className={cn(
                          'num mt-0.5 font-semibold tabular-nums',
                          low && 'text-wakil-amber',
                        )}
                      >
                        {fmtQty(it.stockQty)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">سعر البيع</dt>
                      <dd className="num mt-0.5 font-semibold tabular-nums">
                        {egp(it.sellPrice)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">قيمة المخزون</dt>
                      <dd className="num mt-0.5 font-semibold tabular-nums">
                        {egp(itemValue(it))}
                      </dd>
                    </div>
                  </dl>
                </li>
              )
            })}
          </ul>

          {/* إجمالي قيمة المخزون */}
          <div className="flex items-center justify-between gap-2 border-t bg-muted/40 px-4 py-3">
            <span className="text-sm font-semibold">إجمالي قيمة المخزون</span>
            <Money value={totalValue} className="text-base font-bold" />
          </div>
        </div>
      )}

      {/* إجمالي قيمة المخزون المعروض */}
    </motion.div>
  )
}
