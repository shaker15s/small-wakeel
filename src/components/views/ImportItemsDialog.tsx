'use client'

// وكيل — «استيراد من Excel/CSV»: onboarding a whole catalog in one paste.
//
// Design notes:
//   • TWO steps on purpose — «معاينة» (dry run) then «استيراد». Importing a
//     catalog is irreversible-ish work; the owner must see what will happen
//     (how many new, how many updated, which rows failed and why) before a
//     single row is written.
//   • the file never leaves the browser tab as a binary: we read the text and
//     post it, so the server only ever sees validated text.
//   • errors are listed per row («سطر ٧: مفيش سعر») instead of failing the file.
import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FileSpreadsheet, Loader2, Upload } from 'lucide-react'
import * as XLSX from 'xlsx'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { api, type ItemImportResult } from '@/lib/api'
import { QUERY_KEYS } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { egp } from '@/lib/format'
import { arNum } from './shared'

const SAMPLE = `اسم الصنف,سعر الشراء,سعر البيع,الكمية,الوحدة,حد الطلب,الباركود
شاي العروسة ٢٥٠ جرام,42.5,55,24,box,5,6221031451
مكرونة الملكة ٤٠٠ جرام,18,24.5,60,box,10,6221042917`

export function ImportItemsDialog({ businessId, userId }: { businessId: string; userId: string }) {
  const [open, setOpen] = useState(false)
  const [csv, setCsv] = useState('')
  const [updateExisting, setUpdateExisting] = useState(false)
  const [preview, setPreview] = useState<ItemImportResult | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.importItems({ businessId, userId, csv, updateExisting, dryRun }),
    onSuccess: (result, dryRun) => {
      setPreview(result)
      if (!dryRun) {
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.items(businessId) })
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.overview(businessId, userId) })
        toast({
          title: 'تم الاستيراد',
          description: `اتضاف ${arNum(result.created)} صنف، واتحدّث ${arNum(result.updated)}، واتخطّى ${arNum(result.skipped)}.`,
        })
        setOpen(false)
        setCsv('')
        setPreview(null)
      }
    },
    onError: (err: Error) =>
      toast({ title: 'الاستيراد فشل', description: err.message, variant: 'destructive' }),
  })

  async function readFile(file: File) {
    try {
      const lower = file.name.toLowerCase()
      if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.ods')) {
        const buffer = await file.arrayBuffer()
        const wb = XLSX.read(buffer, { type: 'array' })
        const firstSheetName = wb.SheetNames[0]
        if (!firstSheetName) throw new Error('الملف لا يحتوي على أوراق عمل')
        const ws = wb.Sheets[firstSheetName]
        const csvData = XLSX.utils.sheet_to_csv(ws)
        setCsv(csvData)
      } else {
        const text = await file.text()
        setCsv(text)
      }
      setPreview(null)
    } catch (err) {
      toast({
        title: 'خطأ في قراءة ملف الإكسل',
        description: err instanceof Error ? err.message : 'تعذر استخراج البيانات من الملف',
        variant: 'destructive',
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (setOpen(v), v || setPreview(null))}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          className="h-10 gap-2 focus-visible:ring-wakil-amber/40"
          aria-label="استيراد أصناف من ملف Excel أو CSV"
        >
          <FileSpreadsheet className="size-4" aria-hidden />
          استيراد من Excel
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-2xl" dir="rtl">
        <DialogHeader>
          <DialogTitle>استيراد أصناف من Excel أو CSV</DialogTitle>
          <DialogDescription>
            انسخ الصفوف من Excel والصقهم هنا، أو اختار الملف (.xlsx أو .csv). الأعمدة المفهومة: اسم الصنف،
            سعر الشراء، سعر البيع، الكمية، الوحدة، حد الطلب، الباركود، تاريخ الصلاحية — والترتيب مش مهم.
            الأسعار بالجنيه وهي بتتحوّل لقروش تلقائيًا.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.ods,.csv,.txt,.tsv,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void readFile(file)
              }}
              aria-label="ملف الأصناف"
            />
            <Button type="button" variant="outline" className="h-9 gap-2" onClick={() => fileRef.current?.click()}>
              <Upload className="size-4" aria-hidden />
              اختار ملف
            </Button>
            <Button type="button" variant="ghost" className="h-9 text-xs" onClick={() => (setCsv(SAMPLE), setPreview(null))}>
              حطّ مثال
            </Button>
            <label className="ms-auto flex items-center gap-2 text-sm">
              <Checkbox
                checked={updateExisting}
                onCheckedChange={(v) => setUpdateExisting(v === true)}
                aria-label="تحديث الأصناف الموجودة بنفس الاسم"
              />
              <Label className="cursor-pointer text-sm font-normal">حدّث الأصناف الموجودة</Label>
            </label>
          </div>

          <Textarea
            value={csv}
            onChange={(e) => (setCsv(e.target.value), setPreview(null))}
            rows={8}
            dir="auto"
            spellCheck={false}
            placeholder={'اسم الصنف,سعر البيع,الكمية\nلبن كرتونة,45,24'}
            className="font-mono text-xs leading-6"
            aria-label="محتوى ملف الأصناف"
          />

          {preview && (
            <div
              className="rounded-lg border bg-muted/40 p-3 text-sm"
              role="status"
              aria-live="polite"
            >
              <p className="font-semibold">
                {preview.dryRun ? 'معاينة (مفيش كتابة): ' : 'تم: '}
                {arNum(preview.created)} جديد · {arNum(preview.updated)} تحديث · {arNum(preview.skipped)} متخطّى
              </p>
              {preview.preview && preview.preview.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {preview.preview.map((p) => (
                    <li key={p.name} className="flex justify-between gap-3">
                      <span className="truncate">{p.name}</span>
                      <span className="shrink-0">
                        {egp(p.sellPrice)} · {arNum(p.stockQty)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {preview.unknownHeaders.length > 0 && (
                <p className="mt-2 text-xs text-wakil-amber">
                  أعمدة مش مفهومة واتخطّت: {preview.unknownHeaders.join('، ')}
                </p>
              )}
              {preview.errors.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-destructive">
                  {preview.errors.slice(0, 6).map((e) => (
                    <li key={`${e.row}-${e.message}`}>
                      سطر {arNum(e.row)}: {e.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={csv.trim().length === 0 || run.isPending}
            onClick={() => run.mutate(true)}
          >
            {run.isPending && run.variables === true ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            معاينة
          </Button>
          <Button
            type="button"
            disabled={csv.trim().length === 0 || run.isPending}
            onClick={() => run.mutate(false)}
            className="gap-2"
          >
            {run.isPending && run.variables === false ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            استورد {preview ? `${arNum(preview.created + preview.updated)} صنف` : 'الأصناف'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
