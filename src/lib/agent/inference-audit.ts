// Opt-in acceptance-only scope. No raw prompts/responses persisted by this hook.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type { LLMMessage } from './llm'
export interface InferenceReceipt { model: string; systemSha256: string; systemChars: number; roles: string[]; response: string }
const scopes = new AsyncLocalStorage<InferenceReceipt[]>()
export function strictInference(): boolean { return !!scopes.getStore() }
export async function withStrictInference<T>(run: () => Promise<T>): Promise<{ result: T; receipts: InferenceReceipt[] }> {
  const receipts: InferenceReceipt[] = []
  return scopes.run(receipts, async () => ({ result: await run(), receipts }))
}
export function recordInference(messages: LLMMessage[], response: string, model: string): void {
  const receipts = scopes.getStore()
  if (!receipts) return
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  receipts.push({ model, systemSha256: createHash('sha256').update(system).digest('hex'), systemChars: system.length, roles: messages.map((m) => m.role), response })
}
