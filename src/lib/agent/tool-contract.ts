// R72 / PR-004 — الخطة النهائية v2 §20.3: «عقد أداة واحد» (central tool contract).
//
// The model's tool call is DATA, never AUTHORITY. Server-side, BEFORE any
// dispatch:
//   • a tool name that is not in the registry → refused (no silent pass);
//   • args must be a plain object;
//   • authority fields may never originate in model output — an `approved`
//     flag, a self-declared `risk` class, a `tenantId`/`businessId`/`userId`,
//     an operation `id`/`ref` the model invented, or a self-reported `ok` /
//     `status` / `not_connected` is REFUSED, not stripped and not downgraded.
//     Tenant + identity are injected by the server from the authenticated
//     session; risk and approval state are computed server-side.
// A field that the tool's OWN schema declares (e.g. `ref` on
// get_transaction_status) is legal — the registry is the single source of
// truth, so the gate never fights the catalog.

import { TOOL_NAME_SET, declaredToolParams } from './tool-schemas'

/** Authority fields a model must never put in tool input. */
export const FORBIDDEN_MODEL_INPUT_KEYS: ReadonlySet<string> = new Set<string>([
  // approval authority
  'approved', 'approve', 'approval', 'approver', 'approvedBy',
  // risk authority (the model may not lower/raise RiskClass)
  'risk', 'riskClass', 'risk_class', 'riskLevel',
  // tenant / identity (injected by the server from the authenticated session)
  'tenantId', 'tenant_id', 'businessId', 'business_id', 'userId', 'user_id',
  // operation identity (the model may not target or forge a specific op;
  // the only legal `ref` input is the one get_transaction_status declares)
  'ref', 'operationId', 'operation_id', 'opId', 'idempotencyKey', 'idempotency_key',
  // outcome self-reporting (results are computed server-side)
  'status', 'outcome', 'ok', 'not_connected', 'connectionStatus',
])

export type ToolContractReason = 'unregistered' | 'args-not-object' | 'forbidden-input'

export interface ToolContractVerdict {
  ok: boolean
  reason?: ToolContractReason
  smuggled?: string[]
}

/** Verify ONE model-issued tool call against the central contract. Pure. */
export function verifyToolContract(tool: string, args: unknown): ToolContractVerdict {
  if (typeof tool !== 'string' || !TOOL_NAME_SET.has(tool)) {
    return { ok: false, reason: 'unregistered' }
  }
  if (args != null && (typeof args !== 'object' || Array.isArray(args))) {
    return { ok: false, reason: 'args-not-object' }
  }
  const a = (args ?? {}) as Record<string, unknown>
  const declared = declaredToolParams(tool)
  const smuggled = Object.keys(a).filter((k) => FORBIDDEN_MODEL_INPUT_KEYS.has(k) && !declared.has(k))
  if (smuggled.length > 0) return { ok: false, reason: 'forbidden-input', smuggled }
  return { ok: true }
}
