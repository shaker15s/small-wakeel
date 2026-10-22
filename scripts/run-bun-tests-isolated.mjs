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
const requestedTimeout = Number(process.env.WAKIL_TEST_FILE_TIMEOUT_MS ?? 150_000)
const FILE_TIMEOUT_MS = Number.isFinite(requestedTimeout)
  ? Math.min(Math.max(Math.trunc(requestedTimeout), 30_000), 600_000)
  : 150_000

let passed = 0
const failures = []

for (let index = 0; index < files.length; index++) {
  const relative = path.relative(root, files[index])
  console.log(`\n[isolated-bun-suite] (${index + 1}/${files.length}) ${relative} (timeout ${FILE_TIMEOUT_MS}ms)`)
  let timedOut = false
  const code = await new Promise((resolveCode) => {
    const child = spawn(process.execPath, ['test', relative], {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: 'inherit',
    })
    let settled = false
    let killTimer
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolveCode(value)
    }
    const timer = setTimeout(() => {
      timedOut = true
      console.error(`[isolated-bun-suite] TIMEOUT ${relative} after ${FILE_TIMEOUT_MS}ms; terminating its test process`)
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000)
      killTimer.unref?.()
    }, FILE_TIMEOUT_MS)

    child.once('error', (error) => {
      console.error(`[isolated-bun-suite] failed to start Bun for ${relative}: ${error.message}`)
      finish(127)
    })
    child.once('close', (exitCode, signal) => finish(exitCode ?? (signal ? 128 : 1)))
  })
  const finalCode = timedOut ? 124 : code

  if (finalCode === 0) {
    passed++
    console.log(`[isolated-bun-suite] PASS ${relative}`)
  } else {
    failures.push({ file: relative, code: finalCode, timedOut })
    console.error(`[isolated-bun-suite] FAIL ${relative} (exit ${finalCode}${timedOut ? ', timed out' : ''})`)
  }
}

console.log(`\n[isolated-bun-suite] summary: ${passed} passed; ${failures.length} failed`)
if (failures.length) {
  for (const failure of failures) console.error(` - ${failure.file}: exit ${failure.code}${failure.timedOut ? ' (timed out)' : ''}`)
  process.exitCode = 1
}
