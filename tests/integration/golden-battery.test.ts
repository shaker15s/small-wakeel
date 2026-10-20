// R44 — Golden battery as a permanent gate.
//
// Spawns `tests/evals/run.ts --json` (its own scratch DB, WAKIL_OFFLINE=1,
// every vertical's first business) and asserts EVERY scenario passes.
// The battery is the «جبار مش مجرد شغال» contract: 100+ real owner phrases
// across supermarket / pharmacy / gym / attar / restaurant — money ops,
// reads, advice, reminders, math, and the safe-refusal behaviors
// (overpay protection, unknown item, unknown party).
//
// Run alone:  bun test tests/integration/golden-battery.test.ts   (~3 min)
import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// import.meta.dir is bun-only; the dirname(fileURLToPath(...)) form works in both.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
// The battery runner is TS + '@/'-aliased: bun runs it natively; plain node
// needs the sandbox loader (tests/node/register.mjs) — see the shim there.
const BATTERY_CMD =
  process.versions.bun !== undefined
    ? [process.execPath, 'tests/evals/run.ts', '--json']
    : [process.execPath, '--import', join(ROOT, 'tests/node/register.mjs'), 'tests/evals/run.ts', '--json']

function runBattery(timeoutMs: number): Promise<{ passed: number; total: number; results: { text: string; expect: string; ok: boolean; note: string }[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(BATTERY_CMD[0], BATTERY_CMD.slice(1), {
      cwd: ROOT,
      env: { ...process.env, WAKIL_OFFLINE: '1', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (err += String(d)))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`battery timed out after ${timeoutMs}ms\nstderr: ${err.slice(-2000)}`))
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // The runner prints the result JSON (pure stdout in --json mode); any
      // stray preamble before the first '{' is skipped.
      const i = out.indexOf('{')
      if (i < 0) {
        reject(new Error(`no JSON in battery output (exit ${code})\nstdout: ${out.slice(-2000)}\nstderr: ${err.slice(-2000)}`))
        return
      }
      try {
        resolve(JSON.parse(out.slice(i)))
      } catch (parseErr) {
        reject(new Error(`battery JSON unparseable (exit ${code}): ${String(parseErr)}\nstdout tail: ${out.slice(-1500)}`))
      }
    })
  })
}

test('golden battery: every scenario passes', async () => {
  const d = await runBattery(1500_000)
  const failures = d.results.filter((r) => !r.ok)
  expect(d.total).toBeGreaterThanOrEqual(100)
  if (failures.length > 0) {
    const lines = failures.map((f) => `  ✖ ${f.text}\n      المتوقع: ${f.expect}\n      الناتج:   ${f.note}`)
    throw new Error(`${d.passed}/${d.total} passed — ${failures.length} failing:\n${lines.join('\n')}`)
  }
}, 480_000)
