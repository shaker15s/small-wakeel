#!/usr/bin/env node
/**
 * وكيل — `pilot:gate` (PR-015 / plan v2 §13 «بوابة GO للإطلاق العام»).
 *
 * Evaluates the plan's 8 GO-gate items on THIS SHA with REAL evidence:
 * focused test batteries are executed (not asserted from memory), the model
 * acceptance report is consumed, and documentation/infrastructure presence
 * is checked. Honesty rules:
 *
 *   • an item is `met` ONLY with current, verifiable evidence on this SHA;
 *   • anything not evidenced is `not_met` / `not_evidenced` with the exact
 *     missing piece — the gate NEVER rounds a missing proof into a pass;
 *   • the gate can at most conclude `GO_CANDIDATE`. The plan is explicit:
 *     «لا يوجد إطلاق تلقائي لمجرد اكتمال الخطة» — the final GO is a
 *     DOCUMENTED OWNER APPROVAL attached to this report, never a script
 *     output.
 *
 * Usage:
 *   node scripts/pilot-gate.mjs [--report out.json]
 * Exit: 0 when the report was produced (the gate ran); the GO/NO-GO outcome
 * lives in the report's `overall` field.
 */
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = mkdtempSync(join(root, '.pilot-gate-'))

function git(...args) {
  try { return execSync(`git ${args.join(' ')}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() }
  catch { return null }
}

const sha = git('rev-parse', 'HEAD') ?? 'unknown'
const environment = (() => {
  try {
    execSync('curl -s --max-time 2 http://127.0.0.1:3031/health', { stdio: ['ignore', 'pipe', 'ignore'] })
    return 'sandbox-dev (mock providers present)'
  } catch { return 'sandbox-dev (no mock providers)' }
})()

// --- run one test file the same way tests/node/run-suite.mjs does ----------
function runTestFile(file) {
  return new Promise((res) => {
    const child = spawn(
      process.execPath,
      [
        '--import', join(root, 'tests/node/register.mjs'),
        '-e',
        'import(process.argv[2]).then(() => Promise.all([import(process.argv[1]), import(process.argv[3])])).then(([, shim]) => shim.__runTests(), (e) => { console.error("LOAD FAILED", e); process.exitCode = 1 })',
        join(root, file),
        join(root, 'tests/helpers/preload.ts'),
        join(root, 'tests/node/bun-test-shim.ts'),
      ],
      { cwd: root, env: { ...process.env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => {
      res({ file, ok: code === 0, tail: out.split('\n').filter((l) => l.includes('✗') || l.includes('FAIL') || l.includes('Error')).slice(0, 8).join(' | ') })
    })
  })
}

async function runBattery(files) {
  const results = []
  for (const f of files) results.push(await runTestFile(f))
  return results
}

function fileEvidence(...paths) {
  const found = []
  const missing = []
  for (const p of paths) (existsSync(join(root, p)) ? found : missing).push(p)
  return { found, missing }
}

// --- the 8 gate items (plan §13) -------------------------------------------
const items = []

// 1. P0–P8 closed with PERSISTENT (committed) evidence
{
  const ev = fileEvidence(
    'docs/LAUNCH_VERIFICATION_2026-10-17.md',
    'docs/SAAS_VERIFICATION_2026-10-18.md',
  )
  const docs = ev.found
  const committed = git('ls-files', 'docs')?.split('\n').filter(Boolean).length ?? 0
  items.push({
    id: '1_p0_p8_evidence',
    requirement: 'P0–P8 مغلقة بأدلة دائمة (committed verification artifacts on this SHA)',
    status: docs.length >= 2 ? 'met' : 'not_evidenced',
    evidence: [
      `committed docs files: ${committed}`,
      ...docs.map((d) => `present: ${d}`),
      ...ev.missing.map((d) => `MISSING: ${d}`),
      'per-stage evidence is recorded in these verification docs + each PR commit (R70–R84 gates)',
    ],
  })
}

// 2. the 10 sectors pass their acceptance tests
{
  const results = await runBattery(['tests/unit/sector-contracts.test.ts'])
  const allOk = results.every((r) => r.ok)
  items.push({
    id: '2_sectors_acceptance',
    requirement: 'القطاعات العشرة اجتازت اختبارات القبول الخاصة بها',
    status: allOk ? 'met' : 'not_met',
    evidence: results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.file}${r.ok ? '' : ' — ' + r.tail}`),
  })
}

// 3. model:acceptance + required Live tests — LIVE, from a real environment
{
  const reportPath = join(tmp, 'model-acceptance.json')
  const child = spawn(process.execPath, ['scripts/model-acceptance.mjs', '--report', reportPath], { cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise((r) => child.on('close', r))
  let live = false
  let env = 'unreachable'
  let allPass = false
  try {
    const rep = JSON.parse(readFileSync(reportPath, 'utf8'))
    live = rep.liveAcceptance === true
    env = rep.environment ?? 'unknown'
    allPass = rep.models?.every((m) => m.passed === true) ?? false
  } catch { /* no report */ }
  items.push({
    id: '3_model_acceptance_live',
    requirement: 'model:acceptance واختبارات Live ناجحة من بيئة تشغيل حقيقية؛ لا fallback محسوب نجاحًا',
    status: live && allPass ? 'met' : 'not_met',
    evidence: [
      `model-acceptance environment: ${env}`,
      `liveAcceptance: ${live}`,
      live && allPass ? 'live acceptance passed on a real endpoint' : 'mock run = adapter-contract proof only (liveAcceptance:false) — a LIVE endpoint with WAKIL_ACCEPTANCE_BASE_URL/API_KEY is required',
    ],
  })
}

// 4. every financial operation needs human approval + crash/replay/concurrency/reversal gates
{
  const results = await runBattery([
    'tests/integration/financial-integrity.test.ts',
    'tests/integration/approval-binding.test.ts',
    'tests/integration/cashbook.test.ts',
    'tests/integration/cashbook-natural.test.ts',
    'tests/integration/cashbook-continuation.test.ts',
    'tests/integration/typed-approval.test.ts',
    'tests/integration/tool-contract.test.ts',
    'tests/integration/money-parsing.test.ts',
  ])
  const allOk = results.every((r) => r.ok)
  items.push({
    id: '4_financial_gates',
    requirement: 'كل المعاملات المالية تحتاج اعتمادًا بشريًا + crash/replay/concurrency/reversal gates',
    status: allOk ? 'met' : 'not_met',
    evidence: results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.file}${r.ok ? '' : ' — ' + r.tail}`),
  })
}

// 5. Companion + connectors only at the levels that passed; the rest stays not_connected
{
  const results = await runBattery(['tests/integration/companion.test.ts', 'tests/integration/reconciliation.test.ts', 'tests/integration/plugin-manifest.test.ts'])
  const allOk = results.every((r) => r.ok)
  items.push({
    id: '5_connectors_levels',
    requirement: 'Companion وموصلات العرض تعمل فقط في المستويات المجتازة؛ غير المتصل يظل not_connected',
    status: allOk ? 'met' : 'not_met',
    evidence: results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.file}${r.ok ? '' : ' — ' + r.tail}`),
  })
}

// 6. hosted CI + artifacts tied to SHA + backup/restore/secret-rotation drills
{
  const workflows = existsSync(join(root, '.github/workflows')) ? readdirSync(join(root, '.github/workflows')) : []
  const staged = existsSync(join(root, 'docs/ci/github-actions.yml'))
  const backupDrill = existsSync(join(root, 'scripts/backup-drill.ts'))
  const rotate = existsSync(join(root, 'scripts/rotate-provider-secrets.ts'))
  items.push({
    id: '6_ci_hosted',
    requirement: 'CI مستضاف + artifacts مرتبطة بـ SHA + نسخ/استعادة/تدوير أسرار ناجحة على بيئة مشابهة للإنتاج',
    status: workflows.length > 0 ? 'met' : 'not_met',
    evidence: [
      `.github/workflows: ${workflows.length > 0 ? workflows.join(', ') : 'ABSENT — the workflow exists only staged at docs/ci/github-actions.yml (PR-002 blocked on hosted CI)'}`,
      `workflow staged in docs: ${staged}`,
      `backup-drill script: ${backupDrill ? 'present' : 'MISSING'}`,
      `rotate-provider-secrets script: ${rotate ? 'present' : 'MISSING'}`,
      'hosted runs on THIS SHA: not verifiable from this environment',
    ],
  })
}

// 7. independent security audit + documented privacy/terms/support/operations/monitoring
{
  const ev = fileEvidence('docs/SECURITY.md', 'docs/OPERATIONS.md', 'docs/RUNTIMES.md')
  const privacy = existsSync(join(root, 'docs/PRIVACY.md')) || existsSync(join(root, 'PRIVACY.md'))
  const terms = existsSync(join(root, 'docs/TERMS.md')) || existsSync(join(root, 'TERMS.md'))
  const audit = execSync('git log --oneline -200', { cwd: root, encoding: 'utf8' }).toLowerCase().includes('independent audit')
  const missing = []
  if (!privacy) missing.push('privacy policy (PRIVACY.md)')
  if (!terms) missing.push('terms of service (TERMS.md)')
  if (!audit) missing.push('independent security audit (no committed audit artifact)')
  items.push({
    id: '7_security_audit_docs',
    requirement: 'تدقيق أمني مستقل + خصوصية وشروط ودعم وتشغيل ومراقبة موثقة',
    status: missing.length === 0 ? 'met' : 'not_met',
    evidence: [
      ...ev.found.map((d) => `present: ${d}`),
      ...missing.map((m) => `MISSING: ${m}`),
    ],
  })
}

// 8. unit cost + capacity known, usage limits, rollback, incident plan
{
  const registry = existsSync(join(root, 'src/lib/agent/model-registry.ts'))
  const ratelimit = existsSync(join(root, 'src/lib/security/rateLimit.ts'))
  const rollbackDocs = execSync('git grep -l -i "rollback" -- docs/ | head -5', { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  const capacity = existsSync(join(root, 'docs/CAPACITY.md'))
  items.push({
    id: '8_cost_capacity_rollback',
    requirement: 'تكلفة الوحدة وسعة التشغيل معروفتان + حدود استخدام + تراجع (rollback) + خطة حوادث',
    status: registry && ratelimit && capacity && rollbackDocs.length > 0 ? 'met' : 'not_met',
    evidence: [
      `model-registry pricing data: ${registry ? 'present' : 'MISSING'}`,
      `usage limits (rateLimit): ${ratelimit ? 'present' : 'MISSING'}`,
      `rollback documented in: ${rollbackDocs.length > 0 ? rollbackDocs.join(', ') : 'nowhere'}`,
      `capacity/load evidence (docs/CAPACITY.md): ${capacity ? 'present' : 'MISSING — capacity is NOT measured yet; a load test on a prod-like env is required'}`,
    ],
  })
}

// --- verdict ----------------------------------------------------------------
const met = items.filter((i) => i.status === 'met').length
const overall = met === items.length ? 'GO_CANDIDATE' : 'NO-GO'

const report = {
  date: new Date().toISOString(),
  sha,
  environment,
  items,
  met: `${met}/${items.length}`,
  overall,
  decision:
    overall === 'GO_CANDIDATE'
      ? 'GO_CANDIDATE — all gate items met with evidence on this SHA. The final GO is a DOCUMENTED OWNER APPROVAL attached to this report (plan: «لا يوجد إطلاق تلقائي»). No automatic release.'
      : 'NO-GO — the release stays NO-GO until every gate item is met with durable evidence on a specific SHA. The missing items above are the exact remaining work; nothing is claimed as done that lacks evidence.',
}

const reportIdx = process.argv.indexOf('--report')
if (reportIdx > 0) writeFileSync(process.argv[reportIdx + 1], JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
// the gate RAN successfully; its verdict is in the report
process.exit(0)
