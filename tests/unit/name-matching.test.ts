import { describe, expect, test } from 'bun:test'
import { matchEntity } from '../../src/lib/agent/arabic'

// ---------------------------------------------------------------------------
// R29 — «مين الصنف اللي قصده؟» (name matching must never invent a product)
// ---------------------------------------------------------------------------
// Live bug: «بعت علبة شوكولاتة كيندر بـ٤٠» resolved to «كوكاكولا 1 لتر» because
// «شوكولاتة» CONTAINS the letters «كولا» and the old matcher accepted any
// substring. Money operations must never be built on that.

const SUPERMARKET = [
  { id: 'koka', name: 'كوكاكولا 1 لتر', aliases: 'كولا, كوكاكولا' },
  { id: 'romy', name: 'جبنة رومي كيلو', aliases: 'جبنة رومي, رومي' },
  { id: 'labn', name: 'لبن كرتونة (جهينة)', aliases: 'لبن, لبن جهينة, كرتونة لبن' },
  { id: 'qahwa', name: 'قهوة أحمد 250 جرام', aliases: 'قهوة, قهوة أحمد' },
  { id: 'orio', name: 'بسكويت أوريو', aliases: 'اوريو, بسكويت' },
  { id: 'kinder', name: 'شوكولاتة كيندر', aliases: null },
]

describe('matchEntity — القصد الصح للصنف', () => {
  test('«شوكولاتة كيندر» never becomes كوكاكولا', () => {
    const hit = matchEntity('شوكولاتة كيندر', SUPERMARKET)
    // the EXACT catalog name wins; the cola is not even a candidate
    expect(hit?.entity.name).toBe('شوكولاتة كيندر')
    expect(matchEntity('شوكولاتة كيندر بدون اسم', SUPERMARKET.filter((i) => i.id !== 'kinder'))?.entity.name).toBeUndefined()
  })

  test('generic «شوكولاتة» alone does not resolve to a cola', () => {
    const hit = matchEntity('شوكولاتة', SUPERMARKET.filter((i) => i.id !== 'kinder'))
    expect(hit).toBeNull()
  })

  test('dialect aliases still work (كولا · رومي · أوريو)', () => {
    expect(matchEntity('كولا', SUPERMARKET)?.entity.name).toBe('كوكاكولا 1 لتر')
    expect(matchEntity('رومي', SUPERMARKET)?.entity.name).toBe('جبنة رومي كيلو')
    expect(matchEntity('اوريو', SUPERMARKET)?.entity.name).toBe('بسكويت أوريو')
  })

  test('«ال» does not break a name («الجبنة الرومي» · «اللبن»)', () => {
    expect(matchEntity('الجبنة الرومي', SUPERMARKET)?.entity.name).toBe('جبنة رومي كيلو')
    expect(matchEntity('اللبن', SUPERMARKET)?.entity.name).toBe('لبن كرتونة (جهينة)')
  })

  test('a full sentence resolves what it truly mentions', () => {
    expect(matchEntity('بعت ٢ كيلو رومي بـ٢٩٠', SUPERMARKET)?.entity.name).toBe('جبنة رومي كيلو')
    expect(matchEntity('بعت قهوة أحمد كوباية', SUPERMARKET)?.entity.name).toBe('قهوة أحمد 250 جرام')
  })

  test('an unrelated product is NOT a match (no فزّالة)', () => {
    expect(matchEntity('حليب مجفف', SUPERMARKET)).toBeNull()
    expect(matchEntity('شيبسي', SUPERMARKET)).toBeNull()
    expect(matchEntity('بطاريات', SUPERMARKET)).toBeNull()
  })

  test('pharmacy brand spellings stay distinct (بنادول ≠ بانادول)', () => {
    const pharmacy = [
      { id: 'p1', name: 'بنادول أطفال شراب', aliases: 'بنادول أطفال' },
      { id: 'p2', name: 'بانادول أكتيف 24 قرص', aliases: 'بانادول, بانادول أكتيف' },
      { id: 'p3', name: 'بانادول شرائط', aliases: 'بانادول شريط' },
      { id: 'p4', name: 'أوجمنتين 1 جم', aliases: 'أوجمنتين' },
    ]
    expect(matchEntity('اوجمنتين', pharmacy)?.entity.name).toBe('أوجمنتين 1 جم')
    expect(matchEntity('بنادول أطفال', pharmacy)?.entity.name).toBe('بنادول أطفال شراب')
    expect(matchEntity('فولتارين', pharmacy)).toBeNull()
  })

  test('attar: «زيت عود» ≠ «زيت مسك» ≠ «زيت لوز»', () => {
    const attar = [
      { id: 'z1', name: 'زيت عود', aliases: 'دهن عود' },
      { id: 'z2', name: 'زيت مسك', aliases: 'مسك سائل' },
      { id: 'z3', name: 'زيت لوز', aliases: 'لوز, زيت اللوز' },
      { id: 'z4', name: 'عود كمبودي', aliases: 'عود, العود, عود كمبودي' },
    ]
    expect(matchEntity('دهن عود', attar)?.entity.name).toBe('زيت عود')
    expect(matchEntity('زيت لوز', attar)?.entity.name).toBe('زيت لوز')
    expect(matchEntity('عود كمبودي', attar)?.entity.name).toBe('عود كمبودي')
  })
})
