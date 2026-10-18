import { normalizeAr, toWesternDigits } from './arabic'

const small: Record<string, number> = { صفر: 0, واحد: 1, واحده: 1, اتنين: 2, اثنين: 2, تلاته: 3, ثلاثه: 3, تلات: 3, ثلاث: 3, اربعه: 4, اربع: 4, خمسه: 5, خمس: 5, سته: 6, ست: 6, سبعه: 7, سبع: 7, تمانيه: 8, تمنيه: 8, ثمانيه: 8, تسعه: 9, تسع: 9, عشره: 10, حداشر: 11, احداشر: 11, اتناشر: 12, اثناشر: 12, تلتاشر: 13, تلاتاشر: 13, اربعتاشر: 14, خمستاشر: 15, ستاشر: 16, سبعتاشر: 17, تمنتاشر: 18, تسعتاشر: 19, عشرين: 20, تلاتين: 30, ثلاثين: 30, اربعين: 40, خمسين: 50, ستين: 60, سبعين: 70, تمانين: 80, ثمانين: 80, تسعين: 90 }
const hundreds: Record<string, number> = { ميه: 100, مايه: 100, مئه: 100, مائه: 100, ميتين: 200, مئتين: 200, تلتميه: 300, تلتمائه: 300, تلاتميه: 300, ثلاثمائه: 300, اربعميه: 400, ربعمية: 400, ربعميه: 400, اربعمائه: 400, خمسميه: 500, خمسمائه: 500, خمسميت: 500, ستميه: 600, ستمائه: 600, سبعميه: 700, سبعمائه: 700, تمنميه: 800, ثمانمائه: 800, تسعميه: 900, تسعمائه: 900 }
function underHundred(t: string): number | null {
  if (small[t] != null) return small[t]
  const pair = t.split(/\s+و\s*/)
  if (pair.length !== 2) return null
  const a = small[pair[0]], b = small[pair[1]]
  if (a == null || b == null) return null
  return (a > 0 && a < 10 && b >= 20 && b % 10 === 0) || (b > 0 && b < 10 && a >= 20 && a % 10 === 0) ? a + b : null
}
function underThousand(t: string): number | null {
  if (hundreds[t] != null) return hundreds[t]
  const first = t.split(' ')[0]
  if (hundreds[first] != null) {
    const rest = t.slice(first.length).trim().replace(/^و\s*/, '')
    const low = underHundred(rest)
    return low != null && low > 0 ? hundreds[first] + low : null
  }
  return underHundred(t)
}
function integerWords(t: string): number | null {
  const thousands = t.match(/^(الفين|الف|(?:تلاته?|ثلاثه?|اربعه?|اربع|خمسه?|خمس|سته?|ست|سبعه?|سبع|تمانيه|تمنيه|ثمانيه|تسعه?|تسع|عشره) الاف)(?:\s+(?:و\s*)?(.+))?$/)
  if (!thousands) return underThousand(t)
  const high = thousands[1] === 'الفين' ? 2000 : thousands[1] === 'الف' ? 1000 : (small[thousands[1].split(' ')[0]] ?? 0) * 1000
  if (!high) return null
  if (!thousands[2]) return high
  const low = underThousand(thousands[2])
  return low != null && low > 0 ? high + low : null
}
/** Exact whole-clause parser. Never use parseFloat/extract-first-number for financial dictation. */
export function parseSpokenMoney(raw: string): number | null {
  if (!safeMoneyGrouping(raw)) return null
  const text = normalizeAr(toWesternDigits(raw)).replaceAll(',', '').replace(/[.!؟?،]+$/, '').trim()
  const fractionOnly = text.match(/^(نص|نصف|ربع)(?:\s+جنيه)?$/)
  if (fractionOnly) return fractionOnly[1] === 'ربع' ? 25 : 50
  const centsOnly = text.match(/^(.+)\s+قرش$/)
  if (centsOnly) { const n = /^\d+$/.test(centsOnly[1]) ? Number(centsOnly[1]) : underHundred(centsOnly[1]); if (n != null && n > 0 && n < 100) return n }
  const numeric = text.match(/^(\d+)(?:\.(\d{1,2}))?\s*(?:جنيه|جنيها|ج)?$/)
  if (numeric) {
    const n = Number(numeric[1]) * 100 + Number((numeric[2] ?? '').padEnd(2, '0'))
    return Number.isSafeInteger(n) && n <= 2_147_483_647 ? n : null
  }
  const parts = text.match(/^(.+?)(?:\s+جنيه)?(?:\s+و\s*(نص|نصف|ربع|(?:\d+|خمسه وعشرين|خمسين|خمسه وسبعين)\s+قرش))?$/)
  if (!parts) return null
  const wholeText = parts[1].replace(/\s+جنيه$/, '')
  const whole = /^\d+$/.test(wholeText) ? Number(wholeText) : integerWords(wholeText)
  if (whole == null) return null
  let fraction = 0
  if (parts[2]) {
    if (['نص', 'نصف'].includes(parts[2])) fraction = 50
    else if (parts[2] === 'ربع') fraction = 25
    else {
      const cents = parts[2].replace(/\s+قرش$/, '')
      fraction = /^\d+$/.test(cents) ? Number(cents) : underHundred(cents) ?? -1
      if (fraction < 0 || fraction > 99) return null
    }
  }
  const result = whole * 100 + fraction
  return Number.isSafeInteger(result) && result <= 2_147_483_647 ? result : null
}

// Bounded lexical envelope; parseSpokenMoney still validates the ENTIRE captured clause.
const moneyWords = [...Object.keys(small), ...Object.keys(hundreds), 'الف', 'الفين', 'الاف', 'نص', 'نصف', 'ربع', 'جنيه', 'جنيها', 'قرش']
const token = `(?:\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?|${[...new Set(moneyWords)].sort((a, b) => b.length - a.length).join('|')})`
export const spokenMoneyPattern = `(${token}(?:\\s+(?:و\\s*)?${token})*)(?![\\d.])`

/** A misplaced thousands separator must not silently multiply a financial amount. */
export function safeMoneyGrouping(raw: string): boolean {
  const runs = raw.match(/[0-9٠-٩۰-۹][0-9٠-٩۰-۹٬,٫.]*/g) ?? []
  return runs.every(run => !/[٬,]/.test(run) || /^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(toWesternDigits(run.replaceAll('٬', ','))))
}
