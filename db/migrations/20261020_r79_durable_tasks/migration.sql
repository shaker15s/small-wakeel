-- R78 / PR-010 (final plan v2 §9, P5): durable task runner.
-- Additive only.
--
-- ScheduledTask gains the durable-execution state machine:
--   • leaseOwner    — which worker holds the task (claim is still atomic)
--   • attempts/maxAttempts/nextRetryAt — a bounded retry budget with backoff;
--     a failed run is RETRY_WAIT until its nextRetryAt, never lost and never
--     silently retried forever
--   • executionCount — generation counter: every firing of the task has a
--     distinct generation, which keys the outbox row (crash-safe idempotency)
--   • lastStep      — the last COMPLETED step, for an honest task box
--     («المستخدم يرى آخر خطوة مكتملة والخطوة التالية والسبب الحقيقي»)
ALTER TABLE "ScheduledTask" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ScheduledTask" ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "ScheduledTask" ADD COLUMN "nextRetryAt" DATETIME;
ALTER TABLE "ScheduledTask" ADD COLUMN "leaseOwner" TEXT;
ALTER TABLE "ScheduledTask" ADD COLUMN "executionCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ScheduledTask" ADD COLUMN "lastStep" TEXT;
CREATE INDEX "ScheduledTask_status_nextRetryAt_idx" ON "ScheduledTask"("status", "nextRetryAt");

-- TaskNotification — transactional OUTBOX for task results. Delivery is a
-- separately claimed, separately committed unit of work: «task finished» is
-- never conflated with «notification delivered» (plan §9.3). The row id is
-- deterministic (taskId + generation), so a crashed-and-retried firing can
-- never enqueue the same notification twice, and the posted chat message
-- carries a deterministic id, so it can never be posted twice either.
CREATE TABLE "TaskNotification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "taskId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "conversationId" TEXT,
  "payload" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', -- pending | sending | sent | failed
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "claimedAt" DATETIME,
  "claimedBy" TEXT,
  "failReason" TEXT,
  "sentAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskNotification_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "ScheduledTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TaskNotification_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TaskNotification_status_idx" ON "TaskNotification"("status");
CREATE INDEX "TaskNotification_taskId_idx" ON "TaskNotification"("taskId");
