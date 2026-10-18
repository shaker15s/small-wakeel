import { db } from '@/lib/db'
import { requirePermission } from '@/lib/security/permissions'
import { OperationValidationError } from './errors'
export async function setWorkflow(businessId: string, userId: string, mode: unknown) {
  if (mode !== 'cashbook' && mode !== 'inventory') throw new OperationValidationError('وضع تشغيل غير صالح')
  return db.$transaction(async tx => {
    await requirePermission(businessId, userId, 'business.configure', tx)
    await tx.business.update({ where: { id: businessId }, data: { workflowMode: mode } })
    await tx.auditEvent.create({ data: { businessId, actor: userId, action: 'business.workflow', ref: businessId, detail: JSON.stringify({ mode }) } })
    return { mode }
  })
}
