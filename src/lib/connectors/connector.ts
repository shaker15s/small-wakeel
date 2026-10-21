// وكيل — Connector contract (PR-012 / plan v2 §10.3).
//
// Every connector declares the full manifest — and the connection_state is
// COMPUTED from verified facts, never asserted. A skill appearing in a
// prompt is NOT `CONNECTED`.
//
// The trial connector implemented here is the Level A one (CSV/Excel
// reconciliation against the catalog): its "external source" is the file the
// owner selects, and its write path is the approval-gated, read-back-verified
// reconcile apply. Higher levels (official API / local CLI / CLI-Anything /
// UI automation) are separate, unimplemented surfaces — they stay
// NOT_CONFIGURED and say so.

import { db } from '@/lib/db'

export type ConnectionState =
  | 'NOT_CONFIGURED'
  | 'PAIRING'
  | 'CONNECTED_READ_ONLY'
  | 'CONNECTED_WRITE_PENDING_APPROVAL'
  | 'CONNECTED'
  | 'DEGRADED'
  | 'REVOKED'
  | 'FAILED'

export interface ConnectorManifest {
  provider: string
  app: string
  version: string
  environment: 'sandbox' | 'production'
  level: 'A' | 'B' | 'C' | 'D' | 'E'
  capabilities: string[]
  readScopes: string[]
  writeScopes: string[]
  health: 'ok' | 'degraded' | 'unknown'
  lastVerifiedAt: string | null
  connectionState: ConnectionState
  dataMapping: Record<string, string>
  idempotency: string
  reconciliation: string
  limits: Record<string, number>
  approvalPolicy: string
  disconnect: { supported: boolean; how: string }
  testEvidence: { suite: string; passed: number; failed: number; sha: string }
}

/**
 * Honest connection state for the file-reconciliation connector:
//   • no report ever produced for this business → CONNECTED_READ_ONLY is NOT
//     claimed (nothing verified yet) → NOT_CONFIGURED with the reason
//   • a DRAFT report exists → the read side is verified (the file parsed and
//     matched against live rows) and a write is waiting on the owner →
//     CONNECTED_WRITE_PENDING_APPROVAL
//   • an APPLIED report with 0 read-back mismatches → CONNECTED (the full
//     loop — read, approve, write, read-back — is verified)
//   • an APPLIED report WITH read-back mismatches → DEGRADED (honestly)
 */
export async function describeFileReconciliationConnector(businessId: string): Promise<ConnectorManifest> {
  const reports = await db.reconcileReport.findMany({
    where: { businessId },
    orderBy: { createdAt: 'desc' },
    take: 10,
  })
  const applied = reports.find((r) => r.status === 'APPLIED')
  const draft = reports.find((r) => r.status === 'DRAFT')

  let connectionState: ConnectionState
  let health: 'ok' | 'degraded' | 'unknown' = 'unknown'
  let lastVerifiedAt: string | null = null

  if (applied) {
    const rb = applied.readback ? (JSON.parse(applied.readback) as { mismatched: number }) : null
    if (rb && rb.mismatched > 0) {
      connectionState = 'DEGRADED'
      health = 'degraded'
    } else {
      connectionState = 'CONNECTED'
      health = 'ok'
    }
    lastVerifiedAt = applied.appliedAt?.toISOString() ?? null
  } else if (draft) {
    connectionState = 'CONNECTED_WRITE_PENDING_APPROVAL'
    health = 'ok'
    lastVerifiedAt = draft.createdAt.toISOString()
  } else {
    connectionState = 'NOT_CONFIGURED'
  }

  return {
    provider: 'wakil-local',
    app: 'file-reconciliation',
    version: '1.0.0',
    environment: 'sandbox',
    level: 'A',
    capabilities: ['parse:csv', 'parse:xlsx', 'match:catalog', 'diff:fields', 'write:catalog (approved only)', 'readback:verify'],
    readScopes: ['file:owner-selected', 'catalog:own-business'],
    writeScopes: ['catalog:own-business (dry-run + owner approval + read-back)'],
    health,
    lastVerifiedAt,
    connectionState,
    dataMapping: {
      'اسم الصنف': 'Item.name',
      'التصنيف': 'Item.category',
      'الوحدة': 'Item.unit',
      'سعر الشراء': 'Item.costPrice (piastres)',
      'سعر البيع': 'Item.sellPrice (piastres)',
      'الكمية': 'Item.stockQty',
      'حد الطلب': 'Item.lowStockThreshold',
      'الباركود': 'Item.barcode',
      'تاريخ الصلاحية': 'Item.expiresAt',
    },
    idempotency: 'matching by normalised name + digit folding; apply is bound to the previewed report contentHash',
    reconciliation: 'per-row verdicts with field-level diffs before any write; read-back of every applied row after',
    limits: { maxRows: 2000 },
    approvalPolicy: 'owner acknowledgement of the diff is mandatory; no write before dry-run',
    disconnect: { supported: true, how: 'reports are per-business; revoking access = no new dry-runs (guard permission catalog.manage)' },
    testEvidence: { suite: 'tests/integration/reconciliation.test.ts', passed: 0, failed: 0, sha: 'pending' },
  }
}

/** The other levels are NOT implemented — and say so instead of implying. */
export function describePlannedLevels(): Array<{ level: 'B' | 'C' | 'D' | 'E'; state: ConnectionState; note: string }> {
  return [
    { level: 'B', state: 'NOT_CONFIGURED', note: 'Official API connector — OAuth/API key in vault, sandbox reads أولًا — غير مُنفذ بعد' },
    { level: 'C', state: 'NOT_CONFIGURED', note: 'Local CLI with SKILL/manifest and real tests — غير مُنفذ بعد' },
    { level: 'D', state: 'NOT_CONFIGURED', note: 'CLI-Anything-generated harness — غير مُنفذ بعد' },
    { level: 'E', state: 'NOT_CONFIGURED', note: 'UI automation — ليست المسار الافتراضي' },
  ]
}
