'use client'

// وكيل — شاشة «الإعدادات»: الموديلات والمزوّدين + المهام المؤجلة + ذاكرة وكيل + أدواتك السريعة.

import { SpeechSettings } from './SpeechSettings'
import { AccountPanel } from '@/components/app/AccountPanel'
import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  Activity,
  BrainCog,
  CalendarClock,
  Check,
  Loader2,
  Notebook,
  Play,
  Plus,
  Server,
  Trash2,
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { arDateTime } from '@/lib/format'
import { QUERY_KEYS, useWakil } from '@/lib/store'
import { QuickCommandsManager } from '@/components/chat/QuickCommandsManager'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import type { ModelConfigDTO, ProviderDTO, ScheduledTaskDTO } from '@/lib/types'
import {
  EmptyState,
  ErrorState,
  RECURRENCE_AR,
  READ_TOOL_AR,
  SectionCard,
  TASK_STATUS_AR,
  TierBadge,
  ViewHeader,
  ViewProps,
  arNum, PAGE
} from './shared'

// ---------------------------------------------------------------------------
// الموديلات الجاهزة (built-in عبر z-ai-web-dev-sdk على السيرفر)
// ---------------------------------------------------------------------------

const BUILTIN_MODELS: { key: string; label: string; tier: 'air' | 'balanced' | 'deep'; note: string }[] = [
  {
    key: 'auto',
    label: 'تلقائي ذكي · Gemini + المحرك الحتمي',
    tier: 'balanced',
    note: 'أفضل سرعة ودقة تلقائيًا',
  },
  {
    key: 'gemini-flash',
    label: 'سريع ذكي · Gemini 2.5 Flash',
    tier: 'air',
    note: 'ردود فائقة السرعة ومباشرة للشغل اليومي',
  },
  {
    key: 'gemini-pro',
    label: 'عميق مفكّر · Gemini 2.5 Pro',
    tier: 'deep',
    note: 'تحليل مالي عميق وتخطيط للمنشأة',
  },
  {
    key: 'builtin-deep',
    label: 'عميق احتياطي · glm-4.6',
    tier: 'deep',
    note: 'تفكير أعمق للعمليات المعقدة',
  },
  {
    key: 'builtin-air',
    label: 'خفيف احتياطي · glm-4.5-air',
    tier: 'air',
    note: 'ردود أسرع للشغل اليومي',
  },
]

interface EditableModel {
  remoteId: string
  label: string
  tier: 'air' | 'balanced' | 'deep'
  enabled: boolean
  selected: boolean
}

const RECURRENCE_WHEN: Record<string, string> = {
  daily: 'كل يوم الصبح',
  weekly: 'كل أسبوع',
  monthly: 'كل شهر',
}

function ModelRow({
  selected,
  onSelect,
  disabled,
  children,
  ariaLabel,
}: {
  selected: boolean
  onSelect: () => void
  disabled?: boolean
  children: React.ReactNode
  ariaLabel: string
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={selected}
      className={cn(
        'press focus-warm flex min-h-11 w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-start transition-colors',
        selected
          ? 'border-wakil-amber/50 bg-accent'
          : 'border-transparent hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60',
      )}
    >
      {children}
      {selected && (
        <motion.span
          initial={{ scale: 0.3, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 500, damping: 24 }}
          className="ms-auto flex shrink-0"
        >
          <Check className="size-4 text-wakil-amber" aria-hidden />
        </motion.span>
      )}
    </button>
  )
}

export default function SettingsView({ businessId, userId }: ViewProps) {
  const { toast } = useToast()
  const qc = useQueryClient()
  const modelKey = useWakil((s) => s.modelKey)
  const setModel = useWakil((s) => s.setModel)

  // — queries
  const bootstrapQ = useQuery({ queryKey: QUERY_KEYS.bootstrap, queryFn: api.bootstrap })
  const canManageProviders = bootstrapQ.data?.deploymentAdmin === true
  const providersQ = useQuery({
    queryKey: QUERY_KEYS.providers,
    queryFn: () => api.providers(),
    enabled: canManageProviders,
  })
  const tasksQ = useQuery({
    queryKey: QUERY_KEYS.tasks(businessId),
    queryFn: () => api.tasks(businessId),
  })
  const memoriesQ = useQuery({
    queryKey: QUERY_KEYS.memories(businessId),
    queryFn: () => api.memories(businessId),
  })
  const providers = providersQ.data?.providers ?? []
  // api.tasks types the payload as ScheduledTaskDTO[] but the route actually
  // returns { tasks: [...] } — accept both shapes until lib/api.ts is aligned.
  const tasks: ScheduledTaskDTO[] = Array.isArray(tasksQ.data)
    ? tasksQ.data
    : ((tasksQ.data as unknown as { tasks?: ScheduledTaskDTO[] })?.tasks ?? [])

  // — dialog state (إضافة مزوّد)
  const [addOpen, setAddOpen] = useState(false)
  const [pName, setPName] = useState('')
  const [pBaseUrl, setPBaseUrl] = useState('')
  const [pApiKey, setPApiKey] = useState('')
  const [testBusy, setTestBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [fetched, setFetched] = useState<ProviderDTO | null>(null)
  const [edits, setEdits] = useState<EditableModel[]>([])
  const [saveBusy, setSaveBusy] = useState(false)
  const [busyModelKey, setBusyModelKey] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // — provider health (DeepSeek-harness «provider-check»): probe each
  //   external provider's live endpoint before trusting it
  const [health, setHealth] = useState<Array<{
    id: string; name: string; ok: boolean; status: number | null; ms: number
    modelCount: number; enabledModels: number; detail?: string
  }> | null>(null)
  const [healthBusy, setHealthBusy] = useState(false)

  async function runProviderHealth() {
    setHealthBusy(true)
    try {
      const res = await fetch('/api/providers/health', { cache: 'no-store' })
      if (!res.ok) throw new Error(`السيرفر رد ${res.status}`)
      const json = (await res.json()) as { providers: Array<{
        id: string; name: string; ok: boolean; status: number | null; ms: number
        modelCount: number; enabledModels: number; detail?: string
      }> }
      setHealth(json.providers)
    } catch (err) {
      toast({
        title: 'مش قادر أفحص المزودين',
        description: err instanceof Error ? err.message : 'جرّب تاني',
        variant: 'destructive',
      })
    } finally {
      setHealthBusy(false)
    }
  }

  // — tasks form
  const [taskTitle, setTaskTitle] = useState('')
  const [taskTool, setTaskTool] = useState('list_low_stock')
  const [taskRec, setTaskRec] = useState<'daily' | 'weekly' | 'monthly'>('daily')
  const [taskBusy, setTaskBusy] = useState(false)
  const [tickBusy, setTickBusy] = useState(false)

  // — memory form
  const [memText, setMemText] = useState('')
  const [memKind, setMemKind] = useState<'fact' | 'preference'>('fact')
  const [memBusy, setMemBusy] = useState(false)

  function resetDialog() {
    setAddOpen(false)
    setPName('')
    setPBaseUrl('')
    setPApiKey('')
    setAddError(null)
    setFetched(null)
    setEdits([])
  }

  async function handleTestProvider() {
    setAddError(null)
    if (!pName.trim() || !pBaseUrl.trim() || !pApiKey.trim()) {
      setAddError('املأ الاسم والرابط والمفتاح الأول')
      return
    }
    setTestBusy(true)
    try {
      const { provider } = await api.addProvider({
        name: pName.trim(),
        baseUrl: pBaseUrl.trim(),
        apiKey: pApiKey.trim(),
      })
      setFetched(provider)
      setEdits(
        provider.models.map((m) => ({
          remoteId: m.remoteId,
          label: m.label,
          tier: m.tier,
          enabled: m.enabled,
          selected: true,
        })),
      )
      toast({
        title: 'وصلنا للمزوّد',
        description: `جبنا ${arNum(provider.models.length)} موديل — اختار اللي يعجبك`,
      })
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'حصل خطأ غير متوقع')
    } finally {
      setTestBusy(false)
    }
  }

  async function handleSaveModels() {
    if (!fetched) return
    setSaveBusy(true)
    setAddError(null)
    try {
      const chosen = edits.filter((m) => m.selected)
      await api.saveProviderModels(
        fetched.id,
        chosen.map(({ remoteId, label, tier, enabled }) => ({ remoteId, label, tier, enabled })),
      )
      await qc.invalidateQueries({ queryKey: QUERY_KEYS.providers })
      toast({ title: 'تم الحفظ', description: `حفظنا ${arNum(chosen.length)} موديل مع «${fetched.name}»` })
      resetDialog()
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'حصل خطأ غير متوقع')
    } finally {
      setSaveBusy(false)
    }
  }

  async function handleToggleModel(provider: ProviderDTO, model: ModelConfigDTO, next: boolean) {
    const rowKey = `${provider.id}:${model.id}`
    setBusyModelKey(rowKey)
    try {
      await api.saveProviderModels(
        provider.id,
        provider.models.map((m) => ({
          remoteId: m.remoteId,
          label: m.label,
          tier: m.tier,
          enabled: m.id === model.id ? next : m.enabled,
        })),
      )
      await qc.invalidateQueries({ queryKey: QUERY_KEYS.providers })
      toast({ title: next ? 'فعّلنا الموديل' : 'وقفنا الموديل', description: model.label })
    } catch (e) {
      toast({
        variant: 'destructive',
        title: 'مش قادرين نحفظ',
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setBusyModelKey(null)
    }
  }

  async function handleDeleteProvider(provider: ProviderDTO) {
    setDeletingId(provider.id)
    try {
      const res = await api.deleteProvider(provider.id)
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? 'فشل المسح')
      }
      await qc.invalidateQueries({ queryKey: QUERY_KEYS.providers })
      toast({ title: 'مسحنا المزوّد', description: provider.name })
    } catch (e) {
      toast({
        variant: 'destructive',
        title: 'مش قادرين نمسح المزوّد',
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setDeletingId(null)
    }
  }

  function handleSelectModel(key: string, label: string) {
    setModel(key)
    toast({ title: 'بدّلنا الموديل', description: label })
  }

  async function handleCreateTask() {
    if (!taskTitle.trim()) {
      toast({ variant: 'destructive', title: 'اكتب عنوان المهمة الأول' })
      return
    }
    setTaskBusy(true)
    try {
      await api.createTask({
        businessId,
        userId,
        title: taskTitle.trim(),
        tool: taskTool,
        recurrence: taskRec,
        whenLabel: RECURRENCE_WHEN[taskRec] ?? 'كل يوم الصبح',
      })
      await qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks(businessId) })
      setTaskTitle('')
      toast({ title: 'أضفنا المهمة', description: taskTitle.trim() })
    } catch (e) {
      toast({
        variant: 'destructive',
        title: 'مش قادرين نضيف المهمة',
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setTaskBusy(false)
    }
  }

  async function handleTickTasks() {
    setTickBusy(true)
    try {
      const r = await api.tickTasks({ businessId, force: true })
      await qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks(businessId) })
      await qc.invalidateQueries({ queryKey: QUERY_KEYS.overview(businessId, userId) })
      toast({
        title: r.due === 0 ? 'مفيش مهام مستحقة دلوقتي' : `شغّلنا ${arNum(r.ran)} مهمة على التوازي`,
        description: r.due > 0 ? `تم تنفيذ ${arNum(r.due)} مهمة وإرسال النتايج للمحادثة` : undefined,
      })
    } catch (e) {
      toast({
        variant: 'destructive',
        title: 'مش قادرين نشغّل المهام',
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setTickBusy(false)
    }
  }

  async function handleAddMemory() {
    if (!memText.trim()) {
      toast({ variant: 'destructive', title: 'اكتب اللي عايز وكيل يفتكره' })
      return
    }
    setMemBusy(true)
    try {
      await api.addMemory({ businessId, userId, text: memText.trim(), kind: memKind })
      await qc.invalidateQueries({ queryKey: QUERY_KEYS.memories(businessId) })
      setMemText('')
      toast({ title: 'حفظناها في ذاكرة وكيل' })
    } catch (e) {
      toast({
        variant: 'destructive',
        title: 'مش قادرين نحفظها',
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setMemBusy(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className={PAGE}
    >
      <ViewHeader title="الإعدادات" subtitle="الموديلات والمهام والذاكرة — كل حاجة تحت سيطرتك" />

      <AccountPanel />

      {/* (أ) الموديلات والمزوّدين */}
      <SectionCard
        title="الموديلات والمزوّدين"
        icon={BrainCog}
        action={
          canManageProviders && <Button size="sm" className="min-h-10" onClick={() => setAddOpen(true)}>
            <Plus aria-hidden /> إضافة مزوّد جديد
          </Button>
        }
      >
        <div className="space-y-5">
          {/* الموديلات الجاهزة */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              الموديلات الجاهزة — تحتاج تهيئة من مشغّل الخدمة؛ عند تعذّر الاتصال يعمل المحرك الحتمي
            </p>
            {BUILTIN_MODELS.map((m) => (
              <ModelRow
                key={m.key}
                selected={modelKey === m.key}
                onSelect={() => handleSelectModel(m.key, m.label)}
                ariaLabel={`اختار موديل ${m.label}`}
              >
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">{m.label}</span>
                  <TierBadge tier={m.tier} />
                  <span className="hidden text-xs text-muted-foreground sm:inline">{m.note}</span>
                </span>
              </ModelRow>
            ))}
          </div>

          {/* المزوّدين الخارجيين: مدير النشر فقط */}
          {canManageProviders && <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Server className="size-3.5" aria-hidden />
                مزوّديك الخارجيين (OpenAI-compatible)
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void runProviderHealth()}
                disabled={healthBusy}
                className="h-8 gap-1.5 text-xs"
              >
                {healthBusy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Activity className="size-3.5" aria-hidden />}
                فحص الاتصال بالمزودين
              </Button>
            </div>

            {health && (
              <div className="space-y-1.5 rounded-xl border border-border/70 bg-muted/30 p-3" role="status" aria-label="نتيجة فحص المزودين">
                <p className="text-[11px] font-bold text-muted-foreground">
                  فحص مباشر — كل مزوّد بيتست على نته endpoint الفعلي (المفتاح مش بيتعرض)
                </p>
                {health.map((h) => (
                  <div key={h.id} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className={cn('size-2 shrink-0 rounded-full', h.ok ? 'bg-wakil-teal' : 'bg-destructive')} aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-medium">{h.name}</span>
                    {h.ok ? (
                      <span className="num text-[11px] text-wakil-teal">
                        شغال · {arNum(h.ms)}ms · {arNum(h.modelCount)} موديل عند المزوّد / {arNum(h.enabledModels)} مفعّل عندك
                      </span>
                    ) : (
                      <span className="num max-w-full truncate text-[11px] text-destructive" title={h.detail}>
                        مش متوصّل ({h.status ?? 'بدون رد'}){h.detail ? ` — ${h.detail.slice(0, 60)}` : ''}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {providersQ.isPending ? (
              <div className="space-y-2" aria-busy="true">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-5/6" />
              </div>
            ) : providersQ.isError ? (
              <ErrorState
                message={providersQ.error.message}
                onRetry={() => providersQ.refetch()}
              />
            ) : providers.length === 0 ? (
              <EmptyState
                icon={Server}
                title="لسه مفيش مزوّدين خارجيين"
                hint="عندك مفتاح OpenAI أو أي مزوّد متوافق؟ ضيفه من زر «إضافة مزوّد جديد» وهنجيب موديلاته بنفسنا"
              />
            ) : (
              providers.map((p) => (
                <Card
                  key={p.id}
                  className="card-enter gap-0 py-0 transition-[border-color,box-shadow] duration-200 hover:border-wakil-amber/40 hover:shadow-md"
                >
                  <CardHeader className="border-b px-4 py-3">
                    <CardTitle className="flex w-full flex-wrap items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 break-words font-semibold">{p.name}</span>
                      <span className="flex items-center gap-1">
                        {deletingId === p.id && (
                          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
                        )}
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-10 text-destructive hover:bg-destructive/10"
                              aria-label={`امسح مزوّد ${p.name}`}
                            >
                              <Trash2 aria-hidden />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent dir="rtl">
                            <AlertDialogHeader>
                              <AlertDialogTitle>تمسح «{p.name}»؟</AlertDialogTitle>
                              <AlertDialogDescription>
                                الموديلات المرتبطة بيه هتتمسح معاه. لو الموديل الحالي منه، ارجع
                                للموديلات الجاهزة.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter dir="rtl">
                              <AlertDialogCancel className="min-h-10">إلغاء</AlertDialogCancel>
                              <AlertDialogAction
                                className="min-h-10"
                                onClick={() => handleDeleteProvider(p)}
                              >
                                امسح المزوّد
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </span>
                    </CardTitle>
                    <p dir="ltr" className="num truncate font-mono text-xs text-muted-foreground">
                      {p.baseUrl}
                    </p>
                  </CardHeader>
                  <CardContent className="p-2">
                    {p.models.length === 0 ? (
                      <p className="px-3 py-4 text-center text-sm text-muted-foreground">
                        مفيش موديلات محفوظة للمزوّد ده
                      </p>
                    ) : (
                      <ul className="space-y-1">
                        {p.models.map((m) => {
                          const selected = modelKey === `ext:${m.id}`
                          const busy = busyModelKey === `${p.id}:${m.id}`
                          return (
                            <li key={m.id} className="flex items-center gap-1">
                              <div className="min-w-0 flex-1">
                                <ModelRow
                                  selected={selected}
                                  disabled={!m.enabled}
                                  onSelect={() => m.enabled && handleSelectModel(`ext:${m.id}`, m.label)}
                                  ariaLabel={`اختار موديل ${m.label}`}
                                >
                                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                                    <span
                                      className={cn(
                                        'truncate text-sm font-medium',
                                        !m.enabled && 'text-muted-foreground',
                                      )}
                                    >
                                      {m.label}
                                    </span>
                                    <TierBadge tier={m.tier} />
                                    {busy && (
                                      <Loader2
                                        className="size-3.5 animate-spin text-muted-foreground"
                                        aria-hidden
                                      />
                                    )}
                                  </span>
                                </ModelRow>
                              </div>
                              <div className="ps-1">
                                <SwitchHit
                                  checked={m.enabled}
                                  onToggle={(next) => handleToggleModel(p, m, next)}
                                  ariaLabel={`${m.enabled ? 'وقّف' : 'فعّل'} موديل ${m.label}`}
                                  disabled={busy}
                                />
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              ))
            )}
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              الرابط لازم يكون OpenAI-compatible — بيقبل <span className="font-mono">/models</span> و
              <span className="font-mono"> /chat/completions</span>. المزوّد بيتجرب قبل ما يتحفظ.
            </p>
          </div>}
        </div>
      </SectionCard>

      {canManageProviders && <SpeechSettings providers={providers} />}

      {/* (ب) المهام المؤجلة */}
      <SectionCard
        title="المهام المؤجلة"
        icon={CalendarClock}
        action={
          <Button
            variant="outline"
            size="sm"
            className="min-h-10"
            onClick={handleTickTasks}
            disabled={tickBusy}
          >
            {tickBusy ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Play aria-hidden />
            )}
            شغّل المهام المستحقة
          </Button>
        }
      >
        {/* فورم مهمة جديدة */}
        <div className="space-y-2.5">
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="flex-1">
              <Label htmlFor="task-title" className="sr-only">
                عنوان المهمة
              </Label>
              <Input
                id="task-title"
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                placeholder="عنوان المهمة — مثلاً: فحص المخزون الناقص"
                className="h-11"
              />
            </div>
            <Button className="min-h-11 sm:w-auto" onClick={handleCreateTask} disabled={taskBusy}>
              {taskBusy ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
              ضيف مهمة
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor="task-tool" className="mb-1 block text-xs text-muted-foreground">
                الأداة
              </Label>
              <Select value={taskTool} onValueChange={setTaskTool} dir="rtl">
                <SelectTrigger id="task-tool" className="h-11 w-full" aria-label="أداة المهمة">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(READ_TOOL_AR).map(([value, label]) => (
                    <SelectItem key={value} value={value} className="min-h-10">
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="task-rec" className="mb-1 block text-xs text-muted-foreground">
                التكرار
              </Label>
              <Select
                value={taskRec}
                onValueChange={(v) => setTaskRec(v as 'daily' | 'weekly' | 'monthly')}
                dir="rtl"
              >
                <SelectTrigger id="task-rec" className="h-11 w-full" aria-label="تكرار المهمة">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(RECURRENCE_AR).map(([value, label]) => (
                    <SelectItem key={value} value={value} className="min-h-10">
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* قائمة المهام */}
        <div className="mt-4">
          {tasksQ.isPending ? (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-5/6" />
            </div>
          ) : tasksQ.isError ? (
            <ErrorState message={tasksQ.error.message} onRetry={() => tasksQ.refetch()} />
          ) : tasks.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title="مفيش مهام مؤجلة"
              hint="جدّدلنا مهمة فوق — مثلاً «فحص المخزون الناقص» كل يوم الصبح — وهنشغّلها في وقتها"
            />
          ) : (
            <ul className="max-h-72 space-y-2 overflow-y-auto scroll-warm pe-1">
              {tasks.map((t) => (
                <li key={t.id} className="card-enter rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.title}</span>
                    <TaskStatusBadge status={t.status} />
                    {t.recurrence && (
                      <Badge variant="outline" className="text-[10px]">
                        {RECURRENCE_AR[t.recurrence] ?? t.recurrence}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t.whenLabel} · <span className="num">{arDateTime(t.scheduledFor)}</span>
                  </p>
                  {t.failReason && (
                    <p className="mt-1 text-xs text-destructive">سبب الفشل: {t.failReason}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </SectionCard>

      {/* (ج) ذاكرة وكيل */}
      <SectionCard title="ذاكرة وكيل" icon={Notebook}>
        <div className="space-y-2.5">
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="flex-1">
              <Label htmlFor="mem-text" className="sr-only">
                ذاكرة جديدة
              </Label>
              <Input
                id="mem-text"
                value={memText}
                onChange={(e) => setMemText(e.target.value)}
                placeholder="علّم وكيل حاجة — مثلاً: العميل أحمد بيسدد آخر الشهر"
                className="h-11"
                maxLength={500}
              />
            </div>
            <Select
              value={memKind}
              onValueChange={(v) => setMemKind(v as 'fact' | 'preference')}
              dir="rtl"
            >
              <SelectTrigger
                className="h-11 w-full sm:w-32"
                aria-label="نوع الذاكرة"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fact" className="min-h-10">
                  حقيقة
                </SelectItem>
                <SelectItem value="preference" className="min-h-10">
                  تفضيل
                </SelectItem>
              </SelectContent>
            </Select>
            <Button className="min-h-11" onClick={handleAddMemory} disabled={memBusy}>
              {memBusy ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
              احفظ
            </Button>
          </div>

          {memoriesQ.isPending ? (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-4/5" />
            </div>
          ) : memoriesQ.isError ? (
            <ErrorState message={memoriesQ.error.message} onRetry={() => memoriesQ.refetch()} />
          ) : (memoriesQ.data?.length ?? 0) === 0 ? (
            <EmptyState
              icon={Notebook}
              title="الذاكرة فاضية"
              hint="كل حاجة تخزنها هنا وكيل بيفتكرها في المحادثات — عادات عملائك، تفضيلاتك، أي حاجة"
            />
          ) : (
            <ul className="max-h-72 space-y-2 overflow-y-auto scroll-warm pe-1">
              {(memoriesQ.data ?? []).map((m) => (
                <li
                  key={m.id}
                  className="card-enter flex items-start gap-2.5 rounded-lg border p-3"
                >
                  <Badge
                    className={
                      m.kind === 'preference'
                        ? 'bg-wakil-amber/15 text-wakil-amber'
                        : 'bg-secondary text-secondary-foreground'
                    }
                  >
                    {m.kind === 'preference' ? 'تفضيل' : 'حقيقة'}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-relaxed">{m.text}</p>
                    <p className="num mt-0.5 text-[11px] text-muted-foreground">
                      {arDateTime(m.createdAt)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SectionCard>

      {/* (د) أدواتك السريعة — أوامر جاهزة خاصة بشغلك */}
      <SectionCard title="أدواتك السريعة" icon={Wrench}>
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            أوامر جاهزة بتظهر فوق شاشة المحادثة — خاصة بشغلك انت
          </p>
          <QuickCommandsManager businessId={businessId} userId={userId} />
        </div>
      </SectionCard>

      {/* ديالوج إضافة مزوّد */}
      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          if (!open) resetDialog()
          else setAddOpen(true)
        }}
      >
        <DialogContent dir="rtl" className="max-h-[88vh] overflow-y-auto scroll-warm sm:max-w-lg">
          {!fetched ? (
            <>
              <DialogHeader>
                <DialogTitle>ضيف مزوّد جديد</DialogTitle>
                <DialogDescription>
                  أي مزوّد متوافق مع OpenAI — هنجرّب الرابط ونجيب الموديلات قبل الحفظ.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="p-name">اسم المزوّد</Label>
                  <Input
                    id="p-name"
                    value={pName}
                    onChange={(e) => setPName(e.target.value)}
                    placeholder="مثلاً: OpenAI أو DeepSeek"
                    className="h-11"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="p-url">Base URL</Label>
                  <Input
                    id="p-url"
                    dir="ltr"
                    value={pBaseUrl}
                    onChange={(e) => setPBaseUrl(e.target.value)}
                    placeholder="https://api.example.com/v1"
                    className="h-11 font-mono text-sm"
                    inputMode="url"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="p-key">مفتاح الـ API</Label>
                  <Input
                    id="p-key"
                    dir="ltr"
                    type="password"
                    value={pApiKey}
                    onChange={(e) => setPApiKey(e.target.value)}
                    placeholder="sk-..."
                    className="h-11 font-mono text-sm"
                    autoComplete="off"
                  />
                </div>
                {addError && (
                  <Alert variant="destructive">
                    <AlertTitle>المزوّد مش راضي يتصل</AlertTitle>
                    <AlertDescription>{addError}</AlertDescription>
                  </Alert>
                )}
              </div>
              <DialogFooter dir="rtl" className="gap-2">
                <Button variant="ghost" className="min-h-10" onClick={resetDialog}>
                  إلغاء
                </Button>
                <Button className="min-h-10" onClick={handleTestProvider} disabled={testBusy}>
                  {testBusy ? <Loader2 className="animate-spin" aria-hidden /> : <Server aria-hidden />}
                  جرب واجلب الموديلات
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>اختار موديلات «{fetched.name}»</DialogTitle>
                <DialogDescription>
                  علّم على الموديلات اللي عايزها، عدّل أسماءها لو حابب، وحدّد مستوى كل واحد —
                  بعدين احفظ.
                </DialogDescription>
              </DialogHeader>
              <ul className="max-h-72 space-y-2 overflow-y-auto scroll-warm pe-1">
                {edits.map((m, i) => (
                  <li key={`${m.remoteId}-${i}`} className="space-y-2 rounded-lg border p-3">
                    <div className="flex items-center gap-2.5">
                      <Checkbox
                        checked={m.selected}
                        onCheckedChange={(v) =>
                          setEdits((prev) =>
                            prev.map((x, j) => (j === i ? { ...x, selected: v === true } : x)),
                          )
                        }
                        aria-label={`اختار موديل ${m.label}`}
                        className="size-5"
                      />
                      <Input
                        value={m.label}
                        onChange={(e) =>
                          setEdits((prev) =>
                            prev.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                          )
                        }
                        aria-label="اسم الموديل"
                        className="h-10 flex-1"
                      />
                      <div className="flex items-center gap-1.5">
                        <SwitchHit
                          checked={m.enabled}
                          onToggle={(v) =>
                            setEdits((prev) =>
                              prev.map((x, j) => (j === i ? { ...x, enabled: v } : x)),
                            )
                          }
                          ariaLabel={`مفعّل: ${m.label}`}
                        />
                        <span className="text-[10px] text-muted-foreground">مفعّل</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span dir="ltr" className="num truncate font-mono text-[11px] text-muted-foreground">
                        {m.remoteId}
                      </span>
                      <Select
                        value={m.tier}
                        onValueChange={(v) =>
                          setEdits((prev) =>
                            prev.map((x, j) =>
                              j === i ? { ...x, tier: v as 'air' | 'balanced' | 'deep' } : x,
                            ),
                          )
                        }
                        dir="rtl"
                      >
                        <SelectTrigger
                          className="h-8 w-28 text-xs"
                          aria-label={`مستوى الموديل ${m.label}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="air" className="min-h-9">خفيف</SelectItem>
                          <SelectItem value="balanced" className="min-h-9">متوازن</SelectItem>
                          <SelectItem value="deep" className="min-h-9">عميق</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </li>
                ))}
              </ul>
              {addError && (
                <Alert variant="destructive">
                  <AlertTitle>مش قادرين نحفظ</AlertTitle>
                  <AlertDescription>{addError}</AlertDescription>
                </Alert>
              )}
              <DialogFooter dir="rtl" className="gap-2">
                <Button variant="ghost" className="min-h-10" onClick={resetDialog}>
                  إلغاء
                </Button>
                <Button className="min-h-10" onClick={handleSaveModels} disabled={saveBusy}>
                  {saveBusy ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
                  حفظ المختارة
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </motion.div>
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

function TaskStatusBadge({ status }: { status: string }) {
  const tone =
    status === 'pending'
      ? 'border-wakil-amber/30 bg-wakil-amber/10 text-wakil-amber'
      : status === 'done'
        ? 'border-wakil-teal/25 bg-wakil-teal/10 text-wakil-teal'
        : status === 'failed'
          ? 'border-destructive/25 bg-destructive/10 text-destructive'
          : 'border-border bg-muted text-muted-foreground'
  return (
    <Badge variant="outline" className={cn('text-[10px]', tone)}>
      {TASK_STATUS_AR[status] ?? status}
    </Badge>
  )
}
