import { describe, expect, test } from 'bun:test'
import {
  hasShaBoundCiArtifact,
  selectSuccessfulHostedCiRun,
  validateCapacityEvidence,
  validateIndependentSecurityAudit,
  validateP0P8Evidence,
} from '../../scripts/lib/pilot-gate-evidence.mjs'

const sha = 'a'.repeat(40)
const reportHash = 'b'.repeat(64)

describe('release-gate evidence is exact-SHA and evidence-bound', () => {
  test('a directory, a failed run, PR run, wrong workflow, or another SHA is not a hosted CI pass', () => {
    expect(selectSuccessfulHostedCiRun([], sha)).toBeNull()
    expect(selectSuccessfulHostedCiRun([
      { id: 1, head_sha: sha, path: '.github/workflows/ci.yml', event: 'push', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/run', updated_at: new Date().toISOString() },
      { id: 2, head_sha: sha, path: '.github/workflows/ci.yml', event: 'pull_request', status: 'completed', conclusion: 'success', html_url: 'https://github.com/run', updated_at: new Date().toISOString() },
      { id: 3, head_sha: 'c'.repeat(40), path: '.github/workflows/ci.yml', event: 'push', status: 'completed', conclusion: 'success', html_url: 'https://github.com/run', updated_at: new Date().toISOString() },
      { id: 4, head_sha: sha, path: '.github/workflows/other.yml', event: 'push', status: 'completed', conclusion: 'success', html_url: 'https://github.com/run', updated_at: new Date().toISOString() },
    ], sha)).toBeNull()
  })

  test('requires a completed green push run on the exact SHA', () => {
    const run = { id: 5, head_sha: sha, path: '.github/workflows/ci.yml', event: 'push', status: 'completed', conclusion: 'success', html_url: 'https://github.com/run', updated_at: new Date().toISOString() }
    expect(selectSuccessfulHostedCiRun([run], sha)).toEqual(run)
  })

  test('requires the non-expired log artifact whose name embeds the exact SHA', () => {
    expect(hasShaBoundCiArtifact([{ name: `launch-gate-${sha}`, expired: false, size_in_bytes: 100 }], sha)).toBe(true)
    expect(hasShaBoundCiArtifact([{ name: `launch-gate-${'c'.repeat(40)}`, expired: false, size_in_bytes: 100 }], sha)).toBe(false)
    expect(hasShaBoundCiArtifact([{ name: `launch-gate-${sha}`, expired: true, size_in_bytes: 100 }], sha)).toBe(false)
  })

  test('P0–P8 requires all nine gate entries with report URLs and SHA256 digests', () => {
    const gates = Array.from({ length: 9 }, (_, i) => ({ id: `P${i}`, status: 'passed', reportUrl: 'https://evidence.example/report', reportSha256: reportHash }))
    expect(validateP0P8Evidence({ targetCommitSha: sha, gates }, sha)).toBe(true)
    expect(validateP0P8Evidence({ targetCommitSha: 'c'.repeat(40), gates }, sha)).toBe(false)
    expect(validateP0P8Evidence({ targetCommitSha: sha, gates: gates.slice(0, 8) }, sha)).toBe(false)
  })

  test('security review must identify independent auditor and an external hashed report', () => {
    const evidence = {
      targetCommitSha: sha, status: 'passed', independenceConfirmed: true,
      auditor: { name: 'Independent Reviewer', organization: 'External Audit Firm' },
      reportUrl: 'https://audit.example/report', reportSha256: reportHash,
      scope: 'Security, tenant isolation, financial writes', completedAt: '2026-10-22T00:00:00Z',
    }
    expect(validateIndependentSecurityAudit(evidence, sha)).toBe(true)
    expect(validateIndependentSecurityAudit({ ...evidence, independenceConfirmed: false }, sha)).toBe(false)
    expect(validateIndependentSecurityAudit({ ...evidence, targetCommitSha: 'c'.repeat(40) }, sha)).toBe(false)
  })

  test('capacity evidence must contain real-shaped metrics tied to exact code and environment', () => {
    const evidence = {
      targetCommitSha: sha, status: 'passed', environmentClass: 'production-like',
      testSuite: 'load-v1', testedAt: '2026-10-22T00:00:00Z',
      metrics: { requestCount: 1000, concurrency: 20, p50Ms: 100, p95Ms: 300, p99Ms: 500, errorRatePct: 0 },
      reportUrl: 'https://load.example/report', reportSha256: reportHash,
    }
    expect(validateCapacityEvidence(evidence, sha)).toBe(true)
    expect(validateCapacityEvidence({ ...evidence, targetCommitSha: 'c'.repeat(40) }, sha)).toBe(false)
    expect(validateCapacityEvidence({ ...evidence, metrics: { ...evidence.metrics, p99Ms: 200 } }, sha)).toBe(false)
  })
})
