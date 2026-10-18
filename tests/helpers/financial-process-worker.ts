// Test-only IPC instrumentation. No production failpoints/environment bypasses.
import { db } from '../../src/lib/db'
import { executeOperation } from '../../src/lib/domain/executors'
import { OperationConflictError } from '../../src/lib/domain/errors'
const [opId, actor, phase] = process.argv.slice(2)
async function pause(point: string) {
  if (phase !== point) return
  process.stdout.write(`PAUSED:${point}\n`)
  const timer = setInterval(() => {}, 1000)
  try { await new Promise(() => {}) } finally { clearInterval(timer) }
}
const original = db.$transaction.bind(db)
// Intercept only this child process's DB handle. Every SQL write still uses
// the real adapter/SQLite transaction; the parent kills the OS process.
db.$transaction = (async (callback, options) => {
  const result = await original(async (tx) => {
    const wrapped = new Proxy(tx, { get(target, name) {
      const value = Reflect.get(target, name)
      if (name === 'operation' || name === 'item' || name === 'cashEntry') {
        return new Proxy(value, { get(model, method) {
          const fn = Reflect.get(model, method)
          if (typeof fn !== 'function') return fn
          return async (...args: unknown[]) => {
            const row = await fn.apply(model, args)
            if (name === 'operation' && method === 'updateMany') await pause('after-claim')
            if (name === 'item' && method === 'update') await pause('after-stock')
            if (name === 'cashEntry' && method === 'create') await pause('after-cash')
            return row
          }
        } })
      }
      return typeof value === 'function' ? value.bind(target) : value
    } })
    const outcome = await callback(wrapped)
    await pause('before-commit')
    return outcome
  }, options)
  await pause('after-commit')
  if (phase === 'lost-commit-ack') throw new Error('Simulated commit acknowledgement loss')
  return result
}) as typeof db.$transaction
try {
  const result = await executeOperation(opId, actor)
  console.log(JSON.stringify({ status: result.op.status, ok: result.outcome.ok }))
} catch (e) {
  if (e instanceof OperationConflictError) console.log(JSON.stringify({ status: 409 }))
  else throw e
} finally { await db.$disconnect() }
