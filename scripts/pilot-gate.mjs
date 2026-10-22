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
 * Exit: 0 only for GO_CANDIDATE; 1 for NO-GO. `--report` is still written
 * before exit so failed releases retain their full diagnostic report.
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, writeFileSync, readFileSync, readdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join, resolve, dirname, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { hasShaBoundCiArtifact, reportsMatchHashes, selectSuccessfulHostedCiRun, validateCapacityEvidence, validateIndependentSecurityAudit, validateP0P8Evidence } from './lib/pilot-gate-evidence.mjs'
import { execSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The release gate runs write-capable financial tests. Never inherit an
// operator's DATABASE_URL: create a private, marked copy of the checked-in
// synthetic fixture and fail closed if that copy cannot be prepared.
const tmp = mkdtempSync(join(tmpdir(), 'wakil-test-'))
const pilotDbPath = join(tmp, 'custom.db')
const pilotMarkerPath = join(tmp, '.wakil-disposable-test-db')
const pilotSeedPath = join(root, 'db', 'custom.db')
const pilotDbUrl = `file:${pilotDbPath}`
const PILOT_DB_INITIALIZING = 'WAKIL-DISPOSABLE-SQLITE-INITIALIZING-V1'
const PILOT_DB_READY = 'WAKIL-DISPOSABLE-SQLITE-READY-V1'
let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort OS-temp cleanup */ }
}
process.on('exit', cleanup)

if (!existsSync(pilotSeedPath)) {
  throw new Error('pilot:gate refuses to run: the checked-in synthetic SQLite fixture is missing')
}
for (const suffix of ['-wal', '-shm', '-journal']) {
  const sidecar = pilotSeedPath + suffix
  if (existsSync(sidecar) && statSync(sidecar).size > 0) {
    throw new Error(`pilot:gate refuses to copy a seed with a non-empty ${suffix} sidecar; stop fixture writers and retry`)
  }
}
writeFileSync(pilotMarkerPath, PILOT_DB_INITIALIZING + '\n', { flag: 'wx' })
copyFileSync(pilotSeedPath, pilotDbPath)
const pilotEnv = {
  ...process.env,
  DATABASE_URL: pilotDbUrl,
  WAKIL_OFFLINE: '1',
  WAKIL_SCHEDULER: 'off',
}
const migration = spawnSync('bun', [join(root, 'scripts/migrate.ts')], {
  cwd: root,
  env: pilotEnv,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})
if (migration.error || migration.status !== 0) {
  const detail = [migration.error?.message, migration.stdout, migration.stderr].filter(Boolean).join('\n').slice(-3000)
  throw new Error(`pilot:gate refuses to run without a migrated disposable DB: ${detail || `migration exit ${migration.status}`}`)
}
writeFileSync(pilotMarkerPath, PILOT_DB_READY + '\n', { flag: 'w' })

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
      { cwd: root, env: { ...pilotEnv, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] },
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

async function hostedCiEvidenceForSha(sha) {
  if (!/^[a-f0-9]{40}$/i.test(sha) || sha === 'unknown') {
    return { met: false, evidence: ['Current Git SHA is unavailable; hosted CI cannot be bound to this run.'] }
  }
  try {
    const response = await fetch(`https://api.github.com/repos/shaker15s/small-wakeel/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'wakil-pilot-gate',
      },
    })
    if (!response.ok) throw new Error(`GitHub Actions API returned HTTP ${response.status}`)
    const payload = await response.json()
    const run = selectSuccessfulHostedCiRun(payload.workflow_runs, sha)
    if (!run) {
      return { met: false, evidence: [`No completed successful push run of .github/workflows/ci.yml found for exact SHA ${sha}.`] }
    }
    const artifactsResponse = await fetch(`https://api.github.com/repos/shaker15s/small-wakeel/actions/runs/${run.id}/artifacts?per_page=100`, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'wakil-pilot-gate',
      },
    })
    if (!artifactsResponse.ok) throw new Error(`GitHub artifact API returned HTTP ${artifactsResponse.status}`)
    const artifacts = await artifactsResponse.json()
    if (!hasShaBoundCiArtifact(artifacts.artifacts, sha)) {
      return { met: false, evidence: [`CI run succeeded (${run.html_url}) but its non-expired launch-gate-${sha} log artifact is absent.`] }
    }
    return {
      met: true,
      evidence: [
        `successful exact-SHA hosted CI: ${run.html_url}`,
        `non-expired SHA-bound artifact: launch-gate-${sha}`,
      ],
    }
  } catch (error) {
    return { met: false, evidence: [`Hosted CI evidence could not be verified independently: ${error instanceof Error ? error.message : String(error)}`] }
  }
}

function readEvidenceJson(relativePath, validator, sha) {
  const fullPath = join(root, relativePath)
  if (!existsSync(fullPath)) return { met: false, evidence: [`MISSING: ${relativePath}`] }
  try {
    const evidence = JSON.parse(readFileSync(fullPath, 'utf8'))
    const claimsValid = validator(evidence, sha)
    const reportBytesMatch = claimsValid && reportsMatchHashes(evidence, root)
    const met = claimsValid && reportBytesMatch
    return {
      met,
      evidence: met
        ? [`validated ${relativePath} for exact SHA ${sha}; local report bytes match every declared SHA-256`]
        : [
            !claimsValid
              ? `${relativePath} exists but its claims are incomplete, malformed or not bound to exact SHA ${sha}`
              : `${relativePath} claims are shaped correctly, but a report copy is missing, empty, outside docs/evidence/artifacts, or its actual SHA-256 does not match`,
          ],
    }
  } catch (error) {
    return { met: false, evidence: [`${relativePath} could not be parsed: ${error instanceof Error ? error.message : String(error)}`] }
  }
}

// --- the 8 gate items (plan §13) -------------------------------------------
const items = []

// 1. P0–P8 requires an exact-SHA evidence manifest, not merely two docs files.
{
  const ev = readEvidenceJson(
    'docs/evidence/p0-p8-acceptance.json',
    validateP0P8Evidence,
    sha,
  )
  items.push({
    id: '1_p0_p8_evidence',
    requirement: 'P0–P8 have exact-SHA manifests and a linked, hashed report for every gate',
    status: ev.met ? 'met' : 'not_evidenced',
    evidence: ev.evidence,
  })
}

// 2. the 10 sectors pass their acceptance tests
{
  const results = await runBattery(['tests/unit/sector-contracts.test.ts', 'tests/integration/core-sale-across-sectors.test.ts'])
  const allOk = results.every((r) => r.ok)
  items.push({
    id: '2_sectors_acceptance',
    requirement: 'القطاعات العشرة اجتازت عقد التعريف وسيناريو بيع مالي حقيقي بالاعتماد والتحقق',
    status: allOk ? 'met' : 'not_met',
    evidence: results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.file}${r.ok ? '' : ' — ' + r.tail}`),
  })
}

// 3. model:acceptance + required Live tests — LIVE, from a real environment
{
  const reportPath = join(tmp, 'model-acceptance.json')
  // Model acceptance is explicitly configured; its network probe is separate
  // from app tests and never receives a database handle.
  const child = spawn(process.execPath, ['scripts/model-acceptance.mjs', '--report', reportPath], { cwd: root, env: { ...pilotEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
  const modelExitCode = await new Promise((resolveExit) => child.on('close', resolveExit))
  let live = false
  let env = 'unreachable'
  let allPass = false
  let checkedModels = 0
  try {
    const rep = JSON.parse(readFileSync(reportPath, 'utf8'))
    live = rep.liveAcceptance === true
    env = rep.environment ?? 'unknown'
    const requiredIds = ['A1', 'A2', 'A3', 'A4']
    const results = Array.isArray(rep.results) ? rep.results : []
    checkedModels = results.length
    allPass = modelExitCode === 0 && checkedModels > 0 && results.every((model) => {
      const checks = Array.isArray(model.checks) ? model.checks : []
      const byId = new Map(checks.map((check) => [check.id, check]))
      return requiredIds.every((id) => byId.get(id)?.pass === true) &&
        checks.every((check) => check.pass === true || check.id === 'A5')
    })
  } catch { /* no report */ }
  items.push({
    id: '3_model_acceptance_live',
    requirement: 'model:acceptance واختبارات Live ناجحة من بيئة تشغيل حقيقية؛ لا fallback محسوب نجاحًا',
    status: live && allPass ? 'met' : 'not_met',
    evidence: [
      `model-acceptance environment: ${env}`,
      `liveAcceptance: ${live}`,
      `checked models: ${checkedModels}`,
      `model-acceptance exit code: ${modelExitCode}`,
      live && allPass ? 'A1–A4 passed for every checked model on a live endpoint' : 'A live endpoint with WAKIL_ACCEPTANCE_BASE_URL/API_KEY and passing A1–A4 is required',
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

// 6. Hosted CI is met only after GitHub confirms a successful run on this SHA
// and the run retains its uniquely SHA-bound artifact.
{
  const ev = await hostedCiEvidenceForSha(sha)
  items.push({
    id: '6_ci_hosted',
    requirement: 'Successful hosted CI on this exact SHA with an unexpired, SHA-bound test artifact',
    status: ev.met ? 'met' : 'not_met',
    evidence: ev.evidence,
  })
}

// 7. An independent audit must have a report, auditor identity, scope and exact-SHA binding.
{
  const docs = fileEvidence('docs/SECURITY.md', 'docs/OPERATIONS.md', 'docs/RUNTIMES.md')
  const ev = readEvidenceJson(
    'docs/evidence/independent-security-audit.json',
    validateIndependentSecurityAudit,
    sha,
  )
  const privacy = existsSync(join(root, 'docs/PRIVACY.md')) || existsSync(join(root, 'PRIVACY.md'))
  const terms = existsSync(join(root, 'docs/TERMS.md')) || existsSync(join(root, 'TERMS.md'))
  const missing = [
    ...docs.missing.map((file) => `MISSING: ${file}`),
    ...(!privacy ? ['MISSING: privacy policy (PRIVACY.md)'] : []),
    ...(!terms ? ['MISSING: terms of service (TERMS.md)'] : []),
    ...ev.evidence,
  ]
  items.push({
    id: '7_security_audit_docs',
    requirement: 'Independent security audit + privacy/terms/support/operations/monitoring evidence',
    status: ev.met && docs.missing.length === 0 && privacy && terms ? 'met' : 'not_met',
    evidence: [
      ...docs.found.map((file) => `present: ${file}`),
      ...missing,
    ],
  })
}

// 8. Capacity is met only with commit-bound measurements from a production-like run.
{
  const registry = existsSync(join(root, 'src/lib/agent/model-registry.ts'))
  const ratelimit = existsSync(join(root, 'src/lib/security/rateLimit.ts'))
  const rollbackDocs = execSync('git grep -l -i "rollback" -- docs/ | head -5', { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  const ev = readEvidenceJson(
    'docs/evidence/capacity-acceptance.json',
    validateCapacityEvidence,
    sha,
  )
  items.push({
    id: '8_cost_capacity_rollback',
    requirement: 'Model pricing, usage limits, rollback docs and SHA-bound capacity measurements',
    status: registry && ratelimit && rollbackDocs.length > 0 && ev.met ? 'met' : 'not_met',
    evidence: [
      `model-registry pricing data: ${registry ? 'present' : 'MISSING'}`,
      `usage limits (rateLimit): ${ratelimit ? 'present' : 'MISSING'}`,
      `rollback documented in: ${rollbackDocs.length > 0 ? rollbackDocs.join(', ') : 'MISSING'}`,
      ...ev.evidence,
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
cleanup()
// Never return a successful process status for a NO-GO release gate.
process.exitCode = overall === 'GO_CANDIDATE' ? 0 : 1
