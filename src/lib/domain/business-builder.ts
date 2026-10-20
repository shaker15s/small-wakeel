import { requirePermission } from '@/lib/security/permissions'
import { invalidateCatalog } from '@/lib/agent/catalog'
// وكيل — Dynamic Business Builder & Self-Configuring Engine
// Creates blank real businesses; supplied item names have unknown stock/prices (zero),
// and AgentSettings. No starter parties, staff or financial examples. Live catalog & business
// configuration tools invoked by the agent harness.

import { db } from '@/lib/db'
import { getVertical } from '@/lib/verticals'
import type { BusinessLite, Role, Vertical } from '@/lib/types'
import { normalizeAr } from '@/lib/agent/arabic'

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
  if (!Number.isFinite(params.openingCashEgp ?? 0) || (params.openingCashEgp ?? 0) < 0) throw new Error('رصيد البداية غير صالح')
  const openingCashPiastres = Math.max(0, Math.round((params.openingCashEgp ?? 0) * 100))
  const ownerName = params.ownerName?.trim().slice(0, 60) || 'المدير التنفيذي'

  const v = getVertical(cleanType)

  if (!Number.isSafeInteger(openingCashPiastres) || openingCashPiastres > 1_000_000_000) throw new Error('رصيد البداية غير صالح')
  return db.$transaction(async (tx) => {
    const biz = await tx.business.create({
      data: {
        name: cleanName,
        type: cleanType,
        workflowMode: ['supermarket', 'attar'].includes(cleanType) ? 'cashbook' : 'inventory',
        openingCash: openingCashPiastres,
        opSeq: 0,
      },
  })

  // Create Owner & Staff users
  const owner = await tx.user.create({
    data: {
      businessId: biz.id,
      name: ownerName,
      role: 'owner',
      title: 'صاحب المنشأة',
    },
  })
  // Create AgentSettings
  await tx.agentSettings.create({
    data: {
      businessId: biz.id,
      vertical: cleanType,
      tone: 'friendly',
    },
  })

  // Only names explicitly supplied by the user. Unknown prices/stock stay zero.
  const seeds = [...new Set(params.customItems ?? [])].filter((name) => name.trim()).slice(0, 100).map((name) => ({
    name: name.trim().slice(0, 120), aliases: '', unit: v.units[0] ?? 'piece', category: '',
    costPrice: 0, sellPrice: 0, stockQty: 0, lowStockThreshold: 0,
  }))

  for (const s of seeds) {
    await tx.item.create({
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

  return {
    id: biz.id,
    name: biz.name,
    type: biz.type as Vertical,
    workflowMode: biz.workflowMode,
    itemsCount: seeds.length,
    cashBalance: openingCashPiastres,
    users: [
      { id: owner.id, name: owner.name, role: owner.role as Role, title: owner.title },
    ],
  }
  })
}

export async function configureExistingBusiness(params: {
  businessId: string
  userId: string
  name?: string
  type?: string
  tone?: string
  autonomy?: string
  autoConfirmLow?: boolean
}) {
  await requirePermission(params.businessId, params.userId, 'business.configure')
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
  userId: string
  name: string
  category?: string
  unit?: string
  sellPriceEgp?: number
  buyPriceEgp?: number
  stockQty?: number
  minQty?: number
}) {
  await requirePermission(params.businessId, params.userId, 'catalog.manage')
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
    invalidateCatalog(params.businessId)
    return { created: false, item }
  }

  // R70 / PR-001 (الخطة النهائية v2 — «المجهول ما يصيرش حقيقة»): unknown
  // financial facts are stored as NULL, NEVER invented. The old defaults
  // (sell=50 EGP, cost=75% of sell, stock=10, threshold=5) became real
  // operating facts: margin "calculated" against a fake cost, stock checks
  // against a phantom 10, shortages at a made-up level. category/unit are
  // classification labels, not financial facts — defaults are fine there.
  const item = await db.item.create({
    data: {
      businessId: params.businessId,
      name: cleanName,
      aliases: cleanName,
      category: params.category?.trim() || 'عام',
      unit: params.unit?.trim() || 'piece',
      sellPrice,
      costPrice,
      stockQty: params.stockQty != null ? Math.round(Number(params.stockQty)) : null,
      lowStockThreshold: params.minQty != null ? Math.round(Number(params.minQty)) : null,
    },
  })
  invalidateCatalog(params.businessId)
  return { created: true, item }
}
