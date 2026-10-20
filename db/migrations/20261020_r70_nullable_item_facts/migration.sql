-- R70 / PR-001 (الخطة النهائية v2 — «المجهول ما يصيرش حقيقة»):
-- Item.sellPrice / costPrice / stockQty / lowStockThreshold become NULLABLE.
--
-- BEFORE: a catalog item created without known facts stored INVENTED ones
-- (sell=50 EGP, cost=75% of sell, stock=10, threshold=5 from
-- upsertCatalogItemInDb; 0 from the DB column defaults elsewhere). The
-- invented numbers then drove real money math: margin "calculated" against a
-- fake cost, stock checks against a phantom 10, shortages reported at a
-- made-up threshold.
--
-- AFTER: an unknown fact is NULL — the value the owner (or a trusted source)
-- has not provided. Zero stays a VALID financial fact (a real «نفد» is 0).
-- Reports must say «غير مسجل» for NULL — never treat it as 0.
--
-- Mechanics: SQLite cannot DROP a NOT NULL constraint in place, so this
-- rebuilds the table (rename → create → copy → recreate indexes → drop).
-- Every existing row is copied 1:1 — no value changes, no data loss. No
-- table references Item (the FK points the other way: Item.businessId →
-- Business), so the rename touches nothing else. The build is safe to run on
-- a DB where the columns are already nullable (plain copy) — the ledger
-- still guarantees a single application per database. The migration engine
-- (db-migrations.ts) wraps every file in its own transaction, so this file
-- must not open one itself (and no FKs need disabling: nothing references Item).
ALTER TABLE "Item" RENAME TO "Item_pre_r70";
-- SQLite keeps index NAMES when a table is renamed (they now point at the
-- old table), so the old names are dropped here and recreated below.
DROP INDEX "Item_businessId_name_index";
DROP INDEX "Item_businessId_barcode_index";
DROP INDEX "Item_businessId_stockQty_index";
DROP INDEX "Item_expiresAt_index";
CREATE TABLE "Item" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" TEXT NOT NULL DEFAULT '',
    "unit" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "costPrice" INTEGER,
    "sellPrice" INTEGER,
    "stockQty" INTEGER,
    "lowStockThreshold" INTEGER,
    "batchNo" TEXT,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "barcode" TEXT,
    CONSTRAINT "Item_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "Item" ("id","businessId","name","aliases","unit","category","costPrice","sellPrice","stockQty","lowStockThreshold","batchNo","expiresAt","createdAt","barcode")
SELECT "id","businessId","name","aliases","unit","category","costPrice","sellPrice","stockQty","lowStockThreshold","batchNo","expiresAt","createdAt","barcode" FROM "Item_pre_r70";
CREATE INDEX "Item_businessId_name_index" ON "Item" ("businessId","name");
CREATE INDEX "Item_businessId_stockQty_index" ON "Item" ("businessId","stockQty");
CREATE INDEX "Item_expiresAt_index" ON "Item" ("expiresAt");
CREATE INDEX "Item_businessId_barcode_index" ON "Item" ("businessId","barcode");
DROP TABLE "Item_pre_r70";
