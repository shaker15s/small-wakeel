// وكيل — tiny request/response helpers shared by all read API routes.
import { NextResponse } from 'next/server'

/** Parsed query string of a Request. */
export function searchParams(req: Request): URLSearchParams {
  return new URL(req.url).searchParams
}

/** 400 with an Arabic error body, e.g. { error: 'businessId مطلوب' }. */
export function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/** 404 with an Arabic error body. */
export function notFound(message: string) {
  return NextResponse.json({ error: message }, { status: 404 })
}

/** 500 with the standard Arabic error body; logs the exception with its scope. */
export function serverError(scope: string, e: unknown) {
  console.error(`[api/${scope}]`, e)
  return NextResponse.json({ error: 'حصل خطأ في السيرفر' }, { status: 500 })
}
