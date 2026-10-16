
// ---------------------------------------------------------------------------
// R29 — «الرد لازم يشبه الكارت» (spoken reply ↔ card grounding)
// ---------------------------------------------------------------------------
import { describe, expect, test } from 'bun:test'

describe('reply grounding (رد متسق مع الكروت)', () => {
  test('small talk over a real customer card is NOT grounded', async () => {
    const { replyGroundsCards } = await import('../../src/lib/agent/harness')
    const cards = [
      {
        kind: 'kv' as const,
        title: 'ملف كريم عادل',
        rows: [
          { label: 'المديونية الحالية', value: '٢٠٠ ج.م' },
          { label: 'بيسدد كل', value: 'مفيش بيانات كافية' },
        ],
      },
    ]
    expect(replyGroundsCards('أكيد — دي بيانات السجل الحقيقي. التفاصيل كلها في الكارت تحت.', cards)).toBe(false)
    expect(replyGroundsCards('كريم عادل عليه ٢٠٠ ج.م حالًا.', cards)).toBe(true)
  })

  test('a negative verdict must be echoed, not chatted over', async () => {
    const { replyGroundsCards } = await import('../../src/lib/agent/harness')
    const cards = [
      { kind: 'kv' as const, title: 'ملف العميل', rows: [{ label: 'النتيجة', value: 'ملقيتش عميل بالاسم «أحمد» — مفيش عميل بالاسم ده في السجل' }] },
    ]
    expect(replyGroundsCards('تمام يا فندم، بياناتك جاهزة.', cards)).toBe(false)
    expect(replyGroundsCards('ملقيتش عميل بالاسم «أحمد» في السجل.', cards)).toBe(true)
  })

  test('a period in a card title is not a claim to correct (verifier)', async () => {
    const { verifyReply } = await import('../../src/lib/agent/verify')
    const facts = [
      { label: 'المبيعات', value: '٠ ج.م' },
      { label: 'المصروفات', value: '٠ ج.م' },
    ]
    const out = verifyReply('دي أرقام «قراءة شغلك — آخر 30 يوم» من سجلك: المبيعات ٠ ج.م.', facts)
    expect(out.text).toContain('30')
    expect(out.text).not.toContain('آخر 0')
  })
})
