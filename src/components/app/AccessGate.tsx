'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, setAccessToken } from '@/lib/api'
import { SaasAccess } from './SaasAccess'
import { Button } from '@/components/ui/button'

/** Explicit auth/network failure, never an endless loading animation. */
export function AccessGate({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const [config, setConfig] = useState<{ saasEnabled: boolean; registrationEnabled: boolean } | null>(null)
  useEffect(() => { void fetch('/api/auth/config', { cache: 'no-store' }).then((r) => r.json()).then(setConfig).catch(() => {}) }, [])
  const [token, setToken] = useState('')
  const [storageError, setStorageError] = useState(false)
  const needsIdentity = error instanceof ApiError && (error.status === 401 || error.status === 403)
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!token.trim()) return
    try {
      setAccessToken(token)
      // A hard reload clears the previous user's React Query cache and messages.
      window.location.reload()
    } catch { setStorageError(true) }
  }
  if (needsIdentity && config?.saasEnabled) return <SaasAccess registrationEnabled={config.registrationEnabled} />
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6" dir="rtl">
      <section className="w-full max-w-md space-y-4 rounded-2xl border bg-card p-6" aria-labelledby="access-title">
        <h1 id="access-title" className="text-lg font-semibold">{needsIdentity ? 'الدخول إلى وكيل' : 'تعذّر تحميل وكيل'}</h1>
        <p role="alert" className="text-sm text-muted-foreground">
          {needsIdentity ? 'محتاج مفتاح دخول خاص بمستخدمك من مدير النظام. لو إعدادات الإنتاج ناقصة، مدير النظام لازم يجهّزها أولًا.' : 'الاتصال بالسيرفر مش متاح حاليًا. بياناتك مش ظاهرة؛ جرّب الاتصال مرة تانية.'}
        </p>
        {needsIdentity && (
          <form onSubmit={submit} className="space-y-3">
            <label htmlFor="access-token" className="block text-sm font-medium">مفتاح الدخول</label>
            <input id="access-token" type="password" required value={token} onChange={(event) => setToken(event.target.value)}
              autoComplete="off" spellCheck={false} dir="ltr" className="w-full rounded-md border bg-background px-3 py-2" />
            <p className="text-xs text-muted-foreground">بيتحفظ في التبويب ده فقط في الإنتاج. اقفل التبويب عند الانتهاء، وما تبعتوش في رابط.</p>
            {storageError && <p role="alert" className="text-sm text-destructive">المتصفح منع حفظ مفتاح الدخول. اسمح بتخزين الجلسة وجرّب تاني.</p>}
            <Button type="submit" disabled={!token.trim()}>دخول</Button>
          </form>
        )}
        <Button variant="outline" onClick={onRetry}>جرّب تاني</Button>
      </section>
    </main>
  )
}
