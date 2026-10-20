-- R73 / PR-005 (final plan v2 §20.6): append-only agent event ledger.
-- Additive. One row per lifecycle fact of a turn (start, routing decision,
-- plan, tool proposed/refused, task transition, provider error, reply
-- result). Every row shares traceId + businessId; operationRef links the
-- financial audit trail when it applies. The payload is REDACTED JSON —
-- raw secrets/conversation text are never duplicated into the ledger.
CREATE TABLE "AgentEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "businessId" TEXT NOT NULL,
  "traceId" TEXT NOT NULL,
  "conversationId" TEXT,
  "sequence" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "payload" TEXT,
  "operationRef" TEXT,
  "payloadHash" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentEvent_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AgentEvent_traceId_sequence_idx" ON "AgentEvent"("traceId", "sequence");
CREATE INDEX "AgentEvent_businessId_createdAt_idx" ON "AgentEvent"("businessId", "createdAt");
CREATE INDEX "AgentEvent_operationRef_idx" ON "AgentEvent"("operationRef");
