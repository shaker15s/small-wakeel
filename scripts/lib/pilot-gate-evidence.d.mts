export function selectSuccessfulHostedCiRun(runs: Array<Record<string, unknown>>, sha: string): Record<string, unknown> | null
export function hasShaBoundCiArtifact(artifacts: Array<Record<string, unknown>>, sha: string): boolean
export function validateP0P8Evidence(evidence: Record<string, unknown> | null, sha: string): boolean
export function validateIndependentSecurityAudit(evidence: Record<string, unknown> | null, sha: string): boolean
export function validateCapacityEvidence(evidence: Record<string, unknown> | null, sha: string): boolean
