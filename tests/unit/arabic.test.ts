// وكيل — Egyptian-Arabic normalisation, numbers and unit conversion.
// The agent resolves entities from the OWNER's dialect, so these helpers are
// the difference between «بعت كيلو طماطم» working and silently doing nothing.
import { describe, expect, test } from 'bun:test'
import {
  normalizeAr,
  toWesternDigits,
  parseArabicNumber,
  parseQuantity,
  convertToBaseUnit,
  unitToCode,
  matchEntity,
} from '../../src/lib/agent/arabic'

describe('arabic.normalizeAr', () => {
  test('collapses alef/hamza/ya/ta-marbuta variants to one form', () => {
    const forms = ['احمد', 'أحمد', 'إحمد', 'آحمد']
    const normalized = forms.map((f) => normalizeAr(f))
    expect(new Set(normalized).size).toBe(1)
  })

  test('strips diacritics and tatweel', () => {
    expect(normalizeAr('مُحَمَّد')).toBe(normalizeAr('محمد'))
    expect(normalizeAr('لبـــن')).toBe(normalizeAr('لبن'))
  })

  test('lowercases latin text', () => {
    expect(normalizeAr('Pepsi')).toBe('pepsi')
  })

  test('invisible bidi/zero-width chars become spaces, joiners are removed (R41)', () => {
    // RLM/ZWSP between words must keep the words separate (gluing them broke
    // the «عامل ايه ؟» greeting in the live preview).
    expect(normalizeAr('عامل\u200fايه ؟')).toBe(normalizeAr('عامل ايه ؟'))
    expect(normalizeAr('ازيك\u200b')).toBe('ازيك')
    expect(normalizeAr('\u200eصباح الخير\u200f')).toBe('صباح الخير')
    // the true joiners live INSIDE a word — removed, not space-padded
    expect(normalizeAr('مح\u200cمد')).toBe('محمد')
    // trailing punctuation survives the space-collapse
    expect(normalizeAr('عامل ايه\u200f ؟')).toBe('عامل ايه ؟')
  })
})

describe('arabic.digits', () => {
  test('Arabic-Indic digits are converted to ASCII', () => {
    expect(toWesternDigits('١٢٣')).toBe('123')
    expect(toWesternDigits('٩٥ جنيه')).toBe('95 جنيه')
  })

  test('decimal separators are understood', () => {
    expect(parseArabicNumber('١٢٫٥')).toBeCloseTo(12.5, 5)
    expect(parseArabicNumber('12.5')).toBeCloseTo(12.5, 5)
  })
})

describe('arabic.parseQuantity', () => {
  test('reads a count + unit from a sentence', () => {
    const parsed = parseQuantity('بعت ٢ علبة لبن', null)
    expect(parsed.qty).toBe(2)
    expect(parsed.unit).toBeTruthy()
  })

  test('reads kilos', () => {
    const parsed = parseQuantity('اشتريت ٣ كيلو طماطم', null)
    expect(parsed.qty).toBe(3)
  })

  test('half kilos stay fractional (never silently rounded)', () => {
    const parsed = parseQuantity('نص كيلو لحمة', null)
    expect(parsed.qty).toBeGreaterThan(0)
    expect(parsed.qty).toBeLessThanOrEqual(1)
  })
})

describe('arabic units', () => {
  test('kilo → gram conversion for attar-style base units', () => {
    // The harness always normalises the spoken unit to a code first.
    expect(unitToCode('كيلو')).toBe('kg')
    expect(convertToBaseUnit(1, unitToCode('كيلو')!, 'gram')).toBe(1000)
    expect(convertToBaseUnit(250, unitToCode('جرام')!, 'gram')).toBe(250)
  })

  test('unknown conversions return null instead of a wrong guess', () => {
    expect(convertToBaseUnit(1, 'kg', 'box')).toBeNull()
  })

  test('unit codes are dialect-aware', () => {
    expect(unitToCode('كيلو')).toBe('kg')
    expect(unitToCode('علبة')).toBeTruthy()
  })
})

describe('arabic.matchEntity', () => {
  const items = [
    { name: 'لبن كرتونة (جهينة)', aliases: 'لبن,حليب' },
    { name: 'طماطم', aliases: null },
    { name: 'أرز مصري', aliases: 'رز' },
  ]

  test('matches by canonical name', () => {
    const hit = matchEntity('عايز طماطم', items)
    expect(hit?.entity.name).toBe('طماطم')
    expect(hit!.score).toBeGreaterThan(0.5)
  })

  test('matches by dialect alias', () => {
    expect(matchEntity('رز موجود؟', items)?.entity.name).toBe('أرز مصري')
    expect(matchEntity('فيه حليب؟', items)?.entity.name).toBe('لبن كرتونة (جهينة)')
  })

  test('returns null when nothing matches (no false positives)', () => {
    expect(matchEntity('عايز تفاح', items)).toBeNull()
  })
})
