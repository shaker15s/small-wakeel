// Actual HTTP against the standalone production server, not handler mocks.
// Most cases use explicit fixture drafts; the final Arabic expense exercises
// chat SSE -> persisted draft -> approval -> replay end to end (offline model).
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createClient, type InValue } from '@libsql/client'

type Actor = { id: string; businessId: string; token: string }
export async function financialHttpSmoke(params: {
  base: string; databaseUrl: string; owner: Actor; cashier: Actor; foreign: Actor;
}) {
  const { base, owner, cashier, foreign } = params
  const sql = createClient({ url: params.databaseUrl })
  let requests = 0
  let seq = 0
  const runId = Date.now()
  const query = (text: string, args: InValue[] = []) => sql.execute({ sql: text, args })
  const row = async (text: string, args: InValue[] = []) => (await query(text, args)).rows[0]!
  async function post(path: string, actor: Actor, body: unknown) {
    requests++
    return fetch(base + path, { method: 'POST', headers: {
      authorization: `Bearer ${actor.token}`, 'content-type': 'application/json',
    }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
  }
  async function fixture(type: string, payload: object, actor = owner, risk = type === 'reversal' || type === 'stock_adjustment' ? 'R3' : 'R2') {
    const id = randomUUID()
    const ref = `WKL-${runId}${++seq}`
    await query('INSERT INTO Operation (id,ref,businessId,type,status,userId,risk,summary,payload,idempotencyKey,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [
      id, ref, owner.businessId, type, 'AWAITING_APPROVAL', actor.id, risk, `HTTP fixture ${type}`, JSON.stringify(payload), randomUUID(), Date.now(),
    ])
    return { id, ref }
  }
  const current = (id: string) => row('SELECT * FROM Operation WHERE id = ?', [id])
  const stock = async (id: string) => Number((await row('SELECT stockQty FROM Item WHERE id = ?', [id])).stockQty)
  const balance = async (id: string, table: 'Customer' | 'Supplier' = 'Customer') => Number((await row(`SELECT balance FROM ${table} WHERE id = ?`, [id])).balance)
  const ledgerCount = async (ref: string) => Number((await row('SELECT COUNT(*) AS n FROM CashEntry WHERE ref = ?', [ref])).n)
  async function decide(op: { id: string }, actor = owner, action = 'approve', reason?: string) {
    return post(`/api/operations/${op.id}/confirm`, actor, { action, userId: actor.id, reason })
  }
  async function succeeded(op: { id: string }, reason?: string) {
    const response = await decide(op, owner, 'approve', reason)
    assert.equal(response.status, 200)
    const body = await response.json() as { operation: { status: string }; outcome: { ok: boolean } }
    assert.equal(body.operation.status, 'SUCCEEDED')
    assert.equal(body.outcome.ok, true)
  }
  try {
    const itemId = randomUUID()
    const foreignItem = randomUUID()
    const customerId = randomUUID()
    const supplierId = randomUUID()
    for (const [id, businessId] of [[itemId, owner.businessId], [foreignItem, foreign.businessId]]) {
      await query('INSERT INTO Item (id,businessId,name,unit,costPrice,sellPrice,stockQty,createdAt) VALUES (?,?,?,?,?,?,?,?)', [id, businessId!, `HTTP test ${id}`, 'piece', 60, 100, 10, Date.now()])
    }
    await query('INSERT INTO Customer (id,businessId,name,balance,createdAt) VALUES (?,?,?,?,?)', [customerId, owner.businessId, 'HTTP customer', 1000, Date.now()])
    await query('INSERT INTO Supplier (id,businessId,name,balance,createdAt) VALUES (?,?,?,?,?)', [supplierId, owner.businessId, 'HTTP supplier', 1000, Date.now()])

    const expense = await fixture('expense', { total: 70 })
    for (const action of ['approve', 'reject', 'cancel']) assert.equal((await decide(expense, cashier, action, 'forbidden')).status, 403)
    assert.equal((await current(expense.id)).status, 'AWAITING_APPROVAL')
    assert.equal((await current(expense.id)).reason, null)
    assert.equal(await ledgerCount(expense.ref), 0)
    for (const id of [expense.id, 'unknown-operation']) {
      assert.equal((await decide({ id }, foreign)).status, 404)
      requests++
      assert.equal((await fetch(`${base}/api/operations/${id}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve', userId: owner.id }) })).status, 401)
    }
    await succeeded(expense)
    assert.equal(await ledgerCount(expense.ref), 1)
    assert.equal((await decide(expense)).status, 409)

    const sale = await fixture('sale', { itemId, qty: 2, total: 200, paid: 100, customerId }, cashier)
    const approved = await decide(sale, cashier)
    assert.equal(approved.status, 200)
    assert.equal((await approved.json() as { outcome: { ok: boolean } }).outcome.ok, true)
    assert.equal(await stock(itemId), 8)
    assert.equal(await balance(customerId), 1100)
    assert.equal(await ledgerCount(sale.ref), 1)
    assert.equal((await decide(sale, cashier)).status, 409)
    assert.equal(await stock(itemId), 8)

    const purchase = await fixture('purchase', { itemId, qty: 3, total: 180, paid: 80, supplierId })
    await succeeded(purchase)
    assert.equal(await stock(itemId), 11)
    assert.equal(await balance(supplierId, 'Supplier'), 1100)
    const collection = await fixture('collection', { customerId, amount: 100 })
    await succeeded(collection)
    assert.equal(await balance(customerId), 1000)
    const payment = await fixture('payment', { supplierId, amount: 50 })
    await succeeded(payment)
    assert.equal(await balance(supplierId, 'Supplier'), 1050)

    const adjustment = await fixture('stock_adjustment', { itemId, delta: -1, reason: 'stock count' })
    await succeeded(adjustment, 'stock count')
    assert.equal(await stock(itemId), 10)
    const price = await fixture('price_change', { itemId, newPrice: 130 })
    await succeeded(price)
    assert.equal(Number((await row('SELECT sellPrice FROM Item WHERE id = ?', [itemId])).sellPrice), 130)
    const membership = await fixture('membership', { customerId, total: 300, paid: 200, months: 1 })
    await succeeded(membership)
    assert.equal(await balance(customerId), 1100)
    assert.ok((await row('SELECT expiresAt FROM Customer WHERE id = ?', [customerId])).expiresAt)

    // Unified lots now prohibit reversing a debt while its collection still consumes it.
    const blockedDebtReverse = await fixture('reversal', { originalRef: sale.ref, reason: 'linked receipt exists' })
    const blockedDebt = await decide(blockedDebtReverse, owner, 'approve', 'linked receipt exists')
    assert.equal((await blockedDebt.json() as { operation: { status: string } }).operation.status, 'FAILED_SAFE')
    assert.equal(await stock(itemId), 10)
    const receiptReverse = await fixture('reversal', { originalRef: collection.ref, reason: 'restore receipt before original debt' })
    await succeeded(receiptReverse, 'restore receipt before original debt')
    assert.equal(await balance(customerId), 1200)
    const reversal = await fixture('reversal', { originalRef: sale.ref, reason: 'correct sale' })
    await succeeded(reversal, 'correct sale')
    assert.equal(await stock(itemId), 12)
    assert.equal(await balance(customerId), 1100)
    assert.equal((await current(sale.id)).reversedByRef, reversal.ref)
    assert.equal((await current(reversal.id)).reversalOfRef, sale.ref)
    assert.equal((await row('SELECT amount FROM CashEntry WHERE ref = ?', [reversal.ref])).amount, 100)
    const duplicateReversal = await fixture('reversal', { originalRef: sale.ref, reason: 'duplicate correction' })
    const duplicate = await decide(duplicateReversal)
    assert.equal(duplicate.status, 200)
    assert.equal((await duplicate.json() as { outcome: { ok: boolean } }).outcome.ok, false)
    assert.equal(await ledgerCount(duplicateReversal.ref), 0)
    assert.equal(await stock(itemId), 12)

    // A legacy/stored row must not be able to bypass tenant/numeric validation.
    for (const payload of [
      { itemId: foreignItem, qty: 1, total: 100 },
      { itemId, qty: -2, total: 200 },
      { itemId, qty: 999_999, total: 200 },
    ]) {
      const invalid = await fixture('sale', payload)
      const response = await decide(invalid)
      assert.equal(response.status, 200)
      assert.equal((await response.json() as { operation: { status: string } }).operation.status, 'FAILED_SAFE')
      assert.equal(await ledgerCount(invalid.ref), 0)
      assert.equal(await stock(itemId), 12)
      assert.equal(await stock(foreignItem), 10)
    }

    const large = await fixture('expense', { total: 1_000_000 }, owner, 'R1')
    // Recompute risk for old rows too: stored R1 must not evade R3 reason.
    assert.equal((await decide(large)).status, 400)
    assert.equal((await current(large.id)).status, 'AWAITING_APPROVAL')
    await succeeded(large, 'large payment reviewed')
    assert.equal((await decide(large, owner, 'approve', 'overwrite reason')).status, 409)
    assert.equal((await current(large.id)).reason, 'large payment reviewed')

    const race = await fixture('expense', { total: 15 })
    const decisions = await Promise.all([decide(race), decide(race, owner, 'cancel')])
    assert.deepEqual(decisions.map((r) => r.status).sort(), [200, 409])
    const terminal = await current(race.id)
    assert.ok(['SUCCEEDED', 'CANCELLED'].includes(String(terminal.status)))
    assert.equal(await ledgerCount(race.ref), terminal.status === 'SUCCEEDED' ? 1 : 0)

    const atomic = await fixture('sale', { itemId, qty: 1, total: 100 })
    const trigger = `http_fault_${randomUUID().replaceAll('-', '')}`
    await query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON CashEntry WHEN NEW.ref = '${atomic.ref}' BEGIN SELECT RAISE(ABORT, 'injected HTTP cash failure'); END`)
    try {
      const response = await decide(atomic)
      assert.equal(response.status, 200)
      const body = await response.json() as { operation: { status: string }; outcome: { effects: unknown[] } }
      assert.equal(body.operation.status, 'FAILED_SAFE')
      assert.deepEqual(body.outcome.effects, [])
      assert.equal(await ledgerCount(atomic.ref), 0)
      assert.equal(await stock(itemId), 12)
    } finally { await query(`DROP TRIGGER ${trigger}`) }

    // Verify management denials over real HTTP, not just imported handlers.
    requests++
    assert.equal((await fetch(`${base}/api/export?businessId=${cashier.businessId}`, { headers: { authorization: `Bearer ${cashier.token}` } })).status, 403)
    requests++
    assert.equal((await fetch(`${base}/api/tools?businessId=${cashier.businessId}&userId=${cashier.id}`, { headers: { authorization: `Bearer ${cashier.token}` } })).status, 403)
    for (const [path, body] of [
      ['/api/items/import', { csv: 'اسم,سعر البيع\nاختبار,50' }],
      ['/api/restore', { mode: 'merge', items: [{ name: 'forbidden' }] }],
      ['/api/memories', { text: 'forbidden policy', kind: 'rule' }],
      ['/api/tools', { name: 'forbidden tool', kind: 'web_source', config: { site: 'example.com' } }],
      ['/api/background-tasks', { jobKinds: ['upsert_catalog_batch'], catalogUpdates: [{ name: 'forbidden' }] }],
    ] as const) assert.equal((await post(path, cashier, { businessId: cashier.businessId, userId: cashier.id, ...body })).status, 403)

    // Complete Arabic chat -> draft -> approval, then exact turn replay.
    const fixtureConversation = randomUUID()
    await query('INSERT INTO Conversation (id,businessId,userId,title,createdAt,updatedAt,lastMessageAt) VALUES (?,?,?,?,?,?,?)', [fixtureConversation, owner.businessId, owner.id, 'HTTP financial smoke', Date.now(), Date.now(), Date.now()])
    const turnId = `http-smoke-${randomUUID()}`
    const chatBody = { conversationId: fixtureConversation, businessId: owner.businessId, userId: owner.id, text: 'ضيف مصروف ٣٣ جنيه بند صيانة', turnId }
    const chat = await post('/api/chat', owner, chatBody)
    assert.equal(chat.status, 200)
    const events = (await chat.text()).split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))
    assert.ok(!events.some((ev) => ev.event === 'error'), 'chat must finish without SSE error')
    const conversationId = events.find((ev) => ev.event === 'start')?.conversationId as string
    const draftId = events.find((ev) => ev.event === 'card')?.card?.opId as string
    assert.ok(conversationId && draftId, 'Arabic chat must emit a real persisted draft')
    assert.equal(conversationId, fixtureConversation)
    const chatOp = await current(draftId)
    const chatPayload = JSON.parse(String(chatOp.payload)) as Record<string, unknown>
    assert.equal(chatOp.status, 'AWAITING_APPROVAL')
    assert.equal(
      chatOp.type,
      'expense',
      `Arabic expense phrase created the wrong draft type: type=${String(chatOp.type)}; summary=${String(chatOp.summary)}; payload=${JSON.stringify(chatPayload)}`,
    )
    assert.equal(
      chatPayload.total,
      3300,
      `Arabic expense amount was not stored as canonical piastres: type=${String(chatOp.type)}; payload=${JSON.stringify(chatPayload)}`,
    )
    assert.equal(await ledgerCount(String(chatOp.ref)), 0)
    await succeeded({ id: draftId }, 'HTTP smoke approval')
    assert.equal(await ledgerCount(String(chatOp.ref)), 1)
    const replay = await post('/api/chat', owner, { ...chatBody, conversationId })
    assert.equal(replay.status, 200)
    assert.match(await replay.text(), /"replayed":true/)
    assert.equal(Number((await row('SELECT COUNT(*) AS n FROM Operation WHERE conversationId = ?', [conversationId])).n), 1)
    assert.equal(await ledgerCount(String(chatOp.ref)), 1)
    console.log(`PASS: financial production HTTP (${requests} requests): sale/purchase/expense/collection/payment/stock/price/membership/reversal, denial/race/rollback, Arabic chat approval + replay`)
  } finally { sql.close() }
}
