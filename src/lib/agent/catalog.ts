// وكيل — short-lived catalog cache («سرعة»).
//
// Every turn loads the whole catalog (items + customers + suppliers) to ground
// the owner's words in real rows. That is 3 queries per turn and grows with the
// shop: a 600-item grocery pays it on every message, including the one-word
// follow-ups that are the most common thing an owner types («وبكام؟», «وزود ٢»).
//
// A 5-second TTL removes that cost for bursts of consecutive turns while keeping
// correctness:
//   • writes invalidate explicitly (`invalidateCatalog`) — the executors call it
//     after a committed transaction, the import route after a bulk import
//   • verification read-backs NEVER use this cache (they query the DB directly),
//     so a confirmed operation is always checked against live rows
//   • the TTL bounds any path that forgot to invalidate (HMR, a second worker)
import { db } from '@/lib/db'
import type { Customer, Item, Supplier } from '@prisma/client'

const TTL_MS = 5_000

export interface Catalog {
  items: Item[]
  customers: Customer[]
  suppliers: Supplier[]
}

interface Entry {
  at: number
  value: Catalog
}

const globalForCatalog = globalThis as unknown as {
  __wakilCatalog?: Map<string, Entry>
  __wakilCatalogHits?: { hits: number; misses: number }
}

const store: Map<string, Entry> = (globalForCatalog.__wakilCatalog ??= new Map())
const stats = (globalForCatalog.__wakilCatalogHits ??= { hits: 0, misses: 0 })

/** Cached catalog for one business (5 s TTL, in-process). */
export async function getCatalog(businessId: string): Promise<Catalog> {
  const hit = store.get(businessId)
  if (hit && Date.now() - hit.at < TTL_MS) {
    stats.hits += 1
    return hit.value
  }
  stats.misses += 1
  const [items, customers, suppliers] = await Promise.all([
    db.item.findMany({ where: { businessId } }),
    db.customer.findMany({ where: { businessId } }),
    db.supplier.findMany({ where: { businessId } }),
  ])
  const value: Catalog = { items, customers, suppliers }
  store.set(businessId, { at: Date.now(), value })
  return value
}

/**
 * Drop cached catalogs. Called after ANY committed write that touches items,
 * customers or suppliers — an owner who just approved a sale must not see the
 * pre-sale stock on his next message.
 */
export function invalidateCatalog(businessId?: string): void {
  if (businessId) store.delete(businessId)
  else store.clear()
}

/** Cache telemetry for /api/health (hit ratio is the speed story). */
export function catalogCacheStats(): { hits: number; misses: number; ratio: number; entries: number } {
  const total = stats.hits + stats.misses
  return {
    hits: stats.hits,
    misses: stats.misses,
    ratio: total === 0 ? 0 : Math.round((stats.hits / total) * 100),
    entries: store.size,
  }
}
