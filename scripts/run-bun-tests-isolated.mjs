#!/usr/bin/env bun
/**
 * Run each Bun test file in its own process.
 *
 * The application test suite mutates process-wide environment variables for
 * local provider stubs and uses one Prisma singleton per process. Running every
 * file in a single Bun process creates cross-file environment races; the same
 * long-lived runner also hit a Bun 1.3.11 native crash after ~142s in CI.
 * Process-per-file keeps Bun's real test runtime while isolating environment,
 * module state, the database fixture, and native runtime lifetime.
 */
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, out)
    else if (/\.test\.(?:ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

const args = process.argv.slice(2)
const filter = args.find((arg) => !arg.startsWith('--exclude=')) ?? ''
const excluded = args
  .filter((arg) => arg.startsWith('--exclude='))
  .map((arg) => arg.slice('--exclude='.length))
  .filter(Boolean)
const files = (await walk(path.join(root, 'tests'))).sort()
  .filter((file) => (!filter || file.includes(filter)) && !excluded.some((part) => file.includes(part)))

console.log(`[isolated-bun-suite] ${files.length} test files${filter ? ` (filter: ${filter})` : ''}${excluded.length ? `; excluded: ${excluded.join(', ')}` : ''}`)
let passed = 0
const failures = []

for (let index = 0; index < files.length; index++) {
  const relative = path.relative(root, files[index])
  console.log(`\n[isolated-bun-suite] (${index + 1}/${files.length}) ${relative}`)
  const code = await new Promise((resolveCode) => {
    const child = spawn(process.execPath, ['test', relative], {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: 'inherit',
    })
    child.once('error', (error) => {
      console.error(`[isolated-bun-suite] failed to start Bun for ${relative}: ${error.message}`)
      resolveCode(127)
    })
    child.once('close', (exitCode, signal) => resolveCode(exitCode ?? (signal ? 128 : 1)))
  })

  if (code === 0) {
    passed++
    console.log(`[isolated-bun-suite] PASS ${relative}`)
  } else {
    failures.push({ file: relative, code })
    console.error(`[isolated-bun-suite] FAIL ${relative} (exit ${code})`)
  }
}

console.log(`\n[isolated-bun-suite] summary: ${passed} passed; ${failures.length} failed`)
if (failures.length) {
  for (const failure of failures) console.error(` - ${failure.file}: exit ${failure.code}`)
  process.exitCode = 1
}
