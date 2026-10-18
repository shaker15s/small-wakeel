'use client'

// وكيل — Dynamic Business & Vertical Builder Modal
// Allows creating ANY new business vertical (Pharmacy, Restaurant, Clothing,
// Electronics, Clinic, Grocery, Attara, Gym, or Custom) with seeded catalog & roles.

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { QUERY_KEYS, useWakil } from '@/lib/store'
import { api } from '@/lib/api'
import { VERTICAL_PRESETS } from '@/lib/verticals'
import { Building2, Check, Loader2, Sparkles } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'

export function BusinessBuilderModal() {
  const { businessBuilderOpen, setBusinessBuilderOpen, setSession, setView } = useWakil()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [selectedType, setSelectedType] = useState<string>('pharmacy')
  const [customTypeLabel, setCustomTypeLabel] = useState<string>('')
  const [name, setName] = useState<string>('')
  const [ownerName, setOwnerName] = useState<string>('صاحب العمل')
  const [openingCash, setOpeningCash] = useState<string>('0')
  const [customItemsRaw, setCustomItemsRaw] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    const cleanName = name.trim()
    if (!cleanName) {
      toast({ variant: 'destructive', title: 'اكتب اسم النشاط التجاري الأول' })
      return
    }
    const finalType = selectedType === 'custom' ? (customTypeLabel.trim() || 'تجارة عامة') : selectedType
    const customItems = customItemsRaw
      .split(/[،,\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)

    setSubmitting(true)
    try {
      const res = await api.createBusiness({
        name: cleanName,
        type: finalType,
        ownerName: ownerName.trim() || 'صاحب العمل',
        openingCash: Number(openingCash),
        customItems: customItems.length > 0 ? customItems : undefined,
      })
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.bootstrap })
      const owner = res.business.users.find((u) => u.role === 'owner') ?? res.business.users[0]
      if (owner) {
        setSession(res.business.id, owner.id)
      }
      setView('chat')
      toast({
        title: `تم إنشاء نشاط «${res.business.name}» بنجاح`,
        description: 'النشاط اتفتح من غير بضاعة أو أرصدة أو موظفين تجريبيين. راجع بياناتك الفعلية وكمّلها.',
      })
      setBusinessBuilderOpen(false)
      setName('')
      setCustomItemsRaw('')
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'تعذر إنشاء النشاط',
        description: (err as Error).message,
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={businessBuilderOpen} onOpenChange={setBusinessBuilderOpen}>
      <DialogContent dir="rtl" className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader className="text-right">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-primary/15 text-primary flex items-center justify-center">
              <Building2 className="w-5 h-5" />
            </div>
            <div>
              <DialogTitle className="text-lg font-bold">بناء نشاط تجاري جديد</DialogTitle>
              <DialogDescription className="text-xs">
                هنفتح نشاط فاضي؛ أي أسماء أصناف تدخلها هتبدأ بصفر مخزون وأسعار لحد ما تدخل بياناتها الفعلية.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleCreate} className="space-y-4 mt-2">
          {/* Vertical selector grid */}
          <div className="space-y-2">
            <Label className="text-xs font-semibold">١. اختار نوع النشاط التجاري</Label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {VERTICAL_PRESETS.map((v) => {
                const active = selectedType === v.key
                return (
                  <button
                    key={v.key}
                    type="button"
                    onClick={() => {
                      setSelectedType(v.key)
                      if (!name.trim()) {
                        setName(`${v.shortLabel} النور`)
                      }
                    }}
                    className={`flex items-center gap-2 p-2.5 rounded-xl border text-right transition-all ${
                      active
                        ? 'border-primary bg-primary/10 text-foreground ring-1 ring-primary/30'
                        : 'border-border/70 bg-secondary/30 hover:bg-secondary/60 text-foreground/85'
                    }`}
                  >
                    <span className="text-lg shrink-0">{v.icon}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-bold truncate">{v.shortLabel}</div>
                      <div className="text-[10px] text-muted-foreground truncate">{v.description}</div>
                    </div>
                    {active && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
                  </button>
                )
              })}
              <button
                type="button"
                onClick={() => setSelectedType('custom')}
                className={`flex items-center gap-2 p-2.5 rounded-xl border text-right transition-all ${
                  selectedType === 'custom'
                    ? 'border-primary bg-primary/10 text-foreground ring-1 ring-primary/30'
                    : 'border-dashed border-border bg-secondary/20 hover:bg-secondary/50 text-foreground/85'
                }`}
              >
                <span className="text-lg shrink-0">✨</span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-bold truncate">نشاط مخصص</div>
                  <div className="text-[10px] text-muted-foreground truncate">أي مجال تاني</div>
                </div>
                {selectedType === 'custom' && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
              </button>
            </div>
          </div>

          {selectedType === 'custom' && (
            <div className="space-y-1.5">
              <Label className="text-xs">مجال النشاط المخصص</Label>
              <Input
                value={customTypeLabel}
                onChange={(e) => setCustomTypeLabel(e.target.value)}
                placeholder="مثال: مكتبة وأدوات مكتبية، ورشة صيانة، مخبز حلواني..."
              />
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">٢. اسم المحل / النشاط</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="مثال: صيدلية الشفاء / كافيه السعادة"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">اسم صاحب الشغل</Label>
              <Input
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                placeholder="مثال: أ. محمد"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">رصيد الخزنة الافتتاحي (ج.م)</Label>
              <Input
                type="number"
                value={openingCash}
                onChange={(e) => setOpeningCash(e.target.value)}
                placeholder="15000"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">أصناف مبدئية إضافية (اختياري — افصل بفاصلة)</Label>
              <Input
                value={customItemsRaw}
                onChange={(e) => setCustomItemsRaw(e.target.value)}
                placeholder="سيبها فاضية وهنجهز أصناف افتراضية للمجال"
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/60">
            <Button type="button" variant="outline" onClick={() => setBusinessBuilderOpen(false)}>
              إلغاء
            </Button>
            <Button type="submit" disabled={submitting} className="gap-2">
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              إنشاء النشاط وتفعيل وكيل
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
