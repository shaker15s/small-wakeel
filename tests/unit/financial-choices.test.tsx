import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { choiceDisplayText } from '@/lib/chat-choice'
import { MessageBubble } from '@/components/chat/MessageBubble'
import { ChatActions } from '@/components/chat/ChatActions'
import { parseSpokenMoney } from '@/lib/agent/cashbook-money'
import { parseCashbook } from '@/lib/agent/cashbook-parser'

test('clarification reply buttons are disabled without a live latest-turn handler, not auto-navigation', () => {
  const actions = [{ id: 'choice-test', label: 'أحمد · الحساب ٢', view: 'chat' as const, reply: 'اختيار token رقم 2' }]
  const stale = renderToStaticMarkup(<ChatActions actions={actions} />)
  expect(stale).toContain('disabled=""')
  expect(stale).not.toContain('href=')
  const live = renderToStaticMarkup(<ChatActions actions={actions} onReply={() => {}} />)
  expect(live).not.toContain('disabled=""')
  expect(live).toContain('أحمد')
})
test('financial grouping and sub-pound words are exact, not arbitrary separator stripping', () => {
  for (const [input, expected] of [['نص جنيه', 50], ['ربع', 25], ['خمسين قرش', 50], ['١٬٢٣٤٫٥٠ جنيه', 123450], ['1,234.50', 123450]] as const) expect(parseSpokenMoney(input)).toBe(expected)
  for (const input of ['١٢٬٥٠', '1,20', '1,23,456', '500,,000']) expect(parseSpokenMoney(input)).toBeNull()
  expect(parseCashbook('سلفت أحمد ١٢٬٥٠ جنيه')).toBe('ambiguous')
  expect(parseCashbook('سلفت أحمد 1,250.50 جنيه')).toMatchObject({ amount: 125050 })
})


test('choice bubbles display the actual selected label without changing nonce-bound transport text', () => {
  const text = 'اختيار 3c056148-3286-4fa1-a890-d51ba02f0cb2 رقم 1'
  const actions = [{ id: 'proof', label: 'جبت أكياس تعبئة', view: 'chat' as const, reply: text }]
  const display = choiceDisplayText(text, actions)
  expect(display).toBe('جبت أكياس تعبئة')
  const turn = { id: 'persisted-user', role: 'user' as const, text, createdAt: new Date().toISOString() }
  const html = renderToStaticMarkup(<MessageBubble turn={turn} userDisplayText={display} />)
  expect(html).toContain('جبت أكياس تعبئة')
  expect(html).not.toContain('3c056148')
  expect(turn.text).toBe(text)
  expect(choiceDisplayText('صرفت 500 جنيه بند نظافة', actions)).toBeUndefined()
  expect(choiceDisplayText(text, [])).toContain('سؤال سابق')
  expect(choiceDisplayText(text.replace('رقم 1', 'رقم 2'), actions)).toContain('سؤال سابق')
})
