'use client'

// وكيل — ConversationDrawer: سجل المحادثات القديمة (ChatGPT-style sidebar).
// Slides in from the RIGHT (the RTL start side) over the messages with a soft
// spring. Rows: title + last-message preview + Arabic relative time + count
// chip; hover reveals pin / rename / delete. Pinned conversations float in a
// «مثبتة» section above «الأحدث». Switching = setActive + close; deleting the
// active conversation falls back to the most recent remaining (or a fresh one).

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  Loader2,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Search,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react'

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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { QUERY_KEYS } from '@/lib/store'
import type { ConversationSummaryDTO } from '@/lib/types'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { arDate, daysBetween, startOfDay } from '@/lib/format'

// ---------------------------------------------------------------------------
// Arabic relative time — Egyptian dialect («قبل ساعتين» / «امبارح» / «قبل ٣ أيام»)
// ---------------------------------------------------------------------------
const arNumLocal = (n: number): string => new Intl.NumberFormat('ar-EG').format(n)

export function arRelative(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const diffSec = Math.floor((now.getTime() - d.getTime()) / 1000)
  if (diffSec < 60) return 'الآن'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) {
    if (diffMin === 1) return 'قبل دقيقة'
    if (diffMin === 2) return 'قبل دقيقتين'
    return `قبل ${arNumLocal(diffMin)} دقيقة`
  }
  const diffHr = Math.floor(diffMin / 60)
  const dayDiff = daysBetween(startOfDay(d), startOfDay(now))
  if (dayDiff <= 0) {
    if (diffHr === 1) return 'قبل ساعة'
    if (diffHr === 2) return 'قبل ساعتين'
    return `قبل ${arNumLocal(diffHr)} ساعة`
  }
  if (dayDiff === 1) return 'امبارح'
  if (dayDiff === 2) return 'قبل يومين'
  if (dayDiff < 7) return `قبل ${arNumLocal(dayDiff)} أيام`
  const weeks = Math.floor(dayDiff / 7)
  if (weeks < 5) {
    if (weeks === 1) return 'قبل أسبوع'
    if (weeks === 2) return 'قبل أسبوعين'
    return `قبل ${arNumLocal(weeks)} أسابيع`
  }
  const months = Math.floor(dayDiff / 30)
  if (months < 12) {
    if (months === 1) return 'قبل شهر'
    if (months === 2) return 'قبل شهرين'
    return `قبل ${arNumLocal(months)} شهور`
  }
  return arDate(d)
}

// ---------------------------------------------------------------------------
// The drawer
// ---------------------------------------------------------------------------
export function ConversationDrawer({
  businessId,
  userId,
  activeId,
  onClose,
  onSwitch,
  onNewChat,
  creating,
}: {
  businessId: string
  userId: string
  /** currently-loaded conversation id (row highlight) */
  activeId: string | null
  onClose: () => void
  onSwitch: (id: string) => void
  onNewChat: () => void
  creating?: boolean
}) {
  const qc = useQueryClient()
  const { toast } = useToast()

  const convsQ = useQuery({
    queryKey: QUERY_KEYS.conversations(businessId, userId),
    queryFn: () => api.conversations(businessId, userId),
  })
  const conversations = convsQ.data ?? []
  const cacheKey = QUERY_KEYS.conversations(businessId, userId)

  const [search, setSearch] = useState('')
  const [renaming, setRenaming] = useState<ConversationSummaryDTO | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [deleting, setDeleting] = useState<ConversationSummaryDTO | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const searchRef = useRef<HTMLInputElement>(null)

  // focus the search field on open + Escape closes
  useEffect(() => {
    searchRef.current?.focus()
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const filtered = useMemo(() => {
    const q = search.trim()
    if (!q) return conversations
    return conversations.filter((c) => c.title.includes(q) || c.preview.includes(q))
  }, [conversations, search])
  const pinnedRows = filtered.filter((c) => c.pinned)
  const restRows = filtered.filter((c) => !c.pinned)

  const invalidate = () => qc.invalidateQueries({ queryKey: cacheKey })
  const showError = (err: unknown) =>
    toast({
      title: 'مشكلة',
      description: err instanceof Error ? err.message : 'جرّب تاني',
      variant: 'destructive',
    })

  const handlePin = async (c: ConversationSummaryDTO) => {
    // optimistic flip, then persist + refetch (order fix)
    qc.setQueryData<ConversationSummaryDTO[]>(cacheKey, (old) =>
      old?.map((x) => (x.id === c.id ? { ...x, pinned: !c.pinned } : x)),
    )
    try {
      await api.updateConversation(c.id, { pinned: !c.pinned })
      toast({ title: c.pinned ? 'تم فك التثبيت' : 'تم تثبيت المحادثة' })
      await invalidate()
    } catch (err) {
      showError(err)
      await invalidate()
    }
  }

  const handleRename = async () => {
    if (!renaming) return
    const title = renameValue.trim()
    if (!title || renameBusy) return
    setRenameBusy(true)
    try {
      await api.updateConversation(renaming.id, { title })
      qc.setQueryData<ConversationSummaryDTO[]>(cacheKey, (old) =>
        old?.map((x) => (x.id === renaming.id ? { ...x, title } : x)),
      )
      toast({ title: 'تم تعديل العنوان' })
      setRenaming(null)
      await invalidate()
    } catch (err) {
      showError(err)
    } finally {
      setRenameBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!deleting) return
    const target = deleting
    setDeleteBusy(true)
    // pick the most-recent REMAINING conversation (ignores pinned ordering)
    const remaining = conversations.filter((c) => c.id !== target.id)
    const next = [...remaining].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))[0]
    try {
      await api.deleteConversation(target.id)
      qc.setQueryData<ConversationSummaryDTO[]>(cacheKey, (old) =>
        old?.filter((x) => x.id !== target.id),
      )
      toast({ title: 'اتمسحت المحادثة', description: `«${target.title}» بكل رسائلها` })
      setDeleting(null)
      if (target.id === activeId) {
        if (next) onSwitch(next.id)
        else onNewChat()
      }
      await invalidate()
    } catch (err) {
      showError(err)
    } finally {
      setDeleteBusy(false)
    }
  }

  return (
    <div className="absolute inset-0 z-40" role="dialog" aria-modal="true" aria-label="سجل المحادثات">
      {/* backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* panel — slides in from the physical RIGHT (RTL start side) */}
      <motion.aside
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        transition={{ type: 'spring', stiffness: 400, damping: 36 }}
        className="absolute inset-y-0 right-0 flex h-full w-[19rem] max-w-[85vw] flex-col border-e border-border bg-card shadow-2xl"
      >
        {/* header */}
        <div className="flex shrink-0 items-center justify-between gap-1.5 border-b border-border/70 px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <h2 className="text-sm font-bold">المحادثات</h2>
            {!convsQ.isPending && conversations.length > 0 && (
              <Badge variant="secondary" className="num h-5 min-w-5 px-1.5 text-[10px] tabular-nums">
                {arNumLocal(conversations.length)}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="size-9 text-wakil-amber"
              aria-label="محادثة جديدة"
              title="محادثة جديدة"
              onClick={onNewChat}
              disabled={creating}
            >
              {creating ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <SquarePen className="size-4" aria-hidden="true" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-9 text-muted-foreground"
              aria-label="اقفل سجل المحادثات"
              onClick={onClose}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>

        {/* search */}
        <div className="relative shrink-0 px-3 py-2">
          <Search
            className="pointer-events-none absolute start-[1.35rem] top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="دوّر في محادثاتك…"
            aria-label="دوّر في المحادثات"
            className="h-9 rounded-lg bg-muted/40 ps-9"
          />
        </div>

        {/* list */}
        <div className="scroll-warm min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {convsQ.isPending ? (
            <div className="space-y-1.5" role="status" aria-label="بيحمّل المحادثات" aria-busy="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="skel h-14 w-full rounded-lg" />
              ))}
            </div>
          ) : convsQ.isError ? (
            <div className="px-3 py-8 text-center">
              <p className="text-sm text-destructive">
                {convsQ.error instanceof Error ? convsQ.error.message : 'تعذر تحميل المحادثات'}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3 min-h-11 rounded-full"
                onClick={() => void convsQ.refetch()}
              >
                جرّب تاني
              </Button>
            </div>
          ) : conversations.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <span className="flex size-11 items-center justify-center rounded-full bg-accent text-wakil-amber">
                <MessageSquare className="size-5" aria-hidden="true" />
              </span>
              <p className="text-sm font-medium">لسه مفيش محادثات قديمة</p>
              <p className="text-xs text-muted-foreground">ابدأ واحدة جديدة 👋</p>
              <Button
                className="mt-1 min-h-11 rounded-full"
                onClick={onNewChat}
                disabled={creating}
              >
                {creating ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <SquarePen className="size-4" aria-hidden="true" />
                )}
                محادثة جديدة
              </Button>
            </div>
          ) : filtered.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">
              مفيش محادثة فيها «{search.trim()}»
            </p>
          ) : (
            <>
              {pinnedRows.length > 0 && (
                <Section label="مثبتة" icon={Pin} count={pinnedRows.length} />
              )}
              <ul className="space-y-0.5">
                {pinnedRows.map((c, i) => (
                  <ConversationRow
                    key={c.id}
                    c={c}
                    index={i}
                    active={c.id === activeId}
                    onSwitch={onSwitch}
                    onPin={() => void handlePin(c)}
                    onRename={() => {
                      setRenaming(c)
                      setRenameValue(c.title)
                    }}
                    onDelete={() => setDeleting(c)}
                  />
                ))}
              </ul>
              {pinnedRows.length > 0 && restRows.length > 0 && (
                <div className="my-2 border-t border-border/60" aria-hidden="true" />
              )}
              {restRows.length > 0 && <Section label="الأحدث" icon={MessageSquare} count={restRows.length} />}
              <ul className="space-y-0.5">
                {restRows.map((c, i) => (
                  <ConversationRow
                    key={c.id}
                    c={c}
                    index={i}
                    active={c.id === activeId}
                    onSwitch={onSwitch}
                    onPin={() => void handlePin(c)}
                    onRename={() => {
                      setRenaming(c)
                      setRenameValue(c.title)
                    }}
                    onDelete={() => setDeleting(c)}
                  />
                ))}
              </ul>
            </>
          )}
        </div>
      </motion.aside>

      {/* rename dialog */}
      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent dir="rtl" className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>غيّر اسم المحادثة</DialogTitle>
            <DialogDescription>الاسم الجديد هيظهر في سجل المحادثات على طول.</DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            autoFocus
            maxLength={80}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleRename()
              }
            }}
            aria-label="اسم المحادثة الجديد"
            className="h-11"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)} disabled={renameBusy}>
              سيبها
            </Button>
            <Button onClick={() => void handleRename()} disabled={renameBusy || !renameValue.trim()}>
              {renameBusy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              حفظ الاسم
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* delete confirm */}
      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>امسح المحادثة؟</AlertDialogTitle>
            <AlertDialogDescription>
              «{deleting?.title}» هتمسح بكل رسائلها — دي مش هترجع.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>خليها</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault()
                void handleDelete()
              }}
              disabled={deleteBusy}
            >
              {deleteBusy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="size-4" aria-hidden="true" />
              )}
              امسحها
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Row + section label
// ---------------------------------------------------------------------------
function Section({ label, icon: Icon, count }: { label: string; icon: typeof Pin; count: number }) {
  return (
    <p className="flex items-center gap-1 px-2 pb-1 pt-2 text-[11px] font-semibold text-muted-foreground">
      <Icon className="size-3" aria-hidden="true" />
      {label}
      <span className="num text-[10px] font-normal tabular-nums">({arNumLocal(count)})</span>
    </p>
  )
}

function ConversationRow({
  c,
  index,
  active,
  onSwitch,
  onPin,
  onRename,
  onDelete,
}: {
  c: ConversationSummaryDTO
  index: number
  active: boolean
  onSwitch: (id: string) => void
  onPin: () => void
  onRename: () => void
  onDelete: () => void
}) {
  return (
    <motion.li
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut', delay: Math.min(index * 0.03, 0.18) }}
      className="group relative list-none"
    >
      <button
        type="button"
        onClick={() => onSwitch(c.id)}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'flex min-h-12 w-full flex-col gap-0.5 rounded-lg border-r-2 px-3 py-2 text-start transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
          active ? 'border-r-wakil-amber bg-accent/70' : 'border-r-transparent hover:bg-muted/50',
        )}
      >
        <span className="flex items-center gap-1.5 pe-28">
          {c.pinned && <Pin className="size-3 shrink-0 text-wakil-amber" aria-hidden="true" />}
          <span className="truncate text-xs font-semibold">{c.title}</span>
        </span>
        <span className="flex items-center gap-1.5 pe-28 text-[10px] text-muted-foreground">
          <span className="truncate">{c.preview || 'لسه مفيش رسائل'}</span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0 whitespace-nowrap">{arRelative(c.lastMessageAt)}</span>
          <span className="num flex shrink-0 items-center gap-0.5 rounded-full bg-muted px-1.5 py-px tabular-nums">
            <MessageSquare className="size-2.5" aria-hidden="true" />
            {arNumLocal(c.messageCount)}
          </span>
        </span>
      </button>

      {/* hover / focus actions (always visible on touch screens) */}
      <div className="absolute end-1 top-1/2 flex -translate-y-1/2 gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
        <Button
          variant="ghost"
          size="icon"
          className="size-9 rounded-lg text-muted-foreground hover:text-wakil-amber"
          aria-label={c.pinned ? `فك تثبيت ${c.title}` : `ثبّت ${c.title}`}
          title={c.pinned ? 'فك التثبيت' : 'ثبّت'}
          onClick={onPin}
        >
          {c.pinned ? <PinOff className="size-3.5" aria-hidden="true" /> : <Pin className="size-3.5" aria-hidden="true" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-9 rounded-lg text-muted-foreground"
          aria-label={`غيّر اسم ${c.title}`}
          title="غيّر الاسم"
          onClick={onRename}
        >
          <Pencil className="size-3.5" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-9 rounded-lg text-muted-foreground hover:text-destructive"
          aria-label={`امسح ${c.title}`}
          title="امسح"
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
    </motion.li>
  )
}
