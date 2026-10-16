'use client'

// وكيل — QuickCommandsManager: «أدواتك السريعة» — الأدوات اللي المستخدم
// يضيفها بنفسه (user-extensible tools). Cards list + add form + reorder +
// edit dialog (label + prompt + icon picker) + delete confirm. Embedded in
// SettingsView; the same data powers the pinned chips row in the Composer.

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'
import {
  AlertTriangle,
  BarChart3,
  BookOpen,
  Boxes,
  ChevronDown,
  ChevronUp,
  LayoutGrid,
  Loader2,
  MessageSquareText,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Users,
  Wallet,
  Wrench,
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
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { QUERY_KEYS } from '@/lib/store'
import type { QuickCommandDTO } from '@/lib/types'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { arNum } from '../views/shared'

// ---------------------------------------------------------------------------
// Shared icon registry (spark | boxes | users | wallet | chart | book | today
// | alert) — the SAME set powers suggestion chips + composer chips + manager.
// ---------------------------------------------------------------------------
export const TOOL_ICONS: Record<string, LucideIcon> = {
  spark: Sparkles,
  boxes: Boxes,
  users: Users,
  wallet: Wallet,
  chart: BarChart3,
  book: BookOpen,
  today: LayoutGrid,
  alert: AlertTriangle,
}

export const TOOL_ICON_KEYS = Object.keys(TOOL_ICONS)

const ICON_AR: Record<string, string> = {
  spark: 'شرارة',
  boxes: 'مخزون',
  users: 'ناس',
  wallet: 'فلوس',
  chart: 'أرقام',
  book: 'دفتر',
  today: 'اليوم',
  alert: 'تنبيه',
}

const MAX_LABEL = 24
const MAX_PROMPT = 200

/** Render one tool icon (falls back to the spark when unknown). */
export function ToolIcon({ icon, className }: { icon: string; className?: string }) {
  const Icon = TOOL_ICONS[icon] ?? Sparkles
  return <Icon className={className} aria-hidden="true" />
}

// ---------------------------------------------------------------------------
// Icon picker — radio group of the 8 allowed icons
// ---------------------------------------------------------------------------
function IconPicker({ value, onChange, groupLabel }: { value: string; onChange: (v: string) => void; groupLabel: string }) {
  return (
    <div role="radiogroup" aria-label={groupLabel} className="flex flex-wrap gap-1.5">
      {TOOL_ICON_KEYS.map((key) => {
        const Icon = TOOL_ICONS[key]
        const active = value === key
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={ICON_AR[key]}
            title={ICON_AR[key]}
            onClick={() => onChange(key)}
            className={cn(
              'press flex size-11 items-center justify-center rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              active
                ? 'border-wakil-amber/70 bg-wakil-amber/15 text-wakil-amber'
                : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="size-4.5" aria-hidden="true" />
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------
export function QuickCommandsManager({ businessId, userId }: { businessId: string; userId: string }) {
  const qc = useQueryClient()
  const { toast } = useToast()

  const cmdsQ = useQuery({
    queryKey: QUERY_KEYS.quickCommands(businessId),
    queryFn: () => api.quickCommands(businessId),
  })
  const commands = cmdsQ.data ?? []

  // — add form
  const [aLabel, setALabel] = useState('')
  const [aPrompt, setAPrompt] = useState('')
  const [aIcon, setAIcon] = useState('spark')
  const [addBusy, setAddBusy] = useState(false)

  // — edit dialog
  const [editing, setEditing] = useState<QuickCommandDTO | null>(null)
  const [eLabel, setELabel] = useState('')
  const [ePrompt, setEPrompt] = useState('')
  const [eIcon, setEIcon] = useState('spark')
  const [editBusy, setEditBusy] = useState(false)

  // — delete confirm
  const [deleting, setDeleting] = useState<QuickCommandDTO | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const invalidate = () => qc.invalidateQueries({ queryKey: QUERY_KEYS.quickCommands(businessId) })

  const handleAdd = async () => {
    const label = aLabel.trim()
    const prompt = aPrompt.trim()
    if (!label || !prompt || addBusy) return
    setAddBusy(true)
    try {
      await api.createQuickCommand({ businessId, userId, label, prompt, icon: aIcon })
      setALabel('')
      setAPrompt('')
      setAIcon('spark')
      toast({ title: 'تمت إضافة الأداة', description: `${label} — هتظهر فوق شاشة المحادثة` })
      await invalidate()
    } catch (err) {
      toast({
        title: 'مشكلة',
        description: err instanceof Error ? err.message : 'جرّب تاني',
        variant: 'destructive',
      })
    } finally {
      setAddBusy(false)
    }
  }

  const openEdit = (c: QuickCommandDTO) => {
    setEditing(c)
    setELabel(c.label)
    setEPrompt(c.prompt)
    setEIcon(c.icon)
  }

  const handleEdit = async () => {
    if (!editing) return
    const label = eLabel.trim()
    const prompt = ePrompt.trim()
    if (!label || !prompt || editBusy) return
    setEditBusy(true)
    try {
      await api.updateQuickCommand(editing.id, { label, prompt, icon: eIcon })
      toast({ title: 'تم تعديل الأداة' })
      setEditing(null)
      await invalidate()
    } catch (err) {
      toast({
        title: 'مشكلة',
        description: err instanceof Error ? err.message : 'جرّب تاني',
        variant: 'destructive',
      })
    } finally {
      setEditBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!deleting) return
    setDeleteBusy(true)
    try {
      await api.deleteQuickCommand(deleting.id)
      toast({ title: 'تم مسح الأداة', description: deleting.label })
      setDeleting(null)
      await invalidate()
    } catch (err) {
      toast({
        title: 'مشكلة',
        description: err instanceof Error ? err.message : 'جرّب تاني',
        variant: 'destructive',
      })
    } finally {
      setDeleteBusy(false)
    }
  }

  const handleMove = async (index: number, dir: -1 | 1) => {
    const target = index + dir
    if (target < 0 || target >= commands.length) return
    const next = [...commands]
    ;[next[index], next[target]] = [next[target], next[index]]
    // optimistic renumber (sortOrder = index) then persist the deltas
    qc.setQueryData(
      QUERY_KEYS.quickCommands(businessId),
      next.map((c, i) => ({ ...c, sortOrder: i })),
    )
    try {
      await Promise.all(
        next.map((c, i) => (commands[index].id === c.id || commands[target].id === c.id
          ? api.updateQuickCommand(c.id, { sortOrder: i })
          : null)),
      )
      await invalidate()
    } catch {
      await invalidate()
    }
  }

  const canAdd = aLabel.trim().length > 0 && aPrompt.trim().length > 0 && !addBusy

  return (
    <div className="space-y-4">
      {/* — add form — */}
      <div className="space-y-2.5 rounded-xl border bg-muted/20 p-3">
        <div className="grid gap-2.5 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="qc-label" className="text-xs">
              اسم الأداة <span className="text-muted-foreground">(٢٤ حرف بالكثير)</span>
            </Label>
            <Input
              id="qc-label"
              value={aLabel}
              onChange={(e) => setALabel(e.target.value)}
              placeholder="مثلاً: تسوية الألبان"
              className="h-11"
              maxLength={MAX_LABEL}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">الأيقونة</Label>
            <IconPicker value={aIcon} onChange={setAIcon} groupLabel="أيقونة الأداة الجديدة" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="qc-prompt" className="text-xs">
            الأمر — اللي وكيل هينفذه لما تدوس عليها
          </Label>
          <Textarea
            id="qc-prompt"
            value={aPrompt}
            onChange={(e) => setAPrompt(e.target.value)}
            placeholder="مثلاً: اعمل تسوية لمورد الألبان وورّيني الفرق"
            className="min-h-11 resize-none"
            rows={2}
            maxLength={MAX_PROMPT}
          />
        </div>
        <Button className="min-h-11 w-full sm:w-auto" onClick={() => void handleAdd()} disabled={!canAdd}>
          {addBusy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Plus className="size-4" aria-hidden="true" />}
          ضيف الأداة
        </Button>
      </div>

      {/* — list — */}
      {cmdsQ.isPending ? (
        <div className="space-y-2" aria-busy="true" role="status" aria-label="بيحمّل أدواتك">
          <div className="skel h-20 w-full rounded-xl" />
          <div className="skel h-20 w-11/12 rounded-xl" />
        </div>
      ) : cmdsQ.isError ? (
        <p className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {cmdsQ.error instanceof Error ? cmdsQ.error.message : 'تعذر تحميل الأدوات'}{' '}
          <button
            type="button"
            className="underline underline-offset-4 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={() => void cmdsQ.refetch()}
          >
            جرّب تاني
          </button>
        </p>
      ) : commands.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/30 px-4 py-8 text-center">
          <span className="flex size-11 items-center justify-center rounded-full bg-accent text-wakil-amber">
            <Wrench className="size-5" aria-hidden="true" />
          </span>
          <p className="text-sm font-medium">ضيف أول أداة ليك</p>
          <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
            زي «تسوية مورد الألبان كل سبت» 🧰 — أي أمر بيتكرر في شغلك تحوّله لضغطة واحدة
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {commands.map((c, i) => (
            <motion.li
              key={c.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, ease: 'easeOut', delay: Math.min(i * 0.04, 0.2) }}
              className="flex items-center gap-2.5 rounded-xl border bg-card p-3 transition-colors hover:border-wakil-amber/40"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-wakil-amber">
                <ToolIcon icon={c.icon} className="size-4.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{c.label}</p>
                <p className="truncate text-xs text-muted-foreground">{c.prompt}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {c.usageCount > 0 ? (
                    <>
                      استخدمته <span className="num tabular-nums">{arNum(c.usageCount)}</span>{' '}
                      {c.usageCount === 1 ? 'مرة' : 'مرات'}
                    </>
                  ) : (
                    'لسه ما استخدمتهاش'
                  )}
                </p>
              </div>
              <div className="flex shrink-0 flex-col gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={`انقل ${c.label} لفوق`}
                  disabled={i === 0}
                  onClick={() => void handleMove(i, -1)}
                >
                  <ChevronUp className="size-4" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={`انقل ${c.label} لتحت`}
                  disabled={i === commands.length - 1}
                  onClick={() => void handleMove(i, 1)}
                >
                  <ChevronDown className="size-4" aria-hidden="true" />
                </Button>
              </div>
              <div className="flex shrink-0 flex-col gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={`عدّل ${c.label}`}
                  onClick={() => openEdit(c)}
                >
                  <Pencil className="size-4" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground hover:text-destructive"
                  aria-label={`امسح ${c.label}`}
                  onClick={() => setDeleting(c)}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </div>
            </motion.li>
          ))}
        </ul>
      )}

      {/* — edit dialog — */}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent dir="rtl" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>عدّل الأداة</DialogTitle>
            <DialogDescription>غيّر الاسم أو الأمر أو الأيقونة — التغيير بيسري فورًا.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="qc-edit-label" className="text-xs">
                اسم الأداة
              </Label>
              <Input
                id="qc-edit-label"
                value={eLabel}
                onChange={(e) => setELabel(e.target.value)}
                className="h-11"
                maxLength={MAX_LABEL}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qc-edit-prompt" className="text-xs">
                الأمر
              </Label>
              <Textarea
                id="qc-edit-prompt"
                value={ePrompt}
                onChange={(e) => setEPrompt(e.target.value)}
                rows={3}
                className="resize-none"
                maxLength={MAX_PROMPT}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">الأيقونة</Label>
              <IconPicker value={eIcon} onChange={setEIcon} groupLabel="أيقونة الأداة" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={editBusy}>
                سيبها
            </Button>
            <Button
              onClick={() => void handleEdit()}
              disabled={editBusy || !eLabel.trim() || !ePrompt.trim()}
            >
              {editBusy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <MessageSquareText className="size-4" aria-hidden="true" />}
              حفظ التعديل
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* — delete confirm — */}
      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>امسح «{deleting?.label}»؟</AlertDialogTitle>
            <AlertDialogDescription>
              الأداة هتتشال من شاشة المحادثة والإعدادات — تقدر تضيفها تاني في أي وقت.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>سيبها</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => void handleDelete()}
              disabled={deleteBusy}
            >
              {deleteBusy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Trash2 className="size-4" aria-hidden="true" />}
              امسحها
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
