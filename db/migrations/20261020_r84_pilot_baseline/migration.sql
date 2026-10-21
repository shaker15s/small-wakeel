-- R84 / PR-015 (final plan v2 §13 pilot — «سجل خط أساس وبعدي لكل نشاط»):
-- owner-reported baseline records for before/after value measurement.
-- Additive only.
--
-- Values here are HUMAN-MEASURED by the owner (source: owner_reported). They
-- are never mixed with ledger-measured post-use numbers, and unknowns stay
-- null — a missing number is «غير مسجل», not 0.
CREATE TABLE "PilotBaseline" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "businessId" TEXT NOT NULL,
  "workflow" TEXT NOT NULL, -- agreed workflow name
  "tasksCount" INTEGER, -- times the workflow ran in the baseline window
  "minutes" REAL, -- actual minutes per task, the old way
  "errors" INTEGER, -- owner-counted mistakes/rework in the window
  "note" TEXT,
  "recordedBy" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PilotBaseline_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PilotBaseline_businessId_createdAt_idx" ON "PilotBaseline"("businessId", "createdAt");
