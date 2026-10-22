'use client'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { SaasAccess } from './SaasAccess'
const subscribe = (callback: () => void) => {
  window.addEventListener('hashchange', callback)
  window.addEventListener('popstate', callback)
  return () => { window.removeEventListener('hashchange', callback); window.removeEventListener('popstate', callback) }
}
export function IdentityBoundary({ children }: { children: ReactNode }) {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => '')
  const params = new URLSearchParams(hash.slice(1))
  const action = params.get('action'), token = params.get('token')
  const validLink = !!(action && token && ['reset', 'verify', 'invite'].includes(action))
  const [config, setConfig] = useState<{ saasEnabled: boolean; registrationEnabled: boolean } | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!validLink) return
    const controller = new AbortController()

    // A security-link landing page is a safe GET. Retry a small number of
    // transient failures automatically: a one-off failed fetch must not leave
    // the user stuck on the retry screen when the next request succeeds.
    void (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch('/api/auth/config', {
            cache: 'no-store',
            signal: controller.signal,
          })
          if (!response.ok) throw new Error('Auth configuration unavailable')
          const value: unknown = await response.json()
          if (
            !value ||
            typeof value !== 'object' ||
            typeof (value as { saasEnabled?: unknown }).saasEnabled !== 'boolean' ||
            typeof (value as { registrationEnabled?: unknown }).registrationEnabled !== 'boolean'
          ) {
            throw new Error('Auth configuration response is invalid')
          }
          if (!controller.signal.aborted) {
            setConfig(value as { saasEnabled: boolean; registrationEnabled: boolean })
            setFailed(false)
          }
          return
        } catch {
          if (controller.signal.aborted) return
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)))
          }
        }
      }
      if (!controller.signal.aborted) setFailed(true)
    })()

    return () => controller.abort()
  }, [validLink, action])
  // Never silently show a stale signup/app screen while a security link loads.
  if (validLink && !config) return <main dir="rtl" className="flex min-h-screen flex-col items-center justify-center gap-4 p-6"><p role={failed ? 'alert' : 'status'}>{failed ? 'تعذّر فتح رابط الأمان؛ جرّب تحميل الصفحة تاني. لم يتم تنفيذ أي إجراء.' : 'بنتحقق من إعدادات رابط الأمان…'}</p>{failed && <button type="button" className="rounded-xl border px-4 py-3" onClick={() => window.location.reload()}>جرّب تاني</button>}</main>
  // A different action/token must not reuse the previous form's local mode.
  if (config?.saasEnabled && validLink) return <SaasAccess key={`${action}|${token}`} action={action!} linkToken={token!} registrationEnabled={config.registrationEnabled} />
  return children
}
