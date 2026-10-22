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
    isShaDigest(evidence.reportSha256) &&
    typeof evidence.scope === 'string' && /financial|tenant|authorization|security/i.test(evidence.scope) &&
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
    isShaDigest(evidence.reportSha256)
}
