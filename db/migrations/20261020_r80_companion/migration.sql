-- R80 / PR-011 (final plan v2 §10, P6): companion — a small, revocable,
-- READ-ONLY bridge to files/CLI on the owner's own machine.
-- Additive only.
--
-- Trust model (plan §10.1):
--   • enrollment: owner creates a SHORT-LIVED, SINGLE-USE code (5 min)
--   • activation: the code is exchanged (once) for a device identity whose
--     secret is stored only as a sha256 hash
--   • every claim/result call carries an HMAC over (deviceId|nonce|ts|body)
--     with a 60-second clock window — replayed nonces and stale timestamps
--     are refused
--   • revocation is immediate: a REVOKED device claims nothing and its
--     in-flight jobs can never settle
--   • devices may only do what their EXPLICIT allowlist says (path roots +
--     pinned executables); the bridge executes CLI with separated argv,
--     never a shell string
--   • every read carries a double-read hash (two independent reads must
--     agree) so «القراءة الخارجية تطابق مصدرها» is verifiable evidence,
--     not a promise

CREATE TABLE "CompanionEnrollment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "businessId" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL UNIQUE,
  "deviceName" TEXT NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "usedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CompanionEnrollment_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CompanionEnrollment_businessId_idx" ON "CompanionEnrollment"("businessId");

CREATE TABLE "CompanionDevice" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "businessId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | REVOKED
  "tokenHash" TEXT NOT NULL,
  "allowlist" TEXT NOT NULL DEFAULT '{}', -- JSON: { paths: string[], cli: { command, label }[] }
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedAt" DATETIME,
  "revokedAt" DATETIME,
  "lastSeenAt" DATETIME,
  CONSTRAINT "CompanionDevice_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CompanionDevice_businessId_idx" ON "CompanionDevice"("businessId");

CREATE TABLE "CompanionJob" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "businessId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "tool" TEXT NOT NULL, -- list_dir | read_file | run_cli
  "args" TEXT NOT NULL, -- JSON
  "status" TEXT NOT NULL DEFAULT 'QUEUED', -- QUEUED | CLAIMED | DELIVERED | FAILED | EXPIRED
  "nonce" TEXT NOT NULL,
  "envelopeHmac" TEXT NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "claimedAt" DATETIME,
  "result" TEXT, -- JSON evidence: { hash, size, lines?, truncated, exitCode? }
  "errorReason" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CompanionJob_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "CompanionDevice" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CompanionJob_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CompanionJob_deviceId_status_idx" ON "CompanionJob"("deviceId", "status");
CREATE INDEX "CompanionJob_businessId_idx" ON "CompanionJob"("businessId");
