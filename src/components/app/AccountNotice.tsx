'use client'
import { useQuery } from '@tanstack/react-query'
import { authRequest } from '@/lib/saas/client'
import { Button } from '@/components/ui/button'
/** A new account must not discover verification/expiry only through a failed
 * financial send. Metadata shares AccountPanel's safe query, never a token. */
export function AccountNotice({ onSettings }: { onSettings: () => void }) {
  const { data } = useQuery({ queryKey: ['saas-account'], queryFn: () => authRequest<{ account: { verified: boolean }; subscription: { writable: boolean } | null }>('me'), retry: false, refetchInterval: (query) => query.state.data ? 60_000 : false })
  if (!data || (data.account.verified && data.subscription?.writable)) return null
  return <aside role="status" dir="rtl" className="z-40 flex shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-2 border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
    <p>{!data.account.verified ? 'حسابك اتعمل. افتح رابط التأكيد في بريدك قبل تسجيل الحركات؛ لو الرسالة لم تصل، أعد إرسالها من إعدادات الحساب.' : 'اشتراك المنشأة غير نشط. تقدر تقرأ بياناتك وتصدّر الكتالوج حسب صلاحيتك، لكن تسجيل الحركات متوقف.'}</p>
    <Button size="sm" variant="outline" className="border-amber-300 bg-transparent" onClick={onSettings}>إعدادات الحساب</Button>
  </aside>
}
