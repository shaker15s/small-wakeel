-- R41: «موظف حقيقي» — pending multi-turn requests (new-item purchase flow).
--
-- When the owner starts a task whose information arrives across several
-- messages («جبت 100 صفيحة سمنة ودفعت 1000» → «المورد شركة السمانه المصرية
-- والحساب 2000»), the assistant holds the open request here — per
-- conversation, expiring after 20 minutes (same grace as CashbookDialogue) —
-- instead of dropping it and re-asking from zero. Additive-only.
CREATE TABLE "PendingRequest" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "businessId" TEXT NOT NULL, "conversationId" TEXT NOT NULL UNIQUE, "userId" TEXT NOT NULL,
 "kind" TEXT NOT NULL, "slots" TEXT NOT NULL DEFAULT '{}', "question" TEXT NOT NULL DEFAULT '',
 "status" TEXT NOT NULL DEFAULT 'awaiting', "createdAt" DATETIME NOT NULL, "expiresAt" DATETIME NOT NULL,
 "updatedAt" DATETIME NOT NULL,
 FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PendingRequest_businessId_status_idx" ON "PendingRequest"("businessId", "status");
