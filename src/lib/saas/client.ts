'use client'
let csrf: string | null = null
let pending: Promise<void> | undefined
export function clearBrowserIdentity() {
  csrf = null
  try {
    window.sessionStorage.removeItem('wakil.token')
    window.localStorage.removeItem('wakil.token')
    window.localStorage.removeItem('wakil.session.v2')
    window.localStorage.setItem('wakil.onboarded.v1', '1')
  } catch { /* HttpOnly cookie does not depend on browser storage. */ }
}
async function hydrateCsrf() {
  if (csrf || typeof window === 'undefined') return
  pending ??= fetch('/api/auth/me', { cache: 'no-store', credentials: 'same-origin' }).then(async (response) => {
    if (response.ok) csrf = (await response.json()).csrfToken ?? null
  }).catch(() => {}).finally(() => { pending = undefined })
  await pending
}
export async function sessionFetch(input: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (!['GET', 'HEAD', 'OPTIONS'].includes((init.method ?? 'GET').toUpperCase())) {
    await hydrateCsrf()
    if (csrf) headers.set('x-wakil-csrf', csrf)
  }
  const response = await fetch(input, { ...init, headers, credentials: 'same-origin' })
  if (response.status === 401) csrf = null
  return response
}
export async function authRequest<T = Record<string, unknown>>(action: string, body?: object): Promise<T> {
  const response = await sessionFetch(`/api/auth/${action}`, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? 'تعذّر إتمام الطلب')
  if (data.csrfToken) csrf = data.csrfToken
  return data as T
}
