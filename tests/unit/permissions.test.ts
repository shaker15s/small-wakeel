import { describe, expect, test } from 'bun:test'
import { canUsePermission, PERMISSIONS } from '@/lib/security/permissions'
import { canApprove, canApproveOperation } from '@/lib/domain/risk'

describe('backend capabilities', () => {
  test('owner has all management capabilities; supervisor cannot bulk export', () => {
    for (const permission of PERMISSIONS) {
      expect(canUsePermission('owner', permission)).toBe(true)
      expect(canUsePermission('supervisor', permission)).toBe(permission !== 'data.export')
    }
  })
  test('cashier, reception and unknown roles cannot perform management mutations', () => {
    for (const role of ['cashier', 'reception', 'manager', 'admin', '', 'OWNER']) {
      for (const permission of PERMISSIONS) expect(canUsePermission(role, permission)).toBe(permission === 'workspace.personalize' && ['cashier', 'reception'].includes(role))
    }
  })
  test('formal state changes require owner approval by default, for all write roles', () => {
    const previousStrict = process.env.WAKIL_STRICT_APPROVALS
    const previousDelegation = process.env.WAKIL_ALLOW_DELEGATED_APPROVALS
    delete process.env.WAKIL_STRICT_APPROVALS
    delete process.env.WAKIL_ALLOW_DELEGATED_APPROVALS
    try {
      expect(canApproveOperation('owner', 'sale', 'R2')).toBe(true)
      expect(canApproveOperation('owner', 'expense', 'R3')).toBe(true)
      expect(canApproveOperation('supervisor', 'sale', 'R2')).toBe(false)
      expect(canApproveOperation('supervisor', 'stock_adjustment', 'R3')).toBe(false)
      expect(canApproveOperation('cashier', 'sale', 'R2')).toBe(false)
      expect(canApproveOperation('reception', 'membership', 'R2')).toBe(false)
      expect(canApproveOperation('owner', 'expense', 'R4')).toBe(false)
      expect(canApprove('cashier', 'R2')).toBe(false)
    } finally {
      if (previousStrict === undefined) delete process.env.WAKIL_STRICT_APPROVALS
      else process.env.WAKIL_STRICT_APPROVALS = previousStrict
      if (previousDelegation === undefined) delete process.env.WAKIL_ALLOW_DELEGATED_APPROVALS
      else process.env.WAKIL_ALLOW_DELEGATED_APPROVALS = previousDelegation
    }
  })

  test('supervisor delegation is explicit, bounded to R1/R2, and strict mode overrides it', () => {
    const previousStrict = process.env.WAKIL_STRICT_APPROVALS
    const previousDelegation = process.env.WAKIL_ALLOW_DELEGATED_APPROVALS
    delete process.env.WAKIL_STRICT_APPROVALS
    process.env.WAKIL_ALLOW_DELEGATED_APPROVALS = '1'
    try {
      expect(canApproveOperation('supervisor', 'sale', 'R2')).toBe(true)
      expect(canApproveOperation('supervisor', 'attendance', 'R1')).toBe(true)
      expect(canApproveOperation('supervisor', 'stock_adjustment', 'R3')).toBe(false)
      expect(canApproveOperation('cashier', 'sale', 'R2')).toBe(false)
      expect(canApproveOperation('reception', 'membership', 'R2')).toBe(false)
      process.env.WAKIL_STRICT_APPROVALS = '1'
      expect(canApproveOperation('supervisor', 'sale', 'R2')).toBe(false)
      expect(canApproveOperation('owner', 'sale', 'R2')).toBe(true)
    } finally {
      if (previousStrict === undefined) delete process.env.WAKIL_STRICT_APPROVALS
      else process.env.WAKIL_STRICT_APPROVALS = previousStrict
      if (previousDelegation === undefined) delete process.env.WAKIL_ALLOW_DELEGATED_APPROVALS
      else process.env.WAKIL_ALLOW_DELEGATED_APPROVALS = previousDelegation
    }
  })

  test('risk alone never grants permission for a different operation type', () => {
    expect(canApproveOperation('cashier', 'expense', 'R2')).toBe(false)
    expect(canApproveOperation('cashier', 'sale', 'R2')).toBe(false)
    expect(canApproveOperation('reception', 'purchase', 'R2')).toBe(false)
    expect(canApproveOperation('cashier', 'reversal', 'R3')).toBe(false)
    expect(canApproveOperation('owner', 'expense', 'R4')).toBe(false)
  })
})
