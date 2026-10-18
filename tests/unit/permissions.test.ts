import { describe, expect, test } from 'bun:test'
import { canUsePermission, PERMISSIONS } from '@/lib/security/permissions'
import { canApproveOperation } from '@/lib/domain/risk'

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
  test('risk alone never grants permission for a different operation type', () => {
    expect(canApproveOperation('cashier', 'expense', 'R2')).toBe(false)
    expect(canApproveOperation('reception', 'purchase', 'R2')).toBe(false)
    expect(canApproveOperation('cashier', 'reversal', 'R3')).toBe(false)
    expect(canApproveOperation('owner', 'expense', 'R4')).toBe(false)
  })
})
