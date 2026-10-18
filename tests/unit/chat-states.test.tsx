import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThinkingIndicator } from '@/components/chat/ThinkingIndicator'
import { ThinkingBlock } from '@/components/chat/ThinkingBlock'
import { containsMemorySecret, mayLearnImplicitly } from '@/lib/agent/memory-policy'

test('waiting UI is deterministic and does not invent database/stock checks', () => {
  const html = renderToStaticMarkup(<ThinkingIndicator waiting showAvatar={false} />)
  expect(html).toContain('aria-busy="true"')
  expect(html).toContain('وصل طلبك')
  expect(html).not.toContain('بحسب الأرقام')
  expect(html).not.toContain('بدوّر في سجلك')
})
test('live progress names the actual active event, not a random thought stage', () => {
  const html = renderToStaticMarkup(<ThinkingIndicator showAvatar={false} steps={[{ label: 'اكتمل البحث', detail: '', state: 'done' }, { label: 'جارٍ التحقق من العملية', detail: '', state: 'active' }]} />)
  expect(html).toContain('جارٍ التحقق من العملية')
  expect(html).toContain('خطوات اتنفذت')
})
test('execution disclosure shows steps, not a claim to reveal private model reasoning', () => {
  const html = renderToStaticMarkup(<ThinkingBlock steps={[]} streaming />)
  expect(html).toContain('جارٍ التنفيذ')
  expect(html).not.toContain('بتحقق من المخزن')
})
test('implicit learning refuses quoted, hypothetical, negative, question and secret text', () => {
  for (const text of ['لو انا بحب أسدد كل خميس', 'قال انا بحب أسدد كل خميس', '«انا بحب أسدد كل خميس»', 'انا بحب أسدد كل خميس؟', 'انا مش بحب أسدد كل خميس', 'انا بحب password: unsafe']) expect(mayLearnImplicitly(text)).toBe(false)
  expect(mayLearnImplicitly('انا بحب أسدد كل خميس')).toBe(true)
})
test('common credentials are refused by explicit and implicit memory paths', () => {
  for (const text of ['كلمة السر للاختبار', 'كلمة المرور secret', 'API_KEY=synthetic', 'كود التحقق 123456', 'Bearer synthetic-token']) expect(containsMemorySecret(text)).toBe(true)
  expect(containsMemorySecret('العميل بيفضل السداد يوم الخميس')).toBe(false)
})
