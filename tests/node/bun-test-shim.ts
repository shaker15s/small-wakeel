/**
 * وكيل — bun:test-compatible shim so the suite runs under plain Node (node ≥22.18
 * strips TS types natively). Used ONLY in the sandbox fallback where the bun
 * binary is unavailable — on a normal machine `bun test` remains the runner.
 *
 * Supported surface (exactly what this repo uses):
 *   test / expect / describe / beforeAll / beforeEach / afterAll / afterEach
 * Matchers: toBe toEqual toStrictEqual toContain toContainEqual toBeNull
 *   toBeUndefined toBeDefined toBeTruthy toBeFalsy toThrow toThrowError
 *   toBeGreaterThan toBeGreaterThanOrEqual toBeLessThan toBeLessThanOrEqual
 *   toHaveLength toMatchObject toMatch toBeInstanceOf toBeCloseTo toBeNaN
 *   toHaveProperty + the `.not` modifier on every matcher.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type Hook = () => void | Promise<void>
type TestFn = () => void | Promise<void>
type Matchers = Record<string, (...a: unknown[]) => void> & { not: Matchers }

type Item =
  | { kind: 'test'; name: string; fn: TestFn; timeoutMs?: number }
  | { kind: 'describe'; node: DescribeNode }

interface DescribeNode {
  name: string
  items: Item[]
  beforeAll: Hook[]
  beforeEach: Hook[]
  afterAll: Hook[]
  afterEach: Hook[]
}

const root: DescribeNode = { name: '', items: [], beforeAll: [], beforeEach: [], afterAll: [], afterEach: [] }
let current: DescribeNode = root

let passed = 0
let failed = 0
const failures: { name: string; err: unknown }[] = []

export function test(name: string, fn: TestFn, timeoutMs?: number): void {
  current.items.push({ kind: 'test', name, fn, timeoutMs })
}

/** bun parity: `it` is an alias of `test`. */
export const it = test

export function describe(name: string, body: () => void): void {
  const node: DescribeNode = { name, items: [], beforeAll: [], beforeEach: [], afterAll: [], afterEach: [] }
  current.items.push({ kind: 'describe', node })
  const prev = current
  current = node
  try {
    body()
  } finally {
    current = prev
  }
}

export function beforeAll(fn: Hook): void { current.beforeAll.push(fn) }
export function beforeEach(fn: Hook): void { current.beforeEach.push(fn) }
export function afterAll(fn: Hook): void { current.afterAll.push(fn) }
export function afterEach(fn: Hook): void { current.afterEach.push(fn) }

// ---------------------------------------------------------------------------
// Equality
// ---------------------------------------------------------------------------
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  }
  if (a instanceof RegExp || b instanceof RegExp) {
    return a instanceof RegExp && b instanceof RegExp && String(a) === String(b)
  }
  const ka = Object.keys(a as Record<string, unknown>)
  const kb = Object.keys(b as Record<string, unknown>)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}

function subsetMatch(actual: unknown, expected: unknown, path = '$'): string | null {
  if (expected === null || typeof expected !== 'object') {
    return deepEqual(actual, expected) ? null : `${path}: ${String(actual)} not deep-equal to ${String(expected)}`
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return `${path}: arrays differ`
    for (let i = 0; i < expected.length; i++) {
      const msg = subsetMatch(actual[i], expected[i], `${path}[${i}]`)
      if (msg) return msg
    }
    return null
  }
  if (actual === null || typeof actual !== 'object') return `${path}: expected object, got ${String(actual)}`
  for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
    const msg = subsetMatch((actual as Record<string, unknown>)[k], v, `${path}.${k}`)
    if (msg) return msg
  }
  return null
}

function fmt(v: unknown): string {
  try {
    return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

function buildMatchers(negated: boolean, actual: unknown): Matchers {
  const fail = (msg: string) => {
    throw new Error(negated ? `NOT ${msg} — got ${fmt(actual)}` : msg)
  }
  const assert = (cond: boolean, msg: string) => {
    if (negated ? cond : !cond) fail(msg)
  }
  const m: Record<string, (...a: unknown[]) => void> = {
    toBe: (exp) => assert(Object.is(actual, exp), `expected ${fmt(exp)}`),
    toEqual: (exp) => assert(deepEqualLoose(actual, exp), `expected deep-equal ${fmt(exp)}`),
    toStrictEqual: (exp) => assert(deepEqualLoose(actual, exp), `expected strict-equal ${fmt(exp)}`),
    toBeNull: () => assert(actual === null, 'expected null'),
    toBeUndefined: () => assert(actual === undefined, 'expected undefined'),
    toBeDefined: () => assert(actual !== undefined, 'expected defined'),
    toBeNaN: () => assert(typeof actual === 'number' && Number.isNaN(actual), 'expected NaN'),
    toBeTruthy: () => assert(!!actual, 'expected truthy'),
    toBeFalsy: () => assert(!actual, 'expected falsy'),
    toBeGreaterThan: (exp) => assert(typeof actual === 'number' && (actual as number) > (exp as number), `expected > ${exp}`),
    toBeGreaterThanOrEqual: (exp) => assert(typeof actual === 'number' && (actual as number) >= (exp as number), `expected >= ${exp}`),
    toBeLessThan: (exp) => assert(typeof actual === 'number' && (actual as number) < (exp as number), `expected < ${exp}`),
    toBeLessThanOrEqual: (exp) => assert(typeof actual === 'number' && (actual as number) <= (exp as number), `expected <= ${exp}`),
    toHaveLength: (exp) => {
      const len = (actual as { length?: unknown })?.length
      assert(typeof len === 'number' && len === exp, `expected length ${exp}`)
    },
    toContain: (exp) => {
      if (typeof actual === 'string') {
        assert(actual.includes(String(exp)), `expected "${actual}" to contain "${exp}"`)
      } else if (Array.isArray(actual)) {
        assert(actual.some((item) => deepEqual(item, exp)), `expected array to contain ${fmt(exp)}`)
      } else {
        fail('toContain: actual is not a string or array')
      }
    },
    toContainEqual: (exp) => assert(Array.isArray(actual) && actual.some((item) => deepEqual(item, exp)), `expected array to contain ${fmt(exp)}`),
    toBeInstanceOf: (cls) => assert(actual instanceof (cls as any), `expected instance of ${(cls as { name?: string })?.name}`),
    toMatchObject: (exp) => assert(subsetMatch(actual, exp) === null, `expected object to match ${fmt(exp)}`),
    toMatch: (exp) => {
      const s = typeof actual === 'string' ? actual : String(actual)
      const cond = typeof exp === 'string' ? s.includes(exp as string) : (exp as RegExp).test(s)
      assert(cond, `expected ${fmt(s)} to match ${String(exp)}`)
    },
    toThrow: (exp) => {
      if (typeof actual !== 'function') fail('toThrow: actual is not a function')
      let threw: unknown = null
      let didThrow = false
      try {
        ;(actual as () => unknown)()
      } catch (err) {
        didThrow = true
        threw = err
      }
      if (!didThrow) {
        assert(false, 'expected function to throw (it did not)')
        return
      }
      const msg = threw instanceof Error ? threw.message : String(threw)
      if (exp === undefined) {
        assert(true, '')
        return
      }
      if (typeof exp === 'string') assert(msg.includes(exp as string), `expected error containing "${exp}", got "${msg}"`)
      else if (exp instanceof RegExp) assert((exp as RegExp).test(msg), `expected error matching ${String(exp)}, got "${msg}"`)
      else assert(threw instanceof (exp as any), `expected error to be instance of ${(exp as { name?: string })?.name}`)
    },
    toThrowError: (...a: unknown[]) => m.toThrow(...a),
    toBeCloseTo: (exp, digits = 2) => assert(typeof actual === 'number' && Math.abs((actual as number) - (exp as number)) < 0.5 * 10 ** -Number(digits), `expected close to ${exp}`),
    arrayContaining: () => {
      // used as expect(actual).toEqual(expect.arrayContaining([...])) or toContainEqual
      throw new Error('arrayContaining: use expect.arrayContaining directly (matcher form unsupported in shim)')
    },
    toStartWith: (prefix: unknown) => {
      if (typeof actual !== 'string' || typeof prefix !== 'string') {
        fail('toStartWith: strings only')
        return
      }
      assert(actual.startsWith(prefix as string), `expected "${actual}" to start with "${prefix}"`)
    },
    toHaveProperty: (path, value) => {
      const parts = (Array.isArray(path) ? path : String(path).split('.')).filter(Boolean)
      let v: unknown = actual
      let ok = true
      for (const p of parts) {
        if (v === null || typeof v !== 'object') { ok = false; break }
        v = (v as Record<string, unknown>)[p]
      }
      assert(ok && (value === undefined || deepEqual(v, value)), `expected property ${String(path)}`)
    },
  }
  const table = m as Matchers & { rejects?: unknown }
  let rejectOther: Record<string, unknown> | undefined
  if (actual instanceof Promise) {
    Object.defineProperty(table, 'rejects', {
      enumerable: false,
      get() {
        if (!rejectOther) rejectOther = buildRejectMatchers(negated, actual as Promise<unknown>)
        return rejectOther
      },
    })
  }
  let other: Matchers | undefined
  Object.defineProperty(table, 'not', {
    enumerable: false,
    get() {
      if (!other) other = buildMatchers(!negated, actual)
      return other
    },
  })
  return table
}

/** Async rejection matchers — `await expect(promise).rejects.toThrow(...)`. */
function buildRejectMatchers(negated: boolean, promise: Promise<unknown>) {
  const fail = (msg: string) => new Error(negated ? `NOT ${msg}` : msg)
  const assert = (cond: boolean, msg: string) => {
    if (negated ? cond : !cond) throw fail(msg)
  }
  async function settled(): Promise<{ ok: boolean; value: unknown }> {
    try {
      return { ok: true, value: await promise }
    } catch (value) {
      return { ok: false, value }
    }
  }
  const t: Record<string, unknown> = {}
  t.toThrow = async (exp?: string | RegExp | (new (...args: never[]) => unknown)) => {
    const { ok, value } = await settled()
    if (!ok) {
      const msg = value instanceof Error ? value.message : String(value)
      if (exp === undefined) assert(true, 'expected rejection')
      else if (typeof exp === 'string') assert(msg.includes(exp), `expected rejection containing "${exp}", got "${msg}"`)
      else if (exp instanceof RegExp) assert(exp.test(msg), `expected rejection matching ${String(exp)}, got "${msg}"`)
      else assert(value instanceof exp, `expected rejection to be instance of ${(exp as { name?: string })?.name}, got "${msg}"`)
    } else {
      assert(false, 'expected promise to reject, but it resolved')
    }
  }
  t.toBeInstanceOf = async (cls: new (...args: never[]) => unknown) => {
    const { ok, value } = await settled()
    assert(!ok && value instanceof cls, `expected rejection to be instance of ${(cls as { name?: string })?.name}`)
  }
  t.toMatchObject = async (exp: unknown) => {
    const { ok, value } = await settled()
    assert(!ok && subsetMatch(value, exp) === null, `expected rejection to match ${fmt(exp)}`)
  }
  t.toEqual = async (exp: unknown) => {
    const { ok, value } = await settled()
    assert(!ok && deepEqual(value, exp), `expected rejection deep-equal ${fmt(exp)}`)
  }
  t.toBe = async (exp: unknown) => {
    const { ok, value } = await settled()
    assert(!ok && Object.is(value, exp), `expected rejection ${fmt(exp)}`)
  }
  let other: Record<string, unknown> | undefined
  Object.defineProperty(t, 'not', {
    enumerable: false,
    get() {
      if (!other) other = buildRejectMatchers(!negated, promise)
      return other
    },
  })
  return t
}

export function expect(actual: unknown): Matchers {
  return buildMatchers(false, actual)
}

/** Asymmetric matcher: `expect(actual).toEqual(expect.arrayContaining([...]))`. */
export const arrayContaining = (items: unknown[]): { __asymmetric: 'array'; items: unknown[] } => ({ __asymmetric: 'array', items })
export const objectContaining = (sample: Record<string, unknown>): { __asymmetric: 'object'; sample: Record<string, unknown> } => ({ __asymmetric: 'object', sample })
export const stringContaining = (substr: string): { __asymmetric: 'string'; substr: string } => ({ __asymmetric: 'string', substr })

function asymmetricMatch(actual: unknown, exp: { __asymmetric: string } | unknown): boolean {
  if (exp && typeof exp === 'object' && '__asymmetric' in (exp as object)) {
    const a = exp as { __asymmetric: string; items?: unknown[]; sample?: Record<string, unknown>; substr?: string }
    if (a.__asymmetric === 'string') return typeof actual === 'string' && actual.includes(a.substr ?? '')
    if (a.__asymmetric === 'array') {
      if (!Array.isArray(actual)) return false
      const missing = (a.items ?? []).filter((want) => !actual.some((have) => deepEqual(have, want) || asymmetricMatch(have, want)))
      return missing.length === 0
    }
    if (a.__asymmetric === 'object') {
      return subsetMatch(actual, a.sample ?? {}) === null
    }
  }
  return false
}

// bun parity: asymmetric matchers reachable as `expect.arrayContaining([...])`
;(expect as unknown as Record<string, unknown>).arrayContaining = arrayContaining
;(expect as unknown as Record<string, unknown>).objectContaining = objectContaining
;(expect as unknown as Record<string, unknown>).stringContaining = stringContaining

/** deepEqual that understands asymmetric matchers on the EXPECTED side. */
function deepEqualLoose(a: unknown, b: unknown): boolean {
  if (b && typeof b === 'object' && '__asymmetric' in (b as object)) {
    if (Array.isArray(b)) {
      // expect.arrayContaining passed where an array is expected element-wise is uncommon; treat as array-contains-all
      if (!Array.isArray(a)) return false
      return (b as unknown[]).every((want) => a.some((have) => deepEqualLoose(have, want) || deepEqual(have, want)))
    }
    return asymmetricMatch(a, b)
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return b.every((w, i) => deepEqualLoose(a[i], w))
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a as object)
    const kb = Object.keys(b as object)
    if (ka.length !== kb.length) return false
    return ka.every((k) => deepEqualLoose((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  }
  return deepEqual(a, b)
}

// ---------------------------------------------------------------------------
// mock.module — bun parity for the scenario helpers. The resolve hook runs on
// its own thread, so the registry is shared through a JSON file: mock.module()
// (main thread) writes it, the hook (hook thread) consults it at resolve time.
// ---------------------------------------------------------------------------
const MOCKS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.mocks')
// Per-PID registry: the file must never leak mocks from one process into another
// (a test process and its spawned scenario children each own their mocks).
const REGISTRY_FILE = path.join(MOCKS_DIR, `registry-${process.pid}.json`)
const SHIM_URL = pathToFileURL(fileURLToPath(import.meta.url)).href

export const __mockExports = new Map<string, unknown>()

function readMockRegistry(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

function fileCandidates(base: string): string[] {
  return [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, path.join(base, 'index.ts'), path.join(base, 'index.tsx'), path.join(base, 'index.js')]
}

function findFile(base: string): string | null {
  for (const cand of fileCandidates(base)) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand
  }
  return null
}

function mockCallerDir(): string | undefined {
  try {
    const lines = (new Error()).stack?.split('\n') ?? []
    for (const line of lines.slice(1)) {
      const m = line.match(/(file:\/\/[^\s):]+\.ts)/)
      if (m && !m[1].includes('bun-test-shim')) return path.dirname(fileURLToPath(m[1]))
    }
  } catch {
    // fall through
  }
  return undefined
}

const REPO_ROOT = path.resolve(MOCKS_DIR, '..', '..')

function resolveMockTarget(spec: string): string {
  if (spec.startsWith('@/')) {
    return findFile(path.join(REPO_ROOT, 'src', spec.slice(2))) ?? path.join(REPO_ROOT, 'src', spec.slice(2))
  }
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const base = path.resolve(mockCallerDir() ?? process.cwd(), spec)
    return findFile(base) ?? base
  }
  const seg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
  return `pkg:${seg}`
}

export const mock = {
  module(spec: string, factory: () => unknown): void {
    const target = resolveMockTarget(spec)
    const exportsObj = (factory() ?? {}) as Record<string, unknown>
    __mockExports.set(target, exportsObj)
    mkdirSync(MOCKS_DIR, { recursive: true })
    let hash = 7
    for (const ch of target) hash = (hash * 31 + ch.charCodeAt(0)) | 0
    const mockFile = path.join(MOCKS_DIR, `mock-${Math.abs(hash).toString(36)}.mjs`)
    // Preserve the real module's OTHER exports (static named imports of names
    // the mock does not override would otherwise fail at link time). Local
    // explicit exports shadow the star export, per ESM semantics.
    const realRef = target.startsWith('pkg:')
      ? JSON.stringify(spec)
      : `'${pathToFileURL(target).href}'`
    const lines: string[] = [
      `export * from ${realRef}`,
      `import { __mockExports } from '${SHIM_URL}'`,
      `const m = __mockExports.get(${JSON.stringify(target)}) ?? {}`,
    ]
    for (const k of Object.keys(exportsObj)) {
      if (k === 'default') continue
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k)) lines.push(`export const ${k} = m[${JSON.stringify(k)}]`)
      else {
        const id = `__k${lines.length}`
        lines.push(`const ${id} = m[${JSON.stringify(k)}]`)
        lines.push(`export { ${id} as ${JSON.stringify(k)} }`)
      }
    }
    if ('default' in exportsObj) lines.push('export default m.default')
    writeFileSync(mockFile, lines.join('\n') + '\n')
    const reg = readMockRegistry()
    reg[target] = mockFile
    writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 1))
  },
  // no function spies are used by this repo's tests
  restore(): void {},
  reset(): void {},
}

process.on('exit', () => {
  try {
    if (existsSync(REGISTRY_FILE)) writeFileSync(REGISTRY_FILE, '{}')
  } catch {
    // best effort
  }
})

// ---------------------------------------------------------------------------
// Runner — executes after the module finishes registering (collection phase)
// ---------------------------------------------------------------------------
async function runHooks(hooks: Hook[]): Promise<void> {
  for (const h of hooks) await h()
}

async function runNode(chain: string[], node: DescribeNode, inheritedBeforeEach: Hook[] = [], inheritedAfterEach: Hook[] = []): Promise<void> {
  const here = chain.length ? [...chain, node.name] : [...chain]
  // ancestor beforeEach/afterEach apply to every descendant test (bun/jest semantics)
  const hereBeforeEach = [...inheritedBeforeEach, ...node.beforeEach]
  const hereAfterEach = [...inheritedAfterEach, ...node.afterEach]
  await runHooks(node.beforeAll)
  for (const item of node.items) {
    if (item.kind === 'describe') {
      await runNode(here, item.node, hereBeforeEach, hereAfterEach)
    } else {
      const label = [...here, item.name].join(' > ')
      try {
        await runHooks(hereBeforeEach)
        const limit = item.timeoutMs ?? 60_000
        await Promise.race([
          item.fn(),
          new Promise<never>((_r, rej) => {
            const t = setTimeout(() => rej(new Error(`test timed out after ${limit}ms`)), limit)
            ;(t as { unref?: () => void }).unref?.()
          }),
        ])
        passed++
        console.log(`  ✓ ${label}`)
      } catch (err) {
        failed++
        failures.push({ name: label, err })
        console.log(`  ✗ ${label}\n    ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        await runHooks(hereAfterEach)
      }
    }
  }
  await runHooks(node.afterAll)
}

/**
 * Run the collected suite. Exported (not auto-invoked) so the runner can await
 * the FULL module graph first — including files with top-level await — and
 * only then walk the registration tree.
 */
export async function __runTests(): Promise<void> {
  await runNode([], root)
  console.log(`\n[bun:test-shim] ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('FAILURES:')
    for (const f of failures) {
      console.log(`  ✗ ${f.name}`)
      const e = f.err as Error
      if (e?.stack) console.log(e.stack.split('\n').slice(0, 6).join('\n'))
    }
    process.exitCode = 1
  }
}
