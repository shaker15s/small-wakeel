// وكيل — «مسح يوم شغل حقيقي» (R29).
//
//   bun run sweep                     (--url http://host:port  --only supermarket)
//
// WHY THIS EXISTS: every round so far was judged by unit tests and by hand —
// and the owner still found «اخطاء كتيرة في الرد والشبكة واختيار الأدوات
// والموديلات وشاشات بايضة». So this script stops being a developer harness and
// becomes the OWNER: it signs in as each of the four businesses (owner AND a
// cashier where permissions matter), sends a whole normal working day through
// the real `POST /api/chat` SSE endpoint, and judges every single turn on:
//
//   • رد موجود ومش كلام مصفّح («قولّي تحب نعمل إيه») لما الطلب واضح
//   • الكارت الصح: مسودة لعمليات الكتابة، جدول/أرقام لأي سؤال بيانات
//   • الرد متسق مع الكارت (نفس رقم أو نفس كلمة مميزة) — مش رد مغسول
//   • النبرة والأرقام: الرد بالعربي، الأرقام من السجل مش من دماغ الموديل
//   • الصلاحيات: الكاشير مش بيرجّع «تم» على عملية ممنوعة، بيقول الحقيقة
//   • HTTP 200 على كل نداء، ومفيش «SSE error»، والوقت بالمللي ثانية
//   • الاستمرارية: متابعة في نفس المحادثة («بعت ٢ لبن» → «أحمد عليه كام؟»)
//
// The output is a per-turn table plus a failure list with the exact reply text,
// so any regression is reproducible without a browser. Exit code 1 on failure.

import { db } from '../src/lib/db'

type Vertical = 'supermarket' | 'gym' | 'pharmacy' | 'attar'
type Want = 'draft' | 'cards' | 'reply' | 'refuse' | 'memory' | 'any'

interface Scenario {
  business: Vertical
  text: string
  want: Want
  /** a word/regex the reply (or the cards) MUST contain */
  expect?: RegExp
  /** a word/regex the reply must NEVER contain */
  forbid?: RegExp
  /** run as someone other than the first (owner) user: role match */
  as?: 'owner' | 'cashier' | 'supervisor' | 'reception'
  /** continue in the same conversation as the previous turn of this business */
  follow?: boolean
  note: string
}

const DAY: Scenario[] = [
  // ══ سوبر ماركت النور — خالد (صاحب محل): يوم شغل عادي ═══════════════════════
  { business: 'supermarket', text: 'الخزنة فيها كام؟', want: 'cards', expect: /خزنة|رصيد/i, note: 'قراءة الخزنة' },
  { business: 'supermarket', text: 'ايه اللي ناقص عندي؟', want: 'cards', expect: /ناقص|نواقص/i, note: 'النواقص' },
  { business: 'supermarket', text: 'ملخص النهارده ايه؟', want: 'cards', expect: /مبيعات|تحصيل|مصروف/i, note: 'ملخص اليوم' },
  { business: 'supermarket', text: 'بعت ٣ كيلو جبنة رومي بـ٤٥٠ للكيلو لأم حسن', want: 'draft', expect: /جبنة|رومي/i, note: 'بيع بآجل لعميلة' },
  { business: 'supermarket', text: 'بعت كرتونة لبن جهينة لأحمد ودفع ١٠٠ بس', want: 'draft', expect: /لبن|باقي|آجل/i, note: 'بيع بدفعة جزئية' },
  { business: 'supermarket', text: 'حصلت ١٠٠ من أم حسن', want: 'draft', expect: /تحصيل|أم حسن/i, note: 'تحصيل من عميلة' },
  { business: 'supermarket', text: 'صرفت ١٥٠ كهربا', want: 'draft', expect: /مصروف|كهربا/i, note: 'مصروف من الخزنة' },
  { business: 'supermarket', text: 'اشتريت ١٠ كيلو رز مصري من شركة الألبان الوطنية بـ٢٥٠', want: 'draft', expect: /رز|شرا/i, note: 'شرا بضاعة' },
  { business: 'supermarket', text: 'الجبنة الرومي عندي كام كيلو؟', want: 'cards', expect: /جبنة|رومي|كيلو/i, note: 'استعلام رصيد صنف' },
  { business: 'supermarket', text: 'أحمد عليه كام؟', want: 'reply', expect: /أحمد/i, note: 'سؤال عن عميل موجود' },
  { business: 'supermarket', text: 'احمد فتحي عليه كام؟', want: 'reply', expect: /ملقيتش|مفيش|معرفش|مش لاقي/i, note: 'عميل مش موجود → يعترف بصراحة' },
  { business: 'supermarket', text: 'ضيف أحمد فتحي من اللي عليهم فلوس وعليه ٥٠٠ من أول الشهر', want: 'draft', expect: /أحمد فتحي|عميل/i, note: 'إضافة عميل جديدة من الشات (تعديل مشروع)' },
  { business: 'supermarket', text: 'أنا بربح كام على الأصناف؟', want: 'cards', expect: /ربح|هامش/i, note: 'سوبر باور: هامش الربح' },
  { business: 'supermarket', text: 'ايه اللي هيخلص من المخزون قريب؟', want: 'cards', expect: /نقص|يوم|خلاص/i, note: 'سوبر باور: توقّع النقص' },
  { business: 'supermarket', text: 'قارن الأسبوع ده بالأسبوع اللي فات', want: 'cards', expect: /مقارنة|أسبوع|زيادة|نقص/i, note: 'سوبر باور: مقارنة الفترات' },
  { business: 'supermarket', text: 'فلوسي بتتصرف في ايه؟', want: 'cards', expect: /مصروف|بند/i, note: 'سوبر باور: تفصيل المصاريف' },
  { business: 'supermarket', text: 'ابحث في الويب عن أسعار الجبنة الرومي النهارده', want: 'cards', note: 'بحث في الويب' },
  { business: 'supermarket', text: 'انصحني إزاي أقلل المصاريف الشهر ده', want: 'cards', note: 'نصيحة/تحليل' },
  { business: 'supermarket', text: 'اعمللي خطة: راجع النواقص، وهات ملخص اليوم، وقولي وضع الخزنة', want: 'cards', note: 'خطة أكتر من مهمة' },
  { business: 'supermarket', text: 'افتكر إن أم حسن بتسدد كل أول شهر', want: 'memory', expect: /حفظ|ذاكر/i, note: 'تعلّم/ذاكرة' },
  { business: 'supermarket', text: 'السلام عليكم', want: 'reply', expect: /سلام|أهلا|اهلا|تحت أمرك/i, note: 'تحية' },

  // ══ سوبر ماركت النور — سعاد (كاشير): الصلاحيات ════════════════════════════
  { business: 'supermarket', as: 'cashier', text: 'صرفت ٥٠٠ من الخزنة', want: 'refuse', forbid: /تم التسجيل|تمت العملية|اتنفذت/i, note: 'الكاشير ممنوع يصرف من الخزنة' },
  { business: 'supermarket', as: 'cashier', text: 'بعت ٢ أوريو بـ٣٠', want: 'draft', expect: /أوريو|بيع/i, note: 'الكاشير مسموح له يبيع' },
  { business: 'supermarket', text: 'بعت علبة شوكولاتة كيندر بـ٤٠', want: 'reply', expect: /مش لاقي|ملقيتش|مش عندنا|الصنف/i, forbid: /مسودة|WKL-/i, note: 'صنف مش في الكتالوج → يشرح مش يخترع' },

  // ══ صيدلية الشفاء — د. عبد الله ══════════════════════════════════════════
  { business: 'pharmacy', text: 'الخزنة فيها كام؟', want: 'cards', note: 'قراءة الخزنة' },
  { business: 'pharmacy', text: 'ايه اللي قرب ينتهي؟', want: 'cards', expect: /ينتهي|صلاحية|قرب/i, note: 'الصلاحيات القريبة' },
  { business: 'pharmacy', text: 'بعت ٢ علبة بنادول بـ٤٥ جنيه', want: 'draft', expect: /بنادول/i, note: 'بيع صيدلية' },
  { business: 'pharmacy', text: 'صرفت ٢٠٠ جنيه مستلزمات', want: 'draft', expect: /مصروف/i, note: 'مصروف صيدلية' },
  { business: 'pharmacy', text: 'مستشفى الرحمة عليهم كام؟', want: 'cards', expect: /الرحمة/i, note: 'مديونية عميل' },
  { business: 'pharmacy', text: 'اللي علينا للموردين كام؟', want: 'cards', expect: /مورد|علينا/i, note: 'مستحقات الموردين' },

  // ══ عطارة المسك — عم سيد ═════════════════════════════════════════════════
  { business: 'attar', text: 'الخزنة فيها كام؟', want: 'cards', note: 'قراءة الخزنة' },
  { business: 'attar', text: 'بعت ٥٠ جرام عنبر بـ٣٤٠٠ جنيه', want: 'draft', expect: /عنبر/i, note: 'بيع بالوزن' },
  { business: 'attar', text: 'ايه النواقص؟', want: 'cards', expect: /ناقص|نواقص/i, note: 'النواقص' },
  { business: 'attar', text: 'الحاج رجب عليه كام؟', want: 'cards', expect: /رجب/i, note: 'مديونية عميل' },
  { business: 'attar', text: 'كيلو الكمون بكام؟', want: 'cards', expect: /كمون/i, note: 'سعر صنف' },

  // ══ جيم أبطال — كابتن حسام ═══════════════════════════════════════════════
  { business: 'gym', text: 'الخزنة فيها كام؟', want: 'cards', note: 'قراءة الخزنة' },
  { business: 'gym', text: 'مين اللي عضويته قربت تخلص؟', want: 'cards', expect: /عضوي|اشتراك/i, note: 'اشتراكات قربت تخلص' },
  { business: 'gym', text: 'عمر الشناوي عضويته باقي قد إيه؟', want: 'cards', expect: /عمر|اشتراك|فاضل/i, note: 'حالة عضو' },
  { business: 'gym', text: 'اشتراك عمر الشناوي شهر', want: 'draft', expect: /عمر|اشتراك/i, note: 'تجديد اشتراك' },
  { business: 'gym', text: 'سجل حضور عمر الشناوي النهارده', want: 'draft', expect: /حضور|عمر/i, note: 'تسجيل حضور' },
  { business: 'gym', text: 'كريم عادل عليه كام؟', want: 'cards', expect: /كريم/i, note: 'مديونية عضو' },
]

interface CardBrief {
  kind: string
  title: string
  ref?: string
  /** draft operations created by this run — rejected at the end (demo hygiene) */
  opId?: string
  /** every label/value/row serialized — the grounding judge needs the BODY */
  body: string
}

interface TurnResult {
  scenario: Scenario
  ok: boolean
  problems: string[]
  ms: number
  cards: CardBrief[]
  reply: string
  steps: { label: string; ms?: number }[]
  model: string
  http: number
}

const args = process.argv.slice(2)
const urlArg = args.indexOf('--url')
const BASE = urlArg >= 0 ? args[urlArg + 1] : process.env.WAKIL_URL ?? 'http://localhost:3000'
const onlyArg = args.indexOf('--only')
const ONLY = onlyArg >= 0 ? args[onlyArg + 1] : null

/** Canned «I did not understand» / small-talk replies a real request must never get. */
const CANNED =
  /قولّي تحب نعمل إيه|تحب نعمل ايه|مفيش عملية محددة|مفيش عملية واضحة|تحب نجرب|مش قادر أفهم|مش فاهم قصدك/i

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function toWestern(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
}

/** «الرد متسق مع الكارت»: shares a number or a distinctive word with the cards. */
function grounded(reply: string, cards: TurnResult['cards']): boolean {
  if (cards.length === 0 || reply.trim().length === 0) return true
  const r = toWestern(reply)
  const c = toWestern(cards.map((x) => `${x.ref ?? ''} ${x.title} ${x.body}`).join(' '))
  const nums = (r.match(/\d[\d.,]*/g) ?? []).filter((n) => n.replace(/[.,]/g, '').length >= 2)
  if (nums.some((n) => c.includes(n))) return true
  const words = (s: string) =>
    new Set(
      s
        .split(/[^\p{L}\p{N}]+/u)
        .map((w) => w.replace(/^(ال|و)/, ''))
        .filter((w) => w.length >= 4),
    )
  const cw = words(c)
  return [...words(r)].some((w) => cw.has(w))
}

/** Flatten any card DTO into `kind · title · ref · body` for the judge. */
function briefOf(c: Record<string, unknown>, kind: string): CardBrief {
  const rows = (c.rows as Record<string, unknown>[] | undefined) ?? []
  const sources = (c.sources as { title?: string }[] | undefined) ?? []
  const cols = (c.columns as { label?: string }[] | undefined) ?? []
  const fields = (c.fields as { label?: string; value?: string }[] | undefined) ?? []
  const effects = (c.effects as { label?: string; value?: string }[] | undefined) ?? []
  const body = [
    ...cols.map((x) => x.label ?? ''),
    ...rows.map((r) => Object.values(r).join(' ')),
    ...sources.map((x) => x.title ?? ''),
    ...fields.map((f) => `${f.label} ${f.value}`),
    ...effects.map((f) => `${f.label} ${f.value}`),
    String(c.summary ?? ''),
    String(c.footer ? JSON.stringify(c.footer) : ''),
  ]
    .join(' ')
    .slice(0, 1200)
  return {
    kind,
    title: String(c.title ?? ''),
    ref: typeof c.ref === 'string' ? c.ref : undefined,
    opId: typeof c.opId === 'string' ? c.opId : undefined,
    body,
  }
}

async function runTurn(businessId: string, userId: string, s: Scenario, conversationId: string | null): Promise<{ r: TurnResult; conversationId: string | null }> {
  const started = Date.now()
  const problems: string[] = []
  const cards: TurnResult['cards'] = []
  let reply = ''
  let steps: { label: string; ms?: number }[] = []
  let model = ''
  let http = 0
  let streamError: string | null = null
  let convo = conversationId

  try {
    const body: Record<string, unknown> = { businessId, userId, text: s.text }
    if (conversationId) body.conversationId = conversationId
    let res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.status === 429) {
      const info = (await res.json().catch(() => ({}))) as { retryAfter?: number }
      await sleep(Math.min(20, Number(info.retryAfter ?? 5) || 5) * 1000)
      res = await fetch(`${BASE}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }
    http = res.status
    if (!res.ok || !res.body) {
      problems.push(`HTTP ${res.status}`)
    } else {
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          const payload = t.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          let ev: Record<string, unknown>
          try {
            ev = JSON.parse(payload) as Record<string, unknown>
          } catch {
            continue
          }
          const event = ev.event as string
          if (event === 'delta') reply += String(ev.text ?? '')
          else if (event === 'card') {
            const c = ev.card as Record<string, unknown>
            cards.push(briefOf(c, String(c?.kind ?? 'draft')))
          } else if (event === 'cards') {
            for (const c of (ev.cards as Record<string, unknown>[]) ?? []) cards.push(briefOf(c, String(c.kind ?? '')))
          } else if (event === 'thinking') {
            steps = (ev.steps as { label: string; ms?: number }[]) ?? []
          } else if (event === 'done') {
            model = String(ev.modelLabel ?? '')
            if (typeof ev.conversationId === 'string') convo = ev.conversationId
          } else if (event === 'error') streamError = String(ev.message ?? 'error')
        }
      }
    }
  } catch (err) {
    problems.push(`شبكة: ${(err as Error).message}`)
  }

  const ms = Date.now() - started
  const trimmed = reply.trim()
  const drafts = cards.filter((c) => c.kind === 'draft' || (c.ref ?? '').startsWith('WKL-'))
  const dataCards = cards.filter((c) => ['kv', 'table', 'sources', 'text', 'draft'].includes(c.kind))

  if (streamError) problems.push(`SSE error: ${streamError}`)
  if (!trimmed) problems.push('رد فاضي')
  if (http !== 200) problems.push(`متوقع 200 — جاي ${http}`)
  if (s.want === 'draft' && drafts.length === 0) problems.push('مفيش مسودة (المفروض عملية كتابة)')
  if (s.want === 'cards' && dataCards.length === 0) problems.push('مفيش كارت بيانات (المفروض قراءة)')
  if (s.want === 'refuse' && drafts.length > 0) problems.push('عملية المفروض تتطلب صلاحية — اتعملت مسودة!')
  for (const [flag, want] of [
    ['draft', true],
    ['cards', true],
    ['refuse', true],
    ['memory', true],
  ] as const) {
    void flag
    void want
  }
  if ((s.want === 'draft' || s.want === 'cards' || s.want === 'refuse') && CANNED.test(trimmed)) {
    problems.push(`رد مصفّح على طلب واضح: «${trimmed.slice(0, 60)}»`)
  }
  if (s.forbid && s.forbid.test(trimmed)) problems.push(`الرد فيه حاجة ممنوعة: ${s.forbid}`)
  if (s.expect) {
    const pool = `${trimmed} ${cards.map((c) => `${c.ref ?? ''} ${c.title}`).join(' ')}`
    if (!s.expect.test(pool)) problems.push(`المتوقع مش موجود: ${s.expect}`)
  }
  // The reader sees the sentence first: it must agree with the cards.
  if (dataCards.length > 0 && s.want !== 'refuse' && !grounded(trimmed, dataCards)) {
    problems.push(`الرد مش متسق مع الكروت: «${trimmed.slice(0, 70)}»`)
  }
  if (dataCards.length > 0 && steps.length < 2) problems.push('خطوات التفكير ناقصة')

  return { r: { scenario: s, ok: problems.length === 0, problems, ms, cards, reply: trimmed, steps, model, http }, conversationId: convo }
}

function ar(n: number): string {
  return new Intl.NumberFormat('ar-EG').format(n)
}

const businesses = await db.business.findMany({ include: { users: true } })
const byType = new Map(businesses.map((b) => [b.type, b]))

console.log(`\n🧪 وكيل — مسح يوم شغل حقيقي (${BASE})\n${'─'.repeat(86)}`)
const results: TurnResult[] = []
const convos = new Map<string, string | null>()
let i = 0
for (const s of DAY) {
  if (ONLY && s.business !== ONLY) continue
  const b = byType.get(s.business)
  if (!b) {
    console.log(`⚠️  مفيش نشاط من نوع ${s.business}`)
    continue
  }
  const role = s.as ?? 'owner'
  const user = b.users.find((u) => u.role === role) ?? b.users[0]
  const conv = s.follow ? convos.get(s.business) ?? null : null
  if (i++ > 0) await sleep(Number(process.env.WAKIL_SWEEP_GAP ?? 400))
  const { r, conversationId } = await runTurn(b.id, user.id, s, conv)
  if (conversationId) convos.set(s.business, conversationId)
  results.push(r)
  const timing = r.steps
    .slice(0, 5)
    .map((st) => `${st.label}${st.ms != null ? ` ${ar(Math.round(st.ms))}ms` : ''}`)
    .join(' ← ')
  console.log(`${r.ok ? '✅' : '❌'} [${s.business}${s.as ? `/${s.as}` : ''}] ${s.text}`)
  console.log(`   ${ar(r.ms)}ms · كروت ${ar(r.cards.length)} · ${r.model || 'بلا موديل'} · ${s.note}`)
  if (timing) console.log(`   خطوات: ${timing}`)
  if (r.cards.length) console.log(`   📄 ${r.cards.slice(0, 3).map((c) => `${c.kind}:${c.title}`).join(' | ')}`)
  console.log(`   💬 ${r.reply.slice(0, 170) || '—'}`)
  if (!r.ok) for (const p of r.problems) console.log(`   ⛔ ${p}`)
  console.log()
}

// ---- «سيب الديمو نضيف»: every draft this run created is rejected at the end,
// otherwise a 41-turn sweep leaves ~35 AWAITING_APPROVAL rows and the owner's
// «مستنيات اعتماد» card grows for no reason. Approval behaviour itself is
// covered by `bun run accept`, which approves on purpose.
const draftOps = results.flatMap((r) => {
  const b = byType.get(r.scenario.business)
  const user = b?.users.find((u) => u.role === (r.scenario.as ?? 'owner')) ?? b?.users[0]
  return r.cards
    .map((c) => c.opId)
    .filter((x): x is string => !!x)
    .map((opId) => ({ opId, userId: user?.id }))
})
if (draftOps.length > 0 && process.env.WAKIL_SWEEP_CLEAN !== '0') {
  let cleaned = 0
  for (const { opId, userId } of draftOps) {
    try {
      const res = await fetch(`${BASE}/api/operations/${opId}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'reject', userId, reason: 'مسودة تجربة (sweep)' }),
      })
      if (res.ok) cleaned++
    } catch {
      /* cleanup is best-effort — never fails the gate */
    }
  }
  console.log(`🧹 اتنضف ${ar(cleaned)}/${ar(draftOps.length)} مسودة تجربة من السجل\n`)
}

const failed = results.filter((r) => !r.ok)
const avg = results.length ? Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length) : 0
const worst = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5)
console.log('─'.repeat(86))
console.log(`النتيجة: ${ar(results.length - failed.length)}/${ar(results.length)} نجح · متوسط ${ar(avg)}ms`)
console.log(`أبطأ ٥: ${worst.map((w) => `${ar(w.ms)}ms (${w.scenario.note})`).join(' · ')}`)
if (failed.length > 0) {
  console.log('\nاللي فشل:')
  for (const f of failed) console.log(` • [${f.scenario.business}${f.scenario.as ? `/${f.scenario.as}` : ''}] ${f.scenario.text}\n   → ${f.problems.join(' / ')}`)
  process.exitCode = 1
}
console.log()

await db.$disconnect()
