ALTER TABLE "Business" ADD COLUMN "workflowMode" TEXT NOT NULL DEFAULT 'inventory';
CREATE TABLE "CashbookEntry" (
 "id" TEXT NOT NULL PRIMARY KEY, "businessId" TEXT NOT NULL, "operationRef" TEXT NOT NULL,
 "userId" TEXT NOT NULL, "kind" TEXT NOT NULL, "amount" INTEGER NOT NULL,
 "partyName" TEXT NOT NULL DEFAULT '', "customerId" TEXT, "supplierId" TEXT,
 "occurredOn" TEXT NOT NULL, "dueOn" TEXT, "note" TEXT NOT NULL DEFAULT '',
 "openAmount" INTEGER NOT NULL DEFAULT 0, "cashDelta" INTEGER NOT NULL DEFAULT 0,
 "settlements" TEXT NOT NULL DEFAULT '[]', "lastNudgedOn" TEXT,
 "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 FOREIGN KEY ("operationRef") REFERENCES "Operation"("ref") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CashbookEntry_operationRef_key" ON "CashbookEntry"("operationRef");
CREATE INDEX "CashbookEntry_businessId_dueOn_openAmount_idx" ON "CashbookEntry"("businessId", "dueOn", "openAmount");
CREATE TABLE "ShopReminder" (
 "id" TEXT NOT NULL PRIMARY KEY, "businessId" TEXT NOT NULL, "userId" TEXT NOT NULL,
 "subject" TEXT NOT NULL, "active" BOOLEAN NOT NULL DEFAULT true,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ShopReminder_businessId_userId_subject_key" ON "ShopReminder"("businessId", "userId", "subject");
