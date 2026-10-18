CREATE TABLE "WorkspacePreference" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "businessId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "config" TEXT NOT NULL DEFAULT '{}',
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "WorkspacePreference_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkspacePreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WorkspacePreference_businessId_userId_key" ON "WorkspacePreference"("businessId", "userId");
