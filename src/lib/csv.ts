// وكيل — CSV/TSV parsing for inventory import.
//
// Deliberately NOT a dependency: shops export from Excel with a BOM, CRLF line
// endings, Arabic-Indic digits, «،» decimals and quoted fields that contain
// commas or newlines. This is a small RFC 4180 reader that survives all of it.

/** Strip a UTF-8 BOM and normalise newlines. */
function normalize(raw: string): string {
  return raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

/**
 * Sniff the delimiter: comma, semicolon or tab — whichever splits the header
 * row into the most cells (Excel in Arabic locales often uses «;»).
 */
export function sniffDelimiter(raw: string): string {
  const header = normalize(raw).split('\n')[0] ?? ''
  // «،» (Arabic comma) is what a shop owner types by hand; Excel uses ';' in
  // Arabic locales and '\t' when pasting from a spreadsheet.
  const candidates = [',', ';', '\t', '|', '،']
  let best = ','
  let bestCount = 0
  for (const d of candidates) {
    const count = header.split(d).length
    if (count > bestCount) {
      bestCount = count
      best = d
    }
  }
  return best
}

/**
 * Parse CSV text into a matrix of trimmed strings.
 * Handles quoted fields, escaped quotes ("") and embedded newlines.
 */
export function parseCsv(raw: string, delimiter?: string): string[][] {
  const text = normalize(raw)
  const d = delimiter ?? sniffDelimiter(text)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
      continue
    }
    if (ch === d) {
      row.push(field.trim())
      field = ''
      continue
    }
    if (ch === '\n') {
      row.push(field.trim())
      field = ''
      // skip fully empty lines (trailing blank line in every Excel export)
      if (row.some((c) => c !== '')) rows.push(row)
      row = []
      continue
    }
    field += ch
  }
  row.push(field.trim())
  if (row.some((c) => c !== '')) rows.push(row)
  return rows
}

/** Parsed CSV with a header row mapped onto caller-provided keys. */
export interface CsvTable<K extends string> {
  columns: Record<K, number | -1>
  rows: Record<K, string>[]
  /** Header cells that matched no known column (reported back to the user). */
  unknownHeaders: string[]
  delimiter: string
}

/**
 * Map a header row onto known keys.
 * `synonyms` entries are compared after Arabic normalisation, so «سعر البيع»
 * matches «سعر بيع» and «السعر» alike.
 */
export function mapCsv<K extends string>(
  raw: string,
  synonyms: Record<K, string[]>,
  normalizeFn: (s: string) => string,
): CsvTable<K> {
  const matrix = parseCsv(raw)
  const headers = matrix[0] ?? []
  const keys = Object.keys(synonyms) as K[]
  const columns = {} as Record<K, number | -1>
  for (const k of keys) columns[k] = -1

  // Header matching drops the «ال» article («الاسم» ≡ «اسم») the same way the
  // entity matcher does — otherwise the most natural Arabic header row misses.
  const clean = (x: string) => {
    const base = normalizeFn(x).replace(/[\s_.()-]+/g, ' ').trim()
    const bare = base.replace(/^ال/, '')
    return bare.length >= 3 ? bare : base
  }
  const normHeaders = headers.map(clean)
  const matched = new Set<number>()
  for (const k of keys) {
    for (const synonym of synonyms[k]) {
      const target = clean(synonym)
      const idx = normHeaders.findIndex((h, i) => !matched.has(i) && (h === target || (target.length >= 3 && h.includes(target))))
      if (idx >= 0) {
        columns[k] = idx
        matched.add(idx)
        break
      }
    }
  }

  const rows = matrix.slice(1).map((cells) => {
    const record = {} as Record<K, string>
    for (const k of keys) {
      const idx = columns[k]
      record[k] = idx >= 0 ? (cells[idx] ?? '').trim() : ''
    }
    return record
  })

  const unknownHeaders = headers.filter((_, i) => !matched.has(i)).filter((h) => h !== '')
  return { columns, rows, unknownHeaders, delimiter: sniffDelimiter(raw) }
}

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩'
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹'

/** «١٢٣٤٫٥ جنيه» → 1234.5 (Arabic digits, Arabic decimal separator, currency noise). */
export function parseFlexibleNumber(raw: string): number | null {
  if (raw == null) return null
  let s = ''
  for (const ch of String(raw)) {
    const ai = AR_DIGITS.indexOf(ch)
    const fi = FA_DIGITS.indexOf(ch)
    if (ai >= 0) s += String(ai)
    else if (fi >= 0) s += String(fi)
    else if (ch === '\u066B' || ch === '\u066C') s += ch === '\u066B' ? '.' : ''
    else s += ch
  }
  s = s
    .replace(/ج\.?م|جنيه|EGP|LE/gi, '')
    .replace(/[،,](?=\d{3}\b)/g, '') // thousands separators
    .replace(/[،,]/g, '.')
    .replace(/[^\d.-]/g, '')
    .trim()
  if (!s || s === '-' || s === '.') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** Parse a date cell: ISO, dd/mm/yyyy, yyyy/mm/dd — Arabic digits accepted. */
export function parseFlexibleDate(raw: string): Date | null {
  if (!raw) return null
  let s = ''
  for (const ch of String(raw)) {
    const ai = AR_DIGITS.indexOf(ch)
    const fi = FA_DIGITS.indexOf(ch)
    s += ai >= 0 ? String(ai) : fi >= 0 ? String(fi) : ch
  }
  s = s.trim().replace(/[.\\]/g, '/')
  if (!s) return null
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00.000Z`)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s)
  if (dmy) {
    const year = Number(dmy[3]) < 100 ? 2000 + Number(dmy[3]) : Number(dmy[3])
    const d = new Date(Date.UTC(year, Number(dmy[2]) - 1, Number(dmy[1])))
    return Number.isNaN(d.getTime()) ? null : d
  }
  const parsed = new Date(s)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}
