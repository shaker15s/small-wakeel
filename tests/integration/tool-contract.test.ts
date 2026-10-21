// R72 / PR-004 — الخطة النهائية v2 §20.3: «عقد أداة واحد».
//
// Gates accepted here:
//   • every UNREGISTERED tool name is refused;
//   • authority fields may never originate in model output (approved, risk,
//     tenant/identity ids, self-reported outcome flags) — refused, not stripped;
//   • a field the tool's own schema declares stays legal (registry = truth);
//   • a not_connected result is NEVER ok: true.
import { describe, expect, test } from 'bun:test'
import {
  FORBIDDEN_MODEL_INPUT_KEYS,
  verifyToolContract,
} from '@/lib/agent/tool-contract'
import { TOOL_NAME_SET } from '@/lib/agent/tool-schemas'
import { executeBridgedTool } from '@/lib/agent/cli-anything/bridge'

describe('central tool contract — registry', () => {
  test('every registered tool passes with clean args', async () => {
    // sample across the registry: reads, writes, mind, system
    for (const tool of ['get_daily_summary', 'record_sale', 'memory_save', 'set_persona']) {
      expect(TOOL_NAME_SET.has(tool)).toBe(true)
      const v = verifyToolContract(tool, {})
      expect(v.ok, tool).toBe(true)
    }
  })

  test('an unregistered tool name is refused', () => {
    expect(verifyToolContract('transfer_all_cash', { amount: 1 }).ok).toBe(false)
    expect(verifyToolContract('record_sale_evil', { name: 'x', qty: 1 }).reason).toBe('unregistered')
    expect(verifyToolContract('', {}).ok).toBe(false)
    expect(verifyToolContract('get_daily_summary', {}).ok).toBe(true) // contrast
  })

  test('args must be a plain object', () => {
    expect(verifyToolContract('get_daily_summary', ['period']).ok).toBe(false)
    expect(verifyToolContract('get_daily_summary', 'period=week').reason).toBe('args-not-object')
    expect(verifyToolContract('get_daily_summary', null).ok).toBe(true) // absent args are fine
  })
})

describe('central tool contract — model output is data, never authority', () => {
  test('the model cannot pass approved/approve in input', () => {
    const v = verifyToolContract('record_sale', { name: 'لبن', qty: 2, approved: true })
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('forbidden-input')
    expect(v.smuggled).toContain('approved')
    // the refusal survives nested-looking keys too
    expect(FORBIDDEN_MODEL_INPUT_KEYS.has('approver')).toBe(true)
  })

  test('the model cannot lower or raise RiskClass', () => {
    const v = verifyToolContract('record_purchase', { name: 'سكر', qty: 5, risk: 'R0_READ' })
    expect(v.ok).toBe(false)
    expect(v.smuggled).toContain('risk')
    expect(verifyToolContract('record_purchase', { name: 'سكر', qty: 5, riskClass: 'R0_READ' }).ok).toBe(false)
  })

  test('the model cannot forge tenant / identity fields', () => {
    for (const k of ['tenantId', 'tenant_id', 'businessId', 'business_id', 'userId', 'user_id']) {
      const v = verifyToolContract('get_cash_position', { [k]: 'cmvav3psg000iorbm9e9y9hb8' })
      expect(v.ok, k).toBe(false)
      expect(v.smuggled, k).toContain(k)
    }
  })

  test('the model cannot self-report outcomes', () => {
    for (const k of ['ok', 'status', 'outcome', 'not_connected', 'connectionStatus']) {
      expect(verifyToolContract('get_cash_position', { [k]: 'true' }).ok, k).toBe(false)
    }
    // and cannot target a specific operation by id
    expect(verifyToolContract('get_activity_history', { operationId: 'WKL-1' }).ok).toBe(false)
    expect(verifyToolContract('get_activity_history', { idempotencyKey: 'k' }).ok).toBe(false)
  })

  test('a field the tool schema declares stays legal; the same field elsewhere is refused', () => {
    // `ref` is a declared parameter of get_transaction_status…
    expect(verifyToolContract('get_transaction_status', { ref: 'WKL-1234' }).ok).toBe(true)
    // …but it is NOT a parameter of record_sale
    expect(verifyToolContract('record_sale', { name: 'لبن', qty: 2, ref: 'WKL-9' }).ok).toBe(false)
  })

  test('legal business args are never touched', () => {
    const v = verifyToolContract('record_sale', {
      name: 'لبن ١ لتر', qty: 2, price: 35, paid: 35, customer: 'عميل ١',
    })
    expect(v.ok).toBe(true)
    expect(verifyToolContract('search_catalog', { query: 'سكّر' }).ok).toBe(true)
    expect(verifyToolContract('get_period_totals', { days: 7, yesterday: true }).ok).toBe(true)
  })
})

describe('not_connected is never ok: true', () => {
  test('the CLI bridge reports not_connected with ok:false (no device)', async () => {
    const res = await executeBridgedTool({ appName: 'nonexistent-app-xyz-٩٩', command: 'check_status' })
    expect(res.ok).toBe(false)
    expect(res.status ?? res.error).toBe('not_connected')
  })
})
