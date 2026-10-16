// وكيل — shared row→DTO serializers for read API routes.
// Converts Prisma rows to the DTO contracts in src/lib/types.ts, parsing the
// JSON-string columns (Operation.payload/result, Message.card/cards/thinking,
// ScheduledTask.fields) into real objects. Dates become ISO strings.
import type {
  ActionCardDTO,
  CustomerDTO,
  ItemDTO,
  MemoryDTO,
  MessageDTO,
  OpStatus,
  OpType,
  OperationDTO,
  ResultCardDTO,
  Risk,
  ScheduledTaskDTO,
  SupplierDTO,
  ThinkingStep,
} from '@/lib/types'
import type {
  AgentMemory,
  Customer,
  Item,
  Message,
  Operation,
  ScheduledTask,
  Supplier,
} from '@prisma/client'
import { daysFromTodayCairo } from './dates'

/** Safely parse a JSON-string column; returns the fallback for null/empty/invalid. */
export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null || raw === '') return fallback
  try {
    const parsed = JSON.parse(raw) as T | null
    return parsed === null ? fallback : parsed
  } catch {
    return fallback
  }
}

/** Operation row → OperationDTO (payload/result parsed from JSON strings). */
export function serializeOp(op: Operation, userName?: string): OperationDTO {
  return {
    id: op.id,
    ref: op.ref,
    type: op.type as OpType,
    status: op.status as OpStatus,
    source: op.source,
    risk: op.risk as Risk,
    summary: op.summary,
    payload: parseJson<Record<string, unknown>>(op.payload, {}),
    result: op.result ? parseJson<Record<string, unknown> | null>(op.result, null) : null,
    userId: op.userId,
    userName,
    reason: op.reason,
    failReason: op.failReason,
    createdAt: op.createdAt.toISOString(),
    executedAt: op.executedAt ? op.executedAt.toISOString() : null,
    decidedAt: op.decidedAt ? op.decidedAt.toISOString() : null,
    reversalOfRef: op.reversalOfRef,
    reversedByRef: op.reversedByRef,
  }
}

/** Item row → ItemDTO with daysToExpiry (Cairo calendar days) and valueAtCost. */
export function serializeItem(item: Item): ItemDTO {
  return {
    id: item.id,
    name: item.name,
    aliases: item.aliases,
    unit: item.unit,
    category: item.category,
    costPrice: item.costPrice,
    sellPrice: item.sellPrice,
    stockQty: item.stockQty,
    lowStockThreshold: item.lowStockThreshold,
    batchNo: item.batchNo,
    expiresAt: item.expiresAt ? item.expiresAt.toISOString() : null,
    daysToExpiry: item.expiresAt ? daysFromTodayCairo(item.expiresAt) : null,
    valueAtCost: item.stockQty * item.costPrice,
  }
}

/** Customer row → CustomerDTO with daysLeft on membership expiry (gym). */
export function serializeCustomer(c: Customer): CustomerDTO {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    balance: c.balance,
    plan: c.plan,
    expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
    daysLeft: c.expiresAt ? daysFromTodayCairo(c.expiresAt) : null,
  }
}

/** Supplier row → SupplierDTO. */
export function serializeSupplier(s: Supplier): SupplierDTO {
  return {
    id: s.id,
    name: s.name,
    phone: s.phone,
    balance: s.balance,
  }
}

/** ScheduledTask row → ScheduledTaskDTO (fields JSON parsed). */
export function serializeTask(t: ScheduledTask): ScheduledTaskDTO {
  return {
    id: t.id,
    title: t.title,
    tool: t.tool,
    fields: parseJson<Record<string, unknown>>(t.fields, {}),
    whenLabel: t.whenLabel,
    scheduledFor: t.scheduledFor.toISOString(),
    recurrence: t.recurrence,
    status: t.status as ScheduledTaskDTO['status'],
    result: t.result,
    failReason: t.failReason,
    executedAt: t.executedAt ? t.executedAt.toISOString() : null,
    createdAt: t.createdAt.toISOString(),
  }
}

/** AgentMemory row → MemoryDTO. */
export function serializeMemory(m: AgentMemory): MemoryDTO {
  return {
    id: m.id,
    kind: m.kind as MemoryDTO['kind'],
    category: m.category ?? 'general',
    text: m.text,
    entityRef: m.entityRef ?? null,
    confidence: m.confidence ?? 80,
    usageCount: m.usageCount ?? 0,
    active: m.active ?? true,
    createdAt: m.createdAt.toISOString(),
    updatedAt: (m.updatedAt ?? m.createdAt).toISOString(),
  }
}

/** Message row → MessageDTO (card/cards/thinking parsed from JSON strings). */
export function serializeMessage(m: Message): MessageDTO {
  return {
    id: m.id,
    role: m.role as MessageDTO['role'],
    text: m.text,
    card: m.card ? parseJson<ActionCardDTO | null>(m.card, null) : null,
    cards: m.cards ? parseJson<ResultCardDTO[] | null>(m.cards, null) : null,
    thinking: m.thinking ? parseJson<ThinkingStep[] | null>(m.thinking, null) : null,
    modelLabel: m.modelLabel,
    createdAt: m.createdAt.toISOString(),
  }
}

/** userId → name lookup map for joining userName onto operations. */
export function userNameMap(users: { id: string; name: string }[]): Map<string, string> {
  return new Map(users.map((u) => [u.id, u.name]))
}

/** Read the integer-piastres `total` out of an Operation payload JSON string. */
export function payloadTotalPiastres(payload: string | null | undefined): number {
  const p = parseJson<Record<string, unknown>>(payload, {})
  const total = p.total
  return typeof total === 'number' && Number.isFinite(total) ? Math.round(total) : 0
}
