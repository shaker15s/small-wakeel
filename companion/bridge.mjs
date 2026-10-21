#!/usr/bin/env node
/**
 * وكيل — Companion bridge CLI (PR-011 / plan v2 §10, P6).
 *
 * Runs on the owner's machine (Windows in production — cross-platform Node).
 * OUTBOUND only: it polls the server over HTTPS and opens no inbound port.
 *
 *   node companion/bridge.mjs \
 *     --server https://app.example.com \
 *     --token <DEVICE_TOKEN> \
 *     --device <DEVICE_ID> \
 *     --allowlist allowlist.json
 *
 * allowlist.json: { "paths": ["/data/invoices"], "cli": [{ "command": "/opt/tools/report.exe", "label": "تقرير" }] }
 *
 * The token is the device secret: on Windows it belongs in Credential
 * Manager/DPAPI (production packaging); in dev it may be passed via env
 * WAKIL_COMPANION_TOKEN to keep it out of the process list. This file holds
 * NO logic — all execution policy lives in bridge-core.mjs (tested).
 */
import { bridgePollOnce } from './bridge-core.mjs'
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
function arg(name) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : null
}

const server = arg('server') ?? process.env.WAKIL_COMPANION_SERVER
const device = arg('device') ?? process.env.WAKIL_COMPANION_DEVICE
const token = arg('token') ?? process.env.WAKIL_COMPANION_TOKEN
const allowlistPath = arg('allowlist')

if (!server || !device || !token) {
  console.error('Usage: node companion/bridge.mjs --server <url> --device <id> --token <token> [--allowlist <json-file>]')
  console.error('(or WAKIL_COMPANION_SERVER / WAKIL_COMPANION_DEVICE / WAKIL_COMPANION_TOKEN env vars)')
  process.exit(2)
}
if (!/^https?:\/\//.test(server)) {
  console.error('The server URL must be http(s) — outbound connection only.')
  process.exit(2)
}

const allowlist = allowlistPath
  ? JSON.parse(readFileSync(allowlistPath, 'utf8'))
  : { paths: [], cli: [] }

const intervalMs = Math.max(2000, Number(process.env.WAKIL_COMPANION_POLL_MS) || 5000)
console.log(`[companion] bridge started — device=${device} server=${server} poll=${intervalMs}ms`)
console.log('[companion] read-only mode: files/dirs/CLI per allowlist; no write tools exist.')

let stopped = false
const stop = () => {
  stopped = true
  console.log('[companion] stopping…')
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

for (;;) {
  if (stopped) break
  try {
    const out = await bridgePollOnce(server, token, device, allowlist)
    if (out.claimed) {
      console.log(
        out.executed
          ? `[companion] job ${out.jobId ?? out.evidence?.jobId ?? ''} delivered (hash=${String(out.evidence?.hash ?? '').slice(0, 12)}…)`
          : `[companion] job refused locally: ${out.reason}`,
      )
    }
    if (out.status === 403) {
      console.error('[companion] device revoked or auth failed — stopping. No jobs will be claimed.')
      process.exit(1)
    }
  } catch (e) {
    // network hiccup — log and keep polling; never crash the bridge
    console.warn('[companion] poll error:', e?.message ?? e)
  }
  await new Promise((r) => setTimeout(r, intervalMs))
}
