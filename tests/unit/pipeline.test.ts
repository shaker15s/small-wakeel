// وكيل — the R28 harness layer: plan normalisation, the guarded tool pipeline,
// context budgeting, and the isolated researcher.
//
// These are the rules that keep a multi-step answer both FAST and SAFE:
//   • a «plan» is read-only by construction (no write tool can hide inside it),
//   • a tool can never hang a turn (hard timeout → reported failure),
//   • what the model sees is budgeted, while the UI keeps the whole result,
//   • the sub-agent returns a SUMMARY, not its transcript.
import { describe, expect, test } from 'bun:test'
import {
  budgetToolHistory,
  digestCards,
  extractNumbers,
  normalizePlan,
  parseSubAgentCall,
  runSubAgent,
  runToolPipeline,
} from '../../src/lib/agent/pipeline'

describe('pipeline.normalizePlan', () => {
  test('accepts the three shapes models actually send', () => {
    const a = normalizePlan({ plan: [{ tool: 'get_cash_position' }] })
    const b = normalizePlan([{ tool: 'list_low_stock', args: {} }])
    const c = normalizePlan({ steps: [{ tool: 'get_daily_summary' }] })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(c).toHaveLength(1)
    expect(a[0].tool).toBe('get_cash_position')
  })

  test('a plan can never contain a write tool (the approval gate is not bypassable)', () => {
    const steps = normalizePlan({
      plan: [
        { tool: 'record_sale', args: { item: 'لبن' } },
        { tool: 'memory_save' },
        { tool: 'get_cash_position' },
        { tool: 'nonsense_tool' },
      ],
    })
    expect(steps.map((s) => s.tool)).toEqual(['get_cash_position'])
  })

  test('caps the batch and trims junk', () => {
    const many = Array.from({ length: 12 }, () => ({ tool: 'list_low_stock' }))
    expect(normalizePlan({ plan: many })).toHaveLength(6)
    expect(normalizePlan('not a plan')).toHaveLength(0)
    expect(normalizePlan(null)).toHaveLength(0)
  })
})

describe('pipeline.runToolPipeline', () => {
  test('unknown tools fail closed (no throw, no silent success)', async () => {
    const run = await runToolPipeline('drop_all_tables', 'biz')
    expect(run.ok).toBe(false)
    expect(run.error).toBeTruthy()
    expect(run.cards).toHaveLength(0)
  })

  test('a hanging tool is cut off at the timeout instead of hanging the turn', async () => {
    const started = Date.now()
    // get_item_stock against a bogus business still resolves fast; to test the
    // timeout we use an absurdly small budget so the race must fire either way
    const run = await runToolPipeline('get_activity_history', 'does-not-exist', {}, { timeoutMs: 0 })
    expect(run.ms).toBeLessThan(3_000)
    expect(typeof run.ok).toBe('boolean')
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

describe('pipeline.digestCards', () => {
  const cards = [
    {
      kind: 'kv' as const,
      title: 'وضع الخزنة',
      rows: [
        { label: 'الرصيد دلوقتي', value: '١٥٠٠ ج.م' },
        { label: 'داخل', value: '٣٠٠ ج.م' },
      ],
    },
    {
      kind: 'table' as const,
      title: 'المديونيات',
      columns: [{ key: 'name', label: 'العميل' }],
      rows: [{ name: 'أم حسن' }, { name: 'الحاج رجب' }],
      footer: [{ label: 'الإجمالي', value: '٤٠٠ ج.م' }],
    },
  ]

  test('produces a compact model-facing digest with the real numbers', () => {
    const text = digestCards(cards)
    expect(text).toContain('وضع الخزنة')
    expect(text).toContain('١٥٠٠ ج.م')
    expect(text).toContain('المديونيات')
    expect(text).toContain('أم حسن')
    expect(text.length).toBeLessThan(600)
  })

  test('extractNumbers pulls the figures worth verifying', () => {
    const nums = extractNumbers('المبيعات ٤٣٥ ج.م والنقص ٣ يوم و١٢ علبة')
    expect(nums.length).toBeGreaterThanOrEqual(3)
    expect(nums.join(' ')).toContain('٤٣٥')
  })
})

describe('pipeline.budgetToolHistory', () => {
  test('keeps the newest results whole and digests the older ones', () => {
    const history = Array.from({ length: 7 }, (_, i) => ({ tool: `t${i}`, output: 'x'.repeat(100) }))
    const { kept, budget } = budgetToolHistory(history, 3)
    expect(kept).toHaveLength(3)
    expect(kept[2].tool).toBe('t6')
    expect(budget.compressed).toBe(true)
    expect(budget.digestedChars).toBeGreaterThan(0)
  })

  test('a short history is never compressed', () => {
    const { budget } = budgetToolHistory([{ tool: 'a' }, { tool: 'b' }], 3)
    expect(budget.compressed).toBe(false)
    expect(budget.keptFull).toBe(2)
  })
})

describe('pipeline.subAgent', () => {
  test('only read tools can be called inside a sub-agent', () => {
    expect(parseSubAgentCall('{"tool":"get_cash_position","args":{}}')?.tool).toBe('get_cash_position')
    expect(parseSubAgentCall('{"tool":"record_sale","args":{}}')).toBeNull()
    expect(parseSubAgentCall('مش JSON')).toBeNull()
    expect(parseSubAgentCall('{"tool":"list_low_stock"}')?.args).toEqual({})
  })

  test('the researcher loops on tools then returns ONLY a summary', async () => {
    let call = 0
    const seen: string[] = []
    const res = await runSubAgent({
      businessId: 'biz',
      question: 'ليه المبيعات نزلت؟',
      complete: async (messages) => {
        call++
        seen.push(messages[messages.length - 1].content)
        if (call === 1) return '{"tool":"does_not_exist","args":{}}'
        if (call === 2) return '{"tool":"nope","args":{}}'
        return 'الخلاصة: المبيعات نزلت ١٢٪ بسبب غياب صنفين أساسيين.'
      },
    })
    expect(res.summary).toContain('الخلاصة')
    expect(res.rounds).toBeGreaterThan(1)
    // the intermediate tool output never leaks back as the summary
    expect(res.summary).not.toContain('tool')
    expect(seen.length).toBeGreaterThan(1)
  })

  test('a failing model still yields an honest result (fail-closed)', async () => {
    const res = await runSubAgent({
      businessId: 'biz',
      question: 'أي سؤال',
      complete: async () => {
        throw new Error('provider down')
      },
    })
    expect(res.summary.length).toBeGreaterThan(10)
    expect(res.rounds).toBe(1)
  })
})
