#!/usr/bin/env bun
// وكيل — golden-dataset evaluation suite (deterministic, no LLM required).
//
// WHY: prompt/parser changes used to be validated by hand in the browser, which
// means regressions shipped silently. This harness runs a fixed set of REAL
// Egyptian-Arabic utterances through the whole agent turn (the same code path
// the API uses) with WAKIL_OFFLINE=1, so the rule ladder's routing decisions are
// asserted on every CI run.
//
//   bun run evals            # full table
//   bun run evals --json     # machine-readable (CI artifacts)
//
// A failure means the agent stopped understanding something an Egyptian shop
// owner actually types — that is a product bug, not a test bug.

import { applyMigrations } from '../../scripts/lib/migrations'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'



import { CASES as BASE_CASES } from './cases'
import { generateCases } from './case-generator'
import type { EvalCase } from './cases'

// R46: 1000+ scenario battery = hand-written base + generated cross-product.
const CASES: EvalCase[] = [...BASE_CASES, ...generateCases()]

async function main() {
  const asJson = process.argv.includes('--json')
  const tmpDir = mkdtempSync(join(tmpdir(), 'wakil-eval-'))
  const dbFile = join(tmpDir, 'custom.db')
  copyFileSync(join(process.cwd(), 'db', 'custom.db'), dbFile)

  await applyMigrations(dbFile)
  process.env.DATABASE_URL = `file:${dbFile}`
  // Deterministic ladder only: no network, no retries, no model latency.
  // Separate flag: WAKIL_OFFLINE alone still permits synthetic-model contract tests.
  process.env.WAKIL_OFFLINE = '1'
  process.env.WAKIL_DETERMINISTIC_EVAL = '1'

  const { db } = await import('../../src/lib/db')
  const { runAgentTurn } = await import('../../src/lib/agent/harness')

  const businesses = await db.business.findMany()
  const results: { text: string; expect: string; ok: boolean; ms: number; note: string }[] = []

  // R46: parallel pool (6) — each case is independent (own scratch
  // conversation), results keep case order. 1000+ cases in seconds.
  const runOne = async (c: EvalCase): Promise<{ text: string; expect: string; ok: boolean; ms: number; note: string }> => {
    const business = businesses.find((b: { type: string }) => b.type === c.vertical)
    const user = business
      ? await db.user.findFirst({ where: { businessId: business.id, role: 'owner' } })
      : null
    if (!business || !user) {
      return { text: c.text, expect: c.expect, ok: false, ms: 0, note: `مفيش نشاط من نوع ${c.vertical}` }
    }
    const conversation = await db.conversation.create({
      data: { businessId: business.id, userId: user.id, title: 'تقييم آلي' },
    })

    const started = Date.now()
    try {
      const turnOne = await runAgentTurn(
        {
          business,
          user,
          conversationId: conversation.id,
          text: c.text,
          modelKey: null,
          history: [],
        },
        () => {},
      )
      // R48: multi-turn cases — the check applies to turn TWO (the answer the
      // owner gives to the agent's question).
      const result = c.followUp
        ? await runAgentTurn(
            {
              business,
              user,
              conversationId: conversation.id,
              text: c.followUp,
              modelKey: null,
              history: [
                { role: 'user', text: c.text },
                { role: 'assistant', text: turnOne.replyText },
              ],
            },
            () => {},
          )
        : turnOne
      // Explicit boolean: some legacy checks return a truthy non-boolean
      // (a card object / a count) — it used to survive in-process but vanish
      // in the JSON round-trip (suite saw ok=undefined → phantom failure).
      const ok = Boolean(c.check(result))
      return {
        text: c.followUp ? `${c.text} → ${c.followUp}` : c.text,
        expect: c.expect,
        ok,
        ms: Date.now() - started,
        note: ok
          ? r_note(result)
          : `جاب: card=${result.card?.type ?? '—'} cards=${result.cards?.length ?? 0} رد=«${String(result.replyText).slice(0, 60)}»`,
      }
    } catch (err) {
      return {
        text: c.text,
        expect: c.expect,
        ok: false,
        ms: Date.now() - started,
        note: `استثناء: ${err instanceof Error ? err.message : String(err)}`,
      }
    } finally {
      // the eval conversation is scratch data — keep the copy clean
      await db.conversation.delete({ where: { id: conversation.id } }).catch(() => null)
    }
  }
  const POOL = 6
  for (let i = 0; i < CASES.length; i += POOL) {
    const chunk = CASES.slice(i, i + POOL)
    results.push(...(await Promise.all(chunk.map(runOne))))
  }

  await db.$disconnect()
  rmSync(tmpDir, { recursive: true, force: true })

  const passed = results.filter((r) => r.ok).length
  if (asJson) {
    console.log(JSON.stringify({ passed, total: results.length, results }, null, 2))
  } else {
    console.log('\nوكيل — تقييم التوجيه (golden dataset)\n' + '─'.repeat(78))
    for (const r of results) {
      console.log(`${r.ok ? '✔' : '✖'} ${String(r.ms).padStart(5)}ms  ${r.text}`)
      console.log(`        المتوقع: ${r.expect}`)
      if (!r.ok) console.log(`        الناتج:  ${r.note}`)
    }
    console.log('─'.repeat(78))
    console.log(`${passed}/${results.length} نجح\n`)
  }

  if (passed !== results.length) process.exit(1)
}

 
function r_note(result: any): string {
  if (result.card) return `مسودة ${result.card.type} (${result.card.ref})`
  if (result.cards?.length) return `كروت: ${result.cards.length}`
  return `رد نصي (${String(result.replyText).length} حرف)`
}

main().catch((err) => {
  console.error('eval suite crashed:', err)
  process.exit(1)
})
