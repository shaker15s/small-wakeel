ALTER TABLE "CashbookEntry" ADD COLUMN "promiseRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CashbookEntry" ADD COLUMN "promiseRef" TEXT;
ALTER TABLE "CashbookEntry" ADD COLUMN "followupUserId" TEXT;
ALTER TABLE "CashbookEntry" ADD COLUMN "dateSource" TEXT NOT NULL DEFAULT 'user_day';
