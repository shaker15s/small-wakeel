-- R85 / PR-003: preserve the client/request payload hash separately from
-- the normalized approval payloadHash. Validation can materialize defaults
-- such as paid=total or line totals, so a retried request must bind to the
-- original incoming representation while approval remains bound to stored bytes.
-- Null for older rows: if a retry cannot be proven identical, the executor fails closed.
ALTER TABLE "Operation" ADD COLUMN "requestPayloadHash" TEXT;
