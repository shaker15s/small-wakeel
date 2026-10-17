// R29: parse a PAST date the owner says out loud — «من أيام ١٠ أكتوبر», «من
// الشهر اللي فات», «من يوم ٥/١٠» — so an opening balance keeps the date the debt
// really started instead of silently becoming «today». Returns null when the
// sentence carries no date (the caller then treats the balance as current).
const AR_MONTHS: Record<string, number> = {
  يناير: 1, فبراير: 2, مارس: 3, ابريل: 4, أبريل: 4, مايو: 5, يونيو: 6, يوليو: 7,
  اغسطس: 8, أغسطس: 8, سبتمبر: 9, اكتوبر: 10, أكتوبر: 10, نوفمبر: 11, ديسمبر: 12,
}

/** A date clause in the sentence, or null. Never invents a year: defaults to this year. */
export function parseSinceClause(normWestern: string): Date | null {
  const s = normWestern.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
  const now = new Date()
  const at = (y: number, mo: number, d: number): Date | null => {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
    const dt = new Date(y, mo - 1, d, 12, 0, 0)
    return Number.isNaN(dt.getTime()) ? null : dt
  }
  // «من ١٠ اكتوبر» / «من يوم ١٠ اكتوبر ٢٠٢٥» / «من ايام 10 اكتوبر»
  const named = s.match(/(?:من|من\s+يوم|من\s+ايام|من\s+تاريخ|منذ|سنة|سنه)\s*(?:يوم\s+|ايام\s+)?([0-9]{1,2})\s+([\u0621-\u064A]+)(?:\s+([0-9]{4}))?/)
  if (named) {
    const mo = AR_MONTHS[named[2].replace(/[أإآ]/g, 'ا')] ?? AR_MONTHS[named[2]]
    if (mo) return at(named[3] ? Number(named[3]) : now.getFullYear(), mo, Number(named[1]))
  }
  // «من ٥/١٠» or «من 2026-10-05»
  const numeric = s.match(/(?:من|من\s+يوم|من\s+تاريخ|منذ)\s*([0-9]{1,2})\s*[/-]\s*([0-9]{1,2})(?:\s*[/-]\s*([0-9]{2,4}))?/)
  if (numeric) {
    const y = numeric[3] ? (Number(numeric[3]) < 100 ? 2000 + Number(numeric[3]) : Number(numeric[3])) : now.getFullYear()
    return at(y, Number(numeric[2]), Number(numeric[1]))
  }
  // relative phrases — the owner's own words are enough
  if (/(الشهر اللي فات|الشهر الماضي|شهر اللي فات)/.test(s)) return at(now.getFullYear(), now.getMonth(), Math.min(now.getDate(), 28))
  if (/(الاسبوع اللي فات|الاسبوع الماضي)/.test(s)) {
    const d = new Date(now)
    d.setDate(d.getDate() - 7)
    return d
  }
  if (/(من زمان|من فتره|من قديم|من ايام)/.test(s)) {
    const d = new Date(now)
    d.setDate(d.getDate() - 30)
    return d
  }
  return null
}
