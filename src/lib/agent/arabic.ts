// وكيل — Arabic text parsing: normalization, Arabic numerals, word-numbers,
// unit conversion, and fuzzy entity matching. The LLM only identifies WHAT the
// user wants; this module makes the server actually UNDERSTAND it deterministically.


/** Normalize Arabic text for matching: strip tashkeel/diacritics, unify alef/yaa/taa, collapse spaces. */
export function normalizeAr(input: string): string {
  return input
    .trim()
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '') // tashkeel + tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩'
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹'

/** Convert Arabic-Indic / Persian digits to western. */
export function toWesternDigits(s: string): string {
  let out = ''
  for (const ch of s) {
    const ai = AR_DIGITS.indexOf(ch)
    const fi = FA_DIGITS.indexOf(ch)
    if (ai >= 0) out += String(ai)
    else if (fi >= 0) out += String(fi)
    // ARABIC DECIMAL SEPARATOR (U+066B) and THOUSANDS SEPARATOR (U+066C).
    // Without this, «١٢٫٥٠ جنيه» parsed as 12 — a real money bug: every price
    // typed with an Arabic decimal separator lost its piastres silently.
    else if (ch === '\u066B') out += '.'
    else if (ch === '\u066C') out += ''
    else out += ch
  }
  return out
}

const WORD_NUMBERS: Record<string, number> = {
  'نص كيلو': 0.5,
  'ربع كيلو': 0.25,
  نص: 0.5,
  ربع: 0.25,
  تلت: 1 / 3,
}

const AR_NUMBER_WORDS: Record<string, number> = {
  صفر: 0, واحده: 1, واحد: 1, اتنين: 2, تلات: 3, ثلاث: 3, اربعه: 4, اربع: 4,
  خمسه: 5, خمس: 5, سته: 6, ست: 6, سبعه: 7, سبع: 7, تمانيه: 8, ثمانيه: 8, تمنيه: 8,
  تسعه: 9, تسع: 9, عشره: 10, عشر: 10, عشرين: 20, تلاتين: 30, ثلاثين: 30, اربعين: 40,
  خمسين: 50, ستين: 60, سبعين: 70, تمانين: 80, ثمانين: 80, تسعين: 90, ميه: 100,
  مايه: 100, مئه: 100, الف: 1000,
}

/** Parse a number written in western digits, Arabic-Indic digits, or Arabic words. Returns null if not a number. */
export function parseArabicNumber(raw: string): number | null {
  const hasDigits = /[0-9٠-٩]/.test(raw)
  if (hasDigits) {
    // «،» and «,» are used as decimal separators by Egyptian speakers too.
    const s = toWesternDigits(raw).replace(/[,،]/g, '.')
    const m = s.match(/-?\d+(\.\d+)?/)
    if (m) return parseFloat(m[0])
  }
  const w = normalizeAr(raw)
  if (WORD_NUMBERS[w] != null) return WORD_NUMBERS[w]
  if (AR_NUMBER_WORDS[w] != null) return AR_NUMBER_WORDS[w]
  // compound like «تلات الف»
  const parts = w.split(' ').filter(Boolean)
  if (parts.length === 2) {
    const a = AR_NUMBER_WORDS[parts[0]]
    if (a != null && parts[1] === 'الف') return a * 1000
    const b = AR_NUMBER_WORDS[parts[1]]
    if (a != null && b != null) return a * b
  }
  return null
}

export interface ParsedQuantity {
  qty: number | null
  unit: string | null
}

// NOTE: \b word boundaries DON'T work with Arabic letters (non-word chars in
// JS regex) — always use (^|\s)…(\s|$) patterns or plain includes instead.
const UNIT_WORD_TO_CODE: [RegExp, string][] = [
  [/جرام|جرامات|^جم$|^جم(?=\s)/, 'gram'],
  [/كيلو|كيلوغرام|^كج$|(?<=\s)كج(?=\s)/, 'kg'],
  [/مللي|ميلي|^مل$|(?<=\s)مل(?=\s)/, 'milli'],
  [/لتر|ليتر/, 'liter'],
  [/علبه?|علب|صندوق|صناديق|كرتونه?|كراتين/, 'box'],
  [/شريط|شرايط|شرائط/, 'strip'],
  [/كبسوله?|كبسولات/, 'capsule'],
  [/قطعه?|قطع|عدد|حبه?|حبات/, 'piece'],
  [/حصص?|جلسه?|جلسات/, 'session'],
]

const UNIT_CODES = ['piece', 'kg', 'gram', 'liter', 'milli', 'box', 'strip', 'capsule', 'session']

/** Map an LLM/text unit (Arabic word or code) to the canonical unit code. */
export function unitToCode(u: string | null | undefined): string | null {
  if (!u) return null
  const s = normalizeAr(String(u)).trim()
  if (UNIT_CODES.includes(s)) return s
  for (const [re, code] of UNIT_WORD_TO_CODE) {
    if (re.test(s)) return code
  }
  return null
}

/** Parse a quantity+unit phrase like «10 جرام», «ربع كيلو», «5 علب», «٣ صنادي». */
export function parseQuantity(text: string, defaultUnit: string | null = null): ParsedQuantity {
  const s = toWesternDigits(normalizeAr(text))
  let unit: string | null = defaultUnit
  for (const [re, code] of UNIT_WORD_TO_CODE) {
    if (re.test(s)) {
      unit = code
      break
    }
  }
  const numMatch = s.match(/\d+(\.\d+)?/)
  let qty: number | null = null
  if (numMatch) {
    qty = parseFloat(numMatch[0])
  } else {
    for (const [phrase, val] of Object.entries(WORD_NUMBERS).sort((a, b) => b[0].length - a[0].length)) {
      if (s.includes(normalizeAr(phrase))) {
        qty = val
        break
      }
    }
    if (qty == null) {
      for (const [word, val] of Object.entries(AR_NUMBER_WORDS)) {
        if (new RegExp(`(^| )${word}( |$)`).test(s)) {
          qty = val
          break
        }
      }
    }
  }
  return { qty, unit }
}

/** Convert a quantity+unit to the item's base unit. Returns null if incompatible. */
export function convertToBaseUnit(qty: number, fromUnit: string, baseUnit: string): number | null {
  if (fromUnit === baseUnit) return qty
  const table: Record<string, Record<string, number>> = {
    kg: { gram: 1000, kg: 1 },
    gram: { gram: 1, kg: 0.001 },
    liter: { milli: 1000, liter: 1 },
    milli: { milli: 1, liter: 0.001 },
    box: { piece: 1, box: 1, strip: 1 },
    strip: { piece: 1, strip: 1, box: 1 },
    piece: { piece: 1, box: 1, strip: 1, capsule: 1 },
    capsule: { piece: 1, capsule: 1 },
    session: { session: 1 },
  }
  const row = table[fromUnit]
  if (!row) return null
  const factor = row[baseUnit]
  if (factor == null) return null
  return Math.round(qty * factor * 1000) / 1000
}

/** Fuzzy-match a user-typed name against candidates (name + aliases). Returns best match or null. */
export function matchEntity<T extends { name: string; aliases?: string | null }>(
  query: string,
  candidates: T[],
): { entity: T; score: number } | null {
  const q = normalizeAr(query).replace(/^(ال)/, '')
  if (!q) return null
  let best: { entity: T; score: number } | null = null
  for (const c of candidates) {
    const names = [c.name, ...(c.aliases ? c.aliases.split(',').map((a) => a.trim()) : [])]
    for (const n of names) {
      const nn = normalizeAr(n).replace(/^(ال)/, '')
      if (!nn) continue
      let score = 0
      if (nn === q) score = 1
      else if (nn.includes(q) || q.includes(nn)) {
        score = 0.85 - (Math.abs(nn.length - q.length) / Math.max(nn.length, q.length, 8)) * 0.2
      } else {
        const qt = new Set(q.split(' ').filter((t) => t.length > 1))
        const nt = new Set(nn.split(' ').filter((t) => t.length > 1))
        let hits = 0
        for (const t of qt) if (nt.has(t)) hits++
        if (qt.size > 0 && hits > 0) score = 0.6 + 0.2 * (hits / qt.size)
      }
      if (score > 0 && (!best || score > best.score)) best = { entity: c, score }
    }
  }
  return best && best.score >= 0.55 ? best : null
}

/** Extract candidate entities mentioned in free text (for multi-item messages). */
export function findMentions<T extends { name: string; aliases?: string | null }>(
  text: string,
  candidates: T[],
): T[] {
  const s = normalizeAr(text)
  const found: T[] = []
  for (const c of candidates) {
    const names = [c.name, ...(c.aliases ? c.aliases.split(',').map((a) => a.trim()) : [])]
    for (const n of names) {
      const nn = normalizeAr(n)
      if (nn && nn.length >= 3 && s.includes(nn)) {
        found.push(c)
        break
      }
    }
  }
  return found
}
