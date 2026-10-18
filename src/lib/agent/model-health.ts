import { AsyncLocalStorage } from 'node:async_hooks'
interface Health { retried: boolean; fellBack: boolean; servedBy: string | null }
const fresh = (): Health => ({ retried: false, fellBack: false, servedBy: null })
const scopes = new AsyncLocalStorage<Health>()
const fallback = fresh()
// Preserve existing gateway hooks while making concurrent turns independent.
export const llmHealth = new Proxy(fallback, {
  get(target, key) { return Reflect.get(scopes.getStore() ?? target, key) },
  set(target, key, value) { return Reflect.set(scopes.getStore() ?? target, key, value) },
})
export function withModelHealth<T>(run: () => T): T { return scopes.run(fresh(), run) }
