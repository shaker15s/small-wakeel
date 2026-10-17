'use client'

// وكيل — ChunkRecovery: the self-heal for the one crash that keeps happening.
//
// THE BUG (seen live, repeatedly, in the preview): after a deploy or a dev
// restart the browser is still holding an old document, so a lazy chunk URL it
// references no longer exists. Next reports:
//
//   «Module …/graduation-cap.js was instantiated because it was required from
//    Onboarding.tsx, but the module factory is not available»
//
// and the app lands in its error boundary — a «شاشة بايضة» for the owner, with
// nothing wrong on the server (the same page renders fine on a reload). React's
// own suggestion is a hard reload; doing that FOR him is the difference between
// a broken product and a blip.
//
// How it works: listen for `error` and `unhandledrejection`, recognise the
// chunk/module-factory family, and reload ONCE per session with a cache-busting
// query parameter (sessionStorage guards against a reload loop when the chunk is
// genuinely missing). A manual "reload" is offered in the error boundaries too.

import { useEffect } from 'react'

const RELOAD_KEY = 'wakil:chunk-recovery'

/** The family of messages that mean «the browser has a stale module graph». */
export function isChunkLoadFailure(message: string): boolean {
  return (
    /module factory is not available/i.test(message) ||
    /ChunkLoadError/i.test(message) ||
    /Loading chunk \d+ failed/i.test(message) ||
    /Failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /was instantiated because it was required from module/i.test(message)
  )
}

/**
 * Reload the document once per session, bypassing the HTTP cache.
 * Exported for the error boundaries (they offer the same action as a button).
 */
export function hardReload(): void {
  try {
    const url = new URL(window.location.href)
    url.searchParams.set('recover', Date.now().toString(36))
    window.location.replace(url.toString())
  } catch {
    window.location.reload()
  }
}

export function ChunkRecovery() {
  useEffect(() => {
    const handle = (message: string) => {
      if (!isChunkLoadFailure(message)) return
      let already = '0'
      try {
        already = sessionStorage.getItem(RELOAD_KEY) ?? '0'
      } catch {
        /* private mode — reload anyway, once at most per mount */
      }
      console.warn('[chunk-recovery] إصدار قديم في المتصفح — بنحدّث الصفحة تلقائيًا')
      if (already === '1') return
      try {
        sessionStorage.setItem(RELOAD_KEY, '1')
      } catch {
        /* ignore */
      }
      // a tick of delay so the console keeps the original error for the dev
      setTimeout(hardReload, 120)
    }

    const onError = (event: ErrorEvent) => handle(event.message ?? String(event.error ?? ''))
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason as { message?: string; name?: string } | undefined
      handle(`${reason?.name ?? ''} ${reason?.message ?? String(event.reason ?? '')}`)
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  return null
}
