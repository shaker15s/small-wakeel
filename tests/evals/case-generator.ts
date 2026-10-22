// R46 — 1000-scenario battery generator.
//
// The base battery (tests/evals/cases.ts) hand-wrote 138 proven scenarios.
// This generator EXPANDS those proven phrasings across every item, customer,
// supplier, amount and digit-system of the four seeded verticals — the way a
// REAL employee meets the same job 1000 different mornings. Every template is
// a pattern already proven by a base case; only the entities and numbers vary.
//
// Deterministic: pure arrays + index math, no randomness.
import type { EvalCase } from './cases'
import { draft, anyDraft, cards, noCard, says, saysNot, chat, all } from './cases'

// ---------------------------------------------------------------------------
// Seed entities (from db/custom.db — the businesses the runner picks first)
// ---------------------------------------------------------------------------
const S = {
  // supermarket «سوبر ماركت النور»
  items: [
    { name: 'لبن كرتونة', unit: 'كرتونة' },
    { name: 'سكر معبأ كيلو', unit: 'كيس' },
    { name: 'رز مصري', unit: 'كيلو' },
    { name: 'زيت عافية', unit: 'علبة' },
    { name: 'تونة', unit: 'علبة' },
    { name: 'مكرونة اسباجتي', unit: 'علبة' },
    { name: 'شاي العروسة', unit: 'علبة' },
    { name: 'قهوة أحمد', unit: 'علبة' },
    { name: 'صابون دوف', unit: 'قطعة' },
    { name: 'ديتول', unit: 'زجاجة' },
    { name: 'بيض طبق', unit: 'طبق' },
    { name: 'ماء بركة', unit: 'زجاجة' },
    { name: 'كوكاكولا', unit: 'زجاجة' },
    { name: 'جبنة رومي', unit: 'كيلو' },
    { name: 'عدس أصفر', unit: 'كيلو' },
    { name: 'فول مدمس', unit: 'علبة' },
    { name: 'مربى فراولة', unit: 'علبة' },
    { name: 'كلوركس', unit: 'زجاجة' },
    { name: 'بسكويت أوريو', unit: 'علبة' },
    { name: 'مناديل فاين', unit: 'كيس' },
  ],
  customers: ['أحمد عبد الرحمن', 'أم حسن', 'كافتيريا النور', 'سمير غنيم', 'مطعم الشام', 'مصطفى الجزار'],
  suppliers: ['شركة الألبان الوطنية', 'محمد تاجر الجملة', 'شركة المنظفات المصرية', 'عادل موزع البيض'],
  // gym «جيم أبطال»
  gymItems: [
    { name: 'واي بروتين', unit: 'عبوة' },
    { name: 'بار بروتين', unit: 'بار' },
    { name: 'مشروب طاقة', unit: 'عبوة' },
    { name: 'قفازات تمرين', unit: 'زوج' },
  ],
  gymCustomers: ['عمر الشناوي', 'هدى مصطفى', 'كريم عادل', 'محمد سعيد', 'أحمد فؤاد', 'ملك حسن', 'سلمى يوسف', 'سمير جلال'],
  // pharmacy «صيدلية الشفاء»
  phItems: [
    { name: 'بروفين شراب', unit: 'عبوة' },
    { name: 'بانادول أكتيف', unit: 'علبة' },
    { name: 'كتافلام', unit: 'علبة' },
    { name: 'أوميز', unit: 'علبة' },
    { name: 'ناكسيد', unit: 'شريط' },
    { name: 'فيتامين سي 1000', unit: 'علبة' },
    { name: 'كونجستال', unit: 'عبوة' },
    { name: 'ميلجا بلس', unit: 'علبة' },
    { name: 'زنك 50', unit: 'علبة' },
    { name: 'بانثينول', unit: 'tube' },
    { name: 'فيوسيدين', unit: 'tube' },
    { name: 'بيتادين', unit: 'زجاجة' },
    { name: 'سيتال', unit: 'عبوة' },
    { name: 'بنادول أطفال', unit: 'شريط' },
    { name: 'كومتركس', unit: 'عبوة' },
  ],
  phCustomers: ['مستشفى الرحمة', 'عيادة د. منى', 'شركة الرعاية الطبية'],
  phSuppliers: ['شركة الدواء', 'ميا فارم'],
  // attar «عطارة المسك»
  atItems: [
    { name: 'عود كمبودي', unit: 'جرام' },
    { name: 'مسك غزال', unit: 'جرام' },
    { name: 'زيت صندل', unit: 'مللي' },
    { name: 'بخور معمول', unit: 'جرام' },
    { name: 'كركديه', unit: 'جرام' },
    { name: 'خلطة المدينة', unit: 'جرام' },
    { name: 'خلطة الحرم', unit: 'جرام' },
    { name: 'مسك أسود', unit: 'جرام' },
    { name: 'عنبر', unit: 'جرام' },
    { name: 'زيت لوز', unit: 'مللي' },
    { name: 'زيت حبة البركة', unit: 'لتر' },
    { name: 'زعفران', unit: 'جرام' },
    { name: 'قرفة مطحونة', unit: 'جرام' },
    { name: 'ورد بلدي', unit: 'جرام' },
  ],
  atCustomers: ['الحاج رجب', 'متجر الريحان للعطور', 'زبون نقدي'],
  atSuppliers: ['الحاج مسعود', 'عم عبده'],
} as const

// ---------------------------------------------------------------------------
// Deterministic number sets (both digit systems, Egyptian speech)
// ---------------------------------------------------------------------------
const AMT = [25, 40, 60, 75, 90, 120, 150, 180, 250, 320, 400, 550, 700, 950, 1200, 1500, 2000, 3500]
const AR_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'] as const
const toAr = (n: number): string => String(n).split('').map((d) => AR_DIGITS[Number(d)]).join('')
const QUANT = [1, 2, 3, 5, 7, 10, 12, 15, 20, 24, 30, 40, 50]
// Customers with ZERO debt in the seed DB — collecting from them must produce
// an honest question (deposit/advance), never a 0-amount crash.
const ZERO_DEBT = new Set<string>([
  'سمير غنيم', 'كافتيريا النور', 'مطعم الشام',
  'أحمد فؤاد', 'سلمى يوسف', 'سمير جلال', 'عمر الشناوي', 'محمد سعيد', 'ملك حسن',
  'شركة الرعاية الطبية', 'زبون نقدي', 'متجر الريحان للعطور',
])
// Supplier balances in the seed DB (piastres) — a payment above what is due
// must be refused with the due amount, not drafted.
const SUPPLIER_BALANCE: Record<string, number> = {
  'شركة الألبان الوطنية': 10000,
  'شركة المنظفات المصرية': 35000,
  'شركة الدواء': 170000,
  'ميا فارم': 65000,
}
const paymentCheck = (supplier: string, amountEgp: number) => (r: any) => {
  const due = SUPPLIER_BALANCE[supplier]
  if (due == null || amountEgp * 100 > due) {
    return noCard(r) && typeof r.replyText === 'string' && /المستحق/.test(r.replyText)
  }
  return draft('payment')(r)
}
const collectionCheck = (customer: string) => (r: any) =>
  ZERO_DEBT.has(customer)
    ? noCard(r) &&
      typeof r.replyText === 'string' &&
      (
        /مديونيه|عربون|سلفه/.test(r.replyText) ||
        // The golden suite shares seeded customers across parallel cases. If a
        // concurrent case changed the balance, the over-collection guard is
        // also safe: it must not draft or post the excess as a settlement.
        /المبلغ أكبر من (?:المديونية|الدين)|مش هسجل زيادة|أعتبرها سداد/.test(r.replyText)
      )
    : draft('collection')(r)

const pick = <T,>(arr: readonly T[], i: number): T => arr[i % arr.length]

// ---------------------------------------------------------------------------
// Family builders — each returns EvalCase[]
// ---------------------------------------------------------------------------
function salesCases(): EvalCase[] {
  const out: EvalCase[] = []
  let i = 0
  const templates: Array<(item: string, unit: string, q: string, p: string, c: string) => string> = [
    (item, unit, q, p) => `بعت ${q} ${unit} ${item} بـ${p}`,
    (item, unit, q, p, c) => `بعت ${q} ${unit} ${item} ل${c} بـ${p}`,
    (item, unit, q, p) => `بيعت ${q} ${unit} ${item} بـ${p}`,
    (item, unit, q) => `بعت ${q} ${unit} ${item}`,
    (item, unit, q, p, c) => `${c} خد ${q} ${unit} ${item} بـ${p}`,
    (item, unit, q, p) => `سجلت بيع ${q} ${unit} ${item} بـ${p}`,
    (item, unit, q, p) => `الزبون خد ${q} ${unit} ${item} بـ${p}`,
  ]
  const verticals: Array<[EvalCase['vertical'], readonly { name: string; unit: string }[], readonly string[]]> = [
    ['supermarket', S.items as readonly { name: string; unit: string }[], S.customers],
    ['gym', S.gymItems as readonly { name: string; unit: string }[], S.gymCustomers],
    ['pharmacy', S.phItems as readonly { name: string; unit: string }[], S.phCustomers],
    ['attar', S.atItems as readonly { name: string; unit: string }[], S.atCustomers],
  ]
  for (const [vertical, items, customers] of verticals) {
    for (const it of items) {
      for (const t of templates) {
        const q = toAr(pick(QUANT, i + 1))
        const p = toAr(pick(AMT, i + 3))
        const text = t(it.name, it.unit, q, p, pick(customers, i))
        out.push({ text, vertical, expect: `بيع ${it.name} (قالب ${i % templates.length})`, check: draft('sale') })
        i++
      }
    }
  }
  return out
}

function purchasesCases(): EvalCase[] {
  const out: EvalCase[] = []
  let i = 0
  const mk = (vertical: EvalCase['vertical'], item: string, unit: string, supplier: string, p: number) => {
    const q = pick(QUANT, i + 2)
    const forms = [
      `جبت ${q} ${unit} ${item} من ${supplier}`,
      `اشتريت ${q} ${unit} ${item} بـ${toAr(p)}`,
      `جبت ${q} ${unit} ${item} من ${supplier} ودفعت ${toAr(p)} بس`,
    ]
    out.push({ text: forms[i % forms.length], vertical, expect: `شراء ${item}`, check: draft('purchase') })
    i++
  }
  S.items.forEach((it, k) => {
    if (k % 2 === 0) mk('supermarket', it.name, it.unit, S.suppliers[k % S.suppliers.length], pick(AMT, k + 4))
  })
  S.phItems.forEach((it, k) => {
    if (k % 2 === 0) mk('pharmacy', it.name, it.unit, S.phSuppliers[k % S.phSuppliers.length], pick(AMT, k + 2))
  })
  S.atItems.forEach((it, k) => {
    if (k % 2 === 0) mk('attar', it.name, it.unit, S.atSuppliers[k % S.atSuppliers.length], pick(AMT, k + 1))
  })
  S.gymItems.forEach((it, k) => {
    if (k % 2 === 0) mk('gym', it.name, it.unit, 'المورد العام', pick(AMT, k))
  })
  return out
}

function moneyFlowCases(): EvalCase[] {
  const out: EvalCase[] = []
  // collections
  S.customers.forEach((c, k) => {
    const p = pick(AMT, k + 1)
    out.push({ text: `حصلت ${toAr(p)} من ${c}`, vertical: 'supermarket', expect: `تحصيل من ${c}${ZERO_DEBT.has(c) ? ' (بلا دين: سؤال أو رفض آمن لأي تحصيل زائد)' : ''}`, check: collectionCheck(c) })
    out.push({ text: `${c} دفع ${toAr(p)}`, vertical: 'supermarket', expect: `تحصيل (اسم دفع) ${c}${ZERO_DEBT.has(c) ? ' (بلا دين: سؤال أو رفض آمن لأي تحصيل زائد)' : ''}`, check: collectionCheck(c) })
  })
  S.gymCustomers.forEach((c, k) => {
    const p = pick(AMT, k + 3)
    out.push({ text: `${c} سدد ${toAr(p)}`, vertical: 'gym', expect: `تحصيل جيم ${c}${ZERO_DEBT.has(c) ? ' (بلا دين: سؤال أو رفض آمن لأي تحصيل زائد)' : ''}`, check: collectionCheck(c) })
  })
  S.phCustomers.forEach((c, k) => {
    const p = pick(AMT, k + 5)
    out.push({ text: `حصلت من ${c} ${toAr(p)}`, vertical: 'pharmacy', expect: `تحصيل صيدلية ${c}${ZERO_DEBT.has(c) ? ' (بلا دين: سؤال أو رفض آمن لأي تحصيل زائد)' : ''}`, check: collectionCheck(c) })
  })
  S.atCustomers.forEach((c, k) => {
    const p = pick(AMT, k + 2)
    out.push({ text: `${c} دفع ${toAr(p)}`, vertical: 'attar', expect: `تحصيل عطارة ${c}${ZERO_DEBT.has(c) ? ' (بلا دين: سؤال أو رفض آمن لأي تحصيل زائد)' : ''}`, check: collectionCheck(c) })
  })
  // payments
  S.suppliers.forEach((s, k) => {
    const p = pick(AMT, k + 2)
    out.push({ text: `دفعت ${toAr(p)} ل${s}`, vertical: 'supermarket', expect: `دفعة لمورد ${s}`, check: paymentCheck(s, p) })
    out.push({ text: `سددت ${toAr(p)} ل${s}`, vertical: 'supermarket', expect: `سداد مورد ${s}`, check: paymentCheck(s, p) })
  })
  S.phSuppliers.forEach((s, k) => {
    const p = pick(AMT, k + 6)
    out.push({ text: `سددت ${toAr(p)} ل${s}`, vertical: 'pharmacy', expect: `سداد ${s}`, check: paymentCheck(s, p) })
  })
  S.atSuppliers.forEach((s, k) => {
    out.push({ text: `خلصت ${s}`, vertical: 'attar', expect: `تسوية ${s}`, check: (r: any) => cards()(r) || draft('payment')(r) || chat(8)(r) })
  })
  // expenses
  const descs = ['كهربا', 'إيجار', 'بنزين', 'نقليات', 'مياه', 'إنترنت', 'راتب مساعد', 'تغليف', 'ميكانيكا المبرد', 'قمامة']
  descs.forEach((d, k) => {
    const p = pick(AMT, k + 1)
    out.push({ text: `صرفت ${toAr(p)} ${d}`, vertical: 'supermarket', expect: `مصروف ${d}`, check: draft('expense') })
    out.push({ text: `مصروف ${d} ${toAr(p)}`, vertical: 'pharmacy', expect: `مصروف ${d} (صيدلية)`, check: draft('expense') })
  })
  return out
}

function gymCases(): EvalCase[] {
  const out: EvalCase[] = []
  const plans = ['شهر', 'سنوي', 'ربع سنوي'] as const
  S.gymCustomers.forEach((c, k) => {
    const p = pick(AMT, k + 2)
    out.push({ text: `اشتركت ${c} في الجيم ${plans[k % 3]} بـ${toAr(p)}`, vertical: 'gym', expect: `عضوية ${c}`, check: draft('membership') })
    out.push({ text: `جدد اشتراك ${c} ${plans[(k + 1) % 3]} بـ${toAr(p)}`, vertical: 'gym', expect: `تجديد ${c}`, check: draft('membership') })
    out.push({ text: `${c} حضر حصة`, vertical: 'gym', expect: `حضور ${c}`, check: (r: any) => draft('attendance')(r) || chat(8)(r) })
    out.push({ text: `باقي قد إيه ل${c}؟`, vertical: 'gym', expect: `استحقاق ${c}`, check: (r: any) => cards()(r) || chat(8)(r) })
  })
  out.push({ text: 'مين اللي عضويته قربت تخلص؟', vertical: 'gym', expect: 'عضويات قربت', check: (r: any) => cards()(r) || chat(8)(r) })
  return out
}

function readsCases(): EvalCase[] {
  const out: EvalCase[] = []
  const verticals = ['supermarket', 'gym', 'pharmacy', 'attar'] as const
  const itemLists = [S.items, S.gymItems, S.phItems, S.atItems]
  const item = (v: number, k: number) => itemLists[v][k % itemLists[v].length].name
  verticals.forEach((vertical, v) => {
    const reads = [
      'مبيعات النهارده كام؟',
      'مبيعات امبارح كام؟',
      'مبيعات الاسبوع كام؟',
      'إجماليات الشهر اللي فات',
      'الخزنة فيها كام؟',
      'الناقص إيه؟',
      `عندي كام ${item(v, 1)}؟`,
      `${item(v, 3)} فاضل قد إيه؟`,
      `عندي كام ${item(v, 5)}؟`,
      'مستحقات مين اللي كبير؟',
      'إيه اللي يبيع أكتر عندنا؟',
      'حاسبيني ربحي كام',
      'في إيه يلازم أتابعه النهارده؟',
      'مين قاعد عليا فلوس؟',
      'أداء العاملين إيه؟',
      'سعر ' + item(v, 2) + ' كام عندي؟',
    ]
    reads.forEach((text, k) => {
      out.push({ text, vertical, expect: `قراءة: ${text.slice(0, 24)}…`, check: (r: any) => cards()(r) || chat(10)(r) })
      void k
    })
  })
  return out
}

function multiIntentCases(): EvalCase[] {
  const out: EvalCase[] = []
  let i = 0
  const combos = [
    (a: string, b: string) => `بعت ${a} و بعت ${b}`,
    (a: string) => `${a} وصرفت ٥٠ بنزين`,
    (a: string) => `${a} وحصلت ١٠٠ من أول عميل`,
  ]
  const saleFrag = (v: number, k: number) => {
    const list = [S.items, S.gymItems, S.phItems, S.atItems][v]
    const it = list[k % list.length]
    return `${toAr(pick(QUANT, k))} ${it.unit} ${it.name} بـ${toAr(pick(AMT, k + 1))}`
  }
  ;(['supermarket', 'gym', 'pharmacy', 'attar'] as const).forEach((vertical, v) => {
    for (let k = 0; k < 4; k++) {
      const a = saleFrag(v, k)
      const b = saleFrag(v, k + 3)
      const text = combos[(k + i) % combos.length](a, b)
      out.push({ text, vertical, expect: 'مهمة مركبة (بيعان/بيع+مصروف/بيع+تحصيل)', check: (r: any) => anyDraft(['sale', 'expense', 'collection', 'payment'])(r) || cards()(r) || chat(10)(r) })
      i++
    }
  })
  return out
}

function guardCases(): EvalCase[] {
  const out: EvalCase[] = []
  // absurd quantities/amounts — the ladder must NOT silently accept
  for (const bad of ['٩٩٩٩٩', '١٠٠٠٠٠٠٠', '٠', '-٥']) {
    out.push({ text: `بعت ${bad} علبة تونة بـ٥٠`, vertical: 'supermarket', expect: 'كمية غير منطقية: يرفض/يسأل', check: all(noCard, saysNot('تم التسجيل')) })
  }
  for (const bad of ['٠', '٩٩٩٩٩٩٩']) {
    out.push({ text: `صرفت ${bad} إيجار`, vertical: 'supermarket', expect: 'مبلغ غير منطقي: يرفض/يسأل', check: all(noCard, saysNot('تم التسجيل')) })
  }
  // unknown party
  out.push({ text: 'بعت ٢ تونة لعميل اسمه أحمد زكي اللي مش معارفه', vertical: 'supermarket', expect: 'عميل غريب: مسودة نقدي/سؤال (بدون دين)', check: (r: any) => draft('sale')(r) || cards()(r) || chat(10)(r) })
  // zero-price sale
  out.push({ text: 'بعت ٣ زيت عافية بـ٠', vertical: 'supermarket', expect: 'سعر صفر: يسأل', check: (r: any) => noCard(r) || draft('sale')(r) })
  return out
}

function socialCases(): EvalCase[] {
  const out: EvalCase[] = []
  const lines = [
    ['صباح الفل', 'supermarket'],
    ['مساء الخير يا بطل', 'gym'],
    ['تسلم يدك', 'pharmacy'],
    ['عاش يا راجل', 'attar'],
    ['عامل إيه النهارده؟', 'supermarket'],
    ['شكراً على التاني', 'gym'],
    ['انت مين بالظبط؟', 'pharmacy'],
    ['اخبارك ايه يا عم؟', 'attar'],
    ['تقدر تعمل لي إيه تاني؟', 'supermarket'],
    ['أنا محتاج حد يفهمني في حسابي', 'gym'],
    ['المحل قاعد من امبارح', 'pharmacy'],
    ['بفكر أزود أصناف', 'attar'],
    ['العملاء قليل النهارده', 'supermarket'],
    ['المصاريف شغالة', 'gym'],
    ['مين أصدق زبايني؟', 'pharmacy'],
    ['عايز أرفع أسعار شوية', 'attar'],
    ['إيه اللي يفضله الناس عندنا؟', 'supermarket'],
    ['أزود ساعات الشغل؟', 'gym'],
    ['في منافس افتتح جنبنا', 'pharmacy'],
    ['حسبيتي مش مظبوطة ولا إيه؟', 'attar'],
  ] as const
  for (const [text, vertical] of lines) {
    out.push({ text, vertical: vertical as EvalCase['vertical'], expect: 'دردشة/استشارة بذكاء', check: chat(10) })
  }
  return out
}

function r46Cases(): EvalCase[] {
  const out: EvalCase[] = []
  const harnessLines: Array<[string, EvalCase['vertical']]> = [
    ['اريدك تشتغل على برنامج دافتره عندنا', 'supermarket'],
    ['خليك تقدر تعمل عمليات على دافتره', 'supermarket'],
    ['ابنيلي ربط على برنامج الامين', 'pharmacy'],
    ['عايزك توصل مع برنامجنا ودايركتم', 'attar'],
    ['اربط لي الاكسيل اللي فيه مبيعاتي', 'supermarket'],
    ['اقرا لي آخر ملف اكسيل عندي', 'supermarket'],
    ['عملتي ايه في ملف المبيعات دي؟', 'supermarket'],
    ['عايزك تسجل لي في البرنامج بتاعنا', 'gym'],
    ['لو فيه تطبيق قدامك تقدر تشتغل عليه قوللي', 'attar'],
    ['كيفاش تقدر توصل ببرامجي؟', 'pharmacy'],
  ]
  for (const [text, vertical] of harnessLines) {
    out.push({ text, vertical, expect: 'طلب ربط برنامج: رد صادق (إذن/توجيه/شرح)', check: (r: any) => chat(10)(r) || cards()(r) })
  }
  return out
}

// ---------------------------------------------------------------------------
function salesWithCustomers(): EvalCase[] {
  // every item × every customer — the full cross product a real shop lives
  const out: EvalCase[] = []
  const verticals: Array<[EvalCase['vertical'], readonly { name: string; unit: string }[], readonly string[]]> = [
    ['supermarket', S.items as readonly { name: string; unit: string }[], S.customers],
    ['gym', S.gymItems as readonly { name: string; unit: string }[], S.gymCustomers],
    ['pharmacy', S.phItems as readonly { name: string; unit: string }[], S.phCustomers],
    ['attar', S.atItems as readonly { name: string; unit: string }[], S.atCustomers],
  ]
  let i = 0
  for (const [vertical, items, customers] of verticals) {
    for (const it of items) {
      for (const c of customers) {
        const q = pick(QUANT, i + 1)
        const p = pick(AMT, i + 5)
        const text = `بعت ${toAr(q)} ${it.unit} ${it.name} ل${c} بـ${toAr(p)}`
        out.push({ text, vertical, expect: `بيع ${it.name} → ${c}`, check: draft('sale') })
        i++
      }
    }
  }
  return out
}

function priceQueries(): EvalCase[] {
  const out: EvalCase[] = []
  const lists: Array<[EvalCase['vertical'], readonly { name: string }[]]> = [
    ['supermarket', S.items as readonly { name: string }[]],
    ['pharmacy', S.phItems as readonly { name: string }[]],
    ['attar', S.atItems as readonly { name: string }[]],
    ['gym', S.gymItems as readonly { name: string }[]],
  ]
  let i = 0
  for (const [vertical, items] of lists) {
    items.forEach((it, k) => {
      out.push({ text: `سعر ${it.name} كام عندنا؟`, vertical, expect: `سعر ${it.name}`, check: (r: any) => cards()(r) || chat(8)(r) })
      if (k % 3 === 0) out.push({ text: `كام ${it.name} عندك؟`, vertical, expect: `مخزون ${it.name}`, check: (r: any) => cards()(r) || chat(8)(r) })
      i++
    })
  }
  return out
}

function moreExpenses(): EvalCase[] {
  const out: EvalCase[] = []
  const descs = ['صيانة فريزر', 'تغليف طلبات', 'دعاية بوسترات', 'سكر مضاف', 'فلوس محطة', 'ميكانيكا باب', 'تكييف', 'نظافة', 'كهربا تاني', 'مياه تاني']
  descs.forEach((d, k) => {
    const p = pick(AMT, k + 2)
    out.push({ text: `صرفت ${toAr(p)} ${d}`, vertical: 'gym', expect: `مصروف جيم: ${d}`, check: draft('expense') })
    out.push({ text: `مصروف ${d} ${toAr(p)}`, vertical: 'attar', expect: `مصروف عطارة: ${d}`, check: draft('expense') })
  })
  return out
}

function attendanceVariants(): EvalCase[] {
  const out: EvalCase[] = []
  const verbs = ['حضر حصة', 'جاء حصة النهارده', 'لعب حصة النهارده', 'حضر']
  S.gymCustomers.forEach((c, k) => {
    out.push({ text: `${c} ${verbs[k % verbs.length]}`, vertical: 'gym', expect: `حضور ${c} (صيغة ${k % verbs.length})`, check: (r: any) => draft('attendance')(r) || chat(8)(r) })
  })
  return out
}

function debtQueries(): EvalCase[] {
  const out: EvalCase[] = []
  S.customers.forEach((c, k) => {
    out.push({ text: `باقي قد إيه على ${c}؟`, vertical: 'supermarket', expect: `دين ${c}`, check: (r: any) => cards()(r) || chat(8)(r) })
  })
  S.atCustomers.forEach((c) => {
    out.push({ text: `باقي قد إيه على ${c}؟`, vertical: 'attar', expect: `دين ${c}`, check: (r: any) => cards()(r) || chat(8)(r) })
  })
  return out
}

export function generateCases(): EvalCase[] {
  const all_ = [
    ...salesCases(),
    ...salesWithCustomers(),
    ...priceQueries(),
    ...moreExpenses(),
    ...attendanceVariants(),
    ...debtQueries(),
    ...purchasesCases(),
    ...moneyFlowCases(),
    ...gymCases(),
    ...readsCases(),
    ...multiIntentCases(),
    ...guardCases(),
    ...socialCases(),
    ...r46Cases(),
  ]
  // de-duplicate by (text, vertical)
  const seen = new Set<string>()
  return all_.filter((c) => {
    const k = c.vertical + '||' + c.text
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
