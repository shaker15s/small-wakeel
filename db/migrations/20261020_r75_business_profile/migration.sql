-- R75 / PR-007 (final plan v2 §7.1, PR table): onboarding state machine.
-- Additive. ONE row per business: the interview stage, the owner's ANSWERED
-- facts (source=owner, never guessed), and per-feature consents. Financial
-- facts are recorded ONLY when the owner states them; a skipped financial
-- question stays unknown (null) — never 0-as-unknown.
CREATE TABLE "BusinessProfile" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "businessId" TEXT NOT NULL UNIQUE,
  "stage" TEXT NOT NULL DEFAULT 'not_started',
  "answers" TEXT NOT NULL DEFAULT '{}',
  "consents" TEXT NOT NULL DEFAULT '{}',
  "openingCashStatedAt" DATETIME,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BusinessProfile_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "BusinessProfile_businessId_key" ON "BusinessProfile"("businessId");
