// وكيل — CSV import robustness (Excel exports are messy; the importer must not be).
import { describe, expect, test } from 'bun:test'
import { mapCsv, parseCsv, parseFlexibleDate, parseFlexibleNumber, sniffDelimiter } from '../../src/lib/csv'
import { normalizeAr } from '../../src/lib/agent/arabic'

describe('csv.parseCsv', () => {
  test('quoted fields keep commas and newlines', () => {
    const rows = parseCsv('a,b\n"لبن, كرتونة","سطر\nتاني"')
    expect(rows[0]).toEqual(['a', 'b'])
    expect(rows[1][0]).toBe('لبن, كرتونة')
    expect(rows[1][1]).toBe('سطر\nتاني')
  })

  test('escaped quotes survive', () => {
    expect(parseCsv('a\n"بيقول ""أهلاً"""')[1][0]).toBe('بيقول "أهلاً"')
  })

  test('BOM, CRLF and trailing blank lines are handled', () => {
    const rows = parseCsv('\uFEFFاسم,سعر\r\nلبن,45\r\n\r\n')
    expect(rows).toHaveLength(2)
  })

  test('semicolon and tab exports are sniffed automatically', () => {
    expect(sniffDelimiter('اسم;سعر\nلبن;45')).toBe(';')
    expect(parseCsv('اسم\tسعر\nلبن\t45')[1]).toEqual(['لبن', '45'])
  })
})

describe('csv.mapCsv', () => {
  const synonyms = {
    name: ['اسم', 'الصنف', 'item'],
    sellPrice: ['سعر البيع', 'السعر', 'price'],
    stockQty: ['الكمية', 'الرصيد', 'qty'],
  }
  test('Arabic headers map regardless of spacing/diacritics', () => {
    const table = mapCsv('الاسم،سعر البيع،الكمية\nلبن،٤٥،١٢', synonyms as never, normalizeAr)
    expect(table.rows[0].name).toBe('لبن')
    expect(table.rows[0].sellPrice).toBe('٤٥')
  })

  test('unknown headers are reported, not silently dropped', () => {
    const table = mapCsv('اسم,سعر البيع,حاجة غريبة\nلبن,45,x', synonyms as never, normalizeAr)
    expect(table.unknownHeaders).toContain('حاجة غريبة')
  })
})

describe('csv.parseFlexibleNumber', () => {
  test('Arabic digits and decimal separator', () => {
    expect(parseFlexibleNumber('١٢٣٫٥')).toBeCloseTo(123.5, 5)
  })
  test('currency noise and thousands separators', () => {
    expect(parseFlexibleNumber('1,250.50 ج.م')).toBeCloseTo(1250.5, 5)
    expect(parseFlexibleNumber('12 جنيه')).toBe(12)
  })
  test('empty / junk cells return null instead of NaN', () => {
    expect(parseFlexibleNumber('')).toBeNull()
    expect(parseFlexibleNumber('كلام')).toBeNull()
  })
})

describe('csv.parseFlexibleDate', () => {
  test('ISO and Egyptian dd/mm/yyyy both parse', () => {
    expect(parseFlexibleDate('2026-03-01')?.toISOString().slice(0, 10)).toBe('2026-03-01')
    expect(parseFlexibleDate('01/03/2026')?.toISOString().slice(0, 10)).toBe('2026-03-01')
    expect(parseFlexibleDate('٠١/٠٣/٢٦')?.toISOString().slice(0, 10)).toBe('2026-03-01')
  })
  test('junk returns null', () => {
    expect(parseFlexibleDate('مش تاريخ')).toBeNull()
  })
})

describe('csv → catalog identity', () => {
  test('Arabic-Indic digits fold, so «شاي ٢٥٠» matches «شاي 250»', async () => {
    // mirrors the importer's nameKey (normalise letters, «ال», digits, spaces)
    const { normalizeAr, toWesternDigits } = await import('../../src/lib/agent/arabic')
    const key = (s: string) => normalizeAr(toWesternDigits(s)).replace(/^ال/, '').replace(/\s+/g, ' ').trim()
    expect(key('شاي العروسة ٢٥٠ جرام')).toBe(key('شاي العروسة 250 جرام'))
    expect(key('اللبن كرتونة')).toBe(key('لبن كرتونة'))
  })
})
