-- R71 / PR-003 (الخطة النهائية v2 — §20.4 «موافقة مرتبطة بالـpayload»):
-- Operation gains two additive columns:
--   • payloadHash: sha256 of the CANONICAL serialization of the draft payload
--     (keys sorted recursively). The approved bytes are the executed bytes:
--     executeOperation recomputes the hash from the stored payload and refuses
--     to run a draft that changed after it was recorded.
--   • expiresAt: an approval only holds within its window. A draft older than
--     the window is CANCELLED on approval attempt and the owner redrafts —
--     a stale "اعملها" is not an approval.
-- Nullable on purpose: pre-R71 rows have no hash/expiry and keep working
-- (legacy behavior); every NEW draft carries both.
ALTER TABLE "Operation" ADD COLUMN "payloadHash" TEXT;
ALTER TABLE "Operation" ADD COLUMN "expiresAt" DATETIME;
