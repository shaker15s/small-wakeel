// scripts/accept-ahmed.ts — the owner's acceptance run, as code.
//
// The request was: «احمد عليه كام؟» → «مفيش أحمد اصلا» → «خلاص ضيف احمد كمان من
// اللي عليهم فلوس وعليه كذا من ايام كذا» → and it must actually MUTATE the project,
// by chat, with the draft approved and readable afterwards.
//
//   bun scripts/accept-ahmed.ts                 # supermarket owner (default)
//   bun scripts/accept-ahmed.ts --url http://localhost:3000
//
// Every assertion is checked against what the API returned — never against logs.
export {}

const args = process.argv.slice(2)
const urlArg = args.indexOf('--url')
const BASE = urlArg >= 0 ? args[urlArg + 1] : (process.env.WAKIL_URL ?? 'http://localhost:3000')

// سوبر ماركت النور · خالد (the same owner the sweep uses)
const BIZ = process.env.WAKIL_ACCEPT_BIZ ?? 'cmvav3psg000iorbm9e9y9hb8'
const USER = process.env.WAKIL_ACCEPT_USER ?? 'cmvav3psh000korbmqwag4fcz'

type Card = { kind?: string; ref?: string; opId?: string; fields?: { label: string; value: string }[]; title?: string }
type Turn = { status: number; reply: string; cards: Card[]; error?: string }

async function turn(text: string): Promise<Turn> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ businessId: BIZ, userId: USER, text }),
  })
  if (res.status !== 200) return { status: res.status, reply: '', cards: [], error: `HTTP ${res.status}` }
  const raw = await res.text()
  let reply = ''
  const cards: Card[] = []
  let error: string | undefined
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    try {
      const ev = JSON.parse(line.slice(5)) as { event: string; text?: string; card?: Card; cards?: Card[]; message?: string }
      if (ev.event === 'delta') reply += ev.text ?? ''
      if (ev.event === 'card' && ev.card) cards.push(ev.card)
      if (ev.event === 'cards') cards.push(...(ev.cards ?? []))
      if (ev.event === 'error') error = ev.message ?? 'SSE error'
    } catch {
      /* non-JSON keep-alive line */
    }
  }
  return { status: res.status, reply: reply.trim(), cards, error }
}

const digits = (x: string) => x.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
let pass = 0
let fail = 0
function check(label: string, ok: boolean, detail: string) {
  if (ok) {
    pass++
    console.log(`✅ ${label}`)
  } else {
    fail++
    console.log(`❌ ${label}\n   ${detail}`)
  }
}

console.log(`\nقبول «ضيف أحمد» — ${BASE}\n${'─'.repeat(70)}`)

// 1) «أحمد عليه كام؟» → no أحمد exists, and the agent says so + names the near miss
const first = await turn('أحمد عليه كام؟')
check('1) «أحمد عليه كام؟» يرد بمفيش أحمد (مش بيخترع رصيد)', /ملقيتش|مفيش/.test(first.reply), first.reply)
check('1b) وبيقول «قصدت؟» بأقرب اسم بدل ما يخترع', /قصدت|زي ما هو في السجل/.test(first.reply), first.reply)

// 2) the owner grows the ledger BY TALKING — with the debt's own date
const partyName = `مصطفى الجزار ${1000 + (Date.now() % 9000)}`
const asked = await turn(`ضيف ${partyName} من اللي عليهم فلوس وعليه ٤٥٠ من أيام ١٠ أكتوبر`)
const draft = asked.cards.find((c) => (c.kind ?? '') === 'draft')
check('2) «ضيف … من اللي عليهم فلوس وعليه ٤٥٠» بيعمل مسودة', !!draft, JSON.stringify(asked.cards).slice(0, 300))
const fields = Object.fromEntries((draft?.fields ?? []).map((f) => [f.label, f.value]))
check('2b) الاسم اتقرا صح (مش الجملة كلها)', !!fields['العميل'] && !fields['العميل'].includes('عليه'), fields['العميل'] ?? '—')
check('2c) الرصيد الافتتاحي = ٤٥٠', digits(fields['عليه (افتتاحي)'] ?? '').includes('450'), fields['عليه (افتتاحي)'] ?? '—')
check('2d) تاريخ المديونية محفوظ (من أيام ١٠ أكتوبر)', /أكتوبر|اكتوبر/.test(fields['مستحقة من'] ?? ''), fields['مستحقة من'] ?? '—')

// 3) approval actually executes and mutates the DB
if (draft?.opId) {
  const conf = await fetch(`${BASE}/api/operations/${draft.opId}/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve', userId: USER }),
  })
  const body = (await conf.json()) as { operation?: { status?: string; result?: { ok?: boolean } } }
  check('3) الاعتماد نفّذ العملية فعلًا', conf.status === 200 && body.operation?.status === 'SUCCEEDED', JSON.stringify(body).slice(0, 240))
} else {
  check('3) الاعتماد نفّذ العملية فعلًا', false, 'مفيش مسودة أتعملت — مقدرتش أعتمد')
}

// 4) read it back through the same chat: the mutation is real
const back = await turn(`${partyName} عليه كام؟`)
check(`4) السجل اتغيّر — «${partyName} عليه كام؟» بيرجّع ٤٥٠`, digits(back.reply).includes('450'), back.reply)
check('4b) وبيفتكر تاريخ المديونية في الكارت', JSON.stringify(back.cards).includes('أكتوبر') || JSON.stringify(back.cards).includes('افتتاحي'), JSON.stringify(back.cards).slice(0, 240))

console.log(`${'─'.repeat(70)}\nالنتيجة: ${pass} نجح · ${fail} فشل\n`)
process.exit(fail === 0 ? 0 : 1)
