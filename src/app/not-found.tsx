// وكيل — صفحة ٤٠٤ بالعربي.
//
// Next ships an ENGLISH «This page could not be found» by default, which is a
// rude surprise in an Arabic-first product (and the shop owner may well hit it
// from a truncated WhatsApp link). This page says what happened, in dialect,
// and offers the two things a lost user actually wants.
import Link from 'next/link'

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <p className="num text-5xl font-bold text-wakil-amber/80" aria-hidden>
        ٤٠٤
      </p>
      <h1 className="text-lg font-bold">الصفحة دي مش موجودة</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        يمكن اللينك متقطّع أو الصفحة اتشالت. ارجع لوكيل وكمّل شغلك عادي — كل البيانات في مكانها.
      </p>
      <Link
        href="/"
        className="press rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        ارجع لوكيل
      </Link>
    </main>
  )
}
