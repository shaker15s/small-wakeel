// Context is evidence, never authority. Keep recent dialogue in its real roles,
// bounded independently from the stable system prefix and the current request.
import type { LLMMessage } from './llm'

export const BRAIN_CONTRACT_VERSION = 'wakil-brain-v2'
export const HISTORY_BUDGET_CHARS = 12_000
export function recentDialogue(history: { role: string; text: string }[] = [], budget = HISTORY_BUDGET_CHARS): LLMMessage[] {
  const kept: LLMMessage[] = []
  let remaining = Math.max(0, Math.floor(budget))
  for (const row of history.slice(-12).reverse()) {
    if (!remaining) break
    if ((row.role !== 'user' && row.role !== 'assistant') || !row.text.trim()) continue
    const cap = Math.min(remaining, 3_000)
    const content = row.text.length <= cap ? row.text : row.text.slice(-cap)
    kept.push({ role: row.role, content })
    remaining -= content.length
  }
  return kept.reverse()
}

/** JSON escaping prevents stored text from closing the evidence delimiter.
 * Not an injection firewall: backend permission checks remain mandatory. */
export function evidenceBlock(label: string, text: string, maxChars = 18_000): string {
  const clipped = text.length > maxChars ? text.slice(0, maxChars) + '\n[سياق مختصر؛ اطلب الأداة للتفاصيل]' : text
  return `<context-data name="${label}">\n${JSON.stringify(clipped).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')}\n</context-data>`
}

/** Stable signatures prevent a model retry with reordered object keys from
 * executing the same side effect twice. Array order remains meaningful. */
export function toolSignature(tool: string, args: Record<string, unknown>): string {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
    return value
  }
  return `${tool}:${JSON.stringify(canonical(args))}`
}
