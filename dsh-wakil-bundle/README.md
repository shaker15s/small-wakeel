# WAKIL — Native DeepSeek Harness Bundle

This directory is an out-of-tree DeepSeek Harness bundle and Agent Preset, not a replacement harness. DSH owns conversation/runtime/tool lifecycle; WAKIL owns the business ledger, domain validation, draft state and deterministic execution.

## What the first integration does

- Read the configured owner's business overview and ledger-derived cash position.
- Search catalog items while preserving unknown prices and stock as null.
- List customers, suppliers and pending approvals.
- Prepare draft-only sales, purchases, expenses, collections, payments, memberships, attendance and cashbook operations through WAKIL's existing createDraft domain executor.
- Bind all data access to one server-configured owner and business. The model cannot choose tenant identity.

## Safety boundary

**This DSH preset contains no approve, execute, delete or reverse tool.** Every supported change is a pending operation. The owner must review and approve it in the original WAKIL application; there, the current deterministic executor applies and verifies the result.

The bridge uses a bearer token between the local DSH process and the WAKIL server. The token must never be placed in prompts, tool arguments, YAML, Git or logs. The server reads business/user identity from its own environment and requires an owner role. Requests for approval or execution are explicitly refused.

This is an opt-in controlled-local integration, not a public-SaaS deployment. The official DSH project is still a developer preview and its plugin Host code is not a security sandbox. Test with synthetic data first.

Because DSH Host plugins run in the same trusted process and may access process environment, treat the bridge token as visible to every trusted Host plugin in this profile. Keep this profile dedicated to WAKIL; do not install third-party or unreviewed bundles into it. The profile is an operational boundary, not a sandbox against malicious Host code.

## Compatibility

The package declares DSH version range >=0.2.1-rc.2 and <0.3.0. Check the installed runtime with dsh --version before installing. Do not infer the Windows-installed version from the upstream repository's current version.

## Configure WAKIL

Add the following to the untracked .env.local file used by the WAKIL server:

    WAKIL_DSH_ENABLED=1
    WAKIL_DSH_BRIDGE_TOKEN=<64 random hexadecimal characters>
    WAKIL_DSH_BUSINESS_ID=<existing business id>
    WAKIL_DSH_USER_ID=<owner user id within that business>

Use a cryptographically random token with at least 32 characters; 64 random hexadecimal characters is recommended. The route fails closed if the token is absent/short, the business/user IDs do not match, or the configured user is not the owner.

Do not set WAKIL_DSH_BUSINESS_ID or WAKIL_DSH_USER_ID in the DSH process. Those identities are private server-side configuration only.

## Install into a separate DSH profile (PowerShell)

Run from the WAKIL repository root, with DSH installed and WAKIL configured. This creates a separate profile based on the shipped Web profile; it does not overwrite your existing profile.

    dsh --profile wakil --from-default-profile web

If this command starts the web app, stop it with Ctrl+C after profile creation. Then install the local bundle:

    dsh plugin --profile wakil add .\dsh-wakil-bundle

Start the WAKIL profile with the same bridge token as the WAKIL server. To avoid storing the token in PowerShell command history, read it interactively:

    $secure = Read-Host 'WAKIL bridge token' -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
      $env:WAKIL_DSH_BRIDGE_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
      $env:WAKIL_DSH_BASE_URL = 'http://127.0.0.1:3000'
      dsh --profile wakil
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
      Remove-Item Env:WAKIL_DSH_BRIDGE_TOKEN -ErrorAction SilentlyContinue
    }

Use HTTPS for a remote WAKIL origin. Plain HTTP is accepted by the plugin only for loopback addresses. Never copy the token into this README or a committed profile patch.

If your installation exposes Creator Mode, it can author/install the bundle while developing, but the shop owner should use the dedicated wakil profile as the daily runtime.

## Allowed bridge actions

- overview — read business/ledger summary.
- catalog — search recorded inventory and prices.
- parties — read customers or suppliers.
- pending_operations — list awaiting-approval drafts.
- prepare_draft — write a pending draft only.

The API has no implementation for approve, execute, confirm, reject or delete actions. Money arguments are in EGP with up to two decimal places; the server converts to integer piastres and the domain executor validates the payload. For catalog-based sale/purchase drafts, pass item IDs obtained from the catalog and never invent unknown prices or stock.
For sales, purchases and memberships, explicitly provide `paidEgp`, including `0` when nothing has been paid. An omitted payment amount is rejected; the tool must ask whether the operation is cash, credit or a partial payment rather than assuming it is fully paid.

## Verification boundary

This repository contains the bundle source and bridge tests. It does not silently install into a user's local DSH profile. Final UI/runtime smoke testing still has to be done against the exact DSH version installed on the target Windows machine, with synthetic data, before any real owner data is connected.
