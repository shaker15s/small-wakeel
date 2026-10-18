import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Onboarding } from '@/components/app/Onboarding'
import { useWakil } from '@/lib/store'
import { preferencePatchSchema, DEFAULT_WORKSPACE } from '@/lib/workspace-options'
import { BUSINESS_PLAYBOOKS, businessKnowledgeSection } from '@/lib/agent/business-knowledge'
import { VERTICAL_PRESETS } from '@/lib/verticals'
import { resolveCairoSchedule, nextCairoRun } from '@/lib/tasks/cairo-time'
import { strictInference, withStrictInference, recordInference } from '@/lib/agent/inference-audit'
for (const preset of VERTICAL_PRESETS) {
  test(`curated knowledge covers ${preset.key} with relevant workflow, sources and capability limits`, () => {
    const playbook = BUSINESS_PLAYBOOKS[preset.key]
    expect(playbook).toBeDefined()
    const section = businessKnowledgeSection(preset.key)
    expect(section).toContain(playbook.workflow)
    expect(section).toContain('حدود القدرة')
    expect(section).toContain('https://')
    expect(section).toContain('ليست دليلًا على بيانات المنشأة')
    expect(section.length).toBeLessThan(3000)
  })
}
test('custom businesses ask for real workflow rather than borrowing demo products', () => {
  expect(businessKnowledgeSection('custom-print-shop')).toContain('اسأل المستخدم')
  expect(businessKnowledgeSection('custom-print-shop')).not.toContain('صنف أساسي')
})
test('setup shows real identity, opt-in priorities, bounded colors and truthful model/data limits', () => {
  const before = useWakil.getState()
  useWakil.setState({ businessId: 'setup-business', userId: 'setup-user' })
  try {
    const qc = new QueryClient()
    const html = renderToStaticMarkup(<QueryClientProvider client={qc}><Onboarding businesses={[{ id: 'setup-business', name: 'Actual supplied name', type: 'supermarket', users: [{ id: 'setup-user', name: 'Actual supplied user', role: 'owner', title: null }] }]} onFinish={() => {}} onPick={() => {}} initial={DEFAULT_WORKSPACE} /></QueryClientProvider>)
    expect(html).toContain('Actual supplied name'); expect(html).toContain('Actual supplied user')
    expect(html).toContain('مفيش بضاعة أو فلوس أو عملاء هيتضافوا تلقائي')
    expect(html).toContain('الموديل محتاج مزوّد حقيقي متاح')
    expect(html).toContain('مفيش جدولة تلقائية')
    expect(html).not.toContain('15000'); expect(html).not.toContain('تم ربط')
    qc.clear()
  } finally { useWakil.setState(before) }
})
test('safe presentation schema rejects privileged fields and arbitrary executable styles', () => {
  expect(preferencePatchSchema.safeParse({ accent: 'indigo', responseMode: 'deep' }).success).toBe(true)
  for (const patch of [{ accent: 'url(javascript:alert(1))' }, { js: 'evil' }, { businessId: 'foreign' }, { userId: 'owner' }, { openingCash: 123 }, { goals: ['cash', 'cash', 'stock', 'debts', 'margin'] }]) expect(preferencePatchSchema.safeParse(patch).success).toBe(false)
})
test('chat schedules require explicit day/hour and resolve actual Cairo UTC offsets, not host timezone', () => {
  const now = new Date('2026-10-18T10:00:00Z')
  expect(resolveCairoSchedule('بكرة', now)).toBeNull()
  expect(resolveCairoSchedule('09:00', now)).toBeNull()
  expect(resolveCairoSchedule('بكرة 09:00', now)?.toISOString()).toBe('2026-10-19T06:00:00.000Z')
  expect(resolveCairoSchedule('2026-12-01 09:00', now)?.toISOString()).toBe('2026-12-01T07:00:00.000Z')
  expect(resolveCairoSchedule('2026-02-31 09:00', now)).toBeNull()
  expect(resolveCairoSchedule('2026-01-01 09:00', now)).toBeNull()
})
test('recurring reports preserve Cairo wall-clock across DST and clamp month-end', () => {
  expect(nextCairoRun(new Date('2026-10-29T06:00:00Z'), 'daily').toISOString()).toBe('2026-10-30T07:00:00.000Z')
  expect(nextCairoRun(new Date('2026-01-31T07:00:00Z'), 'monthly').toISOString()).toBe('2026-02-28T07:00:00.000Z')
})
test('strict live acceptance scopes isolate receipts and never persist the raw prompt', async () => {
  const messages = [{ role: 'system' as const, content: 'private system marker' }, { role: 'user' as const, content: 'private question' }]
  const [a, b] = await Promise.all(['a', 'b'].map((value) => withStrictInference(async () => {
    expect(strictInference()).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, value === 'a' ? 5 : 1))
    recordInference(messages, value, `provider-${value}`)
    return value
  })))
  expect(a.receipts).toHaveLength(1); expect(b.receipts).toHaveLength(1)
  expect(a.receipts[0].model).toBe('provider-a'); expect(b.receipts[0].response).toBe('b')
  expect(a.receipts[0].systemSha256).toHaveLength(64)
  expect(JSON.stringify(a.receipts)).not.toContain('private system marker')
  expect(strictInference()).toBe(false)
})
