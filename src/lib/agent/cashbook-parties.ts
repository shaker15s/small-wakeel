import type { Prisma } from '@prisma/client'
import { normalizeAr, toWesternDigits } from './arabic'
import { egp } from '@/lib/format'
import type { CashbookKind } from '@/lib/domain/cashbook'
import type { ChatActionDTO } from '@/lib/types'

export interface PartyChoice { id: string; name: string; side: 'customer' | 'supplier'; phone: string | null; balance: number }
export function partySide(kind: CashbookKind): 'customer' | 'supplier' | null {
  return ['credit_sale', 'lend', 'receive'].includes(kind) ? 'customer' : ['credit_purchase', 'cash_purchase', 'borrow', 'pay'].includes(kind) ? 'supplier' : null
}
export async function matchingParties(tx: Prisma.TransactionClient, businessId: string, name: string, side?: 'customer' | 'supplier'): Promise<PartyChoice[]> {
  const canonical = normalizeAr(name)
  const columns = { id: true, name: true, phone: true, balance: true } as const
  const [customers, suppliers] = await Promise.all([
    side === 'supplier' ? [] : tx.customer.findMany({ where: { businessId }, select: columns, orderBy: { id: 'asc' } }),
    side === 'customer' ? [] : tx.supplier.findMany({ where: { businessId }, select: columns, orderBy: { id: 'asc' } }),
  ])
  return [...customers.filter(p => normalizeAr(p.name) === canonical).map(p => ({ ...p, side: 'customer' as const })), ...suppliers.filter(p => normalizeAr(p.name) === canonical).map(p => ({ ...p, side: 'supplier' as const }))]
}
export function describeParties(parties: PartyChoice[]) {
  return parties.map((p, i) => `${i + 1}. ${p.side === 'customer' ? 'عميل' : 'مورد'} · ${p.name} · ${p.phone ? `تليفون ${p.phone}` : `تمييز الحساب ${p.id.slice(-6)}`} · ${egp(p.balance)}`).join('\n')
}
export function answerChoice(text: string, token: string, length: number): { index: number | null; stale: boolean } {
  const t = normalizeAr(toWesternDigits(text)).trim()
  const stamped = t.match(/^اختيار ([a-z0-9-]+) رقم (\d+)$/)
  if (stamped && stamped[1] !== token) return { index: null, stale: true }
  const n = stamped ? Number(stamped[2]) : /^\d+$/.test(t) ? Number(t) : NaN
  return { index: Number.isSafeInteger(n) && n >= 1 && n <= length ? n - 1 : null, stale: false }
}
export function choiceActions(token: string, labels: string[]): ChatActionDTO[] {
  return labels.map((label, i) => ({ id: `choice-${token}-${i}`, label, view: 'chat', reply: `اختيار ${token} رقم ${i + 1}`, tone: 'outline' }))
}
export async function reloadParty(tx: Prisma.TransactionClient, businessId: string, choice: PartyChoice) {
  return choice.side === 'customer' ? tx.customer.findFirst({ where: { businessId, id: choice.id } }) : tx.supplier.findFirst({ where: { businessId, id: choice.id } })
}
