/**
 * وكيل — sandbox-fallback suite runner (plain Node, no bun).
 * Usage: node tests/node/run-suite.mjs [filter-substring]
 * Runs every test file under tests/ in its own process (same isolation as `bun test`
 * file mode) and aggregates results. Exit 0 iff every file passed.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const filter = process.argv[2] ?? ''

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) await walk(p, out)
    else if (e.name.endsWith('.test.ts') || e.name.endsWith('.test.tsx')) out.push(p)
  }
  return out
}

const files = (await walk(path.join(root, 'tests'))).sort().filter((f) => !filter || f.includes(filter))
console.log(`[node-suite] ${files.length} test files${filter ? ` (filter: ${filter})` : ''}`)

let okFiles = 0
let failFiles = 0
const failures = []

for (const f of files) {
  const rel = path.relative(root, f)
  // Await the FULL entry-module graph (top-level await included) before
  // walking the registration tree — the shim exposes __runTests for this.
  const child = spawn(
    process.execPath,
    [
      '--import', path.join(root, 'tests/node/register.mjs'),
      '-e',
      'import(process.argv[2]).then(() => Promise.all([import(process.argv[1]), import(process.argv[3])])).then(([, shim]) => shim.__runTests(), (e) => { console.error("LOAD FAILED", e); process.exitCode = 1 })',
      f,
      path.join(root, 'tests/helpers/preload.ts'),
      path.join(root, 'tests/node/bun-test-shim.ts'),
    ],
    {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  const code = await new Promise((res) => child.on('close', res))
  if (code === 0) {
    okFiles++
    console.log(`  ✓ file ${rel}`)
  } else {
    failFiles++
    failures.push({ rel, out })
    console.log(`  ✗ file ${rel} (exit ${code})`)
  }
}

console.log(`\n[node-suite] files: ${okFiles} ok, ${failFiles} failed`)
if (failFiles > 0) {
  for (const f of failures) {
    console.log(`\n===== ${f.rel} =====`)
    console.log(f.out.split('\n').filter((l) => l.includes('✗') || l.includes('FAIL') || l.includes('Error') || l.includes('error') || l.includes('[bun:test-shim]')).slice(0, 40).join('\n'))
  }
  process.exit(1)
}
