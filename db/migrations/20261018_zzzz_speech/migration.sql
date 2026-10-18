CREATE TABLE "SpeechSettings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "providerId" TEXT NOT NULL,
  "remoteId" TEXT NOT NULL,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "SpeechSettings_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ModelProvider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
