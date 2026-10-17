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
  Loader2,
  MessageCircle,
  Pencil,
  Plus,
  Power,
  ScrollText,
  Trash2,
  Wrench,
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
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
import type { CustomToolDTO, MemoryDTO } from '@/lib/types'
import { cn } from '@/lib/utils'
import { arNum, EmptyState, ErrorState, SectionCard, ViewProps, PAGE
} from './shared'

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
      className={PAGE}
    >
      {/* hero — the mascot + stats + 5-Layer Contextual Memory Architecture */}
      <header className="rise-in space-y-3.5">
        <div className="flex items-start gap-3 sm:gap-4">
          <AgentAvatar state="searching" size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold sm:text-2xl">الذاكرة السياقية ودستور الشغل</h1>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
                متزامنة لحظياً مع محرك القرار
              </span>
            </div>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              ذاكرة «وكيل» من ٥ طبقات حية: بتحفظ قواعد عملك، تفضيلاتك، لهجة محلك، خططك المتكررة، وتطور مهامك — وأي تعديل هنا بيتطبق فوراً في نفس اللحظة.
            </p>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <span className="chip-lift rounded-full border border-wakil-amber/25 bg-wakil-amber/10 px-2.5 py-1 text-[11px] font-semibold text-wakil-amber">
                <span className="num tabular-nums">{arNum(activeCount)}</span> عنصر نشط في الذاكرة
              </span>
              <span className="chip-lift rounded-full border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                استُخدمت في اتخاذ القرار <span className="num tabular-nums">{arNum(totalUsage)}</span> مرة
              </span>
            </div>
          </div>
        </div>

        {/* 5-Layer Contextual Memory Architecture Strip */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {KIND_ORDER.map((k) => {
            const meta = KIND_META[k]
            const Icon = meta.icon
            const count = memories.filter((m) => m.kind === k && m.active).length
            return (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setAddKind(k)
                  setAddOpen(true)
                }}
                className="group flex flex-col justify-between rounded-xl border bg-card/80 p-3 text-right transition-all hover:border-wakil-amber/50 hover:bg-accent/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex size-7 items-center justify-center rounded-lg bg-wakil-amber/10 text-wakil-amber">
                    <Icon className="size-3.5" aria-hidden />
                  </span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-bold tabular-nums">
                    {arNum(count)}
                  </span>
                </div>
                <div className="mt-2">
                  <p className="text-xs font-bold text-foreground group-hover:text-wakil-amber">
                    {meta.label}
                  </p>
                  <p className="mt-0.5 line-clamp-1 text-[10px] text-muted-foreground">
                    + إضافة سريعة
                  </p>
                </div>
              </button>
            )
          })}
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

      {/* — أدوات بتاعتك (R16) — the owner's own tools the agent actually uses — */}
      <ToolsSection businessId={businessId} userId={userId} />

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

// ---------------------------------------------------------------------------
// أدوات بتاعتك (R16) — the owner's own tools the agent ACTUALLY uses during
// deep research (web sources + read-only webhooks). Same view idioms: kind
// chips in wakil tokens, Arabic-Indic digits, relative time, confirm-delete.
// ---------------------------------------------------------------------------

type ToolKind = CustomToolDTO['kind']

const TOOL_KIND_META: Record<ToolKind, { label: string; chip: string; option: string }> = {
  web_source: {
    label: 'مصدر ويب',
    chip: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
    option: 'مصدر ويب — يخلّي وكيل يدور جوه موقع معين وقت البحث',
  },
  webhook: {
    label: 'أمر خارجي',
    chip: 'bg-[var(--wakil-navy)]/10 text-[var(--wakil-navy)]',
    option: 'أمر خارجي — يطلب من رابط API بيانات',
  },
}

const TOOL_NAME_MAX = 60

/** site sanity check (client-side pre-validation — the server re-validates). */
function looksLikeSite(raw: string): boolean {
  const site = raw
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split('/')[0]
    .replace(/:\d+$/, '')
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(site)
}

function isJsonOk(raw: string): boolean {
  try {
    JSON.parse(raw)
    return true
  } catch {
    return false
  }
}

function ToolsSection({ businessId, userId }: { businessId: string; userId: string }) {
  const { toast } = useToast()
  const qc = useQueryClient()

  const toolsQ = useQuery({
    queryKey: QUERY_KEYS.tools(businessId, userId),
    queryFn: () => api.tools(businessId, userId),
  })
  const tools = toolsQ.data ?? []

  const invalidate = () => qc.invalidateQueries({ queryKey: QUERY_KEYS.tools(businessId, userId) })

  // — add dialog state
  const [addOpen, setAddOpen] = useState(false)
  const [tName, setTName] = useState('')
  const [tKind, setTKind] = useState<ToolKind>('web_source')
  const [tSite, setTSite] = useState('')
  const [tQuery, setTQuery] = useState('')
  const [tUrl, setTUrl] = useState('')
  const [tMethod, setTMethod] = useState<'GET' | 'POST'>('GET')
  const [tBody, setTBody] = useState('')
  const [addBusy, setAddBusy] = useState(false)

  // — delete confirm state
  const [deleting, setDeleting] = useState<CustomToolDTO | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  // — live inline validation (Egyptian Arabic), computed — no extra state
  const name = tName.trim()
  const nameErr = name.length > 0 && name.length < 2 ? 'الاسم قصير أوي — حرفين على الأقل' : null
  const siteVal = tSite.trim()
  const siteErr =
    tKind === 'web_source' && siteVal.length > 0 && !looksLikeSite(siteVal)
      ? 'اكتبه زي drogal.com — من غير http'
      : null
  const urlVal = tUrl.trim()
  const urlErr =
    tKind === 'webhook' && urlVal.length > 0 && !/^https?:\/\/.+/i.test(urlVal)
      ? 'لازم رابط كامل يبدأ بـ http أو https'
      : null
  const bodyVal = tBody.trim()
  const bodyErr =
    tKind === 'webhook' && tMethod === 'POST' && bodyVal.length > 0 && !isJsonOk(bodyVal)
      ? 'الـbody لازم يكون JSON سليم — زي { }'
      : null
  const canSubmit =
    !addBusy &&
    name.length >= 2 &&
    name.length <= TOOL_NAME_MAX &&
    (tKind === 'web_source'
      ? siteVal.length > 0 && !siteErr
      : urlVal.length > 0 && !urlErr && !bodyErr)

  const submitAdd = async () => {
    if (!canSubmit) return
    setAddBusy(true)
    try {
      await api.createTool({
        businessId,
        userId,
        name,
        kind: tKind,
        config:
          tKind === 'web_source'
            ? { site: siteVal, ...(tQuery.trim() ? { queryTemplate: tQuery.trim() } : {}) }
            : { url: urlVal, method: tMethod, ...(bodyVal ? { bodyTemplate: bodyVal } : {}) },
      })
      toast({ title: 'الأداة اتحفظت ✅', description: 'وكيل هيجربها بنفسه في البحث العميق الجاي' })
      setAddOpen(false)
      setTName('')
      setTKind('web_source')
      setTSite('')
      setTQuery('')
      setTUrl('')
      setTMethod('GET')
      setTBody('')
      await invalidate()
    } catch (err) {
      toast({
        title: 'الحفظ مانفذش',
        description: err instanceof Error ? err.message : 'جرّب تاني',
        variant: 'destructive',
      })
    } finally {
      setAddBusy(false)
    }
  }

  const toggleTool = async (t: CustomToolDTO) => {
    try {
      await api.updateTool(t.id, { active: !t.active })
      toast({
        title: t.active
          ? 'وقفتها — وكيل مش هيستخدمها في البحث دلوقتي'
          : 'رجعت شغالة — وكيل هيستخدمها تاني ✅',
      })
      await invalidate()
    } catch (err) {
      toast({
        title: 'التغيير مانفذش',
        description: err instanceof Error ? err.message : 'جرّب تاني',
        variant: 'destructive',
      })
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    setDeleteBusy(true)
    try {
      await api.deleteTool(deleting.id)
      toast({ title: 'اتمسحت الأداة', description: deleting.name })
      setDeleting(null)
      await invalidate()
    } catch (err) {
      toast({
        title: 'المسح مانفذش',
        description: err instanceof Error ? err.message : 'جرّب تاني',
        variant: 'destructive',
      })
    } finally {
      setDeleteBusy(false)
    }
  }

  return (
    <SectionCard
      title="أدوات بتاعتك"
      subtitle="زي الـskills: أضف مصادر أو أوامر يقولك عليها وكيل وقت البحث"
      icon={Wrench}
      action={
        <Button size="sm" className="min-h-11" onClick={() => setAddOpen(true)}>
          <Plus className="size-4" aria-hidden /> أداة جديدة
        </Button>
      }
      className="list-enter"
    >
      {toolsQ.isPending ? (
        <div className="space-y-2.5" aria-busy="true" role="status" aria-label="بيتحمّل أدواتك">
          <div className="skel h-16 rounded-xl" />
          <div className="skel h-16 rounded-xl" />
        </div>
      ) : toolsQ.isError ? (
        <p className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {toolsQ.error instanceof Error ? toolsQ.error.message : 'تعذر تحميل الأدوات'}{' '}
          <button
            type="button"
            className="underline underline-offset-4 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={() => void toolsQ.refetch()}
          >
            جرّب تاني
          </button>
        </p>
      ) : tools.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title="لسه مفيش أدوات"
          hint="جرّب: أضف موقع بيبيع بضاعتك وخلي وكيل يقارن أسعار منه وقت البحث."
        />
      ) : (
        <ul className="space-y-2.5">
          {tools.map((t, i) => (
            <ToolRow
              key={t.id}
              tool={t}
              index={i}
              busy={deleteBusy}
              onToggle={() => void toggleTool(t)}
              onDelete={() => setDeleting(t)}
            />
          ))}
        </ul>
      )}

      {/* — add-tool dialog — */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>أداة جديدة بتاعتك</DialogTitle>
            <DialogDescription>
              وكيل بيستخدم أدواتك بنفسه وقت البحث العميق — بيقرا النتايج بس، عمره ما بينفّذ حاجة منها.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="tool-name" className="text-xs">
                اسم الأداة <span className="text-muted-foreground">(٦٠ حرف بالكثير)</span>
              </Label>
              <Input
                id="tool-name"
                value={tName}
                onChange={(e) => setTName(e.target.value)}
                placeholder="مثلاً: أسعار المنظفات من دروجال"
                className="h-11"
                maxLength={TOOL_NAME_MAX}
                aria-invalid={nameErr ? true : undefined}
              />
              {nameErr && <p className="text-xs text-destructive">{nameErr}</p>}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">نوع الأداة</Label>
              <Select value={tKind} onValueChange={(v) => setTKind(v as ToolKind)}>
                <SelectTrigger size="sm" className="h-11 w-full" aria-label="نوع الأداة">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="web_source">{TOOL_KIND_META.web_source.option}</SelectItem>
                  <SelectItem value="webhook">{TOOL_KIND_META.webhook.option}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {tKind === 'web_source' ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="tool-site" className="text-xs">
                    الموقع
                  </Label>
                  <Input
                    id="tool-site"
                    value={tSite}
                    onChange={(e) => setTSite(e.target.value)}
                    placeholder="drogal.com"
                    className="h-11"
                    dir="ltr"
                    aria-invalid={siteErr ? true : undefined}
                  />
                  {siteErr && <p className="text-xs text-destructive">{siteErr}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tool-query" className="text-xs">
                    كلمة البحث <span className="text-muted-foreground">(اختياري)</span>
                  </Label>
                  <Input
                    id="tool-query"
                    value={tQuery}
                    onChange={(e) => setTQuery(e.target.value)}
                    placeholder="أسعار المنظفات"
                    className="h-11"
                  />
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="tool-url" className="text-xs">
                    الرابط
                  </Label>
                  <Input
                    id="tool-url"
                    value={tUrl}
                    onChange={(e) => setTUrl(e.target.value)}
                    placeholder="https://example.com/api/prices"
                    className="h-11"
                    dir="ltr"
                    aria-invalid={urlErr ? true : undefined}
                  />
                  {urlErr && <p className="text-xs text-destructive">{urlErr}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">الطريقة</Label>
                  <Select value={tMethod} onValueChange={(v) => setTMethod(v === 'POST' ? 'POST' : 'GET')}>
                    <SelectTrigger size="sm" className="h-11 w-40" aria-label="طريقة الطلب">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="GET">GET — بيانات بس</SelectItem>
                      <SelectItem value="POST">POST — بـbody</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {tMethod === 'POST' && (
                  <div className="space-y-1.5">
                    <Label htmlFor="tool-body" className="text-xs">
                      الـbody <span className="text-muted-foreground">(اختياري — JSON)</span>
                    </Label>
                    <Textarea
                      id="tool-body"
                      value={tBody}
                      onChange={(e) => setTBody(e.target.value)}
                      placeholder="{ }"
                      rows={3}
                      className="resize-none font-mono"
                      dir="ltr"
                      aria-invalid={bodyErr ? true : undefined}
                    />
                    {bodyErr && <p className="text-xs text-destructive">{bodyErr}</p>}
                  </div>
                )}
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" className="min-h-10" onClick={() => setAddOpen(false)} disabled={addBusy}>
              إلغاء
            </Button>
            <Button className="min-h-11" disabled={!canSubmit} onClick={() => void submitAdd()}>
              {addBusy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Wrench className="size-4" aria-hidden />
              )}
              ضيف الأداة
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* — delete confirm — */}
      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>امسح «{deleting?.name ?? ''}»؟</AlertDialogTitle>
            <AlertDialogDescription>
              وكيل مش هيشوف الأداة دي تاني وقت البحث — لو احتجتها تضيفها من الأول.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-10">لأ، سيبها</AlertDialogCancel>
            <AlertDialogAction
              className="min-h-10 bg-destructive text-white hover:bg-destructive/90"
              onClick={() => void confirmDelete()}
              disabled={deleteBusy}
            >
              {deleteBusy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
              امسحها
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  )
}

function ToolRow({
  tool: t,
  index,
  busy,
  onToggle,
  onDelete,
}: {
  tool: CustomToolDTO
  index: number
  busy: boolean
  onToggle: () => void
  onDelete: () => void
}) {
  const meta = TOOL_KIND_META[t.kind] ?? TOOL_KIND_META.web_source
  const target = t.kind === 'web_source' ? t.config.site ?? '' : t.config.url ?? ''
  return (
    <li
      className="chip-lift list-enter group flex items-start justify-between gap-2 rounded-xl border bg-card p-3.5 shadow-sm hover:border-wakil-amber/30"
      style={{ animationDelay: `${Math.min(index, 10) * 40}ms` }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <p className="truncate text-sm font-semibold">{t.name}</p>
          <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold', meta.chip)}>
            {meta.label}
          </span>
        </div>
        {target && (
          <p dir="ltr" className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
            {target}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">
          <span>
            {t.usageCount > 0 ? (
              <>
                استخدمها وكيل <span className="num tabular-nums">{arNum(t.usageCount)}</span>{' '}
                {t.usageCount === 1 ? 'مرة' : 'مرات'}
              </>
            ) : (
              'لسه وكيل ما استخدمهاش'
            )}
          </span>
          {t.lastUsedAt && <span>آخر استخدام {relTimeAr(t.lastUsedAt)}</span>}
          {t.kind === 'web_source' && t.config.queryTemplate && (
            <span title="كلمة البحث اللي وكيل بيستخدمها مع الموقع">بيدور على «{t.config.queryTemplate}»</span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <SwitchHit
          checked={t.active}
          onToggle={onToggle}
          ariaLabel={t.active ? `وقّف أداة ${t.name}` : `شغّل أداة ${t.name}`}
          disabled={busy}
        />
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          title="امسحها"
          aria-label={`امسح أداة ${t.name} نهائيًا`}
          className="focus-warm flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      </div>
    </li>
  )
}

/** 44×44 hit-area switch — the visual Switch is pointer-events-none,
 *  this wrapper carries the semantics and the touch target. */
function SwitchHit({
  checked,
  onToggle,
  ariaLabel,
  disabled,
}: {
  checked: boolean
  onToggle: (next: boolean) => void
  ariaLabel: string
  disabled?: boolean
}) {
  return (
    <span
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      tabIndex={disabled ? -1 : 0}
      onClick={() => !disabled && onToggle(!checked)}
      onKeyDown={(e) => {
        if (disabled) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onToggle(!checked)
        }
      }}
      className={cn(
        'flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <Switch checked={checked} className="pointer-events-none" tabIndex={-1} />
    </span>
  )
}
