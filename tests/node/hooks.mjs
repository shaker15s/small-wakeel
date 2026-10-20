/**
 * وكيل — Node ESM resolve hooks for the sandbox fallback test pipeline.
 * Maps:  'bun:test' → the local shim,  '@/x' → src/x (ts/tsx/js/index).
 * Also recovers extensionless relative imports (bundler-style) and subpath
 * imports of packages without an exports map (e.g. 'next/server') — bun
 * resolves those leniently; node is strict, so we close the gap here.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import esbuild from '../../node_modules/esbuild/lib/main.js'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SHIM = pathToFileURL(path.join(root, 'tests/node/bun-test-shim.ts')).href

function tryFile(base) {
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, path.join(base, 'index.ts'), path.join(base, 'index.tsx'), path.join(base, 'index.js')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand
  }
  return null
}

// mock.module() registry (written by the shim on the main thread; consulted
// here because resolve hooks run on a separate thread — the file is the bridge)
function readMockRegistry() {
  try {
    return JSON.parse(readFileSync(path.join(root, 'tests/node/.mocks', `registry-${process.pid}.json`), 'utf8'))
  } catch {
    return {}
  }
}

function pkgRoot(specifier) {
  const seg = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
  return `pkg:${seg}`
}

function mockTargetFor(specifier, context) {
  let target = null
  if (specifier.startsWith('@/')) {
    const base = path.join(root, 'src', specifier.slice(2))
    target = tryFile(base) ?? base
  } else if (specifier.startsWith('./') || specifier.startsWith('../')) {
    if (context.parentURL) {
      const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier)
      target = tryFile(base) ?? base
    }
  } else {
    target = pkgRoot(specifier)
  }
  if (!target) return null
  const reg = readMockRegistry()
  return reg[target] ?? null
}

function bareSpecBase(specifier) {
  // 'next/server' → node_modules/next/server ; '@scope/pkg/x' → node_modules/@scope/pkg/x
  const first = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
  if (!first) return null
  return path.join(root, 'node_modules', specifier)
}

/** .tsx (JSX) needs a real transform — node strips types but not JSX. */
export async function load(url, context, next) {
  if (url.endsWith('.tsx') && !url.includes('node_modules')) {
    const source = readFileSync(fileURLToPath(url), 'utf8')
    const { code } = esbuild.transformSync(source, { loader: 'tsx', jsx: 'automatic', format: 'esm', target: 'es2022' })
    return { format: 'module', source: code, shortCircuit: true }
  }
  return next(url, context)
}

export async function resolve(specifier, context, next) {
  if (specifier === 'bun:test') return { url: SHIM, shortCircuit: true }
  const mocked = mockTargetFor(specifier, context)
  if (mocked) return { url: pathToFileURL(mocked).href, shortCircuit: true }
  if (specifier.startsWith('@/')) {
    const hit = tryFile(path.join(root, 'src', specifier.slice(2)))
    if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true }
    throw new Error(`[hooks] cannot resolve alias ${specifier}`)
  }
  try {
    return await next(specifier, context)
  } catch (err) {
    const code = err?.code ?? String(err)
    const notFound = /ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED/.test(code)
    if (!notFound) throw err
    // relative (bundler-style, extensionless)
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      if (context.parentURL) {
        const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier)
        const hit = tryFile(base)
        if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true }
      }
    }
    // bare package subpath without exports map (next/server, …)
    const base = bareSpecBase(specifier)
    if (base) {
      const hit = tryFile(base)
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true }
    }
    throw err
  }
}
