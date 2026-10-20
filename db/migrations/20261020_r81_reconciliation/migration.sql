-- R81 / PR-012 (final plan v2 §10.2 Level A + §10.3 connector contract):
-- Excel/CSV reconciliation with read-back verification.
-- Additive only.
--
-- The flow is the plan's contract: NO WRITE BEFORE DRY-RUN + OWNER APPROVAL.
--   1. dry-run  → a ReconcileReport: per-row verdict (create/update/skip/
--                 error) + field-level DIFFS against the current catalog.
--                 Zero writes. The report's contentHash is the preview the
--                 owner saw.
--   2. apply    → only the exact report (contentHash must match) and only
--                 when the owner acknowledges the diff. Applied rows are
--                 READ BACK from the database and compared field-by-field;
--                 the readback evidence is stored with the report.
CREATE TABLE "ReconcileReport" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "businessId" TEXT NOT NULL,
  "fileName" TEXT,
  "contentHash" TEXT NOT NULL,
  "payload" TEXT NOT NULL, -- JSON: { rows: verdicts[], summary, unknownHeaders }
  "status" TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT | APPLIED | EXPIRED
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedAt" DATETIME,
  "readback" TEXT, -- JSON evidence: per-row verified/mismatch after apply
  "errorReason" TEXT,
  CONSTRAINT "ReconcileReport_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ReconcileReport_businessId_status_idx" ON "ReconcileReport"("businessId", "status");
