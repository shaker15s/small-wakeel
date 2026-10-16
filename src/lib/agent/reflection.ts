// وكيل — reflection: correction-pattern lesson extraction (Reflexion).
//
// When the user starts a message with a correction («لا», «غلط», «مش كده»,
// «قصدى…») the PREVIOUS assistant reply was probably wrong. وكيل extracts a
// lesson from that moment into long-term memory (kind='insight', confidence
// 85) so the same mistake pattern gets less likely — the agent learns from
// being corrected, like a real employee.
//
// Fire-and-forget: never throws, never blocks the turn.
// NOTE: \b is useless with Arabic letters (documented codebase-wide), so the
// correction words are bounded with (^|\s)…(?=\s|$|punctuation) instead — the
// exact intent of the contract regex /لا|لا لا|غلط|مش كده|قصدى|قصدت/.

import { db } from '@/lib/db'

/** Egyptian correction starters — «لا مش كده», «غلط», «قصدى البيع مش الشرا». */
const CORRECTION_RE = /^\s*(لا|غلط|مش كده|مش كده كده|قصدى|قصدت)(?=\s|$|،|\.|؟|!)/

/** Extract the first correction word actually used (for logging only). */
export function isCorrection(userText: string): boolean {
  return CORRECTION_RE.test(userText.trim())
}

/**
 * Create the lesson memory + a UsageEvent (kind='reflection', label
 * 'correction') when the user just corrected the agent. Safe to call on
 * EVERY turn — non-corrections return immediately.
 */
export async function maybeReflect(
  businessId: string,
  userId: string,
  userText: string,
  lastAssistantText: string | null | undefined,
): Promise<void> {
  try {
    const trimmed = userText.trim()
    if (!trimmed || !CORRECTION_RE.test(trimmed)) return
    // nothing to correct — a correction on the first message has no lesson
    if (!lastAssistantText || !lastAssistantText.trim()) return

    const last80 = lastAssistantText.trim().slice(-80)
    const first80 = trimmed.slice(0, 80)
    const lesson = `المستخدم صحح رد سابق — المرجّح: ${last80}… التصحيح: ${first80}`

    // dedupe: the same correction lesson saved twice adds noise, not wisdom
    const existing = await db.agentMemory.findFirst({
      where: { businessId, userId, kind: 'insight', active: true, text: lesson },
      select: { id: true },
    })
    if (!existing) {
      await db.agentMemory.create({
        data: {
          businessId,
          userId,
          kind: 'insight',
          category: 'corrections',
          text: lesson,
          confidence: 85,
        },
      })
    }
    await db.usageEvent.create({
      data: { businessId, userId, kind: 'reflection', label: 'correction' },
    })
  } catch (e) {
    console.error('[reflection] maybeReflect failed (تجاهل):', e)
  }
}
