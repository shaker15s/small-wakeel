// prisma/seed.ts — وكيل (Wakil) demo data seed
// ---------------------------------------------------------------------------
// Run from the project root:   bun prisma/seed.ts
//
// Wipes all data, then seeds:
//   • 4 demo businesses (سوبر ماركت النور / جيم أبطال / صيدلية الشفاء / عطارة المسك)
//     with users, items, customers, suppliers, operations (WKL-#### refs),
//     cash entries and a full audit trail. Every operation's effect is already
//     reflected in the final balances / cash / stock numbers (verified at the end).
//   • Agent settings, memories, scheduled tasks and one conversation
//     (user + assistant with thinking steps + result cards) per business.
//   • 2 demo model providers (pointing at the mock-provider mini-service on
//     port 3031) with 4 model configs each.
//
// MONEY IS ALWAYS INTEGER PIASTRES (1 EGP = 100 piastres) — never floats.
// Dates: at(daysFromToday, hour, minute) — spread over today and the last 6 days.
// ---------------------------------------------------------------------------

import { db } from '../src/lib/db'

/* ============================== tiny helpers ============================= */

const DAY = 86_400_000

/** Date at (today + `days`) with a fixed time of day. */
function at(days: number, h: number, m = 0, s = 0): Date {
  const d = new Date(Date.now() + days * DAY)
  d.setHours(h, m, s, 0)
  return d
}

function iso(d: Date): string {
  return d.toISOString()
}

function j(x: unknown): string {
  return JSON.stringify(x)
}

const AR_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩']

/** Arabic-Indic formatted number (like Intl ar-EG, ICU-independent). */
function arNum(n: number): string {
  return n
    .toLocaleString('en-US', { maximumFractionDigits: 2 })
    .replace(/[0-9]/g, (d) => AR_DIGITS[Number(d)])
}

/** Piastres → «٤٬٢٨٨ ج.م» */
function egp(piastres: number): string {
  return `${arNum(piastres / 100)} ج.م`
}

/* ------------------------------- data shapes ------------------------------ */

interface UserDef {
  name: string
  role: string // owner | cashier | reception | supervisor
  title?: string
}

interface ItemDef {
  name: string
  aliases?: string
  unit: string
  category: string
  cost: number // piastres per unit
  sell: number
  qty: number
  low: number
  batchNo?: string
  expiresAt?: Date
}

interface CustomerDef {
  name: string
  phone?: string
  balance: number // piastres, + owes us
  plan?: string
  expiresAt?: Date
}

interface SupplierDef {
  name: string
  phone?: string
  balance: number // piastres, + we owe them
}

interface OpInput {
  type: string
  risk: string
  summary: string
  payload: Record<string, unknown>
  userId: string
  status?: string // default SUCCEEDED
  source?: string // default chat
  result?: Record<string, unknown>
  reason?: string
  createdAt: Date
  executedAt?: Date
  decidedAt?: Date
  approverId?: string // who approved (for the audit trail)
  cash?: { direction: 'in' | 'out'; amount: number; reason: string }
  reversalOfRef?: string
}

interface TaskDef {
  title: string
  tool: string
  fields: Record<string, unknown>
  whenLabel: string
  scheduledFor: Date
  createdAt: Date
  recurrence?: string
  status: string
  result?: string
  executedAt?: Date
}

interface MemoryDef {
  kind: string // fact | preference
  text: string
  at: Date
}

interface SeedResult {
  key: string
  name: string
  type: string
  businessId: string
  ownerId: string
  ownerName: string
  opSeq: number
  expectedCash: { in: number; out: number; net: number }
  expectedLowStock: number
}

interface SaleLine {
  name: string
  qty: number
  unit: string
  unitPrice: number
}

const L = (name: string, qty: number, unit: string, unitPrice: number): SaleLine => ({
  name,
  qty,
  unit,
  unitPrice,
})

const T = (ls: SaleLine[]): number => ls.reduce((s, l) => s + l.qty * l.unitPrice, 0)

const applied = (ls: SaleLine[], sign: 1 | -1) => ls.map((l) => ({ name: l.name, qty: sign * l.qty }))

/* ============================ generic creators ============================ */

async function createUsers(businessId: string, defs: UserDef[]) {
  const out: Record<string, { id: string; name: string }> = {}
  for (const def of defs) {
    const u = await db.user.create({
      data: { businessId, name: def.name, role: def.role, title: def.title ?? null },
    })
    out[def.role] = { id: u.id, name: u.name }
  }
  return out
}

async function createItems(businessId: string, defs: ItemDef[]) {
  for (const d of defs) {
    await db.item.create({
      data: {
        businessId,
        name: d.name,
        aliases: d.aliases ?? '',
        unit: d.unit,
        category: d.category,
        costPrice: d.cost,
        sellPrice: d.sell,
        stockQty: d.qty,
        lowStockThreshold: d.low,
        batchNo: d.batchNo ?? null,
        expiresAt: d.expiresAt ?? null,
      },
    })
  }
}

async function createCustomers(businessId: string, defs: CustomerDef[]) {
  for (const d of defs) {
    await db.customer.create({
      data: {
        businessId,
        name: d.name,
        phone: d.phone ?? null,
        balance: d.balance,
        plan: d.plan ?? null,
        expiresAt: d.expiresAt ?? null,
      },
    })
  }
}

async function createSuppliers(businessId: string, defs: SupplierDef[]) {
  for (const d of defs) {
    await db.supplier.create({
      data: { businessId, name: d.name, phone: d.phone ?? null, balance: d.balance },
    })
  }
}

/**
 * Operation factory: WKL-#### refs + cash entry + audit trail in one call.
 * SUCCEEDED ops get created → approved → executed audit events;
 * AWAITING_APPROVAL ops get created → approval_requested.
 */
function opFactory(businessId: string, startSeq: number) {
  let seq = startSeq

  async function create(o: OpInput) {
    const ref = `WKL-${++seq}`
    const status = o.status ?? 'SUCCEEDED'
    const decidedAt =
      o.decidedAt ?? (status === 'SUCCEEDED' ? new Date(o.createdAt.getTime() + 60_000) : null)
    const executedAt =
      o.executedAt ?? (status === 'SUCCEEDED' ? new Date(o.createdAt.getTime() + 120_000) : null)

    const op = await db.operation.create({
      data: {
        ref,
        businessId,
        type: o.type,
        status,
        source: o.source ?? 'chat',
        userId: o.userId,
        risk: o.risk,
        summary: o.summary,
        payload: j(o.payload),
        result: o.result ? j(o.result) : null,
        idempotencyKey: `seed-${businessId}-${ref}`,
        reason: o.reason ?? null,
        createdAt: o.createdAt,
        decidedAt,
        executedAt,
        reversalOfRef: o.reversalOfRef ?? null,
      },
    })

    if (o.cash) {
      await db.cashEntry.create({
        data: {
          businessId,
          direction: o.cash.direction,
          amount: o.cash.amount,
          reason: o.cash.reason,
          ref,
          createdAt: executedAt ?? o.createdAt,
        },
      })
    }

    await db.auditEvent.create({
      data: {
        businessId,
        actor: o.userId,
        action: 'operation.created',
        ref,
        detail: j({ type: o.type, risk: o.risk, summary: o.summary, status }),
        createdAt: o.createdAt,
      },
    })

    if (status === 'SUCCEEDED') {
      await db.auditEvent.create({
        data: {
          businessId,
          actor: o.approverId ?? o.userId,
          action: 'operation.approved',
          ref,
          detail: j({ type: o.type, risk: o.risk, reason: o.reason ?? null }),
          createdAt: decidedAt ?? o.createdAt,
        },
      })
      await db.auditEvent.create({
        data: {
          businessId,
          actor: 'agent',
          action: 'operation.executed',
          ref,
          detail: j({
            summary: o.summary,
            cash: o.cash ? { direction: o.cash.direction, amount: o.cash.amount } : null,
          }),
          createdAt: executedAt ?? o.createdAt,
        },
      })
    } else if (status === 'AWAITING_APPROVAL') {
      await db.auditEvent.create({
        data: {
          businessId,
          actor: 'agent',
          action: 'operation.approval_requested',
          ref,
          detail: j({ risk: o.risk, summary: o.summary }),
          createdAt: o.createdAt,
        },
      })
    }

    return op
  }

  return { create, currentSeq: () => seq }
}

async function createOpeningCash(
  businessId: string,
  ownerId: string,
  amount: number,
  when: Date,
) {
  await db.cashEntry.create({
    data: { businessId, direction: 'in', amount, reason: 'افتتاح الخزنة', createdAt: when },
  })
  await db.auditEvent.create({
    data: {
      businessId,
      actor: ownerId,
      action: 'cash.opening',
      detail: j({ amount, reason: 'افتتاح الخزنة' }),
      createdAt: when,
    },
  })
}

async function createSettings(businessId: string, vertical: string, tone = 'friendly') {
  await db.agentSettings.create({ data: { businessId, vertical, tone } })
}

async function createMemories(businessId: string, userId: string, defs: MemoryDef[]) {
  for (const d of defs) {
    await db.agentMemory.create({
      data: { businessId, userId, kind: d.kind, text: d.text, createdAt: d.at },
    })
  }
}

async function createTasks(businessId: string, userId: string, defs: TaskDef[]) {
  for (const d of defs) {
    await db.scheduledTask.create({
      data: {
        businessId,
        userId,
        title: d.title,
        tool: d.tool,
        fields: j(d.fields),
        whenLabel: d.whenLabel,
        scheduledFor: d.scheduledFor,
        recurrence: d.recurrence ?? null,
        status: d.status,
        result: d.result ?? null,
        failReason: null,
        executedAt: d.executedAt ?? null,
        createdAt: d.createdAt,
      },
    })
  }
}

interface AssistantMsg {
  text: string
  thinking: unknown[]
  cards?: unknown[]
  card?: unknown
  modelLabel: string
}

async function createConversation(
  businessId: string,
  userId: string,
  title: string,
  when: Date,
  userText: string,
  assistant: AssistantMsg,
) {
  const conv = await db.conversation.create({ data: { businessId, userId, title, createdAt: when } })
  await db.message.create({
    data: { conversationId: conv.id, role: 'user', text: userText, createdAt: when },
  })
  await db.message.create({
    data: {
      conversationId: conv.id,
      role: 'assistant',
      text: assistant.text,
      thinking: j(assistant.thinking),
      cards: assistant.cards ? j(assistant.cards) : null,
      card: assistant.card ? j(assistant.card) : null,
      modelLabel: assistant.modelLabel,
      createdAt: new Date(when.getTime() + 90_000),
    },
  })
  return conv
}

/* ============================ 1) سوبر ماركت النور ========================= */

async function seedSupermarket(): Promise<SeedResult> {
  console.log('🛒  سوبر ماركت النور …')
  const b = await db.business.create({
    data: {
      name: 'سوبر ماركت النور',
      type: 'supermarket',
      openingCash: 500_000,
      createdAt: at(-180, 9),
    },
  })

  const users = await createUsers(b.id, [
    { name: 'خالد', role: 'owner', title: 'صاحب المحل' },
    { name: 'سعاد', role: 'cashier', title: 'كاشير' },
    { name: 'محمود', role: 'supervisor', title: 'مشرف وردية' },
  ])
  const so = users.owner.id // خالد
  const sa = users.cashier.id // سعاد

  // 20 أصناف — أسعار بالقروش (لبن sellPrice 4500 = 45 ج). 4 أصناف تحت حد الطلب.
  await createItems(b.id, [
    { name: 'لبن كرتونة (جهينة)', aliases: 'لبن, لبن جهينة, كرتونة لبن', unit: 'box', category: 'ألبان', cost: 4000, sell: 4500, qty: 60, low: 20 },
    { name: 'سكر معبأ كيلو', aliases: 'سكر, سكر كيلو', unit: 'kg', category: 'بقالة', cost: 3000, sell: 3400, qty: 120, low: 30 },
    { name: 'رز مصري كيلو', aliases: 'رز, أرز', unit: 'kg', category: 'بقالة', cost: 2800, sell: 3200, qty: 85, low: 25 },
    { name: 'زيت عافية 800 مل', aliases: 'زيت, زيت عافية', unit: 'piece', category: 'زيوت', cost: 5800, sell: 6500, qty: 40, low: 12 },
    { name: 'تونة قطع 140 جرام', aliases: 'تونة', unit: 'piece', category: 'معلبات', cost: 2000, sell: 2400, qty: 90, low: 24 },
    { name: 'مكرونة اسباجتي 400 جرام', aliases: 'مكرونة, اسباجتي', unit: 'piece', category: 'معلبات', cost: 1100, sell: 1400, qty: 150, low: 40 },
    { name: 'شاي العروسة 250 جرام', aliases: 'شاي, العروسة', unit: 'piece', category: 'مشروبات', cost: 3500, sell: 4000, qty: 55, low: 15 },
    { name: 'قهوة أحمد 250 جرام', aliases: 'قهوة, قهوة أحمد', unit: 'piece', category: 'مشروبات', cost: 8500, sell: 9500, qty: 30, low: 10 },
    { name: 'صابون دوف 90 جرام', aliases: 'صابون, دوف', unit: 'piece', category: 'منظفات', cost: 1500, sell: 1900, qty: 70, low: 20 },
    { name: 'ديتول مطهر 750 مل', aliases: 'ديتول', unit: 'piece', category: 'منظفات', cost: 7500, sell: 8500, qty: 6, low: 8 },
    { name: 'بيض طبق (30 بيضة)', aliases: 'بيض, طبق بيض', unit: 'piece', category: 'طازج', cost: 14000, sell: 16500, qty: 8, low: 10 },
    { name: 'ماء بركة 1.5 لتر', aliases: 'ماء, ميه بركة', unit: 'piece', category: 'مشروبات', cost: 500, sell: 700, qty: 200, low: 48 },
    { name: 'كوكاكولا 1 لتر', aliases: 'كولا, كوكاكولا', unit: 'piece', category: 'مشروبات', cost: 1800, sell: 2200, qty: 20, low: 24 },
    { name: 'جبنة رومي كيلو', aliases: 'جبنة رومي, رومي', unit: 'kg', category: 'ألبان', cost: 12000, sell: 14500, qty: 25, low: 8 },
    { name: 'عدس أصفر كيلو', aliases: 'عدس', unit: 'kg', category: 'بقالة', cost: 3200, sell: 3700, qty: 9, low: 12 },
    { name: 'فول مدمس معلب 400 جرام', aliases: 'فول', unit: 'piece', category: 'معلبات', cost: 900, sell: 1200, qty: 100, low: 30 },
    { name: 'مربى فراولة 350 جرام', aliases: 'مربى', unit: 'piece', category: 'بقالة', cost: 2500, sell: 3000, qty: 35, low: 10 },
    { name: 'كلوركس 1 لتر', aliases: 'كلوروكس, كلور', unit: 'piece', category: 'منظفات', cost: 2200, sell: 2700, qty: 45, low: 12 },
    { name: 'بسكويت أوريو', aliases: 'اوريو, بسكويت', unit: 'piece', category: 'حلويات', cost: 1200, sell: 1500, qty: 80, low: 20 },
    { name: 'مناديل فاين 200', aliases: 'مناديل, فاين', unit: 'piece', category: 'منظفات', cost: 1800, sell: 2200, qty: 50, low: 15 },
  ])

  await createCustomers(b.id, [
    { name: 'أحمد عبد الرحمن', phone: '0100 123 4567', balance: 42_300 },
    { name: 'أم حسن', phone: '0111 987 6543', balance: 12_500 },
    { name: 'كافتيريا النور', phone: '0122 345 6789', balance: 0 },
    { name: 'سمير غنيم', balance: 0 },
    { name: 'مطعم الشام', balance: 0 },
  ])

  await createSuppliers(b.id, [
    { name: 'شركة الألبان الوطنية', phone: '022 345 6789', balance: 10_000 },
    { name: 'محمد تاجر الجملة', phone: '0100 555 4433', balance: 0 },
    { name: 'شركة المنظفات المصرية', balance: 35_000 },
    { name: 'عادل موزع البيض', balance: 0 },
  ])

  // افتتاح الخزنة ٥٠٠٠ ج
  await createOpeningCash(b.id, so, 500_000, at(-6, 0, 5))

  const ops = opFactory(b.id, 1000)

  // أسبوع حقيقي من العمليات (المبالغ كلها بالقروش)
  const s1 = [L('لبن كرتونة (جهينة)', 2, 'box', 4500), L('زيت عافية 800 مل', 1, 'piece', 6500), L('تونة قطع 140 جرام', 3, 'piece', 2400)]
  await ops.create({
    type: 'sale', risk: 'R2', userId: sa, approverId: so, createdAt: at(-6, 9, 35),
    summary: 'بيع نقدي: ٢ لبن كرتونة + ١ زيت عافية + ٣ تونة قطع',
    payload: { lines: s1, payment: 'cash', total: T(s1) },
    result: { total: T(s1), cashDelta: T(s1), stockApplied: applied(s1, -1) },
    cash: { direction: 'in', amount: T(s1), reason: 'بيع نقدي — كاشير سعاد' },
  })

  const p1 = [L('لبن كرتونة (جهينة)', 40, 'box', 4000)]
  await ops.create({
    type: 'purchase', risk: 'R2', userId: so, createdAt: at(-6, 13, 10),
    summary: 'شرا بالآجل: ٤٠ كرتونة لبن من شركة الألبان الوطنية',
    payload: { lines: p1, supplier: 'شركة الألبان الوطنية', payment: 'credit', total: T(p1) },
    result: { total: T(p1), supplierBalanceAfter: 170_000, stockApplied: applied(p1, 1) },
  })

  await ops.create({
    type: 'expense', risk: 'R2', userId: sa, approverId: so, createdAt: at(-5, 11, 0),
    summary: 'مصروف كهرباء — ٣٥٠ ج',
    payload: { category: 'كهرباء', amount: 35_000, note: 'فاتورة كهرباء الشهر' },
    result: { recorded: true, amount: 35_000, cashDelta: -35_000 },
    cash: { direction: 'out', amount: 35_000, reason: 'مصروف كهرباء' },
  })

  const s4 = [L('لبن كرتونة (جهينة)', 5, 'box', 4500), L('سكر معبأ كيلو', 3, 'kg', 3400)]
  await ops.create({
    type: 'sale', risk: 'R2', userId: sa, approverId: so, createdAt: at(-5, 12, 20),
    summary: 'بيع بالآجل للعميل أحمد: ٥ لبن كرتونة + ٣ سكر معبأ',
    payload: { lines: s4, customer: 'أحمد عبد الرحمن', payment: 'credit', total: T(s4) },
    result: { total: T(s4), customerBalanceAfter: 75_000, stockApplied: applied(s4, -1) },
  })

  const p5 = [L('تونة قطع 140 جرام', 24, 'piece', 2000)]
  await ops.create({
    type: 'purchase', risk: 'R2', userId: so, createdAt: at(-4, 10, 15),
    summary: 'شرا نقدي: ٢٤ علبة تونة من محمد تاجر الجملة',
    payload: { lines: p5, supplier: 'محمد تاجر الجملة', payment: 'cash', total: T(p5) },
    result: { total: T(p5), supplierBalanceAfter: 0, cashDelta: -T(p5), stockApplied: applied(p5, 1) },
    cash: { direction: 'out', amount: T(p5), reason: 'شرا تونة — محمد تاجر الجملة' },
  })

  const s6 = [L('مكرونة اسباجتي 400 جرام', 4, 'piece', 1400), L('ماء بركة 1.5 لتر', 6, 'piece', 700)]
  const o6 = await ops.create({
    type: 'sale', risk: 'R2', userId: sa, approverId: so, createdAt: at(-4, 18, 45),
    summary: 'بيع نقدي: ٤ مكرونة اسباجتي + ٦ ماء بركة',
    payload: { lines: s6, payment: 'cash', total: T(s6) },
    result: { total: T(s6), cashDelta: T(s6), stockApplied: applied(s6, -1) },
    cash: { direction: 'in', amount: T(s6), reason: 'بيع نقدي — كاشير سعاد' },
  })

  const s7 = [L('جبنة رومي كيلو', 1, 'kg', 14500), L('شاي العروسة 250 جرام', 2, 'piece', 4000)]
  await ops.create({
    type: 'sale', risk: 'R2', userId: sa, approverId: so, createdAt: at(-3, 12, 5),
    summary: 'بيع نقدي: ١ جبنة رومي كيلو + ٢ شاي العروسة',
    payload: { lines: s7, payment: 'cash', total: T(s7) },
    result: { total: T(s7), cashDelta: T(s7), stockApplied: applied(s7, -1) },
    cash: { direction: 'in', amount: T(s7), reason: 'بيع نقدي — كاشير سعاد' },
  })

  await ops.create({
    type: 'expense', risk: 'R2', userId: users.supervisor.id, approverId: so, createdAt: at(-3, 16, 30),
    summary: 'مصروف صيانة ثلاجات العرض — ٤٨٠ ج',
    payload: { category: 'صيانة', amount: 48_000, note: 'فني تبريد — ضغط كومبروسر الثلاجة' },
    result: { recorded: true, amount: 48_000, cashDelta: -48_000 },
    cash: { direction: 'out', amount: 48_000, reason: 'صيانة ثلاجات العرض' },
  })

  const s9 = [L('بيض طبق (30 بيضة)', 2, 'piece', 16500), L('قهوة أحمد 250 جرام', 1, 'piece', 9500)]
  await ops.create({
    type: 'sale', risk: 'R2', userId: sa, approverId: so, createdAt: at(-3, 19, 10),
    summary: 'بيع بالآجل للعميل أحمد: ٢ طبق بيض + ١ قهوة أحمد',
    payload: { lines: s9, customer: 'أحمد عبد الرحمن', payment: 'credit', total: T(s9) },
    result: { total: T(s9), customerBalanceAfter: 117_500, stockApplied: applied(s9, -1) },
  })

  await ops.create({
    type: 'collection', risk: 'R2', userId: sa, approverId: so, createdAt: at(-2, 14, 0),
    summary: 'تحصيل ٣٢٥ ج من العميل أحمد عبد الرحمن',
    payload: { customer: 'أحمد عبد الرحمن', amount: 32_500 },
    result: { customerBalanceAfter: 85_000, cashDelta: 32_500 },
    cash: { direction: 'in', amount: 32_500, reason: 'تحصيل من العميل أحمد عبد الرحمن' },
  })

  await ops.create({
    type: 'payment', risk: 'R2', userId: so, createdAt: at(-2, 17, 20),
    summary: 'سداد ٥٠٠ ج لشركة الألبان الوطنية',
    payload: { supplier: 'شركة الألبان الوطنية', amount: 50_000 },
    result: { supplierBalanceAfter: 120_000, cashDelta: -50_000 },
    cash: { direction: 'out', amount: 50_000, reason: 'سداد لمورد شركة الألبان الوطنية' },
  })

  const s12 = [L('لبن كرتونة (جهينة)', 2, 'box', 4500), L('بيض طبق (30 بيضة)', 1, 'piece', 16500), L('كوكاكولا 1 لتر', 3, 'piece', 2200)]
  await ops.create({
    type: 'sale', risk: 'R2', userId: sa, approverId: so, createdAt: at(0, 10, 30),
    summary: 'بيع نقدي: ٢ لبن كرتونة + ١ طبق بيض + ٣ كوكاكولا',
    payload: { lines: s12, payment: 'cash', total: T(s12) },
    result: { total: T(s12), cashDelta: T(s12), stockApplied: applied(s12, -1) },
    cash: { direction: 'in', amount: T(s12), reason: 'بيع نقدي — كاشير سعاد' },
  })

  // مسودة بيع بالآجل مستنية اعتماد المشرف (R2)
  const s13 = [L('لبن كرتونة (جهينة)', 3, 'box', 4500), L('سكر معبأ كيلو', 2, 'kg', 3400), L('مربى فراولة 350 جرام', 1, 'piece', 3000)]
  await ops.create({
    type: 'sale', risk: 'R2', status: 'AWAITING_APPROVAL', userId: sa, createdAt: at(0, 11, 5),
    summary: 'بيع بالآجل لأم حسن: ٣ لبن كرتونة + ٢ سكر + ١ مربى فراولة — مستني اعتماد',
    payload: { lines: s13, customer: 'أم حسن', payment: 'credit', total: T(s13) },
  })

  // عكس عملية بيع ناجحة (R3 — بسبب مكتوب)
  const o14 = await ops.create({
    type: 'reversal', risk: 'R3', userId: so, createdAt: at(0, 12, 10),
    summary: `عكس عملية بيع ${o6.ref} — رد ٩٨ ج للعميل`,
    reason: 'فاتورة اتسجلت مرتين بالغلط — العميل دفع مرة واحدة',
    payload: { ref: o6.ref, reason: 'فاتورة اتسجلت مرتين بالغلط' },
    result: { reversed: true, ref: o6.ref, cashDelta: -9_800 },
    cash: { direction: 'out', amount: 9_800, reason: `عكس عملية ${o6.ref}` },
    reversalOfRef: o6.ref,
  })
  await db.operation.update({ where: { id: o6.id }, data: { reversedByRef: o14.ref } })

  // إعدادات الوكيل + الذاكرة + المهام
  await createSettings(b.id, 'supermarket')
  await createMemories(b.id, so, [
    { kind: 'fact', text: 'العميل أحمد عبد الرحمن بيشتري بالآجل دايماً ويسدد آخر الشهر', at: at(-3, 10, 0) },
    { kind: 'fact', text: 'أستاذ خالد بيقفل الخزنة الساعة ١٢ بالليل وبيراجع الفواتير قبل القفل', at: at(-2, 15, 0) },
    { kind: 'preference', text: 'في التقرير اليومي: أرقام مختصرة في جدول من غير شرح طويل', at: at(-1, 20, 0) },
  ])
  await createTasks(b.id, so, [
    {
      title: 'فحص المخزون الناقص',
      tool: 'list_low_stock',
      fields: {},
      whenLabel: 'كل يوم الساعة ٩ صباحاً',
      scheduledFor: at(1, 9),
      createdAt: at(0, 8, 30),
      recurrence: 'daily',
      status: 'pending',
    },
    {
      title: 'إيه وضع الخزنة؟',
      tool: 'get_cash_position',
      fields: {},
      whenLabel: 'امبارح ٩ مساءً',
      scheduledFor: at(-1, 21),
      createdAt: at(-2, 20, 0),
      status: 'done',
      result: j({ in: 619_600, out: 190_800, net: 428_800 }),
      executedAt: at(-1, 21, 0, 30),
    },
  ])

  // محادثة تاريخية واقعية: سؤال + رد بتفكير وكارتين نتائج
  await createConversation(
    b.id,
    so,
    'وضع الخزنة والمخزون الناقص',
    at(0, 9, 20),
    'صباح الخير يا وكيل — إيه وضع الخزنة النهاردة؟ وفين المخزون الناقص؟',
    {
      modelLabel: 'عميق مفكّر · glm-4.6',
      text: `صباح النور يا أستاذ خالد ☀️
الخزنة دلوقتي فيها صافي ${egp(428_800)} (داخل ${egp(619_600)} شامل افتتاح ${egp(500_000)} — خارج ${egp(190_800)}).
وفي ${arNum(4)} أصناف تحت حد الطلب — أخطرهم البيض والديتول.
جهزتلك الجدول تحت، وتحب أجهزلك أمر شرا من الموردين؟`,
      thinking: [
        { label: 'بفهم الطلب', detail: 'أستاذ خالد عايز وضع الخزنة + قائمة المخزون الناقص', state: 'done', icon: 'understand' },
        { label: 'بجمع حركات الخزنة', detail: 'جمعت كل حركات الداخل والخارج من أول الافتتاح', state: 'done', icon: 'search' },
        { label: 'بفحص المخزون', detail: 'قارنت المتبقي بحد الطلب لكل صنف — طلعت ٤ أصناف', state: 'done', icon: 'plan' },
        { label: 'بجهز الرد', detail: 'جدول للمخزون الناقص + ملخص الخزنة بالأرقام', state: 'done', icon: 'verify' },
      ],
      cards: [
        {
          kind: 'table',
          title: 'المخزون الناقص',
          columns: [
            { key: 'name', label: 'الصنف', align: 'start' },
            { key: 'remaining', label: 'المتبقي', align: 'end' },
            { key: 'threshold', label: 'حد الطلب', align: 'end' },
            { key: 'unit', label: 'الوحدة', align: 'start' },
          ],
          rows: [
            { name: 'ديتول مطهر ٧٥٠ مل', remaining: arNum(6), threshold: arNum(8), unit: 'قطعة' },
            { name: 'بيض طبق (٣٠ بيضة)', remaining: arNum(8), threshold: arNum(10), unit: 'طبق' },
            { name: 'كوكاكولا ١ لتر', remaining: arNum(20), threshold: arNum(24), unit: 'قطعة' },
            { name: 'عدس أصفر كيلو', remaining: arNum(9), threshold: arNum(12), unit: 'كيلو' },
          ],
          footer: [{ label: 'أصناف ناقصة', value: arNum(4) }],
        },
        {
          kind: 'kv',
          title: 'وضع الخزنة',
          rows: [
            { label: 'افتتاح الخزنة', value: egp(500_000) },
            { label: 'إجمالي الداخل', value: egp(619_600) },
            { label: 'إجمالي الخارج', value: egp(190_800) },
            { label: 'الصافي دلوقتي', value: egp(428_800) },
          ],
        },
      ],
    },
  )

  await db.business.update({ where: { id: b.id }, data: { opSeq: ops.currentSeq() } })

  return {
    key: 'market',
    name: b.name,
    type: b.type,
    businessId: b.id,
    ownerId: users.owner.id,
    ownerName: users.owner.name,
    opSeq: ops.currentSeq(),
    expectedCash: { in: 619_600, out: 190_800, net: 428_800 },
    expectedLowStock: 4,
  }
}

/* ============================== 2) جيم أبطال ============================== */

async function seedGym(): Promise<SeedResult> {
  console.log('🏋️  جيم أبطال …')
  const b = await db.business.create({
    data: { name: 'جيم أبطال', type: 'gym', openingCash: 200_000, createdAt: at(-150, 10) },
  })

  const users = await createUsers(b.id, [
    { name: 'كابتن حسام', role: 'owner', title: 'كابتن — صاحب الجيم' },
    { name: 'مريم', role: 'reception', title: 'استقبال' },
  ])
  const cap = users.owner.id
  const rec = users.reception.id

  // الأصناف = خطط الاشتراك + منتجات الكافيه والمكملات
  await createItems(b.id, [
    { name: 'اشتراك شهري', aliases: 'شهرية, خطة شهرية', unit: 'piece', category: 'اشتراكات', cost: 28_000, sell: 35_000, qty: 99, low: 0 },
    { name: 'اشتراك ربع سنوي', aliases: 'ربع سنوية, خطة ربع سنوية', unit: 'piece', category: 'اشتراكات', cost: 75_000, sell: 90_000, qty: 99, low: 0 },
    { name: 'اشتراك سنوي', aliases: 'سنوية, خطة سنوية', unit: 'piece', category: 'اشتراكات', cost: 240_000, sell: 300_000, qty: 99, low: 0 },
    { name: 'واي بروتين 2 كيلو', aliases: 'بروتين, واي بروتين', unit: 'box', category: 'مكملات', cost: 90_000, sell: 115_000, qty: 12, low: 4 },
    { name: 'ماء 600 مل', aliases: 'ماء, ميه', unit: 'piece', category: 'كافيه', cost: 300, sell: 500, qty: 120, low: 30 },
    { name: 'قفازات تمرين', aliases: 'قفازات', unit: 'piece', category: 'مستلزمات', cost: 4_000, sell: 5_500, qty: 15, low: 5 },
    { name: 'بار بروتين', aliases: 'بار', unit: 'piece', category: 'مكملات', cost: 2_200, sell: 3_000, qty: 40, low: 10 },
    { name: 'مشروب طاقة', aliases: 'طاقة, ريد بول', unit: 'piece', category: 'كافيه', cost: 2_500, sell: 3_500, qty: 24, low: 8 },
  ])

  // ٨ أعضاء: واحد منتهي (كريم)، اتنين بينتهوا قريب (عمر ٣ أيام، هدى ٥ أيام)، والباقي سليم
  await createCustomers(b.id, [
    { name: 'عمر الشناوي', phone: '0101 234 5678', balance: 0, plan: 'شهرية', expiresAt: at(3, 12) },
    { name: 'هدى مصطفى', phone: '0128 345 6789', balance: 5_000, plan: 'شهرية', expiresAt: at(5, 12) },
    { name: 'كريم عادل', phone: '0100 456 7890', balance: 20_000, plan: 'شهرية', expiresAt: at(-5, 12) },
    { name: 'محمد سعيد', phone: '0111 567 8901', balance: 0, plan: 'شهرية', expiresAt: at(25, 12) },
    { name: 'أحمد فؤاد', phone: '0122 678 9012', balance: 0, plan: 'ربع سنوية', expiresAt: at(86, 12) },
    { name: 'ملك حسن', phone: '0106 789 0123', balance: 0, plan: 'سنوية', expiresAt: at(200, 12) },
    { name: 'سلمى يوسف', phone: '0127 890 1234', balance: 0, plan: 'سنوية', expiresAt: at(120, 12) },
    { name: 'سمير جلال', phone: '0102 901 2345', balance: 0, plan: 'شهرية', expiresAt: at(28, 12) },
  ])

  await createOpeningCash(b.id, cap, 200_000, at(-6, 0, 5))

  const ops = opFactory(b.id, 2000)

  await ops.create({
    type: 'membership', risk: 'R2', userId: rec, approverId: cap, createdAt: at(-5, 18, 0),
    summary: 'تجديد اشتراك محمد سعيد — شهرية ٣٥٠ ج نقدي',
    payload: { member: 'محمد سعيد', plan: 'شهرية', months: 1, amount: 35_000, payment: 'cash' },
    result: { member: 'محمد سعيد', plan: 'شهرية', expiresAt: iso(at(25, 18)), cashDelta: 35_000 },
    cash: { direction: 'in', amount: 35_000, reason: 'تجديد اشتراك شهري — محمد سعيد' },
  })

  await ops.create({
    type: 'attendance', risk: 'R2', userId: rec, approverId: cap, createdAt: at(-5, 19, 30),
    summary: 'تسجيل حضور: عمر الشناوي',
    payload: { memberName: 'عمر الشناوي', date: iso(at(-5, 19)) },
    result: { recorded: true },
  })

  await ops.create({
    type: 'attendance', risk: 'R2', userId: rec, approverId: cap, createdAt: at(-4, 18, 10),
    summary: 'تسجيل حضور: كريم عادل',
    payload: { memberName: 'كريم عادل', date: iso(at(-4, 18)) },
    result: { recorded: true },
  })

  await ops.create({
    type: 'membership', risk: 'R2', userId: rec, approverId: cap, createdAt: at(-4, 19, 5),
    summary: 'تجديد اشتراك أحمد فؤاد — ربع سنوية ٩٠٠ ج نقدي',
    payload: { member: 'أحمد فؤاد', plan: 'ربع سنوية', months: 3, amount: 90_000, payment: 'cash' },
    result: { member: 'أحمد فؤاد', plan: 'ربع سنوية', expiresAt: iso(at(86, 19)), cashDelta: 90_000 },
    cash: { direction: 'in', amount: 90_000, reason: 'تجديد اشتراك ربع سنوي — أحمد فؤاد' },
  })

  await ops.create({
    type: 'attendance', risk: 'R2', userId: rec, approverId: cap, createdAt: at(-3, 18, 5),
    summary: 'تسجيل حضور: ملك حسن',
    payload: { memberName: 'ملك حسن', date: iso(at(-3, 18)) },
    result: { recorded: true },
  })

  const s6 = [L('واي بروتين 2 كيلو', 1, 'box', 115000), L('ماء 600 مل', 6, 'piece', 500)]
  await ops.create({
    type: 'sale', risk: 'R2', userId: rec, approverId: cap, createdAt: at(-3, 20, 15),
    summary: 'بيع من الكافيه: ١ واي بروتين + ٦ ماء',
    payload: { lines: s6, payment: 'cash', total: T(s6) },
    result: { total: T(s6), cashDelta: T(s6), stockApplied: applied(s6, -1) },
    cash: { direction: 'in', amount: T(s6), reason: 'بيع كافيه — استقبال مريم' },
  })

  await ops.create({
    type: 'membership', risk: 'R2', userId: rec, approverId: cap, createdAt: at(-2, 17, 40),
    summary: 'اشتراك جديد: سمير جلال — شهرية ٣٥٠ ج نقدي',
    payload: { member: 'سمير جلال', plan: 'شهرية', months: 1, amount: 35_000, payment: 'cash', newMember: true },
    result: { member: 'سمير جلال', plan: 'شهرية', expiresAt: iso(at(28, 17)), cashDelta: 35_000 },
    cash: { direction: 'in', amount: 35_000, reason: 'اشتراك جديد — سمير جلال' },
  })

  await ops.create({
    type: 'collection', risk: 'R2', userId: rec, approverId: cap, createdAt: at(-2, 21, 0),
    summary: 'تحصيل ١٥٠ ج من العضو كريم عادل',
    payload: { customer: 'كريم عادل', amount: 15_000 },
    result: { customerBalanceAfter: 20_000, cashDelta: 15_000 },
    cash: { direction: 'in', amount: 15_000, reason: 'تحصيل من العضو كريم عادل' },
  })

  await ops.create({
    type: 'expense', risk: 'R2', userId: cap, createdAt: at(-1, 13, 0),
    summary: 'مصروف صيانة أجهزة الكارديو — ٦٠٠ ج',
    payload: { category: 'صيانة', amount: 60_000, note: 'فني أجهزة — تزييت سير التريدميل' },
    result: { recorded: true, amount: 60_000, cashDelta: -60_000 },
    cash: { direction: 'out', amount: 60_000, reason: 'صيانة أجهزة الكارديو' },
  })

  await ops.create({
    type: 'attendance', risk: 'R2', userId: rec, approverId: cap, createdAt: at(0, 18, 20),
    summary: 'تسجيل حضور: سلمى يوسف',
    payload: { memberName: 'سلمى يوسف', date: iso(at(0, 18)) },
    result: { recorded: true },
  })

  const s11 = [L('قفازات تمرين', 2, 'piece', 5500), L('ماء 600 مل', 5, 'piece', 500)]
  await ops.create({
    type: 'sale', risk: 'R2', userId: rec, approverId: cap, createdAt: at(0, 19, 5),
    summary: 'بيع من الكافيه: ٢ قفازات + ٥ ماء',
    payload: { lines: s11, payment: 'cash', total: T(s11) },
    result: { total: T(s11), cashDelta: T(s11), stockApplied: applied(s11, -1) },
    cash: { direction: 'in', amount: T(s11), reason: 'بيع كافيه — استقبال مريم' },
  })

  // تجديد مستني موافقة الكابتن (R2)
  const pendingRenewal = await ops.create({
    type: 'membership', risk: 'R2', status: 'AWAITING_APPROVAL', userId: rec, createdAt: at(0, 20, 0),
    summary: 'تجديد اشتراك عمر الشناوي — شهرية ٣٥٠ ج نقدي — مستني موافقة الكابتن',
    payload: { member: 'عمر الشناوي', plan: 'شهرية', months: 1, amount: 35_000, payment: 'cash' },
  })

  await createSettings(b.id, 'gym')
  await createMemories(b.id, cap, [
    { kind: 'fact', text: 'أوقات الزحمة من ٥ لـ ٨ مساءً — معظم التجديدات والتحصيلات بتقع في الوقت ده', at: at(-3, 22, 0) },
    { kind: 'fact', text: 'كابتن حسام بيدّي خصم ١٠٪ للطلبة على الاشتراك الشهري بس', at: at(-2, 16, 0) },
    { kind: 'preference', text: 'سجّل حضور العضو أول ما يدخل الباب مش في نص التمرين', at: at(-1, 19, 0) },
  ])
  await createTasks(b.id, cap, [
    {
      title: 'فحص المخزون الناقص',
      tool: 'list_low_stock',
      fields: {},
      whenLabel: 'كل يوم الساعة ٩ صباحاً',
      scheduledFor: at(1, 9),
      createdAt: at(0, 8, 30),
      recurrence: 'daily',
      status: 'pending',
    },
    {
      title: 'متابعة مديونيات الأعضاء',
      tool: 'list_receivables',
      fields: {},
      whenLabel: 'امبارح ٨ مساءً',
      scheduledFor: at(-1, 20),
      createdAt: at(-2, 19, 0),
      status: 'done',
      result: j({ members: 2, total: 25_000, top: ['كريم عادل ٢٠٠ ج', 'هدى مصطفى ٥٠ ج'] }),
      executedAt: at(-1, 20, 0, 30),
    },
  ])

  // محادثة: سؤال عن اشتراك عمر + كارت مسودة التجديد المعلّق
  const conv = await createConversation(
    b.id,
    cap,
    'تجديد اشتراك عمر الشناوي',
    at(0, 20, 30),
    'كابتن عمر الشناوي اشتراكه فاضل فيه كام؟ وجهزلي تجديده',
    {
      modelLabel: 'عميق مفكّر · glm-4.6',
      text: `اشتراك عمر الشناوي الشهري بينتهي بعد ${arNum(3)} أيام يا كابتن، وهدى مصطفى بعد ${arNum(5)} — وكريم عادل منتهي من ${arNum(5)} أيام.
جهزتلك كارت تجديد عمر (${egp(35_000)} شهرية) — مستني موافقتك تنفذه.`,
      thinking: [
        { label: 'بفهم الطلب', detail: 'كابتن حسام يسأل عن اشتراك عمر وعايز تجديده', state: 'done', icon: 'understand' },
        { label: 'بجيب بيانات العضو', detail: 'عمر الشناوي — خطة شهرية، باقي ٣ أيام، من غير مديونية', state: 'done', icon: 'search' },
        { label: 'بجهز التجديد', detail: 'تجديد شهر واحد × ٣٥٠ ج نقدي — مستني موافقة', state: 'done', icon: 'plan' },
        { label: 'بتحقق قبل العرض', detail: 'العضو سليم الحساب — تمام للتنفيذ بعد الاعتماد', state: 'done', icon: 'verify' },
      ],
      cards: [
        {
          kind: 'table',
          title: 'الاشتراكات اللي هتنتهي قريب',
          columns: [
            { key: 'name', label: 'العضو', align: 'start' },
            { key: 'plan', label: 'الخطة', align: 'start' },
            { key: 'left', label: 'المتبقي', align: 'end' },
          ],
          rows: [
            { name: 'عمر الشناوي', plan: 'شهرية', left: `${arNum(3)} أيام` },
            { name: 'هدى مصطفى', plan: 'شهرية', left: `${arNum(5)} أيام` },
            { name: 'كريم عادل', plan: 'شهرية', left: `منتهي ${arNum(5)} أيام` },
          ],
          footer: [{ label: 'أعضاء محتاجين متابعة', value: arNum(3) }],
        },
        {
          kind: 'kv',
          title: 'حالة عمر الشناوي',
          rows: [
            { label: 'الخطة الحالية', value: 'شهرية' },
            { label: 'ينتهي بعد', value: `${arNum(3)} أيام` },
            { label: 'آخر حضور', value: `قبل ${arNum(5)} أيام` },
            { label: 'مديونية', value: 'لا يوجد' },
          ],
        },
      ],
      card: {
        kind: 'draft',
        opId: pendingRenewal.id,
        ref: pendingRenewal.ref,
        type: 'membership',
        risk: 'R2',
        title: 'تجديد اشتراك — عمر الشناوي',
        summary: 'تجديد الخطة الشهرية لمدة شهر واحد — ٣٥٠ ج نقدي',
        fields: [
          { label: 'العضو', value: 'عمر الشناوي' },
          { label: 'الخطة', value: 'شهرية' },
          { label: 'المدة', value: 'شهر واحد' },
          { label: 'المبلغ', value: egp(35_000) },
          { label: 'طريقة الدفع', value: 'نقدي' },
        ],
        effects: [
          { label: 'الصلاحية الجديدة', value: `${arNum(30)} يوم من تاريخ التنفيذ`, tone: 'good' },
          { label: 'الخزنة', value: `+${egp(35_000)}`, tone: 'good' },
        ],
        status: 'AWAITING_APPROVAL',
      },
    },
  )
  await db.operation.update({
    where: { id: pendingRenewal.id },
    data: { conversationId: conv.id },
  })

  await db.business.update({ where: { id: b.id }, data: { opSeq: ops.currentSeq() } })

  return {
    key: 'gym',
    name: b.name,
    type: b.type,
    businessId: b.id,
    ownerId: users.owner.id,
    ownerName: users.owner.name,
    opSeq: ops.currentSeq(),
    expectedCash: { in: 506_500, out: 60_000, net: 446_500 },
    expectedLowStock: 0,
  }
}

/* ============================ 3) صيدلية الشفاء ============================ */

async function seedPharmacy(): Promise<SeedResult> {
  console.log('💊  صيدلية الشفاء …')
  const b = await db.business.create({
    data: { name: 'صيدلية الشفاء', type: 'pharmacy', openingCash: 300_000, createdAt: at(-200, 9) },
  })

  const users = await createUsers(b.id, [
    { name: 'د. عبد الله', role: 'owner', title: 'صيدلي' },
    { name: 'نورهان', role: 'cashier', title: 'موظفة صيدلية' },
  ])
  const doc = users.owner.id
  const cash = users.cashier.id

  // ٢٢ صنف بتشغيلات وصلاحيات: ٥ قربت يخلصوا (٣٠ يوم)، ٢ منتهيين، ٣ ناقصين
  await createItems(b.id, [
    { name: 'بروفين شراب', aliases: 'بروفين, بروفين 600', unit: 'box', category: 'مسكنات', cost: 4500, sell: 5500, qty: 28, low: 10, batchNo: 'B-2401', expiresAt: at(12, 12) },
    { name: 'بانادول أكتيف 24 قرص', aliases: 'بانادول, بانادول أكتيف', unit: 'box', category: 'مسكنات', cost: 3200, sell: 4000, qty: 40, low: 12, batchNo: 'PN-2398', expiresAt: at(25, 12) },
    { name: 'بانادول شرائط', aliases: 'بانادول شريط', unit: 'strip', category: 'مسكنات', cost: 1200, sell: 1600, qty: 100, low: 30, batchNo: 'PN-2397', expiresAt: at(70, 12) },
    { name: 'أوجمنتين 1 جم', aliases: 'أوجمنتين', unit: 'box', category: 'مضاد حيوي', cost: 9000, sell: 11000, qty: 18, low: 6, batchNo: 'AG-2411', expiresAt: at(150, 12) },
    { name: 'كتافلام 50 مجم', aliases: 'كتافلام', unit: 'box', category: 'مسكنات', cost: 3800, sell: 4600, qty: 22, low: 8, batchNo: 'KF-2380', expiresAt: at(8, 12) },
    { name: 'أوميز 20 مجم', aliases: 'أوميز', unit: 'box', category: 'معدة', cost: 2600, sell: 3300, qty: 55, low: 15, batchNo: 'OM-2405', expiresAt: at(90, 12) },
    { name: 'ناكسيد 40 مجم', aliases: 'ناكسيد', unit: 'box', category: 'معدة', cost: 5000, sell: 6200, qty: 8, low: 10, batchNo: 'NX-2407', expiresAt: at(60, 12) },
    { name: 'فيتامين سي 1000 فوار', aliases: 'فيتامين سي', unit: 'box', category: 'فيتامينات', cost: 2800, sell: 3600, qty: 45, low: 12, batchNo: 'VT-2395', expiresAt: at(18, 12) },
    { name: 'كونجستال', aliases: 'كونجستال', unit: 'box', category: 'برد وجيوب أنفية', cost: 2000, sell: 2600, qty: 35, low: 10, batchNo: 'CG-2390', expiresAt: at(5, 12) },
    { name: 'ميلجا بلس', aliases: 'ميلجا', unit: 'box', category: 'فيتامينات', cost: 6500, sell: 8000, qty: 6, low: 8, batchNo: 'MG-2410', expiresAt: at(200, 12) },
    { name: 'زنك 50 مجم', aliases: 'زنك', unit: 'box', category: 'فيتامينات', cost: 1500, sell: 2000, qty: 50, low: 12, batchNo: 'ZN-2415', expiresAt: at(180, 12) },
    { name: 'بانثينول كريم 75 جم', aliases: 'بانثينول', unit: 'piece', category: 'موضعية', cost: 5500, sell: 7000, qty: 20, low: 6, batchNo: 'PN-2416', expiresAt: at(300, 12) },
    { name: 'فيوسيدين مرهم 15 جم', aliases: 'فيوسيدين', unit: 'piece', category: 'موضعية', cost: 8000, sell: 9800, qty: 4, low: 5, batchNo: 'FS-2409', expiresAt: at(240, 12) },
    { name: 'بيتادين محلول 120 مل', aliases: 'بيتادين', unit: 'piece', category: 'موضعية', cost: 3000, sell: 3800, qty: 30, low: 8, batchNo: 'BD-2412', expiresAt: at(270, 12) },
    { name: 'سيتال شراب', aliases: 'سيتال', unit: 'box', category: 'مسكنات', cost: 1800, sell: 2400, qty: 12, low: 6, batchNo: 'CT-2388', expiresAt: at(-10, 12) },
    { name: 'تليفاست 180', aliases: 'تليفاست', unit: 'box', category: 'حساسية', cost: 3400, sell: 4200, qty: 9, low: 4, batchNo: 'TF-2375', expiresAt: at(-25, 12) },
    { name: 'أنسولين ميكستارد قلم', aliases: 'أنسولين, ميكستارد', unit: 'box', category: 'سكري', cost: 12000, sell: 14000, qty: 10, low: 4, batchNo: 'IN-2420', expiresAt: at(120, 12) },
    { name: 'شريط تحليل سكر (50)', aliases: 'ستريب سكر, شرائط سكر', unit: 'box', category: 'سكري', cost: 15000, sell: 18000, qty: 14, low: 5, batchNo: 'ST-2418', expiresAt: at(100, 12) },
    { name: 'محلول ملح 500 مل', aliases: 'محلول ملح, سيروم ملح', unit: 'piece', category: 'محاليل', cost: 900, sell: 1300, qty: 60, low: 20, batchNo: 'SR-2404', expiresAt: at(45, 12) },
    { name: 'بنادول أطفال شراب', aliases: 'بنادول أطفال', unit: 'box', category: 'مسكنات', cost: 2400, sell: 3100, qty: 26, low: 8, batchNo: 'PN-2399', expiresAt: at(70, 12) },
    { name: 'كومتركس', aliases: 'كومتركس', unit: 'box', category: 'برد وجيوب أنفية', cost: 2200, sell: 2800, qty: 32, low: 10, batchNo: 'KM-2385', expiresAt: at(65, 12) },
    { name: 'بيتاميثازون مرهم 30 جم', aliases: 'بيتاميثازون', unit: 'piece', category: 'موضعية', cost: 4200, sell: 5300, qty: 16, low: 5, batchNo: 'BM-2422', expiresAt: at(220, 12) },
  ])

  await createCustomers(b.id, [
    { name: 'مستشفى الرحمة', phone: '022 777 8899', balance: 234_000 },
    { name: 'عيادة د. منى', phone: '0100 222 3344', balance: 60_000 },
    { name: 'شركة الرعاية الطبية', balance: 0 },
  ])

  await createSuppliers(b.id, [
    { name: 'شركة الدواء', phone: '022 555 6677', balance: 170_000 },
    { name: 'ميا فارم', phone: '0111 333 5588', balance: 65_000 },
  ])

  await createOpeningCash(b.id, doc, 300_000, at(-6, 0, 5))

  const ops = opFactory(b.id, 3000)

  const s1 = [L('أوجمنتين 1 جم', 2, 'box', 11000), L('أوميز 20 مجم', 1, 'box', 3300)]
  await ops.create({
    type: 'sale', risk: 'R2', userId: cash, approverId: doc, createdAt: at(-5, 10, 20),
    summary: 'بيع نقدي: ٢ أوجمنتين + ١ أوميز',
    payload: { lines: s1, payment: 'cash', total: T(s1) },
    result: { total: T(s1), cashDelta: T(s1), stockApplied: applied(s1, -1) },
    cash: { direction: 'in', amount: T(s1), reason: 'بيع نقدي — صيدلية الشفاء' },
  })

  const p2 = [L('بروفين شراب', 20, 'box', 4500)]
  await ops.create({
    type: 'purchase', risk: 'R2', userId: doc, createdAt: at(-5, 14, 0),
    summary: 'شرا بالآجل: ٢٠ علبة بروفين من شركة الدواء',
    payload: { lines: p2, supplier: 'شركة الدواء', payment: 'credit', total: T(p2) },
    result: { total: T(p2), supplierBalanceAfter: 260_000, stockApplied: applied(p2, 1) },
  })

  // بيع فيه سياق صلاحية (تنبيه للعميل)
  const s3 = [L('كتافلام 50 مجم', 3, 'box', 4600), L('كونجستال', 2, 'box', 2600)]
  await ops.create({
    type: 'sale', risk: 'R2', userId: cash, approverId: doc, createdAt: at(-4, 11, 30),
    summary: 'بيع نقدي: ٣ كتافلام + ٢ كونجستال — تنبيه صلاحية كتافلام (٨ أيام)',
    payload: {
      lines: s3,
      payment: 'cash',
      total: T(s3),
      expiryNotes: [
        { item: 'كتافلام 50 مجم', batchNo: 'KF-2380', expiresAt: iso(at(8, 12)), note: 'صلاحية قريبة — تم تنبيه العميل' },
      ],
    },
    result: { total: T(s3), cashDelta: T(s3), warnings: ['كتافلام ٥٠ مجم — صلاحيته بعد ٨ أيام'], stockApplied: applied(s3, -1) },
    cash: { direction: 'in', amount: T(s3), reason: 'بيع نقدي — صيدلية الشفاء' },
  })

  await ops.create({
    type: 'expense', risk: 'R2', userId: cash, approverId: doc, createdAt: at(-4, 16, 0),
    summary: 'مصروف أدوات تنظيم رفوف — ١٨٠ ج',
    payload: { category: 'أدوات', amount: 18_000, note: 'فواصل رفوف وملصقات تشغيلات' },
    result: { recorded: true, amount: 18_000, cashDelta: -18_000 },
    cash: { direction: 'out', amount: 18_000, reason: 'أدوات تنظيم رفوف' },
  })

  const s5 = [L('أوجمنتين 1 جم', 10, 'box', 11000), L('محلول ملح 500 مل', 20, 'piece', 1300)]
  await ops.create({
    type: 'sale', risk: 'R2', userId: cash, approverId: doc, createdAt: at(-3, 11, 0),
    summary: 'بيع بالآجل لمستشفى الرحمة: ١٠ أوجمنتين + ٢٠ محلول ملح',
    payload: { lines: s5, customer: 'مستشفى الرحمة', payment: 'credit', total: T(s5) },
    result: { total: T(s5), customerBalanceAfter: 370_000, stockApplied: applied(s5, -1) },
  })

  await ops.create({
    type: 'collection', risk: 'R2', userId: cash, approverId: doc, createdAt: at(-3, 14, 30),
    summary: 'تحصيل ١٢٠٠ ج من مستشفى الرحمة',
    payload: { customer: 'مستشفى الرحمة', amount: 120_000 },
    result: { customerBalanceAfter: 250_000, cashDelta: 120_000 },
    cash: { direction: 'in', amount: 120_000, reason: 'تحصيل من مستشفى الرحمة' },
  })

  const p7 = [L('ميلجا بلس', 15, 'box', 6500), L('بيتادين محلول 120 مل', 10, 'piece', 3000)]
  await ops.create({
    type: 'purchase', risk: 'R2', userId: doc, createdAt: at(-2, 10, 0),
    summary: 'شرا نقدي من ميا فارم: ١٥ ميلجا بلس + ١٠ بيتادين',
    payload: { lines: p7, supplier: 'ميا فارم', payment: 'cash', total: T(p7) },
    result: { total: T(p7), supplierBalanceAfter: 65_000, cashDelta: -T(p7), stockApplied: applied(p7, 1) },
    cash: { direction: 'out', amount: T(p7), reason: 'شرا من ميا فارم' },
  })

  await ops.create({
    type: 'payment', risk: 'R2', userId: doc, createdAt: at(-2, 15, 0),
    summary: 'سداد ٨٠٠ ج لشركة الدواء',
    payload: { supplier: 'شركة الدواء', amount: 80_000 },
    result: { supplierBalanceAfter: 180_000, cashDelta: -80_000 },
    cash: { direction: 'out', amount: 80_000, reason: 'سداد لمورد شركة الدواء' },
  })

  const s9 = [L('أنسولين ميكستارد قلم', 1, 'box', 14000), L('شريط تحليل سكر (50)', 2, 'box', 18000)]
  await ops.create({
    type: 'sale', risk: 'R2', userId: cash, approverId: doc, createdAt: at(-1, 19, 20),
    summary: 'بيع نقدي: ١ أنسولين ميكستارد + ٢ شريط تحليل سكر',
    payload: { lines: s9, payment: 'cash', total: T(s9) },
    result: { total: T(s9), cashDelta: T(s9), stockApplied: applied(s9, -1) },
    cash: { direction: 'in', amount: T(s9), reason: 'بيع نقدي — صيدلية الشفاء' },
  })

  const s10 = [L('بانادول شرائط', 2, 'strip', 1600), L('فيتامين سي 1000 فوار', 1, 'box', 3600)]
  await ops.create({
    type: 'sale', risk: 'R2', userId: cash, approverId: doc, createdAt: at(0, 10, 15),
    summary: 'بيع نقدي: ٢ بانادول شرائط + ١ فيتامين سي',
    payload: { lines: s10, payment: 'cash', total: T(s10) },
    result: { total: T(s10), cashDelta: T(s10), stockApplied: applied(s10, -1) },
    cash: { direction: 'in', amount: T(s10), reason: 'بيع نقدي — صيدلية الشفاء' },
  })

  await ops.create({
    type: 'expense', risk: 'R2', userId: cash, approverId: doc, createdAt: at(0, 13, 40),
    summary: 'مصروف نوبعة ليل — ١٥٠ ج',
    payload: { category: 'نوبعات', amount: 15_000, note: 'نوبعة موظفة الوردية الليلية' },
    result: { recorded: true, amount: 15_000, cashDelta: -15_000 },
    cash: { direction: 'out', amount: 15_000, reason: 'نوبعة ليل' },
  })

  // تسوية مخزون كبيرة مستنية اعتماد مع سبب (R3)
  await ops.create({
    type: 'stock_adjustment', risk: 'R3', status: 'AWAITING_APPROVAL', userId: doc, createdAt: at(0, 15, 0),
    summary: 'تسوية مخزون كبيرة: سيتال شراب −١٢ علبة (منتهي الصلاحية) — مستني اعتماد',
    reason: 'صلاحية انتهت من ١٠ أيام — محتاج إتلاف موثق بمحضر',
    payload: {
      item: 'سيتال شراب',
      unit: 'box',
      delta: -12,
      currentStock: 12,
      newStock: 0,
      batchNo: 'CT-2388',
      reason: 'صلاحية انتهت من ١٠ أيام — محتاج إتلاف موثق بمحضر',
    },
  })

  await createSettings(b.id, 'pharmacy')
  await createMemories(b.id, doc, [
    { kind: 'fact', text: 'مستشفى الرحمة بياخوا أوجمنتين ومحاليل بالآجل وبيحولوا الفلوس أول كل شهر', at: at(-3, 12, 0) },
    { kind: 'fact', text: 'د. عبد الله بيرجّع أي دواء صلاحيته أقل من ٦٠ يوم للمورد وقت الاستلام', at: at(-2, 14, 0) },
    { kind: 'preference', text: 'افتكر تتأكد من رقم التشغيلة (Batch) قبل تسجيل أي شرا صيدلي', at: at(-1, 21, 0) },
  ])
  await createTasks(b.id, doc, [
    {
      title: 'فحص المخزون الناقص',
      tool: 'list_low_stock',
      fields: {},
      whenLabel: 'كل يوم الساعة ٩ صباحاً',
      scheduledFor: at(1, 9),
      createdAt: at(0, 8, 30),
      recurrence: 'daily',
      status: 'pending',
    },
    {
      title: 'الأدوية اللي صلاحيتها قربت تخلص',
      tool: 'list_expiring',
      fields: { days: 30 },
      whenLabel: 'امبارح ٩ مساءً',
      scheduledFor: at(-1, 21),
      createdAt: at(-2, 20, 0),
      status: 'done',
      result: j({
        count: 5,
        items: ['كونجستال (٥ أيام)', 'كتافلام ٥٠ مجم (٨ أيام)', 'بروفين شراب (١٢ يوم)', 'فيتامين سي ١٠٠٠ (١٨ يوم)', 'بانادول أكتيف (٢٥ يوم)'],
      }),
      executedAt: at(-1, 21, 0, 30),
    },
  ])

  await createConversation(
    b.id,
    doc,
    'الصلاحيات والمخزون الناقص',
    at(0, 16, 10),
    'يا وكيل — إيه الأدوية اللي صلاحيتها قربت تخلص؟ والمخزون الناقص إيه؟',
    {
      modelLabel: 'عميق مفكّر · glm-4.6',
      text: `يا دكتور — ${arNum(5)} أدوية صلاحيتها أقل من ${arNum(30)} يوم، أخطرهم كونجستال (${arNum(5)} أيام بس) وكتافلام (${arNum(8)} أيام).
وفي ${arNum(3)} أصناف ناقصة: ناكسيد، ميلجا بلس، فيوسيدين.
وغير كده سيتال وتليفاست منتهيين خلاص — لقيت تسوية إتلاف سيتال معلّقة مستنية اعتمادك.`,
      thinking: [
        { label: 'بفهم الطلب', detail: 'د. عبد الله عايز الأدوية قريبة الصلاحية + الناقص', state: 'done', icon: 'understand' },
        { label: 'بفحص الصلاحيات', detail: 'قارنت تواريخ الانتهاء بـ٣٠ يوم — طلعت ٥ أدوية', state: 'done', icon: 'search' },
        { label: 'بفحص المخزون', detail: '٣ أصناف تحت حد الطلب + صنفين منتهيين', state: 'done', icon: 'plan' },
        { label: 'بجهز الرد', detail: 'جدولين مرتبين بالأخطر الأول', state: 'done', icon: 'verify' },
      ],
      cards: [
        {
          kind: 'table',
          title: 'أدوية صلاحيتها أقل من ٣٠ يوم',
          columns: [
            { key: 'name', label: 'الدواء', align: 'start' },
            { key: 'days', label: 'المتبقي', align: 'end' },
            { key: 'stock', label: 'المخزون', align: 'end' },
          ],
          rows: [
            { name: 'كونجستال', days: `${arNum(5)} أيام`, stock: `${arNum(35)} علبة` },
            { name: 'كتافلام ٥٠ مجم', days: `${arNum(8)} أيام`, stock: `${arNum(22)} علبة` },
            { name: 'بروفين شراب', days: `${arNum(12)} يوم`, stock: `${arNum(28)} علبة` },
            { name: 'فيتامين سي ١٠٠٠', days: `${arNum(18)} يوم`, stock: `${arNum(45)} علبة` },
            { name: 'بانادول أكتيف', days: `${arNum(25)} يوم`, stock: `${arNum(40)} علبة` },
          ],
          footer: [{ label: 'إجمالي', value: arNum(5) }],
        },
        {
          kind: 'table',
          title: 'المخزون الناقص',
          columns: [
            { key: 'name', label: 'الدواء', align: 'start' },
            { key: 'remaining', label: 'المتبقي', align: 'end' },
            { key: 'threshold', label: 'حد الطلب', align: 'end' },
            { key: 'unit', label: 'الوحدة', align: 'start' },
          ],
          rows: [
            { name: 'ناكسيد ٤٠ مجم', remaining: arNum(8), threshold: arNum(10), unit: 'علبة' },
            { name: 'ميلجا بلس', remaining: arNum(6), threshold: arNum(8), unit: 'علبة' },
            { name: 'فيوسيدين مرهم', remaining: arNum(4), threshold: arNum(5), unit: 'قطعة' },
          ],
          footer: [{ label: 'أصناف ناقصة', value: arNum(3) }],
        },
      ],
    },
  )

  await db.business.update({ where: { id: b.id }, data: { opSeq: ops.currentSeq() } })

  return {
    key: 'pharmacy',
    name: b.name,
    type: b.type,
    businessId: b.id,
    ownerId: users.owner.id,
    ownerName: users.owner.name,
    opSeq: ops.currentSeq(),
    expectedCash: { in: 521_100, out: 240_500, net: 280_600 },
    expectedLowStock: 3,
  }
}

/* ============================== 4) عطارة المسك ============================= */

async function seedAttar(): Promise<SeedResult> {
  console.log('🕌  عطارة المسك …')
  const b = await db.business.create({
    data: { name: 'عطارة المسك', type: 'attar', openingCash: 150_000, createdAt: at(-220, 10) },
  })

  const users = await createUsers(b.id, [
    { name: 'عم سيد', role: 'owner', title: 'العطار' },
    { name: 'زبير', role: 'cashier', title: 'مساعد عطارة' },
  ])
  const sid = users.owner.id
  const zob = users.cashier.id

  // ٢٠ صنف بالجرام/المللي — عود كمبودي ٩٥ ج للجرام، مسك غزال تحت حد التنبيه
  await createItems(b.id, [
    { name: 'عود كمبودي', aliases: 'عود, العود, عود كمبودي', unit: 'gram', category: 'عود', cost: 7200, sell: 9500, qty: 85, low: 20 },
    { name: 'مسك غزال', aliases: 'مسك, مسك الغزال', unit: 'gram', category: 'مسك', cost: 14000, sell: 18000, qty: 340, low: 350 },
    { name: 'زيت صندل', aliases: 'صندل, زيت الصندل', unit: 'milli', category: 'زيوت', cost: 250, sell: 350, qty: 500, low: 150 },
    { name: 'بخور معمول', aliases: 'بخور, بنكن', unit: 'gram', category: 'بخور', cost: 40, sell: 52, qty: 12000, low: 4000 },
    { name: 'كركديه', aliases: 'كركديه, كركديه مجفف', unit: 'gram', category: 'أعشاب', cost: 9, sell: 12, qty: 30000, low: 6000 },
    { name: 'خلطة المدينة', aliases: 'خلطة المدينة, خلطة مدينة', unit: 'gram', category: 'خلطات', cost: 150, sell: 220, qty: 4000, low: 1000 },
    { name: 'خلطة الحرم', aliases: 'خلطة الحرم', unit: 'gram', category: 'خلطات', cost: 180, sell: 250, qty: 3500, low: 1000 },
    { name: 'زيت عود', aliases: 'دهن عود', unit: 'milli', category: 'زيوت', cost: 1500, sell: 2200, qty: 800, low: 200 },
    { name: 'مسك أسود', aliases: 'مسك اسود', unit: 'gram', category: 'مسك', cost: 300, sell: 450, qty: 2000, low: 500 },
    { name: 'عنبر', aliases: 'عنبر بار', unit: 'gram', category: 'عنبر', cost: 5000, sell: 6800, qty: 120, low: 30 },
    { name: 'زيت لوز', aliases: 'لوز, زيت اللوز', unit: 'milli', category: 'زيوت', cost: 180, sell: 260, qty: 2500, low: 600 },
    { name: 'زيت حبة البركة', aliases: 'زيت البركة', unit: 'liter', category: 'زيوت', cost: 35000, sell: 45000, qty: 15, low: 5 },
    { name: 'حبة البركة (حبوب)', aliases: 'حبة البركة', unit: 'gram', category: 'أعشاب', cost: 12, sell: 15, qty: 25000, low: 5000 },
    { name: 'زعفران', aliases: 'زعفران', unit: 'gram', category: 'توابل', cost: 2500, sell: 3500, qty: 12, low: 15 },
    { name: 'حبهان (هيل)', aliases: 'حبهان, هيل', unit: 'gram', category: 'توابل', cost: 550, sell: 650, qty: 8000, low: 2000 },
    { name: 'قرفة مطحونة', aliases: 'قرفة', unit: 'gram', category: 'توابل', cost: 60, sell: 90, qty: 6000, low: 1500 },
    { name: 'ينسون', aliases: 'ينسون', unit: 'gram', category: 'أعشاب', cost: 90, sell: 130, qty: 9000, low: 2000 },
    { name: 'كركم', aliases: 'كركم', unit: 'gram', category: 'توابل', cost: 50, sell: 80, qty: 8000, low: 2000 },
    { name: 'ورد بلدي مجفف', aliases: 'ورد, ورد بلدي', unit: 'gram', category: 'أعشاب', cost: 200, sell: 300, qty: 2500, low: 600 },
    { name: 'زيت مسك', aliases: 'مسك سائل', unit: 'milli', category: 'زيوت', cost: 400, sell: 600, qty: 1500, low: 400 },
  ])

  await createCustomers(b.id, [
    { name: 'الحاج رجب', phone: '0100 111 2233', balance: 8_000 },
    { name: 'متجر الريحان للعطور', phone: '022 444 5566', balance: 0 },
    { name: 'زبون نقدي', balance: 0 },
  ])

  await createSuppliers(b.id, [
    { name: 'الحاج مسعود — مورد العطور', phone: '0100 999 8877', balance: 0 },
    { name: 'عم عبده — مورد الأعشاب', balance: 0 },
  ])

  await createOpeningCash(b.id, sid, 150_000, at(-6, 0, 5))

  const ops = opFactory(b.id, 4000)

  // بيع بالجرام (payload qty 10 unit gram)
  const s1 = [L('عود كمبودي', 10, 'gram', 9500), L('بخور معمول', 500, 'gram', 52)]
  await ops.create({
    type: 'sale', risk: 'R2', userId: sid, createdAt: at(-5, 16, 0),
    summary: 'بيع نقدي: ١٠ جرام عود كمبودي + ٥٠٠ جرام بخور معمول (نصف كيلو)',
    payload: { lines: s1, payment: 'cash', total: T(s1) },
    result: { total: T(s1), cashDelta: T(s1), stockApplied: applied(s1, -1) },
    cash: { direction: 'in', amount: T(s1), reason: 'بيع نقدي — عطارة المسك' },
  })

  const s2 = [L('مسك غزال', 3, 'gram', 18000), L('زيت صندل', 200, 'milli', 350)]
  await ops.create({
    type: 'sale', risk: 'R2', userId: sid, createdAt: at(-4, 12, 30),
    summary: 'بيع نقدي: ٣ جرام مسك غزال + ٢٠٠ مللي زيت صندل',
    payload: { lines: s2, payment: 'cash', total: T(s2) },
    result: { total: T(s2), cashDelta: T(s2), stockApplied: applied(s2, -1) },
    cash: { direction: 'in', amount: T(s2), reason: 'بيع نقدي — عطارة المسك' },
  })

  const p3 = [L('مسك غزال', 30, 'gram', 14000)]
  await ops.create({
    type: 'purchase', risk: 'R2', userId: sid, createdAt: at(-4, 15, 0),
    summary: 'شرا بالآجل من الحاج مسعود: ٣٠ جرام مسك غزال',
    payload: { lines: p3, supplier: 'الحاج مسعود — مورد العطور', payment: 'credit', total: T(p3) },
    result: { total: T(p3), supplierBalanceAfter: 420_000, stockApplied: applied(p3, 1) },
  })

  await ops.create({
    type: 'expense', risk: 'R2', userId: zob, approverId: sid, createdAt: at(-3, 11, 0),
    summary: 'مصروف أكياس وتغليف — ٩٠ ج',
    payload: { category: 'تغليف', amount: 9_000, note: 'أكياس عطر وورق تغليف هدايا' },
    result: { recorded: true, amount: 9_000, cashDelta: -9_000 },
    cash: { direction: 'out', amount: 9_000, reason: 'أكياس وتغليف' },
  })

  const s5 = [L('خلطة المدينة', 500, 'gram', 220), L('خلطة الحرم', 300, 'gram', 250)]
  await ops.create({
    type: 'sale', risk: 'R2', userId: sid, createdAt: at(-3, 17, 30),
    summary: 'بيع بالآجل لمتجر الريحان: ٥٠٠ جرام خلطة المدينة + ٣٠٠ جرام خلطة الحرم',
    payload: { lines: s5, customer: 'متجر الريحان للعطور', payment: 'credit', total: T(s5) },
    result: { total: T(s5), customerBalanceAfter: 185_000, stockApplied: applied(s5, -1) },
  })

  await ops.create({
    type: 'collection', risk: 'R2', userId: sid, createdAt: at(-2, 13, 0),
    summary: 'تحصيل ١٤٠٠ ج من متجر الريحان للعطور',
    payload: { customer: 'متجر الريحان للعطور', amount: 140_000 },
    result: { customerBalanceAfter: 45_000, cashDelta: 140_000 },
    cash: { direction: 'in', amount: 140_000, reason: 'تحصيل من متجر الريحان للعطور' },
  })

  await ops.create({
    type: 'payment', risk: 'R2', userId: sid, createdAt: at(-2, 16, 45),
    summary: 'سداد ٣٣٠٠ ج للحاج مسعود',
    payload: { supplier: 'الحاج مسعود — مورد العطور', amount: 330_000 },
    result: { supplierBalanceAfter: 90_000, cashDelta: -330_000 },
    cash: { direction: 'out', amount: 330_000, reason: 'سداد لمورد الحاج مسعود' },
  })

  // ربع كيلو كركديه = ٢٥٠ جرام (تحويل الوحدات)
  const s8 = [L('كركديه', 250, 'gram', 12), L('ينسون', 100, 'gram', 130)]
  await ops.create({
    type: 'sale', risk: 'R2', userId: zob, approverId: sid, createdAt: at(-1, 12, 15),
    summary: 'بيع نقدي: ربع كيلو كركديه (٢٥٠ جرام) + ١٠٠ جرام ينسون',
    payload: { lines: s8, payment: 'cash', total: T(s8), unitConversions: [{ from: 'kilo', to: 'gram', factor: 1000, qty: 0.25 }] },
    result: { total: T(s8), cashDelta: T(s8), stockApplied: applied(s8, -1) },
    cash: { direction: 'in', amount: T(s8), reason: 'بيع نقدي — عطارة المسك' },
  })

  const s9 = [L('ورد بلدي مجفف', 20, 'gram', 300), L('زيت لوز', 50, 'milli', 260)]
  await ops.create({
    type: 'sale', risk: 'R2', userId: sid, createdAt: at(0, 11, 20),
    summary: 'بيع نقدي: ٢٠ جرام ورد بلدي + ٥٠ مللي زيت لوز',
    payload: { lines: s9, payment: 'cash', total: T(s9) },
    result: { total: T(s9), cashDelta: T(s9), stockApplied: applied(s9, -1) },
    cash: { direction: 'in', amount: T(s9), reason: 'بيع نقدي — عطارة المسك' },
  })

  // بيع بالجرام مستني اعتماد (R2)
  const s10 = [L('عنبر', 5, 'gram', 6800), L('قرفة مطحونة', 100, 'gram', 90)]
  await ops.create({
    type: 'sale', risk: 'R2', status: 'AWAITING_APPROVAL', userId: zob, createdAt: at(0, 12, 40),
    summary: 'بيع بالآجل للحاج رجب: ٥ جرام عنبر + ١٠٠ جرام قرفة — مستني اعتماد',
    payload: { lines: s10, customer: 'الحاج رجب', payment: 'credit', total: T(s10) },
  })

  await createSettings(b.id, 'attar')
  await createMemories(b.id, sid, [
    { kind: 'fact', text: 'الحاج رجب بيشتري عنبر وورد بلدي بالآجل وبيسدد بعد الجمع', at: at(-3, 13, 0) },
    { kind: 'fact', text: 'عم سيد بيزنّن العود والمسك بالجرام مش بالتولة', at: at(-2, 15, 0) },
    { kind: 'preference', text: 'اسأل العميل عن درجة الخلطة (خفيفة/تقيلة) قبل تجهيز خلطة المدينة', at: at(-1, 18, 0) },
  ])
  await createTasks(b.id, sid, [
    {
      title: 'فحص المخزون الناقص',
      tool: 'list_low_stock',
      fields: {},
      whenLabel: 'كل يوم الساعة ٩ صباحاً',
      scheduledFor: at(1, 9),
      createdAt: at(0, 8, 30),
      recurrence: 'daily',
      status: 'pending',
    },
    {
      title: 'إيه وضع الخزنة؟',
      tool: 'get_cash_position',
      fields: {},
      whenLabel: 'امبارح ١٠ مساءً',
      scheduledFor: at(-1, 22),
      createdAt: at(-2, 21, 0),
      status: 'done',
      result: j({ in: 570_000, out: 339_000, net: 231_000 }),
      executedAt: at(-1, 22, 0, 30),
    },
  ])

  await createConversation(
    b.id,
    sid,
    'مسك الغزال والناقص في المحل',
    at(0, 13, 30),
    'مسك الغزال فاضل منه كام جرام؟ وبصلي إيه الناقص في المحل كله',
    {
      modelLabel: 'عميق مفكّر · glm-4.6',
      text: `مسك الغزال فاضل منه ${arNum(340)} جرام بس يا عم سيد — وده تحت حد التنبيه (${arNum(350)} جرام).
غيره زعفران (${arNum(12)} جرام والحد ${arNum(15)}).
بقية المحل تمام. تحب أجهزلك أمر شرا مسك من الحاج مسعود؟`,
      thinking: [
        { label: 'بفهم الطلب', detail: 'عم سيد يسأل عن مخزون مسك الغزال + الناقص كله', state: 'done', icon: 'understand' },
        { label: 'بفحص المخزون بالجرام', detail: 'قارنت الجرامات المتبقية بحدود التنبيه', state: 'done', icon: 'search' },
        { label: 'بحدد الناقص', detail: 'مسك غزال وزعفران تحت الحد', state: 'done', icon: 'plan' },
        { label: 'بجهز الرد', detail: 'جدول ناقص + أغلى أصناف المحل', state: 'done', icon: 'verify' },
      ],
      cards: [
        {
          kind: 'table',
          title: 'المخزون الناقص',
          columns: [
            { key: 'name', label: 'الصنف', align: 'start' },
            { key: 'remaining', label: 'المتبقي', align: 'end' },
            { key: 'threshold', label: 'حد التنبيه', align: 'end' },
            { key: 'unit', label: 'الوحدة', align: 'start' },
          ],
          rows: [
            { name: 'مسك غزال', remaining: arNum(340), threshold: arNum(350), unit: 'جرام' },
            { name: 'زعفران', remaining: arNum(12), threshold: arNum(15), unit: 'جرام' },
          ],
          footer: [{ label: 'أصناف ناقصة', value: arNum(2) }],
        },
        {
          kind: 'kv',
          title: 'أغلى أصناف المحل',
          rows: [
            { label: 'عود كمبودي', value: `${egp(9_500)} / جرام` },
            { label: 'مسك غزال', value: `${egp(18_000)} / جرام` },
            { label: 'عنبر', value: `${egp(6_800)} / جرام` },
            { label: 'زيت عود', value: `${egp(2_200)} / مللي` },
          ],
        },
      ],
    },
  )

  await db.business.update({ where: { id: b.id }, data: { opSeq: ops.currentSeq() } })

  return {
    key: 'attar',
    name: b.name,
    type: b.type,
    businessId: b.id,
    ownerId: users.owner.id,
    ownerName: users.owner.name,
    opSeq: ops.currentSeq(),
    expectedCash: { in: 570_000, out: 339_000, net: 231_000 },
    expectedLowStock: 2,
  }
}

/* ============================ 5) model providers =========================== */

async function seedProviders() {
  console.log('🔌  مزودي النماذج التجريبيين …')
  const p1 = await db.modelProvider.create({
    data: { name: 'مزوّد تجريبي', baseUrl: 'http://localhost:3031/v1', apiKey: 'demo-key' },
  })
  const p2 = await db.modelProvider.create({
    data: { name: 'مزوّد الاختبار', baseUrl: 'http://localhost:3031/v1', apiKey: 'test-key' },
  })
  const defs: [string, string, string][] = [
    ['wakil-mock-air', 'وكيل خفيف', 'air'],
    ['wakil-mock-flash', 'وكيل سريع', 'air'],
    ['wakil-mock-balanced', 'وكيل متوازن', 'balanced'],
    ['wakil-mock-deep', 'وكيل عميق', 'deep'],
  ]
  for (const [remoteId, label, tier] of defs) {
    await db.modelConfig.create({ data: { providerId: p1.id, remoteId, label, tier, enabled: true } })
  }
  for (const [remoteId, label, tier] of defs) {
    // على المزوّد الثاني: wakil-mock-flash معطّل — عشان واجهة التفعيل تبان
    await db.modelConfig.create({
      data: { providerId: p2.id, remoteId, label, tier, enabled: remoteId !== 'wakil-mock-flash' },
    })
  }
}

/* ============================== verification ============================== */

let failures = 0

function check(name: string, actual: unknown, expected: unknown) {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? '✅' : '❌'} ${name} → actual=${actual}${ok ? '' : ` (expected ${expected})`}`)
}

async function verify(seeds: Record<string, SeedResult>) {
  console.log('\n📊 counts per model:')
  console.table(
    Object.fromEntries([
      ['Business', await db.business.count()],
      ['User', await db.user.count()],
      ['Item', await db.item.count()],
      ['Customer', await db.customer.count()],
      ['Supplier', await db.supplier.count()],
      ['Operation', await db.operation.count()],
      ['CashEntry', await db.cashEntry.count()],
      ['AuditEvent', await db.auditEvent.count()],
      ['Conversation', await db.conversation.count()],
      ['Message', await db.message.count()],
      ['ScheduledTask', await db.scheduledTask.count()],
      ['AgentMemory', await db.agentMemory.count()],
      ['AgentSettings', await db.agentSettings.count()],
      ['ModelProvider', await db.modelProvider.count()],
      ['ModelConfig', await db.modelConfig.count()],
    ]),
  )

  console.log('🔎 verification checks:')
  for (const key of ['market', 'gym', 'pharmacy', 'attar'] as const) {
    const s = seeds[key]
    const entries = await db.cashEntry.findMany({ where: { businessId: s.businessId } })
    const cashIn = entries.filter((e) => e.direction === 'in').reduce((sum, e) => sum + e.amount, 0)
    const cashOut = entries.filter((e) => e.direction === 'out').reduce((sum, e) => sum + e.amount, 0)
    check(`cash[${s.name}] in`, cashIn, s.expectedCash.in)
    check(`cash[${s.name}] out`, cashOut, s.expectedCash.out)
    check(`cash[${s.name}] net`, cashIn - cashOut, s.expectedCash.net)

    const items = await db.item.findMany({ where: { businessId: s.businessId } })
    const lowCount = items.filter((i) => i.lowStockThreshold != null && i.lowStockThreshold > 0 && i.stockQty != null && i.stockQty <= i.lowStockThreshold).length
    check(`lowStock[${s.name}]`, lowCount, s.expectedLowStock)
  }

  check('pending operations (AWAITING_APPROVAL)', await db.operation.count({ where: { status: 'AWAITING_APPROVAL' } }), 4)
  check('reversal ops', await db.operation.count({ where: { type: 'reversal' } }), 1)

  // ربط العكس بالعملية الأصلية
  const reversal = await db.operation.findFirst({ where: { type: 'reversal' } })
  const reversed = reversal ? await db.operation.findFirst({ where: { ref: reversal.reversalOfRef ?? '' } }) : null
  check('reversal linkage', reversal?.reversalOfRef && reversed?.reversedByRef === reversal.ref ? 'linked' : 'broken', 'linked')

  // صيدلية: صلاحيات
  const now = Date.now()
  const ph = seeds.pharmacy
  const phItems = await db.item.findMany({
    where: { businessId: ph.businessId, expiresAt: { not: null } },
  })
  const expiring = phItems.filter(
    (i) => i.expiresAt && i.expiresAt.getTime() >= now && i.expiresAt.getTime() - now <= 30 * DAY,
  ).length
  const expired = phItems.filter((i) => i.expiresAt && i.expiresAt.getTime() < now).length
  check('pharmacy expiring ≤30d', expiring, 5)
  check('pharmacy expired', expired, 2)

  // الجيم: أعضاء
  const gymMembers = await db.customer.findMany({ where: { businessId: seeds.gym.businessId } })
  check('gym members', gymMembers.length, 8)
  const expiringMembers = gymMembers.filter((m) => m.expiresAt && m.expiresAt.getTime() - now <= 5 * DAY).length
  check('gym members ending within 5 days', expiringMembers, 2)

  // المزودون
  const enabled = await db.modelConfig.count({ where: { enabled: true } })
  check('model configs enabled', enabled, 7)

  // الرسائل: thinking/cards JSON strings قابلة للتحليل
  const assistantMsgs = await db.message.findMany({ where: { role: 'assistant' } })
  let parseable = 0
  for (const m of assistantMsgs) {
    try {
      JSON.parse(m.thinking ?? '[]')
      JSON.parse(m.cards ?? '[]')
      parseable++
    } catch {
      // عدّ الرسائل غير الصالحة فقط
    }
  }
  check('assistant messages with parseable thinking+cards', parseable, 4)

  console.log('\n🏢 businesses + owners (for QA):')
  for (const key of ['market', 'gym', 'pharmacy', 'attar'] as const) {
    const s = seeds[key]
    console.log(`  ${s.name} (${s.type}) → businessId=${s.businessId} · owner=${s.ownerName} (${s.ownerId}) · opSeq=${s.opSeq}`)
  }

  const pending = await db.operation.findMany({
    where: { status: 'AWAITING_APPROVAL' },
    orderBy: { ref: 'asc' },
    select: { ref: true, type: true, risk: true, summary: true },
  })
  console.log('\n⏳ pending approvals:')
  for (const p of pending) console.log(`  ${p.ref} · ${p.type} · ${p.risk} · ${p.summary}`)

  if (failures > 0) throw new Error(`${failures} verification checks failed`)
}

/* ================================== main =================================== */

async function main() {
  console.log('🧹  wiping existing data …')
  await db.message.deleteMany()
  await db.conversation.deleteMany()
  await db.scheduledTask.deleteMany()
  await db.agentMemory.deleteMany()
  await db.agentSettings.deleteMany()
  await db.auditEvent.deleteMany()
  await db.cashEntry.deleteMany()
  await db.operation.deleteMany()
  await db.customer.deleteMany()
  await db.supplier.deleteMany()
  await db.item.deleteMany()
  await db.user.deleteMany()
  await db.business.deleteMany()
  await db.modelConfig.deleteMany()
  await db.modelProvider.deleteMany()

  await seedProviders()

  const seeds: Record<string, SeedResult> = {}
  seeds.market = await seedSupermarket()
  seeds.gym = await seedGym()
  seeds.pharmacy = await seedPharmacy()
  seeds.attar = await seedAttar()

  await verify(seeds)

  console.log('\n🌱  seed completed successfully.')
}

main()
  .then(async () => {
    await db.$disconnect()
  })
  .catch(async (err) => {
    console.error('❌  seed failed:', err)
    await db.$disconnect()
    process.exit(1)
  })
