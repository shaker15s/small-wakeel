import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const SHA_RE = /^[a-f0-9]{40}$/i
const P0_TO_P8 = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function isShaDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

/**
 * Verify report bytes, not merely the shape of a manifest's claimed digest.
 * Release reports must be copied into the ignored local evidence directory;
 * arbitrary paths and symlinks out of that directory are rejected.
 */
export function verifyEvidenceReportHash(reportPath, expectedSha256, root) {
  if (typeof reportPath !== 'string' || !reportPath.trim() || !isShaDigest(expectedSha256)) return false
  if (isAbsolute(reportPath) || reportPath.split(/[\\/]/).includes('..')) return false

  try {
    const evidenceRoot = resolve(root, 'docs/evidence/artifacts')
    const target = resolve(root, reportPath)
    const relativeTarget = relative(evidenceRoot, target)
    if (!relativeTarget || relativeTarget === '..' || relativeTarget.startsWith('..' + sep) || isAbsolute(relativeTarget)) return false
    if (!existsSync(evidenceRoot) || !existsSync(target)) return false

    const actualRepoRoot = realpathSync(root)
    const actualRoot = realpathSync(evidenceRoot)
    const baseRelative = relative(actualRepoRoot, actualRoot)
    if (!baseRelative || baseRelative === '..' || baseRelative.startsWith('..' + sep) || isAbsolute(baseRelative)) return false
    const actualTarget = realpathSync(target)
    const realRelative = relative(actualRoot, actualTarget)
    if (!realRelative || realRelative === '..' || realRelative.startsWith('..' + sep) || isAbsolute(realRelative)) return false
    const stat = statSync(actualTarget)
    if (!stat.isFile() || stat.size === 0) return false

    const actualSha256 = createHash('sha256').update(readFileSync(actualTarget)).digest('hex')
    return actualSha256.toLowerCase() === expectedSha256.toLowerCase()
  } catch {
    return false
  }
}

/** Every linked evidence report must have a local copy matching its claimed hash. */
export function reportsMatchHashes(evidence, root) {
  const reports = Array.isArray(evidence?.gates) ? evidence.gates : [evidence]
  return reports.length > 0 && reports.every((report) =>
    verifyEvidenceReportHash(report?.reportPath, report?.reportSha256, root),
  )
}

/** Find a completed successful push CI run on the exact commit and workflow. */
export function selectSuccessfulHostedCiRun(runs, sha) {
  if (typeof sha !== 'string' || !SHA_RE.test(sha) || !Array.isArray(runs)) return null
  return runs
    .filter((run) =>
      run?.head_sha === sha &&
      run?.path === '.github/workflows/ci.yml' &&
      run?.event === 'push' &&
      run?.status === 'completed' &&
      run?.conclusion === 'success' &&
      Number.isSafeInteger(run?.id) &&
      isHttpsUrl(run?.html_url),
    )
    .sort((a, b) => Date.parse(b.updated_at ?? b.created_at ?? 0) - Date.parse(a.updated_at ?? a.created_at ?? 0))[0] ?? null
}

/** Require the log artifact explicitly named for the exact SHA and not expired. */
export function hasShaBoundCiArtifact(artifacts, sha) {
  if (typeof sha !== 'string' || !SHA_RE.test(sha) || !Array.isArray(artifacts)) return false
  return artifacts.some((artifact) =>
    artifact?.name === `launch-gate-${sha}` &&
    artifact?.expired === false &&
    Number(artifact?.size_in_bytes) > 0,
  )
}

/** P0–P8 pass only with an exact-SHA manifest and hashed, linked evidence per gate. */
export function validateP0P8Evidence(evidence, sha) {
  if (!evidence || evidence.targetCommitSha !== sha || !SHA_RE.test(sha)) return false
  if (!Array.isArray(evidence.gates)) return false
  return P0_TO_P8.every((id) => {
    const item = evidence.gates.find((entry) => entry?.id === id)
    return item?.status === 'passed' &&
      isHttpsUrl(item.reportUrl) &&
      typeof item.reportPath === 'string' &&
      isShaDigest(item.reportSha256)
  })
}

/** Do not infer independent security review from a commit message or file presence. */
export function validateIndependentSecurityAudit(evidence, sha) {
  if (!evidence || evidence.targetCommitSha !== sha || !SHA_RE.test(sha)) return false
  return evidence.status === 'passed' &&
    evidence.independenceConfirmed === true &&
    typeof evidence.auditor?.name === 'string' && evidence.auditor.name.trim().length > 1 &&
    typeof evidence.auditor?.organization === 'string' && evidence.auditor.organization.trim().length > 1 &&
    isHttpsUrl(evidence.reportUrl) &&
    typeof evidence.reportPath === 'string' &&
    isShaDigest(evidence.reportSha256) &&
    typeof evidence.scope === 'string' && /financial|tenant|authorization|security/i.test(evidence.scope) &&
    Number.isFinite(Date.parse(evidence.completedAt))
}

const REQUIRED_LEGAL_REVIEW_TOPICS = [
  'law_151_2020',
  'executive_regulations_816_2025',
  'controller_processor_roles_and_registration',
  'cross_border_ai_and_asr_transfers',
  'data_subject_rights_and_retention',
  'security_breach_and_incident_reporting',
  'privacy_policy_and_terms_of_service',
  'dpo_and_other_applicable_obligations',
]

/**
 * Legal review is distinct from the technical security audit. The gate verifies
 * the evidence shape/report; the owner must independently verify counsel licence.
 */
export function validateLegalPolicyReview(evidence, sha) {
  if (!evidence || evidence.targetCommitSha !== sha || !SHA_RE.test(sha)) return false
  const policies = Array.isArray(evidence.reviewedPolicies) ? evidence.reviewedPolicies : []
  const topics = Array.isArray(evidence.reviewedTopics) ? evidence.reviewedTopics : []
  return evidence.status === 'passed' &&
    evidence.independentReview === true &&
    evidence.counsel?.licensedInEgypt === true &&
    typeof evidence.counsel?.name === 'string' && evidence.counsel.name.trim().length > 1 &&
    typeof evidence.counsel?.organization === 'string' && evidence.counsel.organization.trim().length > 1 &&
    typeof evidence.counsel?.licenceNumber === 'string' && evidence.counsel.licenceNumber.trim().length > 1 &&
    policies.includes('docs/PRIVACY.md') &&
    policies.includes('docs/TERMS.md') &&
    REQUIRED_LEGAL_REVIEW_TOPICS.every((topic) => topics.includes(topic)) &&
    isHttpsUrl(evidence.reportUrl) &&
    typeof evidence.reportPath === 'string' &&
    isShaDigest(evidence.reportSha256) &&
    Number.isFinite(Date.parse(evidence.completedAt))
}

/** Capacity evidence must identify this commit, a production-like run and its raw report. */
export function validateCapacityEvidence(evidence, sha) {
  if (!evidence || evidence.targetCommitSha !== sha || !SHA_RE.test(sha)) return false
  const m = evidence.metrics
  return evidence.status === 'passed' &&
    evidence.environmentClass === 'production-like' &&
    typeof evidence.testSuite === 'string' && evidence.testSuite.trim().length > 0 &&
    Number.isFinite(Date.parse(evidence.testedAt)) &&
    Number.isFinite(m?.requestCount) && m.requestCount > 0 &&
    Number.isFinite(m?.concurrency) && m.concurrency > 0 &&
    Number.isFinite(m?.p50Ms) && m.p50Ms >= 0 &&
    Number.isFinite(m?.p95Ms) && m.p95Ms >= m.p50Ms &&
    Number.isFinite(m?.p99Ms) && m.p99Ms >= m.p95Ms &&
    Number.isFinite(m?.errorRatePct) && m.errorRatePct >= 0 && m.errorRatePct <= 100 &&
    isHttpsUrl(evidence.reportUrl) &&
    typeof evidence.reportPath === 'string' &&
    isShaDigest(evidence.reportSha256)
}
