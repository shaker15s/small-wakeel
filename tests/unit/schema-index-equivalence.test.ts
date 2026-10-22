import { describe, expect, test } from 'bun:test'
import { hasEquivalentIndex } from '../../scripts/lib/prisma-index-equivalence'

describe('schema index equivalence', () => {
  const expected = { name: 'Item_businessId_name_idx', kind: 'index' as const, fields: ['businessId', 'name'] }
  test('accepts a structurally identical legacy-named default index', () => {
    expect(hasEquivalentIndex(expected, [{ name: 'Item_businessId_name_index', unique: false, fields: ['businessId', 'name'] }], 'Item_businessId_name_idx')).toBe(true)
  })
  test('does not accept a partial, reordered, different-field or unique index as equivalent', () => {
    expect(hasEquivalentIndex(expected, [{ name: 'legacy', unique: false, partial: true, fields: ['businessId', 'name'] }], expected.name)).toBe(false)
    expect(hasEquivalentIndex(expected, [{ name: 'legacy', unique: false, fields: ['name', 'businessId'] }], expected.name)).toBe(false)
    expect(hasEquivalentIndex(expected, [{ name: 'legacy', unique: false, fields: ['businessId', 'barcode'] }], expected.name)).toBe(false)
    expect(hasEquivalentIndex(expected, [{ name: 'legacy', unique: true, fields: ['businessId', 'name'] }], expected.name)).toBe(false)
  })
  test('keeps an explicit custom Prisma map name strict', () => {
    const mapped = { name: 'custom_catalog_idx', kind: 'index' as const, fields: ['businessId', 'name'] }
    expect(hasEquivalentIndex(mapped, [{ name: 'legacy', unique: false, fields: ['businessId', 'name'] }], 'Item_businessId_name_idx')).toBe(false)
    expect(hasEquivalentIndex(mapped, [{ name: 'custom_catalog_idx', unique: false, fields: ['businessId', 'name'] }], 'Item_businessId_name_idx')).toBe(true)
  })
})
