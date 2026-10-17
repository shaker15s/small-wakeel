// وكيل — Dynamic Business Builder & Self-Configuring Engine
// Generates any preset or custom business vertical with realistic initial items,
// quick commands, staff roles, and AgentSettings, plus live catalog & business
// configuration tools invoked by the agent harness.

import { db } from '@/lib/db'
import { getVertical } from '@/lib/verticals'
import type { BusinessLite, Role, Vertical } from '@/lib/types'
import { normalizeAr } from '@/lib/agent/arabic'

interface DefaultItemSeed {
  name: string
  aliases: string
  unit: string
  category: string
  costPrice: number // piastres
  sellPrice: number // piastres
  stockQty: number
  lowStockThreshold: number
}

const VERTICAL_SEED_ITEMS: Record<string, DefaultItemSeed[]> = {
  pharmacy: [
    { name: 'بنادول إكسترا ٢٤ قرص', aliases: 'بنادول,اكسترا,مسكن', unit: 'box', category: 'مسكنات', costPrice: 4200, sellPrice: 5500, stockQty: 40, lowStockThreshold: 12 },
    { name: 'أوجمنتين ١ جم ١٤ قرص', aliases: 'اوجمنتين,مضاد حيوي', unit: 'box', category: 'مضاد حيوي', costPrice: 11000, sellPrice: 14500, stockQty: 18, lowStockThreshold: 8 },
    { name: 'فيتامين سي فوار', aliases: 'فيتامين سي,فوار,مناعة', unit: 'box', category: 'فيتامينات', costPrice: 3500, sellPrice: 4800, stockQty: 6, lowStockThreshold: 10 },
    { name: 'قطرة مرطبة للعين', aliases: 'قطرة,مرطب عين', unit: 'piece', category: 'عناية', costPrice: 5000, sellPrice: 7000, stockQty: 15, lowStockThreshold: 5 },
  ],
  restaurant: [
    { name: 'قهوة تركي محوج', aliases: 'قهوة,تركي,فنجان قهوة', unit: 'cup', category: 'مشروبات ساخنة', costPrice: 1200, sellPrice: 3500, stockQty: 120, lowStockThreshold: 25 },
    { name: 'إسبريسو دبل', aliases: 'اسبريسو,دبل شوت', unit: 'cup', category: 'مشروبات ساخنة', costPrice: 1800, sellPrice: 5500, stockQty: 90, lowStockThreshold: 20 },
    { name: 'آيس سبانيش لاتيه', aliases: 'لاتيه,سبانيش,ايس لاتيه', unit: 'cup', category: 'مشروبات باردة', costPrice: 2800, sellPrice: 8500, stockQty: 65, lowStockThreshold: 15 },
    { name: 'كرواسون زبدة طازج', aliases: 'كرواسون,مخبوزات', unit: 'piece', category: 'مخبوزات', costPrice: 2200, sellPrice: 5000, stockQty: 18, lowStockThreshold: 10 },
    { name: 'بن برازيلي خام', aliases: 'بن,قهوة خام', unit: 'kg', category: 'خامات', costPrice: 42000, sellPrice: 58000, stockQty: 6, lowStockThreshold: 8 },
  ],
  clinic: [
    { name: 'كشف استشاري تخصصي', aliases: 'كشف,استشارة,فحص', unit: 'visit', category: 'كشوفات', costPrice: 5000, sellPrice: 40000, stockQty: 999, lowStockThreshold: 10 },
    { name: 'جلسة متابعة علاجية', aliases: 'متابعة,جلسة,اعادة', unit: 'session', category: 'جلسات', costPrice: 5000, sellPrice: 25000, stockQty: 999, lowStockThreshold: 10 },
    { name: 'مستلزمات تعقيم طبية', aliases: 'تعقيم,كحول,جوانتي', unit: 'box', category: 'مستلزمات', costPrice: 15000, sellPrice: 20000, stockQty: 4, lowStockThreshold: 6 },
  ],
  electronics: [
    { name: 'شاحن سريع أصلي 30W', aliases: 'شاحن,شاحن سريع,راس شاحن', unit: 'piece', category: 'إكسسوارات', costPrice: 28000, sellPrice: 45000, stockQty: 15, lowStockThreshold: 5 },
    { name: 'سماعة بلوتوث لاسلكية', aliases: 'سماعة,ايربودز,بلوتوث', unit: 'piece', category: 'صوتيات', costPrice: 45000, sellPrice: 75000, stockQty: 8, lowStockThreshold: 4 },
    { name: 'اسكرينة حماية زجاجية', aliases: 'اسكرينة,لزقة شاشة', unit: 'piece', category: 'حماية', costPrice: 2500, sellPrice: 8000, stockQty: 4, lowStockThreshold: 10 },
    { name: 'شاشة غيار أصلية', aliases: 'شاشة,قطع غيار', unit: 'piece', category: 'صيانة', costPrice: 95000, sellPrice: 140000, stockQty: 3, lowStockThreshold: 3 },
  ],
  wholesale: [
    { name: 'كرتونة زيت عباد 12 زجاجة', aliases: 'كرتونة زيت,زيت جملة', unit: 'carton', category: 'زيوت', costPrice: 78000, sellPrice: 86000, stockQty: 45, lowStockThreshold: 15 },
    { name: 'بالة أرز فاخر 25 كيلو', aliases: 'بالة رز,ارز جملة', unit: 'pack', category: 'حبوب', costPrice: 68000, sellPrice: 75000, stockQty: 30, lowStockThreshold: 10 },
    { name: 'كرتونة مكرونة 20 كيس', aliases: 'كرتونة مكرونة,مكرونة', unit: 'carton', category: 'مكرونات', costPrice: 24000, sellPrice: 28500, stockQty: 12, lowStockThreshold: 15 },
  ],
  clothing: [
    { name: 'قميص كتان كاجوال', aliases: 'قميص,كتان', unit: 'piece', category: 'رجالي', costPrice: 32000, sellPrice: 55000, stockQty: 22, lowStockThreshold: 6 },
    { name: 'بنطلون جينز كلاسيك', aliases: 'بنطلون,جينز', unit: 'piece', category: 'رجالي', costPrice: 38000, sellPrice: 65000, stockQty: 14, lowStockThreshold: 5 },
    { name: 'تيشيرت قطن بولو', aliases: 'تيشيرت,بولو', unit: 'piece', category: 'كاجوال', costPrice: 18000, sellPrice: 32000, stockQty: 4, lowStockThreshold: 8 },
  ],
}

export async function createNewBusinessWithDefaults(params: {
  name: string
  type: string
  openingCashEgp?: number
  ownerName?: string
  customItems?: string[]
  skipDefaultSeeds?: boolean
}): Promise<BusinessLite & { itemsCount: number; cashBalance: number }> {
  const cleanName = params.name.trim().slice(0, 80) || 'منشأة جديدة'
  const cleanType = params.type.trim().slice(0, 60) || 'supermarket'
  const openingCashPiastres = Math.max(0, Math.round((params.openingCashEgp ?? 15000) * 100))
  const ownerName = params.ownerName?.trim().slice(0, 60) || 'المدير التنفيذي'

  const v = getVertical(cleanType)

  const biz = await db.business.create({
    data: {
      name: cleanName,
      type: cleanType,
      openingCash: openingCashPiastres,
      opSeq: 10,
    },
  })

  // Create Owner & Staff users
  const owner = await db.user.create({
    data: {
      businessId: biz.id,
      name: ownerName,
      role: 'owner',
      title: 'صاحب المنشأة',
    },
  })
  const staff = await db.user.create({
    data: {
      businessId: biz.id,
      name: 'مسؤول الوردية',
      role: v.features.memberships ? 'reception' : 'cashier',
      title: v.features.memberships ? 'استقبال' : 'كاشير',
    },
  })

  // Create AgentSettings
  await db.agentSettings.create({
    data: {
      businessId: biz.id,
      vertical: cleanType,
      tone: 'friendly',
    },
  })

  // Seed initial catalog items appropriate for the vertical (unless skipped for real authentic onboarding)
  const seeds: DefaultItemSeed[] = params.skipDefaultSeeds
    ? []
    : params.customItems && params.customItems.length > 0
      ? params.customItems.map((name) => ({
          name: name.trim(),
          aliases: name.trim(),
          unit: v.units[0] ?? 'piece',
          category: 'عام',
          costPrice: 5000,
          sellPrice: 8000,
          stockQty: 25,
          lowStockThreshold: 5,
        }))
      : VERTICAL_SEED_ITEMS[cleanType] ?? [
          {
            name: `صنف أساسي — ${v.shortLabel}`,
            aliases: 'صنف اول,اساسي',
            unit: v.units[0] ?? 'piece',
            category: 'عام',
            costPrice: 5000,
            sellPrice: 8000,
            stockQty: 25,
            lowStockThreshold: 5,
          },
          {
            name: `خدمة / منتج مميز — ${v.shortLabel}`,
            aliases: 'مميز,خدمة',
            unit: v.units[0] ?? 'piece',
            category: 'مميز',
            costPrice: 12000,
            sellPrice: 20000,
            stockQty: 8,
            lowStockThreshold: 10,
          },
        ]

  for (const s of seeds) {
    await db.item.create({
      data: {
        businessId: biz.id,
        name: s.name,
        aliases: s.aliases,
        unit: s.unit,
        category: s.category,
        costPrice: s.costPrice,
        sellPrice: s.sellPrice,
        stockQty: s.stockQty,
        lowStockThreshold: s.lowStockThreshold,
      },
    })
  }

  // Seed default customer & supplier
  await db.customer.create({
    data: {
      businessId: biz.id,
      name: 'أحمد محمود',
      phone: '01012345678',
      balance: 0,
      ...(v.features.memberships ? { plan: 'شهرية', expiresAt: new Date(Date.now() + 25 * 86400000) } : {}),
    },
  })
  await db.supplier.create({
    data: {
      businessId: biz.id,
      name: 'المورد الرئيسي',
      phone: '01123456789',
      balance: 0,
    },
  })

  // Seed Quick Commands tailored to the vertical
  const defaultCommands = [
    { label: 'ملخص اليوم والخزنة', prompt: 'ملخص اليوم ووضع الخزنة', icon: 'wallet', sortOrder: 0 },
    { label: 'تحليل الربحية والهوامش', prompt: 'حلل الربحية وهوامش الربح في المحل', icon: 'chart', sortOrder: 1 },
    { label: 'توقع نفاد المخزون', prompt: 'توقع المخزون ومعدل السحب والأصناف اللي قربت تخلص', icon: 'boxes', sortOrder: 2 },
    { label: 'نبض الشغل والتنبيهات', prompt: 'قولي تنبيهات ذكية وفرص ومخاطر الشغل دلوقتي', icon: 'spark', sortOrder: 3 },
  ]
  for (const cmd of defaultCommands) {
    await db.quickCommand.create({
      data: {
        businessId: biz.id,
        userId: owner.id,
        label: cmd.label,
        prompt: cmd.prompt,
        icon: cmd.icon,
        sortOrder: cmd.sortOrder,
      },
    })
  }

  return {
    id: biz.id,
    name: biz.name,
    type: biz.type as Vertical,
    itemsCount: seeds.length,
    cashBalance: openingCashPiastres,
    users: [
      { id: owner.id, name: owner.name, role: owner.role as Role, title: owner.title },
      { id: staff.id, name: staff.name, role: staff.role as Role, title: staff.title },
    ],
  }
}

export async function configureExistingBusiness(params: {
  businessId: string
  name?: string
  type?: string
  tone?: string
  autonomy?: string
  autoConfirmLow?: boolean
}) {
  const current = await db.business.findUnique({ where: { id: params.businessId } })
  if (!current) throw new Error('Business not found')

  const nextName = params.name?.trim() || current.name
  const nextType = params.type?.trim() || current.type

  const updated = await db.business.update({
    where: { id: params.businessId },
    data: {
      name: nextName,
      type: nextType,
    },
  })

  if (params.tone || params.type) {
    await db.agentSettings.upsert({
      where: { businessId: params.businessId },
      update: {
        ...(params.type ? { vertical: nextType } : {}),
        ...(params.tone ? { tone: params.tone } : {}),
        updatedAt: new Date(),
      },
      create: {
        businessId: params.businessId,
        vertical: nextType,
        tone: params.tone ?? 'friendly',
      },
    })
  }

  return updated
}

export async function upsertCatalogItemInDb(params: {
  businessId: string
  name: string
  category?: string
  unit?: string
  sellPriceEgp?: number
  buyPriceEgp?: number
  stockQty?: number
  minQty?: number
}) {
  const cleanName = params.name.trim()
  const normTarget = normalizeAr(cleanName)
  const items = await db.item.findMany({ where: { businessId: params.businessId } })
  const existing = items.find((i) => normalizeAr(i.name) === normTarget)

  const sellPrice = params.sellPriceEgp != null ? Math.round(params.sellPriceEgp * 100) : undefined
  const costPrice = params.buyPriceEgp != null ? Math.round(params.buyPriceEgp * 100) : undefined

  if (existing) {
    const item = await db.item.update({
      where: { id: existing.id },
      data: {
        ...(params.category ? { category: params.category.trim() } : {}),
        ...(params.unit ? { unit: params.unit.trim() } : {}),
        ...(sellPrice != null ? { sellPrice } : {}),
        ...(costPrice != null ? { costPrice } : {}),
        ...(params.stockQty != null ? { stockQty: params.stockQty } : {}),
        ...(params.minQty != null ? { lowStockThreshold: params.minQty } : {}),
      },
    })
    return { created: false, item }
  }

  const sell = sellPrice ?? 5000
  const cost = costPrice ?? Math.round(sell * 0.75)
  const item = await db.item.create({
    data: {
      businessId: params.businessId,
      name: cleanName,
      aliases: cleanName,
      category: params.category?.trim() || 'عام',
      unit: params.unit?.trim() || 'piece',
      sellPrice: sell,
      costPrice: cost,
      stockQty: params.stockQty ?? 10,
      lowStockThreshold: params.minQty ?? 5,
    },
  })
  return { created: true, item }
}
