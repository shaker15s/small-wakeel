CREATE TABLE "Account" (
  "id" TEXT PRIMARY KEY,
  "email" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "verifiedAt" DATETIME,
  "disabledAt" DATETIME,
  "mfaSecret" TEXT,
  "pendingMfaSecret" TEXT,
  "pendingMfaAt" DATETIME,
  "mfaLastStep" INTEGER NOT NULL,
  "recoveryHashes" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL
);

CREATE TABLE "AccountToken" (
  "id" TEXT PRIMARY KEY,
  "tokenHash" TEXT NOT NULL UNIQUE,
  "accountId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "usedAt" DATETIME,
  "expiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL,
  FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AuthThrottle" (
  "id" TEXT PRIMARY KEY,
  "attempts" INTEGER NOT NULL,
  "windowAt" DATETIME NOT NULL
);

CREATE TABLE "Invitation" (
  "id" TEXT PRIMARY KEY,
  "businessId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL UNIQUE,
  "invitedBy" TEXT NOT NULL,
  "acceptedAt" DATETIME,
  "revokedAt" DATETIME,
  "expiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL,
  FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "MailOutbox" (
  "id" TEXT PRIMARY KEY,
  "payload" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL,
  "nextAttemptAt" DATETIME NOT NULL,
  "lockedAt" DATETIME,
  "sentAt" DATETIME,
  "expiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL
);

CREATE TABLE "Membership" (
  "id" TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "userId" TEXT NOT NULL UNIQUE,
  "disabledAt" DATETIME,
  "createdAt" DATETIME NOT NULL,
  FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  UNIQUE ("accountId", "userId")
);

CREATE TABLE "Session" (
  "id" TEXT PRIMARY KEY,
  "tokenHash" TEXT NOT NULL UNIQUE,
  "accountId" TEXT NOT NULL,
  "membershipId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL,
  "lastSeenAt" DATETIME NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "revokedAt" DATETIME,
  FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("membershipId") REFERENCES "Membership" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "Subscription" (
  "id" TEXT PRIMARY KEY,
  "businessId" TEXT NOT NULL UNIQUE,
  "plan" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "trialEndsAt" DATETIME NOT NULL,
  "seatLimit" INTEGER NOT NULL,
  "dailyChatLimit" INTEGER NOT NULL,
  "createdAt" DATETIME NOT NULL,
  FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AccountToken_accountId_purpose_index" ON "AccountToken" ("accountId", "purpose");

CREATE INDEX "Invitation_businessId_email_index" ON "Invitation" ("businessId", "email");

CREATE INDEX "MailOutbox_status_nextAttemptAt_index" ON "MailOutbox" ("status", "nextAttemptAt");

CREATE UNIQUE INDEX "Membership_accountId_userId_unique" ON "Membership" ("accountId", "userId");

CREATE INDEX "Session_accountId_revokedAt_index" ON "Session" ("accountId", "revokedAt");

CREATE INDEX "Session_expiresAt_index" ON "Session" ("expiresAt");

CREATE INDEX "Session_membershipId_index" ON "Session" ("membershipId");

CREATE TABLE "QuotaBucket" ("id" TEXT PRIMARY KEY, "used" INTEGER NOT NULL);
