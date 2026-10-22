import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { testDb } from '../helpers/test-db'
import { POST as bridgePost } from '@/app/api/dsh/bridge/route'
import { egpToPiastres } from '@/lib/dsh-bridge/bridge'

const db = await testDb()
const bridgeToken = 'dsh-test-token-' + randomUUID() + randomUUID()
let businessId = ''
let ownerId = ''
let itemId = ''
const priorEnv = {
  enabled: process.env.WAKIL_DSH_ENABLED,
  token: process.env.WAKIL_DSH_BRIDGE_TOKEN,
  businessId: process.env.WAKIL_DSH_BUSINESS_ID,
  userId: process.env.WAKIL_DSH_USER_ID,
}

function request(body: Record<string, unknown>, token = bridgeToken) {
  return new Request('http://localhost/api/dsh/bridge', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify(body),
  })
}

async function call(body: Record<string, unknown>, token = bridgeToken) {
  const response = await bridgePost(request(body, token))
  return { status: response.status, body: await response.json() as Record<string, any> }
}

beforeAll(async () => {
  businessId = (await db.business.create({
    data: { name: 'DSH bridge synthetic ' + randomUUID(), type: 'supermarket', openingCash: 10_000 },
  })).id
  ownerId = (await db.user.create({
    data: { businessId, name: 'Synthetic DSH owner', role: 'owner' },
  })).id
  itemId = (await db.item.create({
    data: {
      businessId,
      name: 'Synthetic oil 1.5L',
      unit: 'piece',
      stockQty: 50,
      sellPrice: 2_500,
      costPrice: 1_750,
    },
  })).id

  process.env.WAKIL_DSH_ENABLED = '1'
  process.env.WAKIL_DSH_BRIDGE_TOKEN = bridgeToken
  process.env.WAKIL_DSH_BUSINESS_ID = businessId
  process.env.WAKIL_DSH_USER_ID = ownerId
})

afterAll(async () => {
  if (businessId) await db.business.deleteMany({ where: { id: businessId } })
  const restoreEnv = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  restoreEnv('WAKIL_DSH_ENABLED', priorEnv.enabled)
  restoreEnv('WAKIL_DSH_BRIDGE_TOKEN', priorEnv.token)
  restoreEnv('WAKIL_DSH_BUSINESS_ID', priorEnv.businessId)
  restoreEnv('WAKIL_DSH_USER_ID', priorEnv.userId)
})

describe('native DSH bridge — owner-bound and draft-only', () => {
  test('disabled bridge fails closed', async () => {
    const previous = process.env.WAKIL_DSH_ENABLED
    process.env.WAKIL_DSH_ENABLED = '0'
    try {
      const result = await call({ action: 'overview' })
      expect(result.status).toBe(503)
      expect(result.body.ok).toBe(false)
    } finally {
      process.env.WAKIL_DSH_ENABLED = previous ?? '1'
    }
  })

  test('missing and wrong bearer tokens cannot read data', async () => {
    expect((await call({ action: 'overview' }, '')).status).toBe(401)
    expect((await call({ action: 'overview' }, 'wrong-token-that-is-not-valid')).status).toBe(401)
  })

  test('overview and catalog read only the server-configured tenant', async () => {
    const forgedTenant = await call({ action: 'overview', businessId: 'model-supplied-tenant', userId: 'model-supplied-user' })
    expect(forgedTenant.status).toBe(400)
    const overview = await call({ action: 'overview' })
    expect(overview.status).toBe(200)
    expect(overview.body.data.business.id).toBe(businessId)
    expect(overview.body.data.business.name).toContain('DSH bridge synthetic')
    expect(overview.body.data.cashIsPhysicalCount).toBe(false)

    const catalog = await call({ action: 'catalog', query: 'Synthetic oil' })
    expect(catalog.status).toBe(200)
    expect(catalog.body.data.items.map((item: { id: string }) => item.id)).toContain(itemId)
    expect(catalog.body.data.items.every((item: { id: string }) => item.id === itemId)).toBe(true)
    expect(catalog.body.data.items[0].sellPrice).toEqual({ piastres: 2_500, egp: '25.00' })
  })

  test('sale tool prepares an idempotent draft and never mutates stock or cash', async () => {
    const requestId = 'a'.repeat(64)
    const body = {
      action: 'prepare_draft',
      requestId,
      operationType: 'sale',
      summary: 'بيع اختبار من إضافة DSH',
      payload: {
        lines: [{ itemId, qty: 2 }],
        paidEgp: 50,
      },
    }

    const first = await call(body)
    expect(first.status).toBe(200)
    expect(first.body.ok).toBe(true)
    expect(first.body.data.draft.status).toBe('AWAITING_APPROVAL')
    expect(first.body.data.draft.type).toBe('sale')
    expect(first.body.data.ownerApprovalRequired).toBe(true)
    expect(first.body.data.mutationExecuted).toBe(false)
    expect(first.body.data.draft.payload.total).toBe(5_000)
    expect(first.body.data.draft.payload.paid).toBe(5_000)

    const retry = await call(body)
    expect(retry.status).toBe(200)
    expect(retry.body.data.draft.id).toBe(first.body.data.draft.id)
    expect(await db.item.findUniqueOrThrow({ where: { id: itemId } }).then((item) => item.stockQty)).toBe(50)
    expect(await db.cashEntry.count({ where: { businessId } })).toBe(0)
    expect(await db.operation.count({ where: { businessId, status: 'AWAITING_APPROVAL' } })).toBe(1)
  })

  test('bridge has no approval/execution endpoint; an approval request cannot change a draft', async () => {
    const requestId = 'b'.repeat(64)
    const draft = await call({
      action: 'prepare_draft',
      requestId,
      operationType: 'expense',
      summary: 'مصروف اختبار ينتظر المالك',
      payload: { totalEgp: 12.5, reason: 'مستلزمات اختبار' },
    })
    expect(draft.status).toBe(200)
    const opId = draft.body.data.draft.id
    const denied = await call({ action: 'approve', operationId: opId })
    expect(denied.status).toBe(403)
    const op = await db.operation.findUniqueOrThrow({ where: { id: opId } })
    expect(op.status).toBe('AWAITING_APPROVAL')
    expect(await db.cashEntry.count({ where: { businessId } })).toBe(0)
  })

  test('money conversion is exact and rejects invented precision', () => {
    expect(egpToPiastres(1, 'amount')).toBe(100)
    expect(egpToPiastres(12.5, 'amount')).toBe(1_250)
    expect(egpToPiastres(0, 'paid', true)).toBe(0)
    expect(() => egpToPiastres(1.001, 'amount')).toThrow(/منزلتين/)
    expect(() => egpToPiastres(-1, 'amount')).toThrow()
    expect(() => egpToPiastres(1e22, 'amount')).toThrow()
  })

  test('server-side actor must be a configured owner in the configured business', async () => {
    const manager = await db.user.create({ data: { businessId, name: 'Synthetic manager', role: 'manager' } })
    process.env.WAKIL_DSH_USER_ID = manager.id
    try {
      const result = await call({ action: 'overview' })
      expect(result.status).toBe(503)
    } finally {
      process.env.WAKIL_DSH_USER_ID = ownerId
      await db.user.deleteMany({ where: { id: manager.id } })
    }
  })
})
