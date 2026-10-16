'use client'

// وكيل — NotesSheet: «ورقة وكيل» — the agent's scratchpad for THIS conversation
// (R15 «موظف حقيقي»: ورقة وقلم). وكيل بيكتب ملاحظات وهو بيشتغل — حقايق
// بمراجعها، فرضيات، مهات مؤجلة، خطط، ومصادر — والمستخدم بيقراها هنا.
// READ-ONLY by design: no edit/delete/pin actions — the paper belongs to the
// agent. Same sheet geometry as ConversationDrawer: slides in from the
// physical RIGHT (the RTL start side), soft spring, backdrop blur, Escape
// closes. Rows: kind chip + text + source ref (mono) + Arabic relative time;
// pinned first, then newest-first.

import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { NotebookPen, Pin, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { QUERY_KEYS } from '@/lib/store'
import type { NoteDTO } from '@/lib/types'
import { arRelative } from './ConversationDrawer'
import { cn } from '@/lib/utils'

const arNum = (n: number): string => new Intl.NumberFormat('ar-EG').format(n)

/** Wrap every digit-run in a .num span so numbers stay LTR inside RTL text. */
function withNums(text: string): React.ReactNode {
  if (!text) return text
  const parts = text.split(
    /(\[[\u0660-\u0669\u066B\u066C\u06F0-\u06F9\d.,]+\]|[\u0660-\u0669\u066B\u066C\u06F0-\u06F9][\u0660-\u0669\u066B\u066C\u06F0-\u06F9.,]*|\d[\d.,]*)/g,
  )
  if (parts.length === 1) return text
  return parts.map((p, i) =>
    i % 2 === 1 && p ? <span key={i} className="num">{p}</span> : p,
  )
}

// kind → label + tint: حقيقة=teal · فرضية=amber · مهمة=navy · خطة=violet ·
// مصدر=rose (wakil tokens where they exist, Tailwind palette otherwise)
const KIND_META: Record<NoteDTO['kind'], { label: string; className: string }> = {
  fact: { label: 'حقيقة', className: 'bg-[var(--wakil-teal)]/10 text-[var(--wakil-teal)]' },
  hypothesis: { label: 'فرضية', className: 'bg-[var(--wakil-amber)]/15 text-[var(--wakil-amber)]' },
  todo: { label: 'مهمة', className: 'bg-[var(--wakil-navy)]/10 text-[var(--wakil-navy)]' },
  plan: { label: 'خطة', className: 'bg-violet-500/10 text-violet-600 dark:text-violet-400' },
  citation: { label: 'مصدر', className: 'bg-rose-500/10 text-rose-600 dark:text-rose-400' },
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------
export function NotesSheet({
  businessId,
  conversationId,
  onClose,
}: {
  businessId: string
  /** the conversation whose scratchpad is shown (the loaded one) */
  conversationId: string
  onClose: () => void
}) {
  const notesQ = useQuery({
    queryKey: QUERY_KEYS.notes(businessId, conversationId),
    queryFn: () => api.notes(businessId, conversationId),
    retry: 1,
  })

  // pinned first, then newest-first (the server orders too — enforced locally)
  const notes = [...(notesQ.data ?? [])].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.createdAt.localeCompare(a.createdAt)
  })

  // Escape closes (same as the conversations drawer)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="absolute inset-0 z-40" role="dialog" aria-modal="true" aria-label="ورقة وكيل">
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
        {/* header — same geometry/styling as the conversations drawer */}
        <div className="flex shrink-0 items-center justify-between gap-1.5 border-b border-border/70 px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <NotebookPen className="size-4 shrink-0 text-wakil-amber" aria-hidden="true" />
            <h2 className="text-sm font-bold">ورقة وكيل</h2>
            {!notesQ.isPending && notes.length > 0 && (
              <Badge variant="secondary" className="num h-5 min-w-5 px-1.5 text-[10px] tabular-nums">
                {arNum(notes.length)}
              </Badge>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-9 text-muted-foreground"
            aria-label="اقفل ورقة وكيل"
            onClick={onClose}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>

        {/* subtitle */}
        <p className="shrink-0 px-3 pb-2 pt-2.5 text-[11px] leading-relaxed text-muted-foreground">
          ملاحظاته من شغله في المحادثة دي
        </p>

        {/* the notes timeline — scrolls after 60vh */}
        <div className="scroll-warm max-h-[60vh] overflow-y-auto px-2.5 pb-2">
          {notesQ.isPending ? (
            <div className="flex flex-col gap-2" role="status" aria-label="بيحمّل ورقة وكيل" aria-busy="true">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex flex-col gap-2 rounded-lg border border-border/70 bg-muted/30 p-2.5">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-5 w-12 rounded-full" />
                    <Skeleton className="ms-auto h-3.5 w-14" />
                  </div>
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              ))}
            </div>
          ) : notesQ.isError ? (
            <div className="px-3 py-8 text-center">
              <p className="text-sm text-destructive">
                {notesQ.error instanceof Error ? notesQ.error.message : 'تعذر تحميل ورقة وكيل'}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3 min-h-11 rounded-full"
                onClick={() => void notesQ.refetch()}
              >
                جرّب تاني
              </Button>
            </div>
          ) : notes.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <span className="flex size-11 items-center justify-center rounded-full bg-accent text-wakil-amber">
                <NotebookPen className="size-5" aria-hidden="true" />
              </span>
              <p className="text-sm font-medium">لسه ملاحظاتش حاجة</p>
              <p className="text-xs text-muted-foreground">لما يشغّل أدوات ويبحث هيكتب هنا</p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {notes.map((n, i) => (
                <NoteRow key={n.id} note={n} index={i} />
              ))}
            </ul>
          )}
        </div>

        {/* read-only footer — anchors the full-height panel */}
        <p className="mt-auto shrink-0 border-t border-border/70 px-3 py-2.5 text-[10px] leading-relaxed text-muted-foreground">
          وكيل هو اللي بيكتب الورقة دي وهو شغّال — انت بتقراها بس
        </p>
      </motion.aside>
    </div>
  )
}

// ---------------------------------------------------------------------------
// One note row: kind chip · pin mark · relative time / text / source ref
// ---------------------------------------------------------------------------
function NoteRow({ note, index }: { note: NoteDTO; index: number }) {
  const meta = KIND_META[note.kind] ?? KIND_META.fact
  return (
    <motion.li
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut', delay: Math.min(index * 0.03, 0.15) }}
      className="list-none rounded-lg border border-border/70 bg-muted/30 p-2.5"
    >
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            'inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[10px] font-semibold',
            meta.className,
          )}
        >
          {meta.label}
        </span>
        {note.pinned && (
          <span className="flex shrink-0 items-center gap-0.5 text-[10px] font-medium text-wakil-amber">
            <Pin className="size-3" aria-hidden="true" />
            مثبتة
          </span>
        )}
        <span className="ms-auto shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">
          {arRelative(note.createdAt)}
        </span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-xs leading-6">{withNums(note.text)}</p>
      {note.source ? (
        <p className="mt-1 truncate font-mono text-xs text-muted-foreground" dir="ltr" title={note.source}>
          {note.source}
        </p>
      ) : null}
    </motion.li>
  )
}
