import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccessGate } from '@/components/app/AccessGate'
import { ApiError } from '@/lib/api'

test('401 renders an explicit credential form, not an endless loading screen', () => {
  const html = renderToStaticMarkup(<AccessGate error={new ApiError('unauthorized', 401)} onRetry={() => {}} />)
  expect(html).toContain('الدخول إلى وكيل')
  expect(html).toContain('type="password"')
  expect(html).toContain('htmlFor="access-token"'.replace('htmlFor', 'for'))
  expect(html).toContain('role="alert"')
  expect(html).not.toContain('وكيل بيجهز')
})

test('network failures offer a retry without claiming a successful connection', () => {
  const html = renderToStaticMarkup(<AccessGate error={new Error('offline')} onRetry={() => {}} />)
  expect(html).toContain('تعذّر تحميل وكيل')
  expect(html).toContain('جرّب تاني')
  expect(html).not.toContain('type="password"')
})
