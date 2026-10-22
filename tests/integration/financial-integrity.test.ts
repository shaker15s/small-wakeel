import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Business, User } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { testDb } from '../helpers/test-db'
import { createDraft, executeOperation, rejectOperation } from '@/lib/domain/executors'
import { AuthorizationError } from '@/lib/security/permissions'
import { OperationValidationError } from '@/lib/domain/errors'
import { runAgentTurn } from '@/lib/agent/harness'

let db: Awaited<ReturnType<typeof testDb>>
let business: Business
let foreign: Business
let owner: User
let cashier: User
let outsider: User
const key = () => `financial-test-${randomUUID()}`
async function item(businessId = business.id, stockQty = 10, sellPrice = 100) {
  return db.item.create({ data: { businessId, name: key(), unit: 'piece', stockQty, sellPrice, costPrice: 50 } })
}
async function expense(total = 100) {
  return createDraft({ businessId: business.id, userId: owner.id, type: 'expense', summary: key(), payload: { total }, idempotencyKey: key() })
}
async function sale(stockQty = 10, qty = 2) {
  const it = await item(business.id, stockQty)
  const op = await createDraft({ businessId: business.id, userId: owner.id, type: 'sale', summary: key(), payload: {
    itemId: it.id, qty, total: qty * (it.sellPrice ?? 0),
  }, idempotencyKey: key() })
  return { it, op }
}
async function cashRows(ref: string) { return db.cashEntry.count({ where: { businessId: business.id, ref } }) }
beforeAll(async () => {
  db = await testDb()
  business = await db.business.create({ data: { name: key(), type: 'supermarket' } })
  foreign = await db.business.create({ data: { name: key(), type: 'supermarket' } })
  owner = await db.user.create({ data: { businessId: business.id, name: 'owner', role: 'owner' } })
  cashier = await db.user.create({ data: { businessId: business.id, name: 'cashier', role: 'cashier' } })
  outsider = await db.user.create({ data: { businessId: foreign.id, name: 'outsider', role: 'owner' } })
})
afterAll(async () => {
  await db.business.deleteMany({ where: { id: { in: [business.id, foreign.id] } } })
})

describe('financial write boundary', () => {
  test('collecting from a known zero-balance customer asks about an advance/loan and creates no draft', async () => {
    const customer = await db.customer.create({
      data: { businessId: business.id, name: `عميل بلا مديونية ${randomUUID().slice(0, 8)}`, balance: 0 },
    })
    const conversation = await db.conversation.create({
      data: { businessId: business.id, userId: owner.id, title: key() },
    })

    const result = await runAgentTurn({
      business,
      user: owner,
      conversationId: conversation.id,
      modelKey: null,
      text: `حصلت من ${customer.name} ١٨٠`,
      history: [],
    }, () => {})

    expect(result.replyText).toMatch(/عربون ولا سلفة/)
    expect(await db.operation.count({ where: { conversationId: conversation.id } })).toBe(0)
    expect((await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).balance).toBe(0)
  })

  test('draft creation checks live membership, type permissions and conversation ownership', async () => {
    const conversation = await db.conversation.create({ data: { businessId: business.id, userId: cashier.id, title: 'private' } })
    const params = { businessId: business.id, userId: owner.id, type: 'expense' as const, summary: key(), payload: { total: 100 }, idempotencyKey: key() }
    await expect(createDraft({ ...params, userId: outsider.id })).rejects.toBeInstanceOf(AuthorizationError)
    await expect(createDraft({ ...params, userId: cashier.id })).rejects.toBeInstanceOf(AuthorizationError)
    await expect(createDraft({ ...params, conversationId: conversation.id })).rejects.toBeInstanceOf(AuthorizationError)
    expect(await db.operation.count({ where: { idempotencyKey: params.idempotencyKey } })).toBe(0)
  })
  test('idempotency cannot disclose another tenant/user or reuse a key for another type', async () => {
    const op = await expense()
    for (const params of [
      { businessId: foreign.id, userId: outsider.id, type: 'expense' as const },
      { businessId: business.id, userId: cashier.id, type: 'sale' as const },
      { businessId: business.id, userId: owner.id, type: 'purchase' as const },
    ]) await expect(createDraft({ ...params, summary: '', payload: {}, idempotencyKey: op.idempotencyKey })).rejects.toBeInstanceOf(AuthorizationError)
  })
  test('concurrent creation with one key produces one draft and one audit', async () => {
    const params = { businessId: business.id, userId: owner.id, type: 'expense' as const, summary: key(), payload: { total: 100 }, idempotencyKey: key() }
    const rows = await Promise.all([createDraft(params), createDraft(params), createDraft(params)])
    expect(new Set(rows.map((op) => op.id)).size).toBe(1)
    expect(await db.auditEvent.count({ where: { ref: rows[0].ref, action: 'operation.drafted' } })).toBe(1)
  })
  test('new businesses can allocate globally unique refs despite equal initial counters', async () => {
    const a = await expense()
    const b = await createDraft({ businessId: foreign.id, userId: outsider.id, type: 'expense', summary: key(), payload: { total: 100 }, idempotencyKey: key() })
    expect(a.ref).not.toBe(b.ref)
    expect(b.ref).toMatch(/^WKL-\d+$/)
  })
  test('caller cannot lower computed risk, and amount/balance risks are not ignored', async () => {
    for (const [type, payload] of [
      ['expense', { total: 1_000_000 }],
      ['collection', { customerId: (await db.customer.create({ data: { businessId: business.id, name: key(), balance: 2_000_000 } })).id, amount: 1_000_000 }],
      ['customer_add', { name: key(), balance: -1_000_000 }],
    ] as const) {
      const op = await createDraft({ businessId: business.id, userId: owner.id, type, summary: key(), payload, risk: 'R1', idempotencyKey: key() })
      expect(op.risk).toBe('R3')
      await expect(executeOperation(op.id, owner.id)).rejects.toBeInstanceOf(OperationValidationError)
      expect((await db.operation.findUniqueOrThrow({ where: { id: op.id } })).status).toBe('AWAITING_APPROVAL')
    }
  })
  test('direct approval/rejection checks both role and tenant without touching reason/status', async () => {
    const op = await expense()
    for (const user of [cashier, outsider]) {
      await expect(executeOperation(op.id, user.id, 'forbidden')).rejects.toBeInstanceOf(AuthorizationError)
      await expect(rejectOperation(op.id, user.id, 'forbidden')).rejects.toBeInstanceOf(AuthorizationError)
    }
    const current = await db.operation.findUniqueOrThrow({ where: { id: op.id } })
    expect(current.status).toBe('AWAITING_APPROVAL')
    expect(current.reason).toBeNull()
    expect(await cashRows(op.ref)).toBe(0)
  })
  test('role changes are read from DB, not a stale turn/user object', async () => {
    const user = await db.user.create({ data: { businessId: business.id, name: key(), role: 'owner' } })
    const op = await createDraft({ businessId: business.id, userId: user.id, type: 'expense', summary: key(), payload: { total: 100 }, idempotencyKey: key() })
    await db.user.update({ where: { id: user.id }, data: { role: 'cashier' } })
    await expect(executeOperation(op.id, user.id)).rejects.toBeInstanceOf(AuthorizationError)
    expect(await cashRows(op.ref)).toBe(0)
  })
  test('every financial party/item reference, including basket lines, is tenant-bound', async () => {
    const local = await item()
    const other = await item(foreign.id)
    const customer = await db.customer.create({ data: { businessId: foreign.id, name: key() } })
    const supplier = await db.supplier.create({ data: { businessId: foreign.id, name: key() } })
    for (const [type, payload] of [
      ['sale', { itemId: other.id, qty: 1, total: 100 }],
      ['purchase', { lines: [{ itemId: other.id, qty: 1 }] }],
      ['sale', { itemId: local.id, qty: 1, total: 100, customerId: customer.id }],
      ['purchase', { itemId: local.id, qty: 1, total: 100, supplierId: supplier.id }],
      ['collection', { customerId: customer.id, amount: 100 }],
      ['payment', { supplierId: supplier.id, amount: 100 }],
      ['membership', { customerId: customer.id, total: 100 }],
      ['attendance', { customerId: customer.id }],
      ['stock_adjustment', { itemId: other.id, delta: 1, reason: 'test' }],
    ] as const) await expect(createDraft({ businessId: business.id, userId: owner.id, type, payload, summary: key(), idempotencyKey: key() })).rejects.toBeInstanceOf(OperationValidationError)
    expect((await db.item.findUniqueOrThrow({ where: { id: other.id } })).stockQty).toBe(10)
  })
  test('invalid quantities, money, duplicate lines and unassigned credit are rejected before drafting', async () => {
    const it = await item()
    for (const override of [
      { qty: 0 }, { qty: -2 }, { qty: 0.5 }, { qty: NaN }, { qty: Infinity },
      { paid: -1 }, { paid: 201 }, { paid: 0 }, { total: NaN }, { total: 1.5 },
      { lines: [{ itemId: it.id, qty: 1 }, { itemId: it.id, qty: 1 }] },
    ]) await expect(createDraft({ businessId: business.id, userId: owner.id, type: 'sale', summary: key(), payload: {
      itemId: it.id, qty: 2, total: 200, ...override,
    }, idempotencyKey: key() })).rejects.toBeInstanceOf(OperationValidationError)
  })
  test('stored drafts are revalidated at execution, not trusted as already safe', async () => {
    const { op, it } = await sale()
    const other = await item(foreign.id)
    await db.operation.update({ where: { id: op.id }, data: { payload: JSON.stringify({ itemId: other.id, qty: 2, total: 200 }) } })
    const result = await executeOperation(op.id, owner.id)
    expect(result.op.status).toBe('FAILED_SAFE')
    expect(result.outcome.ok).toBe(false)
    expect(await cashRows(op.ref)).toBe(0)
    expect((await db.item.findUniqueOrThrow({ where: { id: it.id } })).stockQty).toBe(10)
    expect((await db.item.findUniqueOrThrow({ where: { id: other.id } })).stockQty).toBe(10)
  })
})

describe('atomic financial effects and decisions', () => {
  test('approve versus cancel: one terminal decision, no overwritten execution', async () => {
    for (let i = 0; i < 4; i++) {
      const op = await expense()
      const results = await Promise.allSettled([executeOperation(op.id, owner.id), rejectOperation(op.id, owner.id, 'cancel', 'cancel')])
      expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1)
      const current = await db.operation.findUniqueOrThrow({ where: { id: op.id } })
      expect(['SUCCEEDED', 'CANCELLED']).toContain(current.status)
      expect(await cashRows(op.ref)).toBe(current.status === 'SUCCEEDED' ? 1 : 0)
      expect(await db.auditEvent.count({ where: { ref: op.ref, action: { in: ['operation.succeeded', 'operation.cancelled'] } } })).toBe(1)
    }
  })
  test('different concurrent sales cannot oversell the same stock', async () => {
    const { op, it } = await sale(1, 1)
    const second = await createDraft({ businessId: business.id, userId: owner.id, type: 'sale', summary: key(), payload: JSON.parse(op.payload), idempotencyKey: key() })
    const results = await Promise.all([executeOperation(op.id, owner.id), executeOperation(second.id, owner.id)])
    expect(results.map((r) => r.op.status).sort()).toEqual(['FAILED_SAFE', 'SUCCEEDED'])
    expect((await db.item.findUniqueOrThrow({ where: { id: it.id } })).stockQty).toBe(0)
    expect(await db.cashEntry.count({ where: { ref: { in: [op.ref, second.ref] } } })).toBe(1)
  })
  test('failure writing the success audit rolls back stock AND cash', async () => {
    const { op, it } = await sale()
    const trigger = `audit_fault_${randomUUID().replaceAll('-', '')}`
    await db.$executeRawUnsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON AuditEvent WHEN NEW.ref = '${op.ref}' AND NEW.action = 'operation.succeeded' BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END`)
    try {
      const result = await executeOperation(op.id, owner.id)
      expect(result.op.status).toBe('FAILED_SAFE')
      expect(result.outcome.effects).toEqual([])
      expect(await cashRows(op.ref)).toBe(0)
      expect((await db.item.findUniqueOrThrow({ where: { id: it.id } })).stockQty).toBe(10)
      expect(await db.auditEvent.count({ where: { ref: op.ref, action: 'operation.succeeded' } })).toBe(0)
    } finally { await db.$executeRawUnsafe(`DROP TRIGGER ${trigger}`) }
  })
  test('a failed read-back verification rolls all financial effects back', async () => {
    const { op, it } = await sale()
    const trigger = `verify_fault_${randomUUID().replaceAll('-', '')}`
    await db.$executeRawUnsafe(`CREATE TRIGGER ${trigger} AFTER UPDATE OF stockQty ON Item WHEN NEW.id = '${it.id}' BEGIN UPDATE Item SET stockQty = OLD.stockQty WHERE id = NEW.id; END`)
    try {
      const result = await executeOperation(op.id, owner.id)
      expect(result.op.status).toBe('FAILED_SAFE')
      expect(result.outcome.checks.some((c) => !c.pass)).toBe(true)
      expect(result.outcome.effects).toEqual([])
      expect(await cashRows(op.ref)).toBe(0)
      expect((await db.item.findUniqueOrThrow({ where: { id: it.id } })).stockQty).toBe(10)
    } finally { await db.$executeRawUnsafe(`DROP TRIGGER ${trigger}`) }
  })
  test('membership cash failure does not leave a newly created member or extension', async () => {
    const name = key()
    const op = await createDraft({ businessId: business.id, userId: owner.id, type: 'membership', summary: key(), payload: { customerName: name, total: 1000, months: 1 }, idempotencyKey: key() })
    const trigger = `membership_fault_${randomUUID().replaceAll('-', '')}`
    await db.$executeRawUnsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON CashEntry WHEN NEW.ref = '${op.ref}' BEGIN SELECT RAISE(ABORT, 'injected cash failure'); END`)
    try {
      expect((await executeOperation(op.id, owner.id)).op.status).toBe('FAILED_SAFE')
      expect(await db.customer.count({ where: { businessId: business.id, name } })).toBe(0)
      expect(await cashRows(op.ref)).toBe(0)
    } finally { await db.$executeRawUnsafe(`DROP TRIGGER ${trigger}`) }
  })
  test('basket prices stay approved prices; reversal restores exactly stock, debt and cash', async () => {
    const first = await item()
    const second = await item(business.id, 10, 150)
    const customer = await db.customer.create({ data: { businessId: business.id, name: key(), balance: 1000 } })
    const op = await createDraft({ businessId: business.id, userId: owner.id, type: 'sale', summary: key(), payload: {
      lines: [{ itemId: first.id, qty: 2 }, { itemId: second.id, qty: 1 }], paid: 100, customerId: customer.id,
    }, idempotencyKey: key() })
    await db.item.update({ where: { id: first.id }, data: { sellPrice: 900 } })
    const done = await executeOperation(op.id, owner.id)
    expect(done.op.status).toBe('SUCCEEDED')
    expect(JSON.parse(done.op.payload).total).toBe(350)
    expect((await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).balance).toBe(1250)
    const reversal = await createDraft({ businessId: business.id, userId: owner.id, type: 'reversal', summary: key(), payload: { originalRef: op.ref, reason: 'test correction' }, idempotencyKey: key() })
    expect((await executeOperation(reversal.id, owner.id)).op.status).toBe('SUCCEEDED')
    expect((await db.item.findUniqueOrThrow({ where: { id: first.id } })).stockQty).toBe(10)
    expect((await db.item.findUniqueOrThrow({ where: { id: second.id } })).stockQty).toBe(10)
    expect((await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).balance).toBe(1000)
    const cash = await db.cashEntry.findMany({ where: { ref: { in: [op.ref, reversal.ref] } } })
    expect(cash.map((entry) => [entry.direction, entry.amount])).toEqual([['in', 100], ['out', 100]])
  })
  test('simultaneous reversals compensate the original only once', async () => {
    const { op, it } = await sale()
    await executeOperation(op.id, owner.id)
    const reversals = await Promise.all([1, 2].map(() => createDraft({ businessId: business.id, userId: owner.id, type: 'reversal', summary: key(), payload: { originalRef: op.ref, reason: 'correction' }, idempotencyKey: key() })))
    const results = await Promise.all(reversals.map((reversal) => executeOperation(reversal.id, owner.id)))
    expect(results.map((r) => r.op.status).sort()).toEqual(['FAILED_SAFE', 'SUCCEEDED'])
    expect((await db.item.findUniqueOrThrow({ where: { id: it.id } })).stockQty).toBe(10)
    expect(await db.cashEntry.count({ where: { ref: { in: reversals.map((r) => r.ref) } } })).toBe(1)
    const winner = results.find((r) => r.op.status === 'SUCCEEDED')!.op
    expect((await db.operation.findUniqueOrThrow({ where: { id: op.id } })).reversedByRef).toBe(winner.ref)
    expect(winner.reversalOfRef).toBe(op.ref)
  })
  test('reversal failure after stock change rolls back compensation and both links', async () => {
    const { op, it } = await sale()
    await executeOperation(op.id, owner.id)
    const reversal = await createDraft({ businessId: business.id, userId: owner.id, type: 'reversal', summary: key(), payload: { originalRef: op.ref, reason: 'correction' }, idempotencyKey: key() })
    const trigger = `reversal_fault_${randomUUID().replaceAll('-', '')}`
    await db.$executeRawUnsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON CashEntry WHEN NEW.ref = '${reversal.ref}' BEGIN SELECT RAISE(ABORT, 'injected reversal failure'); END`)
    try {
      expect((await executeOperation(reversal.id, owner.id)).op.status).toBe('FAILED_SAFE')
      expect((await db.item.findUniqueOrThrow({ where: { id: it.id } })).stockQty).toBe(8)
      expect(await cashRows(reversal.ref)).toBe(0)
      expect((await db.operation.findUniqueOrThrow({ where: { id: op.id } })).reversedByRef).toBeNull()
      expect((await db.operation.findUniqueOrThrow({ where: { id: reversal.id } })).reversalOfRef).toBeNull()
    } finally { await db.$executeRawUnsafe(`DROP TRIGGER ${trigger}`) }
  })
  test('purchase reversal cannot remove stock already sold', async () => {
    const it = await item(business.id, 0)
    const op = await createDraft({ businessId: business.id, userId: owner.id, type: 'purchase', summary: key(), payload: { itemId: it.id, qty: 2, total: 100 }, idempotencyKey: key() })
    await executeOperation(op.id, owner.id)
    await db.item.update({ where: { id: it.id }, data: { stockQty: 1 } })
    const reversal = await createDraft({ businessId: business.id, userId: owner.id, type: 'reversal', summary: key(), payload: { originalRef: op.ref, reason: 'correction' }, idempotencyKey: key() })
    expect((await executeOperation(reversal.id, owner.id)).op.status).toBe('FAILED_SAFE')
    expect((await db.item.findUniqueOrThrow({ where: { id: it.id } })).stockQty).toBe(1)
    expect(await cashRows(reversal.ref)).toBe(0)
  })
  test('expense, collection, payment and purchase reversals restore their exact financial deltas', async () => {
    const it = await item()
    const customer = await db.customer.create({ data: { businessId: business.id, name: key(), balance: 1000 } })
    const supplier = await db.supplier.create({ data: { businessId: business.id, name: key(), balance: 1000 } })
    for (const [type, payload] of [
      ['expense', { total: 70 }],
      ['collection', { customerId: customer.id, amount: 100 }],
      ['payment', { supplierId: supplier.id, amount: 100 }],
      ['purchase', { itemId: it.id, qty: 2, total: 100, paid: 50, supplierId: supplier.id }],
    ] as const) {
      const op = await createDraft({ businessId: business.id, userId: owner.id, type, payload, summary: key(), idempotencyKey: key() })
      expect((await executeOperation(op.id, owner.id)).op.status).toBe('SUCCEEDED')
      const inverse = await createDraft({ businessId: business.id, userId: owner.id, type: 'reversal', payload: { originalRef: op.ref, reason: 'correction' }, summary: key(), idempotencyKey: key() })
      const result = await executeOperation(inverse.id, owner.id)
      expect(result.op.status).toBe('SUCCEEDED')
      expect(result.outcome.checks.every((c) => c.pass)).toBe(true)
      const entries = await db.cashEntry.findMany({ where: { ref: { in: [op.ref, inverse.ref] } } })
      expect(entries.reduce((net, entry) => net + (entry.direction === 'in' ? entry.amount : -entry.amount), 0)).toBe(0)
      expect((await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).balance).toBe(1000)
      expect((await db.supplier.findUniqueOrThrow({ where: { id: supplier.id } })).balance).toBe(1000)
      expect((await db.item.findUniqueOrThrow({ where: { id: it.id } })).stockQty).toBe(10)
    }
  })
  test('reversal read-back failure rolls back cash and never marks the original reversed', async () => {
    const { op, it } = await sale()
    await executeOperation(op.id, owner.id)
    const inverse = await createDraft({ businessId: business.id, userId: owner.id, type: 'reversal', payload: { originalRef: op.ref, reason: 'correction' }, summary: key(), idempotencyKey: key() })
    const trigger = `inverse_verify_${randomUUID().replaceAll('-', '')}`
    await db.$executeRawUnsafe(`CREATE TRIGGER ${trigger} AFTER UPDATE OF stockQty ON Item WHEN NEW.id = '${it.id}' BEGIN UPDATE Item SET stockQty = OLD.stockQty WHERE id = NEW.id; END`)
    try {
      const result = await executeOperation(inverse.id, owner.id)
      expect(result.op.status).toBe('FAILED_SAFE')
      expect(result.outcome.checks.some((c) => !c.pass)).toBe(true)
      expect(await cashRows(inverse.ref)).toBe(0)
      expect((await db.operation.findUniqueOrThrow({ where: { id: op.id } })).reversedByRef).toBeNull()
      expect((await db.item.findUniqueOrThrow({ where: { id: it.id } })).stockQty).toBe(8)
    } finally { await db.$executeRawUnsafe(`DROP TRIGGER ${trigger}`) }
  })

  test('sale verification detects a missing customer debt movement and rolls back cash/stock', async () => {
    const it = await item()
    const customer = await db.customer.create({ data: { businessId: business.id, name: key(), balance: 1000 } })
    const op = await createDraft({ businessId: business.id, userId: owner.id, type: 'sale', payload: { itemId: it.id, qty: 2, total: 200, paid: 100, customerId: customer.id }, summary: key(), idempotencyKey: key() })
    const trigger = `debt_verify_${randomUUID().replaceAll('-', '')}`
    await db.$executeRawUnsafe(`CREATE TRIGGER ${trigger} AFTER UPDATE OF balance ON Customer WHEN NEW.id = '${customer.id}' BEGIN UPDATE Customer SET balance = OLD.balance WHERE id = NEW.id; END`)
    try {
      const result = await executeOperation(op.id, owner.id)
      expect(result.op.status).toBe('FAILED_SAFE')
      expect(result.outcome.checks.some((c) => !c.pass)).toBe(true)
      expect(await cashRows(op.ref)).toBe(0)
      expect((await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).balance).toBe(1000)
      expect((await db.item.findUniqueOrThrow({ where: { id: it.id } })).stockQty).toBe(10)
    } finally { await db.$executeRawUnsafe(`DROP TRIGGER ${trigger}`) }
  })
  test('sale verification detects a missing cash entry even when stock read-back succeeds', async () => {
    const { op, it } = await sale()
    const trigger = `cash_verify_${randomUUID().replaceAll('-', '')}`
    await db.$executeRawUnsafe(`CREATE TRIGGER ${trigger} AFTER INSERT ON CashEntry WHEN NEW.ref = '${op.ref}' BEGIN DELETE FROM CashEntry WHERE id = NEW.id; END`)
    try {
      const result = await executeOperation(op.id, owner.id)
      expect(result.op.status).toBe('FAILED_SAFE')
      expect(result.outcome.checks.some((c) => !c.pass)).toBe(true)
      expect(await cashRows(op.ref)).toBe(0)
      expect((await db.item.findUniqueOrThrow({ where: { id: it.id } })).stockQty).toBe(10)
    } finally { await db.$executeRawUnsafe(`DROP TRIGGER ${trigger}`) }
  })

})

describe('atomic execution claim and terminal audit', () => {
  test('failure recording safe failure rolls the claim back to pending, without financial effects', async () => {
    const { op, it } = await sale()
    const suffix = randomUUID().replaceAll('-', ''), cashFault = `double_cash_${suffix}`, auditFault = `double_audit_${suffix}`
    await db.$executeRawUnsafe(`CREATE TRIGGER ${cashFault} BEFORE INSERT ON CashEntry WHEN NEW.ref = '${op.ref}' BEGIN SELECT RAISE(ABORT, 'injected cash storage fault'); END`)
    await db.$executeRawUnsafe(`CREATE TRIGGER ${auditFault} BEFORE INSERT ON AuditEvent WHEN NEW.ref = '${op.ref}' AND NEW.action = 'operation.failed_safe' BEGIN SELECT RAISE(ABORT, 'injected failure audit storage fault'); END`)
    try {
      await expect(executeOperation(op.id, owner.id)).rejects.toThrow()
      const current = await db.operation.findUniqueOrThrow({ where: { id: op.id } })
      expect(current.status).toBe('AWAITING_APPROVAL'); expect(current.decidedAt).toBeNull()
      expect(current.result).toBeNull(); expect(await cashRows(op.ref)).toBe(0)
      expect((await db.item.findUniqueOrThrow({ where: { id: it.id } })).stockQty).toBe(10)
      expect(await db.auditEvent.count({ where: { ref: op.ref, action: { in: ['operation.failed_safe', 'operation.succeeded'] } } })).toBe(0)
    } finally { await db.$executeRawUnsafe(`DROP TRIGGER ${cashFault}`); await db.$executeRawUnsafe(`DROP TRIGGER ${auditFault}`) }
    expect((await executeOperation(op.id, owner.id)).op.status).toBe('SUCCEEDED')
    expect(await cashRows(op.ref)).toBe(1)
  })
  test('historical EXECUTING rows are not blindly reset or replayed', async () => {
    const op = await expense()
    await db.operation.update({ where: { id: op.id }, data: { status: 'EXECUTING' } })
    await db.cashEntry.create({ data: { businessId: business.id, direction: 'out', amount: 100, reason: 'Synthetic historical partial effect', ref: op.ref } })
    await expect(executeOperation(op.id, owner.id)).rejects.toMatchObject({ status: 409 })
    expect((await db.operation.findUniqueOrThrow({ where: { id: op.id } })).status).toBe('EXECUTING')
    expect(await cashRows(op.ref)).toBe(1)
  })
})
