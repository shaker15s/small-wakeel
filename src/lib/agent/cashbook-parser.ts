import { normalizeAr, toWesternDigits } from './arabic'
import { cashbookDay, cashbookAnswerDay } from './cashbook-dates'
import { parseSpokenMoney, spokenMoneyPattern, safeMoneyGrouping } from './cashbook-money'
import type { CashbookKind } from '@/lib/domain/cashbook'

const money = spokenMoneyPattern
export function originalName(text: string, normalized: string) {
  let folded = ''; const indices: number[] = []
  for (let i = 0; i < text.length; i++) {
    const c = /\s/.test(text[i]) ? (folded.endsWith(' ') ? '' : ' ') : normalizeAr(text[i])
    for (const letter of c) { folded += letter; indices.push(i) }
  }
  const start = folded.indexOf(normalized)
  return start < 0 ? normalized : text.slice(indices[start], indices[start + normalized.length - 1] + 1).trim()
}
export type CashbookIntent = { kind: CashbookKind; amount: number; partyName?: string; occurredOn: string | null; dueOn?: string | null; note: string; reason?: string; dateSource?: 'user_day' | 'assumed_today'; customerId?: string; supplierId?: string; supersedesRef?: string }
/** Deliberately narrow. Unknown direction/purpose/multiple money movements require clarification. */
export function parseCashbook(text: string, now = new Date()): CashbookIntent | 'ambiguous' | null {
  const t = normalizeAr(toWesternDigits(text)).trim()
  if (t.length > 900) return null
  if (/[؟?«»“”"]|^(?:لو|افترض|قال|هل|ممكن|ازاي|ليه|يعني|اشرح|مثال|ما |لا |مش |متسجل|ما تسجل)/.test(t)) return null
  if (!safeMoneyGrouping(text)) return 'ambiguous'
  if (/\sو(?:بعدين|بعدها)?\s*(?:سلفت|استلفت|سددت|حصلت|صرفت|بعت|جبت|حطيت|سحبت)/.test(t)) return 'ambiguous'
  const dueMatch = t.match(/(?:و?هيسدد|و?هيدفع|و?هسدده?|و?ميعاد السداد|و?وعد يسدد|و?وعد يدفع|و?السداد)\s+(.+)$/)
  const main = dueMatch ? t.slice(0, dueMatch.index).trim() : t
  const dueOn = dueMatch ? cashbookAnswerDay(dueMatch[1], now) : undefined
  // Only a trailing date clause is a date, never a substring of somebody's name.
  const dated = main.match(/\s+(?:(?:يوم|بتاريخ)\s+)?(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|اول امبارح|امبارح|امس|النهارده|اليوم|(?:السبت|الاحد|الاتنين|الاثنين|التلات|الثلاثاء|الاربع|الاربعاء|الخميس|الجمعه)\s+(?:الجاي|القادم|اللي فات))$/)
  const incomplete = !dated && main.match(/\s+(?:يوم|بتاريخ)\s+(.+)$/)
  const dateClause = dated ?? incomplete
  const body = dateClause ? main.slice(0, dateClause.index).trim() : main
  const occurredOn = dateClause ? cashbookAnswerDay(dateClause[1], now) : cashbookDay('', now)
  const specs: [CashbookKind, RegExp, boolean][] = [
    ['cash_count', new RegExp(`^(?:سجل |قفل اليوم |اقفل اليوم )?(?:باقي في (?:الخزنه|الدرج)|في الخزنه|عديت (?:الخزنه|الدرج)|الخزنه فيها|الخزنه بقت)\\s*${money}\\s*(?:جنيه)?$`), false],
    ['credit_sale', new RegExp(`^(?:سجل )?(?:بعت ل|بعت لـ)(.+?)\\s+(?:بضاعه|حاجه|طلبات)\\s+ب?ـ?\\s*${money}\\s*(?:جنيه)?\\s*(?:علي الحساب|اجل)$`), true],
    ['credit_sale', new RegExp(`^(?:سجل )?(.+?)\\s+(?:خد|اخد)\\s+بضاعه\\s+ب?ـ?\\s*${money}\\s*(?:جنيه)?\\s*(?:علي الحساب|اجل)$`), true],
    ['cash_purchase', new RegExp(`^(?:سجل )?(?:جبت|اشتريت|استلمت)\\s+بضاعه\\s+من\\s+(.+?)\\s+ب?ـ?\\s*${money}\\s*(?:جنيه)?\\s*كاش$`), true],
    ['credit_purchase', new RegExp(`^(?:سجل )?(?:جبت|اشتريت|استلمت)\\s+بضاعه\\s+من\\s+(.+?)\\s+ب?ـ?\\s*${money}\\s*(?:جنيه)?\\s*(?:علي الحساب|اجل)$`), true],
    ['credit_purchase', new RegExp(`^(?:انا )?عليا ل(?:ـ)?(.+?)\\s+(?:مبلغ )?${money}\\s*(?:جنيه)?\\s+(?:ثمن|تمن)\\s+بضاعه$`), true],
    ['lend', new RegExp(`^(?:سجل )?سلفت\\s+(.+?)\\s+${money}\\s*(?:جنيه)?$`), true],
    ['borrow', new RegExp(`^(?:سجل )?استلفت\\s+من\\s+(.+?)\\s+${money}\\s*(?:جنيه)?$`), true],
    ['receive', new RegExp(`^(?:سجل )?(?:حصلت|قبضت|استلمت سداد)\\s+من\\s+(.+?)\\s+${money}\\s*(?:جنيه)?$`), true],
    ['pay', new RegExp(`^(?:سجل )?(?:سددت ل|سددت لـ)(.+?)\\s+${money}\\s*(?:جنيه)?$`), true],
    ['withdrawal', new RegExp(`^(?:سجل )?(?:سحبت لنفسي|خدت لنفسي)\\s+${money}\\s*(?:جنيه)?$`), false],
    ['deposit', new RegExp(`^(?:سجل )?(?:حطيت من جيبي|اودعت من جيبي)\\s+${money}\\s*(?:جنيه)?$`), false],
    ['expense', new RegExp(`^(?:سجل )?(?:صرفت|مصروف|ضيف مصروف)\\s+${money}\\s*(?:جنيه)?\\s+(?:علي|لـ?|مقابل|بند)\\s+(.+)$`), false],
  ]
  for (const [kind, regex, party] of specs) {
    const match = body.match(regex)
    if (!match) continue
    if (party && (/\d/.test(match[1]) || match[1].trim().split(' ').some(word => parseSpokenMoney(word) != null))) return 'ambiguous'
    const amount = parseSpokenMoney(match[party ? 2 : 1])
    if (amount == null) return 'ambiguous'
    return { kind, amount, ...(party ? { partyName: originalName(text, match[1].trim()) } : {}), occurredOn, dateSource: dateClause ? 'user_day' : 'assumed_today', dueOn, note: text, ...(kind === 'expense' ? { reason: originalName(text, match[2]) } : {}) }
  }
  if (/(خد|اخد|خدت|اديت|دفعت|عليا|ليا|سلفت|استلفت|سددت|حصلت|باقي في الخزنه|الخزنه فيها)/.test(t) && /فلوس|\d/.test(t) || /بضاعه.*(?:علي الحساب|اجل)/.test(t)) return 'ambiguous'
  return null
}


export function startsCashbookRequest(text: string, parsed = parseCashbook(text)) {
  const t = normalizeAr(text)
  return parsed != null || /^(?:سجل )?(?:سلفت|استلفت من|حصلت من|سددت ل)|^عايز اسجل (?:بضاعه|سداد|فلوس خرجت)/.test(t)
}
