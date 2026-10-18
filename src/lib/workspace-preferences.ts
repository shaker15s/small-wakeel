import { db } from '@/lib/db'
import { AuthorizationError, requirePermission } from '@/lib/security/permissions'
import { DEFAULT_WORKSPACE, preferencePatchSchema, type WorkspacePreferences } from './workspace-options'
export async function getWorkspacePreferences(businessId: string, userId: string): Promise<WorkspacePreferences> {
  if (!await db.user.findFirst({ where: { id: userId, businessId }, select: { id: true } })) throw new AuthorizationError()
  const row = await db.workspacePreference.findUnique({ where: { businessId_userId: { businessId, userId } } })
  const parsed = preferencePatchSchema.safeParse(row ? JSON.parse(row.config) : {})
  return { ...DEFAULT_WORKSPACE, ...(parsed.success ? parsed.data : {}) }
}
export async function updateWorkspacePreferences(businessId: string, userId: string, input: unknown): Promise<WorkspacePreferences> {
  const patch = preferencePatchSchema.parse(input)
  return db.$transaction(async (tx) => {
    await requirePermission(businessId, userId, 'workspace.personalize', tx)
    const row = await tx.workspacePreference.findUnique({ where: { businessId_userId: { businessId, userId } } })
    const previous = preferencePatchSchema.parse(row ? JSON.parse(row.config) : {})
    const next = { ...DEFAULT_WORKSPACE, ...previous, ...patch }
    await tx.workspacePreference.upsert({ where: { businessId_userId: { businessId, userId } }, create: { businessId, userId, config: JSON.stringify(next) }, update: { config: JSON.stringify(next) } })
    await tx.auditEvent.create({ data: { businessId, actor: userId, action: 'workspace.personalized', detail: JSON.stringify({ fields: Object.keys(patch) }) } })
    return next
  })
}
