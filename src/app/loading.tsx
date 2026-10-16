// وكيل — هيكل التحميل (Suspense fallback).
// Keeps the first paint identical to the app's own skeleton language, so a slow
// network shows the product instead of a white flash.
export default function Loading() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3">
        <span
          className="size-10 animate-pulse rounded-full bg-wakil-amber/20"
          aria-hidden
        />
        <p className="shimmer-text text-sm font-medium">وكيل بيجهز…</p>
      </div>
    </main>
  )
}
