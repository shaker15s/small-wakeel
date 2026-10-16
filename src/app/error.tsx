'use client'

// وكيل — حدّ الخطأ للواجهة (App Router error boundary).
//
// Why it matters: without it, a render error inside any view shows the browser's
// blank page or a raw stack (production), and the shop owner loses the screen he
// was on. Here he gets an Arabic explanation, a retry that re-renders the view,
// and — importantly — the error id so support can find it in the logs.
import { useEffect } from 'react'
import { RotateCcw, TriangleAlert } from 'lucide-react'

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Server-side digest (if any) is the identifier the operator can grep for.
    console.error('[ui] error boundary:', error.digest ?? error.message, error)
  }, [error])

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-wakil-amber/15 text-wakil-amber">
        <TriangleAlert className="size-6" aria-hidden />
      </span>
      <h1 className="text-lg font-bold">حصلت مشكلة في الشاشة دي</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        بياناتك ومخزونك زي ما هما — المشكلة في العرض بس. جرّب تاني، ولو فضلت، ابعت الرقم
        ده للدعم.
      </p>
      {error.digest ? (
        <code className="num rounded bg-muted px-2 py-1 text-xs text-muted-foreground">{error.digest}</code>
      ) : null}
      <button
        type="button"
        onClick={reset}
        className="press inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        <RotateCcw className="size-4" aria-hidden />
        جرّب تاني
      </button>
    </main>
  )
}
