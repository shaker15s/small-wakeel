# Release evidence required by `pilot:gate`

The launch gate deliberately fails closed. **Do not create these files with guessed or placeholder values.** Each manifest must be tied to the exact release commit and backed by real retained artifacts.

**These three JSON manifests are intentionally ignored by Git and must remain local operator evidence.** Prepare them only after the target release SHA is fixed; otherwise committing a manifest changes the SHA it claims to verify and makes the evidence circular. Do not force-add them to the repository.
Local report copies in `docs/evidence/artifacts/` are ignored too. The gate calculates the SHA-256 from each file itself and refuses to count a syntactically valid digest if the file is missing or its bytes differ.

The gate reads these optional evidence files:

- `docs/evidence/p0-p8-acceptance.json`: `targetCommitSha` plus all nine entries `P0` through `P8`. Each entry must have `status: "passed"`, an HTTPS `reportUrl`, a `reportPath` under `docs/evidence/artifacts/`, and a SHA-256 `reportSha256` that matches the actual file bytes.
- `docs/evidence/independent-security-audit.json`: `targetCommitSha`, `status: "passed"`, `independenceConfirmed: true`, external auditor name and organization, completion date, audit scope, an HTTPS report URL, a `reportPath` under `docs/evidence/artifacts/`, and a SHA-256 that matches the report copy byte-for-byte. A project-authored checklist is not an independent audit.
- `docs/evidence/capacity-acceptance.json`: exact `targetCommitSha`, `status: "passed"`, `environmentClass: "production-like"`, test-suite/version, test date, request count, concurrency, p50/p95/p99 latency, error rate, HTTPS report URL, a `reportPath` under `docs/evidence/artifacts/`, and a SHA-256 that matches the report copy byte-for-byte.

## Hosted CI evidence

`pilot:gate` queries GitHub Actions for a **completed successful push run** of `.github/workflows/ci.yml` on the exact current SHA and requires the non-expired `launch-gate-<SHA>` artifact. A workflow file existing in the repository, a pull-request-only check, an unrelated successful commit, or an expired/missing artifact does not count.

## What the deterministic CI proves—and what it does not

The hosted workflow runs `scripts/ci.sh`: frozen dependency install, schema checks/migrations on disposable data, typecheck, lint, automated tests, financial process-kill/reopen checks, offline Arabic routing evaluations, build, local production smoke and browser checks.

This is not a live-model quality test, a third-party security audit, production hosting acceptance, external mail delivery, provider integration acceptance, or a load test. Those are separate, explicitly evidenced release gates.

Never place provider secrets, customer data, or raw financial records in these manifests or public CI artifacts.
