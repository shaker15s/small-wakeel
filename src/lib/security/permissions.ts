// Backend capabilities, not model/UI decisions. Unknown roles fail closed.
import { db } from '@/lib/db'
import type { Prisma, User } from '@prisma/client'

export const PERMISSIONS = [
  'catalog.manage', 'data.export', 'memory.manage', 'tools.manage',
  'automation.manage', 'business.configure', 'workspace.personalize',
] as const
export type Permission = (typeof PERMISSIONS)[number]

const CAPABILITIES: Record<Permission, readonly string[]> = {
  'workspace.personalize': ['owner', 'supervisor', 'cashier', 'reception'],
  'catalog.manage': ['owner', 'supervisor'],
  'data.export': ['owner'],
  'memory.manage': ['owner', 'supervisor'],
  'tools.manage': ['owner', 'supervisor'],
  'automation.manage': ['owner', 'supervisor'],
  'business.configure': ['owner', 'supervisor'],
}

export class AuthorizationError extends Error {
  readonly status = 403
  constructor() { super('صلاحيتك مش بتسمح بالإجراء ده'); this.name = 'AuthorizationError' }
}

export function canUsePermission(role: string, permission: Permission): boolean {
  return CAPABILITIES[permission]?.includes(role) ?? false
}

async function businessActor(businessId: string, userId: string, client: Prisma.TransactionClient) {
  const user = await client.user.findFirst({ where: { id: userId, businessId } })
  if (!user) throw new AuthorizationError()
  const membership = await client.membership.findUnique({ where: { userId }, include: { account: true } })
  if (membership && (membership.disabledAt || membership.account.disabledAt)) throw new AuthorizationError()
  return { user, membership }
}

/** Read-only snapshots remain available after a trial expires. Disabled actors
 * never regain access, and this helper grants NO mutation permission. */
export async function requireBusinessReader(
  businessId: string, userId: string, client: Prisma.TransactionClient = db,
): Promise<User> {
  return (await businessActor(businessId, userId, client)).user
}

/** Recheck live membership, verification and subscription at every write boundary. */
export async function requireBusinessUser(
  businessId: string, userId: string, client: Prisma.TransactionClient = db,
): Promise<User> {
  const { user, membership } = await businessActor(businessId, userId, client)
  if (membership) {
    if (!membership.account.verifiedAt) throw new AuthorizationError()
    const sub = await client.subscription.findUnique({ where: { businessId } })
    if (!sub || !(sub.status === 'active' || (sub.status === 'trialing' && sub.trialEndsAt > new Date()))) throw new AuthorizationError()
  }
  return user
}

export async function requirePermission(
  businessId: string, userId: string, permission: Permission, client: Prisma.TransactionClient = db,
): Promise<User> {
  const user = await requireBusinessUser(businessId, userId, client)
  if (!canUsePermission(user.role, permission)) throw new AuthorizationError()
  return user
}
