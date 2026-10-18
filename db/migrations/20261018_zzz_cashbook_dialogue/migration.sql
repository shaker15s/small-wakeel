CREATE TABLE "CashbookDialogue" (
 "conversationId" TEXT NOT NULL PRIMARY KEY,
 "state" TEXT NOT NULL, "lastTurnId" TEXT, "lastInput" TEXT NOT NULL DEFAULT '',
 "lastReply" TEXT NOT NULL DEFAULT '', "resolved" TEXT,
 "version" INTEGER NOT NULL DEFAULT 0, "expiresAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL,
 FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
