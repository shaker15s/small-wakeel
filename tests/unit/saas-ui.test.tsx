import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SaasAccess } from '@/components/app/SaasAccess'
import { AccountNotice } from '@/components/app/AccountNotice'
import { AccountPanel } from '@/components/app/AccountPanel'

test('SaaS entry offers email/password/reset/signup without a shared token field', () => {
  const html = renderToStaticMarkup(<SaasAccess registrationEnabled />)
  expect(html).toContain('البريد الإلكتروني'); expect(html).toContain('نسيت كلمة المرور')
  expect(html).toContain('إنشاء حساب جديد'); expect(html).not.toContain('مفتاح الدخول')
  expect(renderToStaticMarkup(<SaasAccess registrationEnabled={false} />)).not.toContain('إنشاء حساب جديد')
})
test('security links require an explicit submit and do not render the raw one-time token', () => {
  const token = 'secret-test-token-not-for-DOM'
  const verify = renderToStaticMarkup(<SaasAccess action="verify" linkToken={token} registrationEnabled />)
  expect(verify).toContain('تأكيد البريد'); expect(verify).not.toContain(token)
  const reset = renderToStaticMarkup(<SaasAccess action="reset" linkToken={token} registrationEnabled />)
  expect(reset).toContain('تأكيد كلمة المرور'); expect(reset).toContain('minLength="12"'); expect(reset).not.toContain(token)
  expect(renderToStaticMarkup(<SaasAccess action="invite" linkToken={token} registrationEnabled />)).toContain('الحساب صاحب البريد المدعو')
})
function account(role: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(['saas-account'], { account: { email: 'fixture@example.test', name: 'Fixture', verified: false, mfaEnabled: false }, sessionId: 'current', membershipId: 'member', memberships: [{ id: 'member', businessId: 'business', userId: 'actor', businessName: 'Blank workspace', role }], subscription: { plan: 'trial', status: 'trialing', trialEndsAt: '2026-10-30T00:00:00.000Z', seatLimit: 5, dailyChatLimit: 50, writable: true } })
  const html = renderToStaticMarkup(<QueryClientProvider client={qc}><AccountPanel /></QueryClientProvider>)
  qc.clear()
  return html
}
test('owner account panel renders limits, verification, sessions and team but no fake checkout', () => {
  const html = account('owner')
  expect(html).toContain('الفريق والصلاحيات'); expect(html).toContain('الجلسات النشطة')
  expect(html).toContain('الدفع الإلكتروني غير مفعّل'); expect(html).toContain('50 طلب وكيل يوميًا')
})
test('staff security settings never present team privilege controls', () => {
  const html = account('cashier')
  expect(html).toContain('أمان الحساب'); expect(html).not.toContain('الفريق والصلاحيات')
  expect(html).not.toContain('إرسال دعوة')
})

test('verification and expired-plan notices appear outside Settings, not only after a failed write', () => {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  const render = (verified: boolean, writable: boolean) => {
    qc.setQueryData(['saas-account'], { account: { verified }, subscription: { writable } })
    return renderToStaticMarkup(<QueryClientProvider client={qc}><AccountNotice onSettings={() => {}} /></QueryClientProvider>)
  }
  expect(render(false, true)).toContain('افتح رابط التأكيد')
  expect(render(true, false)).toContain('اشتراك المنشأة غير نشط')
  expect(render(true, true)).toBe('')
  qc.clear()
})
