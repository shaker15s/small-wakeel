// R71 / PR-003 — الخطة النهائية v2 §20.4: approval is bound to the payload.
//
// `payload_hash` is computed from a CANONICAL serialization of the draft
// payload — recursively key-sorted JSON, NOT a non-deterministic JSON string
// (plan §20.4). Array ORDER is preserved (sale/purchase lines are ordered
// facts); object KEY order is not.
//
// The hash is stored when the draft is created and recomputed from the STORED
// payload at approval time: if the two differ, the draft changed after it was
// recorded and the approval is refused (the owner redrafts).
import { createHash } from 'node:crypto'

/** Recursively sort plain-object keys (arrays keep their order). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(src).sort()) {
      const v = src[k]
      if (v !== undefined) out[k] = canonicalize(v)
    }
    return out
  }
  return value
}

/** Stable string form of a payload object. */
export function canonicalPayload(payload: unknown): string {
  return JSON.stringify(canonicalize(payload ?? null))
}

/** sha256 hex of the canonical payload — the value stored on Operation. */
export function canonicalPayloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalPayload(payload)).digest('hex')
}
