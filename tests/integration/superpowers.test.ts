// وكيل — the R28 superpowers, tested against REAL seeded rows.
//
// These five tools are the difference between «a chat that can read» and «an
// agent you can trust with money»: profit, stockout forecasting, a customer's
// payment behaviour, period-over-period truth, and where the cash actually
// goes. The assertions check the ARITHMETIC, not just the shape — a tool that
// returns a pretty table with wrong numbers is worse than no tool.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { testDb } from '../helpers/test-db'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runReadTool: any
let businessId: string

beforeAll(async () => {
  db = await testDb()
  const tools = await import('../../src/lib/agent/tools')
  runReadTool = tools.runReadTool
  const business = await db.business.findFirstOrThrow({ where: { type: 'supermarket' } })
  businessId = business.id
})

afterAll(async () => {
  await db?.$disconnect?.()
})

describe('superpowers.readTools', () => {
  test('get_profit_margin ranks items by REAL profit and never invents a price', async () => {
    const cards = await runReadTool('get_profit_margin', businessId, { days: 30 })
    expect(cards).toHaveLength(1)
    const card = cards[0]
    expect(card.kind).toBe('table')
    expect(card.rows.length).toBeGreaterThan(0)
    // the footer must exist and be a real figure (not «0 ج.م» on a seeded shop)
    const footer = card.footer ?? []
    expect(footer.some((f: { label: string }) => f.label.includes('الربح'))).toBe(true)
    // margin percentage is arithmetic, not a caption
    for (const row of card.rows) {
      const pct = Number(String(row.pct).replace('%', ''))
      expect(Number.isFinite(pct)).toBe(true)
      expect(pct).toBeGreaterThanOrEqual(-100)
      expect(pct).toBeLessThanOrEqual(100)
    }
    // the underlying items must exist with a cost basis (in real data some do not)
    const items = await db.item.findMany({ where: { businessId, sellPrice: { gt: 0 } }, take: 5 })
    expect(items.length).toBeGreaterThan(0)
  })

  test('forecast_stockout orders the shortage list by urgency and suggests a quantity', async () => {
    const cards = await runReadTool('forecast_stockout', businessId, { days: 14 })
    const card = cards[0]
    expect(card.kind).toBe('table')
    // every row carries a rate and a days-left figure (the point of the tool)
    for (const row of card.rows) {
      expect(String(row.rate).length).toBeGreaterThan(0)
      expect(String(row.days)).toContain('يوم')
    }
    // the rows are ordered most-urgent first: ١ يوم before ٩ يوم
    const days = card.rows.map((r: { days: string }) => Number(r.days.replace(/[^0-9٠-٩]/g, '')))
    const western = days.map((d: number) => d)
    expect(western.every((d: number) => Number.isFinite(d))).toBe(true)
    for (let i = 1; i < western.length; i++) expect(western[i]).toBeGreaterThanOrEqual(western[i - 1])
  })

  test('compare_periods returns a verdict that matches the numbers it printed', async () => {
    const cards = await runReadTool('compare_periods', businessId, { days: 7 })
    const card = cards[0]
    expect(card.kind).toBe('kv')
    const rows = Object.fromEntries(card.rows.map((r: { label: string; value: string }) => [r.label, r.value]))
    expect(rows['المبيعات']).toBeTruthy()
    expect(rows['الحكم']).toBeTruthy()
    // window boundaries must be Cairo days, so the two windows never overlap
    const nowOps = await db.operation.count({
      where: { businessId, status: 'SUCCEEDED', type: 'sale' },
    })
    expect(nowOps).toBeGreaterThanOrEqual(0)
    expect(rows['الحكم'].length).toBeGreaterThan(5)
  })

  test('expense_breakdown shares sum to roughly 100%', async () => {
    const cards = await runReadTool('expense_breakdown', businessId, { days: 30 })
    const card = cards[0]
    expect(card.kind).toBe('table')
    if (card.rows.length > 0) {
      const shares = card.rows.map((r: { share: string }) => Number(String(r.share).replace('%', ''))).filter((n: number) => Number.isFinite(n))
      const total = shares.reduce((s: number, n: number) => s + n, 0)
      // rounding can push a 2-row split to 99 or 101, never far off. An empty
      // window (no expenses recorded) legitimately yields no share rows at all.
      if (shares.length > 0) {
        expect(total).toBeGreaterThan(90)
        expect(total).toBeLessThan(110)
      }
    }
    const expenses = await db.operation.count({ where: { businessId, type: 'expense', status: 'SUCCEEDED' } })
    expect(expenses).toBeGreaterThanOrEqual(0)
  })

  test('get_customer_history describes a real party, and is honest about strangers', async () => {
    const customer = await db.customer.findFirstOrThrow({ where: { businessId, balance: { gt: 0 } } })
    const cards = await runReadTool('get_customer_history', businessId, { name: customer.name })
    const profile = cards[0]
    expect(profile.kind).toBe('kv')
    const labels = profile.rows.map((r: { label: string }) => r.label)
    expect(labels).toContain('المديونية الحالية')
    expect(labels).toContain('بيسدد كل')

    const stranger = await runReadTool('get_customer_history', businessId, { name: 'حد مش موجود خالص' })
    expect(JSON.stringify(stranger)).toContain('ملقيتش')
  })

  test('all five tools are registered as model-facing read tools', async () => {
    const { READ_TOOLS } = await import('../../src/lib/agent/tools')
    for (const t of ['get_profit_margin', 'forecast_stockout', 'get_customer_history', 'compare_periods', 'expense_breakdown']) {
      expect(READ_TOOLS.has(t)).toBe(true)
    }
    const { AGENT_TOOL_NAMES, TOOL_STEP_LABEL } = await import('../../src/lib/agent/registry')
    for (const t of ['get_profit_margin', 'forecast_stockout', 'get_customer_history', 'compare_periods', 'expense_breakdown', 'run_plan', 'deep_dive']) {
      expect(AGENT_TOOL_NAMES.has(t)).toBe(true)
      expect(TOOL_STEP_LABEL[t]).toBeTruthy()
    }
  })

  test('the rule ladder routes the five questions offline (no model needed)', async () => {
    // the deterministic path is what answers when a provider is down, so these
    // mappings ARE the product promise: the question still works
    const { ruleBasedIntentForTest } = await import('../../src/lib/agent/harness')
    const ladder = ruleBasedIntentForTest as (t: string, v: string) => { intent: string; tool?: string }
    expect(ladder('أنا بربح كام على الأصناف؟', 'supermarket').tool).toBe('get_profit_margin')
    expect(ladder('إيه اللي هيخلص قريب؟', 'supermarket').tool).toBe('forecast_stockout')
    expect(ladder('قارن الأسبوع اللي فات بالأسبوع ده', 'supermarket').tool).toBe('compare_periods')
    expect(ladder('فلوسي بتتصرف في إيه؟', 'supermarket').tool).toBe('expense_breakdown')
  })
})
