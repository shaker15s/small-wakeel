'use client'

// وكيل — آخر حدّ للخطأ (يفشل التطبيق كله).
//
// This one replaces the root layout, so it must bring its own <html>/<body> and
// cannot rely on the design system. It exists so a fatal boot error is still a
// readable Arabic sentence with a reload button — not an empty white page on a
// shop's counter tablet.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="ar" dir="rtl">
      <body
        style={{
          display: 'flex',
          minHeight: '100dvh',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1rem',
          padding: '1.5rem',
          textAlign: 'center',
          fontFamily: 'system-ui, sans-serif',
          background: '#faf7f1',
          color: '#1a1a1a',
        }}
      >
        <h1 style={{ fontSize: '1.125rem', fontWeight: 700 }}>وكيل مش قادر يفتح دلوقتي</h1>
        <p style={{ maxWidth: '26rem', fontSize: '0.875rem', lineHeight: 1.7 }}>
          حصلت مشكلة في تحميل التطبيق. بياناتك متحفوظة في قاعدة البيانات ومش هتتأثر — اقفل
          الصفحة وافتحها تاني.
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            borderRadius: '0.5rem',
            background: '#1a1a1a',
            color: '#faf7f1',
            padding: '0.5rem 1rem',
            fontSize: '0.875rem',
            fontWeight: 500,
            border: 0,
            cursor: 'pointer',
          }}
        >
          جرّب تاني
        </button>
        {error.digest ? (
          <code style={{ fontSize: '0.6875rem', opacity: 0.6 }}>{error.digest}</code>
        ) : null}
      </body>
    </html>
  )
}
