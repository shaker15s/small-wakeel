import { db } from '@/lib/db'
import { SaasError } from './crypto'
export const quotaKey = (businessId: string) => `${businessId}:${new Date().toISOString().slice(0, 10)}`
/** Counts chat HTTP attempts, including retries, not payments/provider tokens.
 * A DB transaction enforces the shared daily cap across server processes.
 */
export async function consumeChatQuota(businessId: string) {
  return db.$transaction(async (tx) => {
    const sub = await tx.subscription.findUnique({ where: { businessId } })
    if (!sub || !(sub.status === 'active' || (sub.status === 'trialing' && sub.trialEndsAt > new Date()))) throw new SaasError('اشتراك المنشأة غير نشط', 402)
    const id = quotaKey(businessId)
    const current = await tx.quotaBucket.findUnique({ where: { id } })
    if ((current?.used ?? 0) >= sub.dailyChatLimit) throw new SaasError('وصلت لحد طلبات الوكيل اليومي؛ القراءة والتصدير ما زالا متاحين', 429, 'daily_quota')
    await tx.quotaBucket.upsert({ where: { id }, create: { id, used: 1 }, update: { used: { increment: 1 } } })
  })
}
