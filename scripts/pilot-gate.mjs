#!/usr/bin/env node
/**
 * وكيل — `pilot:gate` (PR-015 / plan v2 §13 «بوابة GO للإطلاق العام»).
 *
 * Evaluates release gates on THIS SHA with REAL evidence:
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
 *   node scripts/pilot-gate.mjs [--report out.json] [--strict]
 * Exit: 0 when the report was produced by default; `--strict` exits nonzero
 * unless every launch gate has evidence. A NO-GO report is never a GO decision.
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

function readExternalEvidence(envName) {
  const evidencePath = process.env[envName]
  if (!evidencePath) return { path: null, value: null, error: `${envName} is not set` }
  try {
    return { path: evidencePath, value: JSON.parse(readFileSync(evidencePath, 'utf8')), error: null }
  } catch (error) {
    return { path: evidencePath, value: null, error: `cannot read valid JSON: ${String(error).slice(0, 180)}` }
  }
}

function validEvidenceHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

// --- the 8 gate items (plan §13) -------------------------------------------
const items = []

// 1. Historical reports are records, not proof that the present SHA passed every launch gate.
{
  const ev = fileEvidence(
    'docs/LAUNCH_VERIFICATION_2026-10-17.md',
    'docs/SAAS_VERIFICATION_2026-10-18.md',
  )
  const docs = ev.found
  const committed = git('ls-files', 'docs')?.split('\n').filter(Boolean).length ?? 0
  items.push({
    id: '1_historical_verification_records',
    requirement: 'تقارير التحقق التاريخية محفوظة؛ وجودها وحده لا يثبت إغلاق كل بوابة على SHA الحالي',
    status: docs.length >= 2 ? 'met' : 'not_evidenced',
    evidence: [
      `committed docs files: ${committed}`,
      ...docs.map((d) => `historical record present: ${d}`),
      ...ev.missing.map((d) => `MISSING: ${d}`),
      `current candidate SHA: ${sha}`,
      'Historical reports are records, not substitutes for current-run tests or external audit/load evidence.',
    ],
  })
}

// 2. The following sector test covers registry contracts only. Full workflows are a separate gate.
{
  const results = await runBattery(['tests/unit/sector-contracts.test.ts'])
  const allOk = results.every((r) => r.ok)
  items.push({
    id: '2_sectors_acceptance',
    requirement: 'تعريفات القطاعات وعقود الأدوات متسقة (لا يثبت هذا وحده عمل دورة مالية كاملة في كل قطاع)',
    status: allOk ? 'met' : 'not_met',
    evidence: [
      ...results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.file}${r.ok ? '' : ' — ' + r.tail}`),
      'Scope limitation: registry/schema consistency only; per-sector end-to-end workflow evidence is required below.',
    ],
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
    allPass = Array.isArray(rep.results) && rep.results.length > 0 && rep.results.every((m) => Array.isArray(m.checks) && m.checks.length > 0 && m.checks.every((c) => c.id === 'A5' || c.pass === true))
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

// 6. Hosted CI on the exact SHA, with a persistent artifact for the same run.
{
  const workflowPath = '.github/workflows/ci.yml'
  const workflowContent = existsSync(join(root, workflowPath)) ? readFileSync(join(root, workflowPath), 'utf8') : ''
  const workflowConfigured = workflowContent.includes('bash scripts/ci.sh')
    && workflowContent.includes('actions/upload-artifact')
    && workflowContent.includes('ci-results')
  const hostedRunMatches = process.env.GITHUB_ACTIONS === 'true'
    && process.env.GITHUB_WORKFLOW === 'WAKIL CI'
    && process.env.GITHUB_SHA === sha
    && Boolean(process.env.GITHUB_RUN_ID)
  items.push({
    id: '6_hosted_ci_exact_sha',
    requirement: 'CI مستضاف نفّذ الاختبارات على SHA مطابق وحفظ artifacts مرتبطة بنفس التشغيل',
    status: workflowConfigured && hostedRunMatches ? 'met' : 'not_met',
    evidence: [
      `workflow configured: ${workflowConfigured}`,
      `GITHUB_ACTIONS: ${process.env.GITHUB_ACTIONS ?? 'unset'}`,
      `GITHUB_WORKFLOW: ${process.env.GITHUB_WORKFLOW ?? 'unset'}`,
      `GITHUB_SHA matches checked-out HEAD: ${Boolean(process.env.GITHUB_SHA && process.env.GITHUB_SHA === sha)}`,
      `GITHUB_RUN_ID: ${process.env.GITHUB_RUN_ID ?? 'unset'}`,
      'After completion, verify the Actions run conclusion and retrieve its matching artifact; a running step alone is not final proof.',
    ],
  })
}

// 7. Production-like restore and secret rotation require external evidence, not just local scripts.
{
  const proof = readExternalEvidence('WAKIL_RECOVERY_EVIDENCE')
  const e = proof.value
  const valid = Boolean(e
    && e.targetSha === sha
    && e.environment === 'production-like'
    && e.result === 'pass'
    && e.backupRestore?.passed === true
    && e.secretRotation?.passed === true
    && validTimestamp(e.measuredAt)
    && validEvidenceHash(e.reportSha256))
  items.push({
    id: '7_production_like_recovery',
    requirement: 'إثبات مستقل لاستعادة نسخة كاملة وتدوير الأسرار على بيئة شبيهة بالإنتاج لنفس SHA',
    status: valid ? 'met' : 'not_met',
    evidence: valid
      ? [`recovery/rotation evidence bound to SHA ${sha}`, `evidence file: ${proof.path}`]
      : [proof.error ?? 'evidence does not match current SHA, environment, result, and required subchecks',
          'Synthetic local backup drills alone do not satisfy production-like recovery acceptance.'],
  })
}

// 8. Independent security audit plus legally reviewed privacy and terms.
{
  const ev = fileEvidence('docs/SECURITY.md', 'docs/OPERATIONS.md', 'docs/RUNTIMES.md')
  const privacy = existsSync(join(root, 'docs/PRIVACY.md')) || existsSync(join(root, 'PRIVACY.md'))
  const terms = existsSync(join(root, 'docs/TERMS.md')) || existsSync(join(root, 'TERMS.md'))
  const proof = readExternalEvidence('WAKIL_SECURITY_AUDIT_EVIDENCE')
  const e = proof.value
  const audit = Boolean(e
    && e.targetSha === sha
    && e.independent === true
    && e.result === 'pass'
    && typeof e.auditor === 'string' && e.auditor.trim().length >= 3
    && validTimestamp(e.completedAt)
    && validEvidenceHash(e.reportSha256))
  const missing = []
  if (!privacy) missing.push('privacy policy (PRIVACY.md)')
  if (!terms) missing.push('terms of service (TERMS.md)')
  if (!audit) missing.push(`independent audit evidence missing/invalid: ${proof.error ?? 'not bound to current SHA or invalid schema'}`)
  items.push({
    id: '8_security_audit_and_policies',
    requirement: 'تدقيق أمني مستقل موثق + سياسة خصوصية وشروط خدمة منشورة',
    status: missing.length === 0 ? 'met' : 'not_met',
    evidence: [
      ...ev.found.map((d) => `present: ${d}`),
      ...missing.map((m) => `MISSING: ${m}`),
      ...(audit ? [`independent audit report hash: ${e.reportSha256}`] : []),
    ],
  })
}

// 9. Unit-cost data, usage controls, rollback guidance, and measured capacity.
{
  const registry = existsSync(join(root, 'src/lib/agent/model-registry.ts'))
  const ratelimit = existsSync(join(root, 'src/lib/security/rateLimit.ts'))
  const rollbackDocs = execSync('git grep -l -i "rollback" -- docs/ | head -5', { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  const proof = readExternalEvidence('WAKIL_CAPACITY_EVIDENCE')
  const e = proof.value
  const capacity = Boolean(e
    && e.targetSha === sha
    && e.environment === 'production-like'
    && e.result === 'pass'
    && Number.isFinite(e.totalRequests) && e.totalRequests >= 1000
    && Number.isFinite(e.concurrency) && e.concurrency >= 10
    && Number.isFinite(e.p95Ms) && e.p95Ms > 0
    && Number.isFinite(e.p99Ms) && e.p99Ms >= e.p95Ms
    && Number.isFinite(e.errorRatePct) && e.errorRatePct >= 0 && e.errorRatePct <= 1
    && validTimestamp(e.measuredAt)
    && validEvidenceHash(e.reportSha256))
  const ok = registry && ratelimit && rollbackDocs.length > 0 && capacity
  items.push({
    id: '9_capacity_and_operability',
    requirement: 'تكلفة الموديل وحدود الاستخدام وتراجع موثق وقياس ضغط على بيئة شبيهة بالإنتاج',
    status: ok ? 'met' : 'not_met',
    evidence: [
      `model registry with pricing: ${registry ? 'present' : 'MISSING'}`,
      `rate limits: ${ratelimit ? 'present' : 'MISSING'}`,
      `rollback documents: ${rollbackDocs.length > 0 ? rollbackDocs.join(', ') : 'MISSING'}`,
      capacity ? `load evidence accepted for SHA ${sha}; requests=${e.totalRequests}, concurrency=${e.concurrency}, p95=${e.p95Ms}ms, p99=${e.p99Ms}ms, errors=${e.errorRatePct}%`
        : `capacity evidence missing/invalid: ${proof.error ?? 'must match current SHA and measured production-like schema'}`,
    ],
  })
}

// 10. Advertised sector support needs end-to-end acceptance, not a registry contract alone.
{
  const testPath = 'tests/integration/sector-end-to-end.test.ts'
  const exists = existsSync(join(root, testPath))
  const result = exists ? await runBattery([testPath]) : []
  const passed = exists && result.length > 0 && result.every((r) => r.ok)
  items.push({
    id: '10_sector_end_to_end',
    requirement: 'مسار كتابة مالي معتمد واحد على الأقل لكل قطاع معلن اجتاز E2E (لا يعني ذلك اكتمال كل الخصائص المتخصصة)',
    status: passed ? 'met' : 'not_met',
    evidence: [
      ...(exists
        ? result.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.file}${r.ok ? '' : ' — ' + r.tail}`)
        : [`MISSING: ${testPath}; sector contracts are not an end-to-end test.`]),
      'Scope limitation: canonical sale path for stock sectors and one membership path for gym; sector-specific expiry, grams, attendance, and other specialized flows require separate acceptance cases.',
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
if (process.argv.includes('--strict') && overall !== 'GO_CANDIDATE') process.exitCode = 1
else process.exit(0)
