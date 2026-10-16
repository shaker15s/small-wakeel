'use client'

// وكيل — شاشة «ذاكرة وكيل» (Memory Inspector):
// كل اللي الوكيل اتعلمه عن صاحب الشغل — قوانين، تفضيلات، معلومات،
// أسماء دارجة، وملاحظات — مع تعديل / إيقاف / حذف / إضافة مباشرة.
// Defensive by design: يشتغل مع أي شكل قديم/جديد من /api/memories.

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'
import {
  BookMarked,
  Heart,
  Info,
  Lightbulb,
  MessageCircle,
  Pencil,
  Plus,
  Power,
  ScrollText,
  Trash2,
} from 'lucide-react'

import { AgentAvatar } from '@/components/chat/AgentAvatar'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { api } from '@/lib/api'
import { arDate } from '@/lib/format'
import { QUERY_KEYS } from '@/lib/store'
import type { MemoryDTO } from '@/lib/types'
import { cn } from '@/lib/utils'
import { arNum, EmptyState, ErrorState, SectionCard, ViewProps } from './shared'

// ---------------------------------------------------------------------------
// Kind registry — labels / icons / descriptions (Egyptian Arabic)
// ---------------------------------------------------------------------------

type MemoryKind = MemoryDTO['kind']

const KIND_ORDER: MemoryKind[] = ['rule', 'preference', 'fact', 'lexicon', 'insight']

const KIND_META: Record<MemoryKind, { label: string; icon: LucideIcon; desc: string }> = {
  rule: {
    label: 'قوانين شغلك',
    icon: ScrollText,
    desc: 'قواعد حددتها لوكيل — بتتطبق تلقائي',
  },
  preference: {
    label: 'تفضيلاتك',
    icon: Heart,
    desc: 'حاجات بتحب وكيل يعملها بطريقتك المفضلة',
  },
  fact: {
    label: 'معلومات',
    icon: Info,
    desc: 'معلومات اتعلمها وكيل عن شغلك وعمالك',
  },
  lexicon: {
    label: 'الأسماء الدارجة',
    icon: BookMarked,
    desc: 'الأسماء الدارجة اللي وكيل بيربطها بالحاجات الحقيقية',
  },
  insight: {
    label: 'ملاحظات وكيل',
    icon: Lightbulb,
    desc: 'ملاحظات ودروس استخلصها وكيل من شغلك اليومي',
  },
}

const CATEGORY_AR: Record<string, string> = {
  general: 'عام',
  credit_limits: 'حدود آجل',
  pricing: 'تسعير',
  membership_policies: 'اشتراكات',
}

const CATEGORY_OPTIONS = [
  { value: 'general', label: 'عام' },
  { value: 'credit_limits', label: 'حدود آجل' },
  { value: 'pricing', label: 'تسعير' },
  { value: 'membership_policies', label: 'اشتراكات' },
]

/** Translate a category key; unknown keys get a humanized fallback. */
function categoryLabel(raw?: string | null): string {
  const key = (raw ?? 'general').trim()
  if (CATEGORY_AR[key]) return CATEGORY_AR[key]
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'عام'
}

// ---------------------------------------------------------------------------
// Defensive mapping — THE single place old/odd shapes get normalized
// (the endpoint may briefly return the legacy {kind:'fact'|'preference'} shape)
// ---------------------------------------------------------------------------

const FALLBACK_DATE = new Date(0).toISOString()

function normalizeMemory(m: MemoryDTO): MemoryDTO {
  const raw = m as Partial<MemoryDTO> & Record<string, unknown>
  const kind = (raw.kind as MemoryKind) ?? 'fact'
  return {
    id: String(raw.id ?? ''),
    kind: KIND_ORDER.includes(kind) ? kind : 'fact',
    category: typeof raw.category === 'string' && raw.category ? raw.category : 'general',
    text: typeof raw.text === 'string' ? raw.text : '',
    entityRef: typeof raw.entityRef === 'string' ? raw.entityRef : null,
    confidence: typeof raw.confidence === 'number' ? Math.min(100, Math.max(0, raw.confidence)) : 80,
    usageCount: typeof raw.usageCount === 'number' ? raw.usageCount : 0,
    active: typeof raw.active === 'boolean' ? raw.active : true,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : FALLBACK_DATE,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : (typeof raw.createdAt === 'string' ? raw.createdAt : FALLBACK_DATE),
  }
}

/** Relative date, Egyptian style: النهاردة / امبارح / من X يوم … */
function relTimeAr(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000)
  if (days <= 0) return 'النهاردة'
  if (days === 1) return 'امبارح'
  if (days < 7) return `من ${arNum(days)} يوم`
  if (days < 14) return 'من أسبوع'
  if (days < 30) return `من ${arNum(Math.floor(days / 7))} أسابيع`
  if (days < 60) return 'من شهر'
  return arDate(d)
}

// ---------------------------------------------------------------------------
// Raw fetch helpers for the mutations R14-brain owns (PATCH/DELETE may 404
// until it lands them — every failure becomes a graceful toast, never a crash)
// ---------------------------------------------------------------------------

async function patchMemoryApi(id: string, patch: { text?: string; active?: boolean; category?: string }): Promise<MemoryDTO> {
  const res = await fetch('/api/memories', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, ...patch }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `فشل الطلب (${res.status})`)
  }
  return (await res.json()) as MemoryDTO
}

async function deleteMemoryApi(id: string): Promise<void> {
  const res = await fetch(`/api/memories?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `فشل الطلب (${res.status})`)
  }
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export default function MemoryView({ businessId, userId, onNavigate }: ViewProps) {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: QUERY_KEYS.memories(businessId),
    queryFn: () => api.memories(businessId),
  })

  const memories = useMemo(() => (data ?? []).map(normalizeMemory), [data])

  const sections = useMemo(
    () =>
      KIND_ORDER.map((kind) => ({
        kind,
        meta: KIND_META[kind],
        items: memories.filter((m) => m.kind === kind),
      })).filter((s) => s.items.length > 0),
    [memories],
  )

  const activeCount = useMemo(() => memories.filter((m) => m.active).length, [memories])
  const totalUsage = useMemo(() => memories.reduce((sum, m) => sum + m.usageCount, 0), [memories])

  // — dialog state (no AnimatePresence anywhere — per the freeze postmortem)
  const [addOpen, setAddOpen] = useState(false)
  const [addKind, setAddKind] = useState<MemoryKind>('fact')
  const [addText, setAddText] = useState('')

  const [editing, setEditing] = useState<MemoryDTO | null>(null)
  const [editText, setEditText] = useState('')
  const [editCategory, setEditCategory] = useState('general')

  const [deleting, setDeleting] = useState<MemoryDTO | null>(null)

  // — mutations: optimistic where cheap; server truth wins on settle
  const patchMemory = useMutation({
    mutationFn: (vars: { id: string; patch: { text?: string; active?: boolean; category?: string } }) =>
      patchMemoryApi(vars.id, vars.patch),
    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEYS.memories(businessId) })
      const prev = queryClient.getQueryData<MemoryDTO[]>(QUERY_KEYS.memories(businessId))
      if (prev) {
        queryClient.setQueryData(
          QUERY_KEYS.memories(businessId),
          prev.map((m) => (m.id === id ? { ...m, ...patch, updatedAt: new Date().toISOString() } : m)),
        )
      }
      return { prev }
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(QUERY_KEYS.memories(businessId), ctx.prev)
      toast({ title: 'التغيير مانفذش', description: err.message, variant: 'destructive' })
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.memories(businessId) })
    },
  })

  const deleteMemory = useMutation({
    mutationFn: (id: string) => deleteMemoryApi(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEYS.memories(businessId) })
      const prev = queryClient.getQueryData<MemoryDTO[]>(QUERY_KEYS.memories(businessId))
      if (prev) {
        queryClient.setQueryData(QUERY_KEYS.memories(businessId), prev.filter((m) => m.id !== id))
      }
      return { prev }
    },
    onError: (err, _id, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(QUERY_KEYS.memories(businessId), ctx.prev)
      toast({ title: 'الحذف مانفذش', description: err.message, variant: 'destructive' })
    },
    onSuccess: () => {
      toast({ title: 'وكيل نسى ده ✅' })
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.memories(businessId) })
    },
  })

  const addMemory = useMutation({
    mutationFn: (m: { kind: MemoryKind; text: string }) =>
      api.addMemory({ businessId, userId, text: m.text, kind: m.kind }),
    onError: (err) => {
      toast({ title: 'الحفظ مانفذش', description: err.message, variant: 'destructive' })
    },
    onSuccess: () => {
      toast({ title: 'وكيل حفظها في ذاكرته ✅' })
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.memories(businessId) })
    },
  })

  // — handlers
  const openEdit = (m: MemoryDTO) => {
    setEditing(m)
    setEditText(m.text)
    setEditCategory(m.category || 'general')
  }

  const saveEdit = () => {
    if (!editing) return
    const text = editText.trim()
    if (!text) return
    patchMemory.mutate({ id: editing.id, patch: { text, category: editCategory } })
    setEditing(null)
  }

  const toggleActive = (m: MemoryDTO) => {
    patchMemory.mutate({ id: m.id, patch: { active: !m.active } })
    toast({
      title: m.active ? 'وقفتها — وكيل مش هيستخدمها دلوقتي' : 'رجعت شغالة — وكيل هيستخدمها تاني ✅',
    })
  }

  const confirmDelete = () => {
    if (!deleting) return
    deleteMemory.mutate(deleting.id)
    setDeleting(null)
  }

  const submitAdd = () => {
    const text = addText.trim()
    if (!text) return
    addMemory.mutate({ kind: addKind, text })
    setAddOpen(false)
    setAddText('')
    setAddKind('fact')
  }

  // — render ----------------------------------------------------------------

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="mx-auto w-full max-w-5xl space-y-4 px-4 pb-8 pt-2 sm:space-y-5 sm:px-6"
    >
      {/* hero — the mascot + stats */}
      <header className="rise-in flex items-start gap-3 sm:gap-4">
        <AgentAvatar state="searching" size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold sm:text-2xl">ذاكرة وكيل</h1>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            كل اللي اتعلمته عنك وعن شغلك — بتتطور كل يوم معاك
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <span className="chip-lift rounded-full border border-wakil-amber/25 bg-wakil-amber/10 px-2.5 py-1 text-[11px] font-semibold text-wakil-amber">
              <span className="num tabular-nums">{arNum(activeCount)}</span> حاجة فاكرها
            </span>
            <span className="chip-lift rounded-full border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              استخدمت <span className="num tabular-nums">{arNum(totalUsage)}</span> مرة
            </span>
          </div>
        </div>
      </header>

      {isError ? (
        <ErrorState message={error.message} onRetry={() => refetch()} />
      ) : isPending ? (
        <MemorySkeleton />
      ) : memories.length === 0 ? (
        <>
          <EmptyState
            icon={BookMarked}
            mascot
            title="لسه ذاكرتي فاضية"
            hint={'قول لي في المحادثة: «خليك فاكر إني...» وهحفظهولك هنا'}
          />
          <div className="flex justify-center">
            {onNavigate && (
              <Button variant="outline" size="sm" className="min-h-10" onClick={() => onNavigate('chat')}>
                <MessageCircle aria-hidden /> افتح المحادثة وقول لي
              </Button>
            )}
          </div>
        </>
      ) : (
        <>
          {sections.map(({ kind, meta, items }, si) => {
            const Icon = meta.icon
            return (
              <SectionCard
                key={kind}
                title={meta.label}
                icon={Icon}
                accent={kind === 'rule' ? 'amber' : undefined}
                action={<CountChip count={items.length} />}
                className="list-enter"
              >
                <p className="-mt-1 mb-3 text-xs leading-relaxed text-muted-foreground">{meta.desc}</p>
                <ul className="space-y-2.5">
                  {items.map((m, i) => (
                    <MemoryCard
                      key={m.id}
                      memory={m}
                      kind={kind}
                      index={si * 3 + i}
                      busy={patchMemory.isPending || deleteMemory.isPending}
                      onEdit={() => openEdit(m)}
                      onToggle={() => toggleActive(m)}
                      onDelete={() => setDeleting(m)}
                    />
                  ))}
                </ul>
              </SectionCard>
            )
          })}
        </>
      )}

      {/* add-memory entry — always available */}
      <button
        type="button"
        onClick={() => setAddOpen(true)}
        className="press focus-warm press-deep flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-wakil-amber/40 bg-accent/30 px-4 py-3.5 text-sm font-semibold text-wakil-amber transition-colors hover:border-wakil-amber/70 hover:bg-accent/60"
      >
        <Plus className="size-4" aria-hidden />
        علّم وكيل حاجة جديدة
      </button>

      {/* — edit dialog — */}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>تعديل الذاكرة</DialogTitle>
            <DialogDescription>عدّل النص أو التصنيف — وكيل هيستخدم النسخة الجديدة على طول.</DialogDescription>
          </DialogHeader>
          <Textarea
            dir="rtl"
            rows={4}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            placeholder="اكتب الذاكرة بالعامي زي ما بتقولها…"
            aria-label="نص الذاكرة"
            className="min-h-24 leading-relaxed"
          />
          <div className="flex items-center gap-2">
            <Select value={editCategory} onValueChange={setEditCategory}>
              <SelectTrigger size="sm" className="w-36" aria-label="تصنيف الذاكرة">
                <SelectValue placeholder="التصنيف" />
              </SelectTrigger>
              <SelectContent>
                {(CATEGORY_OPTIONS.some((o) => o.value === editCategory)
                  ? CATEGORY_OPTIONS
                  : [{ value: editCategory, label: categoryLabel(editCategory) }, ...CATEGORY_OPTIONS]
                ).map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" className="min-h-10" onClick={() => setEditing(null)}>
              إلغاء
            </Button>
            <Button className="min-h-10" disabled={!editText.trim() || patchMemory.isPending} onClick={saveEdit}>
              حفظ التعديل
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* — add dialog — */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>علّم وكيل حاجة جديدة</DialogTitle>
            <DialogDescription>اكتبها مرة واحدة — وكيل يفتكرها ويطبقها في شغلك اليومي.</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Select value={addKind} onValueChange={(v) => setAddKind(v as MemoryKind)}>
              <SelectTrigger size="sm" className="w-40" aria-label="نوع الذاكرة">
                <SelectValue placeholder="النوع" />
              </SelectTrigger>
              <SelectContent>
                {KIND_ORDER.map((k) => (
                  <SelectItem key={k} value={k}>
                    {KIND_META[k].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Textarea
            dir="rtl"
            rows={4}
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            placeholder="مثال: خليك فاكر إن عم حسين بياخد البضاعة بالآجل وسامح له لحد ٥٠٠ جنيه بس…"
            aria-label="نص الذاكرة الجديدة"
            className="min-h-24 leading-relaxed"
          />
          <DialogFooter>
            <Button variant="outline" className="min-h-10" onClick={() => setAddOpen(false)}>
              إلغاء
            </Button>
            <Button className="min-h-10" disabled={!addText.trim() || addMemory.isPending} onClick={submitAdd}>
              <Plus aria-hidden /> احفظها لوكيل
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* — delete confirm — */}
      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>انسى ده نهائي؟</AlertDialogTitle>
            <AlertDialogDescription>
              «{deleting?.text.slice(0, 120) ?? ''}
              {(deleting?.text.length ?? 0) > 120 ? '…' : ''}» —
              وكيل مش هيشوفها تاني في شغلك. مفيش رجوع في الخطوة دي.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-10">لأ، سيبها</AlertDialogCancel>
            <AlertDialogAction
              className="min-h-10 bg-destructive text-white hover:bg-destructive/90"
              onClick={confirmDelete}
            >
              <Trash2 aria-hidden /> انسَها
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// Memory card
// ---------------------------------------------------------------------------

function MemoryCard({
  memory: m,
  kind,
  index,
  busy,
  onEdit,
  onToggle,
  onDelete,
}: {
  memory: MemoryDTO
  kind: MemoryKind
  index: number
  busy: boolean
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
}) {
  const confidence = Math.min(100, Math.max(0, m.confidence))
  const showCategory = kind === 'rule' || (m.category && m.category !== 'general')

  return (
    <li
      className={cn(
        'chip-lift list-enter group relative rounded-xl border bg-card p-3.5 shadow-sm hover:border-wakil-amber/30',
        !m.active && 'opacity-60',
      )}
      style={{ animationDelay: `${Math.min(index, 10) * 40}ms` }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-sm leading-relaxed">{m.text}</p>

        {/* actions — hover-reveal on mouse devices, always visible on touch */}
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 max-lg:opacity-100 pointer-coarse:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            onClick={onEdit}
            disabled={busy}
            title="عدّل"
            aria-label="عدّل الذاكرة"
            className="focus-warm flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-wakil-navy disabled:opacity-50"
          >
            <Pencil className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={onToggle}
            disabled={busy}
            title={m.active ? 'وقّفها' : 'شغّلها'}
            aria-label={m.active ? 'وقّف الذاكرة' : 'شغّل الذاكرة'}
            className={cn(
              'focus-warm flex size-10 items-center justify-center rounded-lg transition-colors disabled:opacity-50',
              m.active
                ? 'text-muted-foreground hover:bg-accent hover:text-wakil-amber'
                : 'text-wakil-teal hover:bg-wakil-teal/10',
            )}
          >
            <Power className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            title="انسَها"
            aria-label="احذف الذاكرة نهائياً"
            className="focus-warm flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
          >
            <Trash2 className="size-4" aria-hidden />
          </button>
        </div>
      </div>

      {/* meta row — confidence bar + usage + date + category + paused badge */}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">
        <span
          className="flex items-center gap-1.5"
          title={`ثقة وكيل في الذاكرة: ${arNum(confidence)}٪`}
        >
          <span className="h-1.5 w-12 overflow-hidden rounded-full bg-muted" aria-hidden>
            <span
              className={cn(
                'block h-full rounded-full',
                confidence >= 70 ? 'bg-wakil-amber' : 'bg-muted-foreground/50',
              )}
              style={{ width: `${confidence}%` }}
            />
          </span>
          <span className="num tabular-nums">{arNum(confidence)}٪</span>
        </span>
        {m.usageCount > 0 && (
          <span>
            استُخدمت <span className="num tabular-nums">{arNum(m.usageCount)}</span> مرة
          </span>
        )}
        <span>{relTimeAr(m.updatedAt || m.createdAt)}</span>
        {showCategory && (
          <span className="chip-lift rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">
            {categoryLabel(m.category)}
          </span>
        )}
        {!m.active && (
          <span className="rounded-full border bg-card px-2 py-0.5 text-[10px] font-semibold">متوقفة</span>
        )}
      </div>
    </li>
  )
}

function CountChip({ count }: { count: number }) {
  return (
    <span className="num rounded-full bg-wakil-amber/15 px-2.5 py-0.5 text-xs font-semibold text-wakil-amber tabular-nums">
      {arNum(count)}
    </span>
  )
}

function MemorySkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="بيتحمّل">
      <div className="skel h-40 rounded-xl" />
      <div className="skel h-28 rounded-xl" />
      <div className="skel h-24 rounded-xl" />
    </div>
  )
}
