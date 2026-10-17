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

import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface EvalCase {
  /** What the owner types. */
  text: string
  /** The seeded business type to run it in. */
  vertical: 'supermarket' | 'gym' | 'pharmacy' | 'attar'
  /** What must be true about the turn result. */
  expect: string
   
  check: (r: any) => boolean
}

const CASES: EvalCase[] = [
  {
    text: 'انت مين؟',
    vertical: 'supermarket',
    expect: 'بيرد بتعريف بنفسه من غير ما يحتاج موديل',
    check: (r) => typeof r.replyText === 'string' && r.replyText.length > 20 && !r.card,
  },
  {
    text: 'الخزنة فيها كام؟',
    vertical: 'supermarket',
    expect: 'قراءة حقيقية من السجل (كروت بيانات)',
    check: (r) => Array.isArray(r.cards) && r.cards.length > 0,
  },
  {
    text: 'ايه النواقص عندي؟',
    vertical: 'supermarket',
    expect: 'قراءة قايمة النواقص',
    check: (r) => Array.isArray(r.cards) && r.cards.length > 0,
  },
  {
    text: 'بعت ٢ علبة لبن لأم حسن بـ٩٥ جنيه',
    vertical: 'supermarket',
    expect: 'مسودة بيع محتاجة اعتماد (مش تنفيذ فوري)',
    check: (r) => r.card?.kind === 'draft' && r.card?.type === 'sale' && r.card?.status === 'AWAITING_APPROVAL',
  },
  {
    text: 'صرفت ٣٠٠ جنيه كهربا النهاردة',
    vertical: 'supermarket',
    expect: 'مسودة مصروف',
    check: (r) => r.card?.kind === 'draft' && r.card?.type === 'expense',
  },
  {
    text: 'حسن دفع ٥٠ من اللي عليه',
    vertical: 'supermarket',
    expect: 'مسودة تحصيل من عميل',
    check: (r) => r.card?.kind === 'draft' && r.card?.type === 'collection',
  },
  {
    text: 'اشتركت هدى في الجيم شهر بـ٤٠٠',
    vertical: 'gym',
    expect: 'مسودة اشتراك/تجديد عضوية في النشاط الصح',
    check: (r) => r.card?.kind === 'draft' && (r.card?.type === 'membership' || r.card?.type === 'sale'),
  },
  {
    text: 'اشتركت نادية في الجيم شهر بـ٤٠٠',
    vertical: 'gym',
    expect: 'اسم مش مسجّل → يسمّيه ويقول الحل، مش يسأل «لمين؟» تاني',
    check: (r) => typeof r.replyText === 'string' && r.replyText.includes('نادية') && !r.card,
  },
  {
    text: 'حسن دفع ٥٠ من اللي عليه',
    vertical: 'supermarket',
    expect: '«اللي عليه» فيها «ليه» — لازم تفضل تحصيل ومتعملش بحث',
    check: (r) => r.card?.kind === 'draft' && r.card?.type === 'collection' && !r.research,
  },
  {
    text: 'احفظ إن أم حسن بتسدد كل خميس',
    vertical: 'supermarket',
    expect: 'يتحفظ في الذاكرة طويلة المدى',
    check: (r) => /حفظ|فاكر|ذكرت|سجل/i.test(r.replyText),
  },
]

async function main() {
  const asJson = process.argv.includes('--json')
  const tmpDir = mkdtempSync(join(tmpdir(), 'wakil-eval-'))
  const dbFile = join(tmpDir, 'custom.db')
  copyFileSync(join(process.cwd(), 'db', 'custom.db'), dbFile)

  process.env.DATABASE_URL = `file:${dbFile}`
  // Deterministic ladder only: no network, no retries, no model latency.
  process.env.WAKIL_OFFLINE = '1'

  const { db } = await import('../../src/lib/db')
  const { runAgentTurn } = await import('../../src/lib/agent/harness')

  const businesses = await db.business.findMany()
  const results: { text: string; expect: string; ok: boolean; ms: number; note: string }[] = []

  for (const c of CASES) {
    const business = businesses.find((b: { type: string }) => b.type === c.vertical)
    const user = business
      ? await db.user.findFirst({ where: { businessId: business.id, role: 'owner' } })
      : null
    if (!business || !user) {
      results.push({ text: c.text, expect: c.expect, ok: false, ms: 0, note: `مفيش نشاط من نوع ${c.vertical}` })
      continue
    }
    const conversation = await db.conversation.create({
      data: { businessId: business.id, userId: user.id, title: 'تقييم آلي' },
    })

    const started = Date.now()
    try {
      const result = await runAgentTurn(
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
      const ok = c.check(result)
      results.push({
        text: c.text,
        expect: c.expect,
        ok,
        ms: Date.now() - started,
        note: ok
          ? r_note(result)
          : `جاب: card=${result.card?.type ?? '—'} cards=${result.cards?.length ?? 0} رد=«${String(result.replyText).slice(0, 60)}»`,
      })
    } catch (err) {
      results.push({
        text: c.text,
        expect: c.expect,
        ok: false,
        ms: Date.now() - started,
        note: `استثناء: ${err instanceof Error ? err.message : String(err)}`,
      })
    } finally {
      // the eval conversation is scratch data — keep the copy clean
      await db.conversation.delete({ where: { id: conversation.id } }).catch(() => null)
    }
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
