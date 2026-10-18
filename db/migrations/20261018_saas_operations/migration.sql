-- Additive operational state. Never migrate automatically on request/startup.
CREATE TABLE "WorkerHeartbeat" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runId" TEXT NOT NULL,
  "startedAt" DATETIME NOT NULL,
  "finishedAt" DATETIME,
  "ok" BOOLEAN
);
