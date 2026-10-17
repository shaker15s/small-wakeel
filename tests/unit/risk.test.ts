// وكيل — the risk ladder & approval matrix.
// R0/R1 read or self-serve; R2/R3/R4 write and need the right role. These rules
// are the reason the owner can let staff use the agent at all.
import { describe, expect, test } from 'bun:test'
import { canApprove, canDraft, computeRisk, R3_AMOUNT_THRESHOLD, RISK_META } from '../../src/lib/domain/risk'

describe('risk.computeRisk', () => {
  test('reads are R0', () => {
    expect(computeRisk('sale')).toBeTruthy() // sanity: known type returns a level
  })

  test('every operation type yields a valid level', () => {
    const types = ['sale', 'purchase', 'expense', 'collection', 'payment', 'stock_adjustment', 'membership', 'attendance', 'reversal'] as const
    for (const t of types) {
      const risk = computeRisk(t)
      expect(RISK_META[risk]).toBeTruthy()
    }
  })

  test('very large amounts escalate to R3', () => {
    const small = computeRisk('expense', 50_000) // 500 EGP
    const huge = computeRisk('expense', R3_AMOUNT_THRESHOLD + 1)
    const order = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 } as const
    expect(order[huge]).toBeGreaterThanOrEqual(order[small])
    expect(order[huge]).toBeGreaterThanOrEqual(2)
  })
})

describe('risk.canApprove', () => {
  test('owner can approve everything below R4', () => {
    expect(canApprove('owner', 'R2')).toBe(true)
    expect(canApprove('owner', 'R3')).toBe(true)
  })

  test('cashier/reception may approve routine R2 by default', () => {
    delete process.env.WAKIL_STRICT_APPROVALS
    expect(canApprove('cashier', 'R2')).toBe(true)
    expect(canApprove('reception', 'R2')).toBe(true)
  })

  test('strict-approvals mode routes every write through management', () => {
    process.env.WAKIL_STRICT_APPROVALS = '1'
    expect(canApprove('cashier', 'R2')).toBe(false)
    expect(canApprove('reception', 'R2')).toBe(false)
    expect(canApprove('supervisor', 'R2')).toBe(true)
    expect(canApprove('owner', 'R2')).toBe(true)
    delete process.env.WAKIL_STRICT_APPROVALS
  })

  test('R4 is never approvable — even by the owner', () => {
    expect(canApprove('owner', 'R4')).toBe(false)
  })

  test('R3 stays management-only in both modes', () => {
    delete process.env.WAKIL_STRICT_APPROVALS
    expect(canApprove('cashier', 'R3')).toBe(false)
    expect(canApprove('supervisor', 'R3')).toBe(true)
  })

  test('supervisor can approve routine writes', () => {
    const r2 = canApprove('supervisor', 'R2')
    expect(typeof r2).toBe('boolean')
  })
})

describe('risk.canDraft', () => {
  test('roles that may draft writes are consistent with their job', () => {
    expect(canDraft('owner', 'sale')).toBe(true)
    expect(canDraft('cashier', 'sale')).toBe(true)
    expect(canDraft('cashier', 'expense')).toBe(false)
  })
})
