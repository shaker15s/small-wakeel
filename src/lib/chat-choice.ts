import type { ChatActionDTO } from './types'

/** Presentation only. Keep the original nonce-bound text for transport, retries,
 * model context and the audit trail. Labels come from the immediately preceding
 * server reply, never a client-supplied display override or another question. */
export function choiceDisplayText(text: string, precedingActions?: ChatActionDTO[] | null): string | undefined {
  const value = text.trim().replace(/\s+/g, ' ')
  if (!/^اختيار [a-z0-9-]+ رقم \d+$/.test(value)) return undefined
  return precedingActions?.find(a => a.reply === value)?.label ?? 'اختيار من سؤال سابق؛ راجع رد وكيل'
}
