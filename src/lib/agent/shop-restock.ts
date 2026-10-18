import { requirePermission } from '@/lib/security/permissions'
import { normalizeAr, toWesternDigits } from './arabic'
import { mayLearnImplicitly } from './memory-policy'
import { originalName } from './cashbook-parser'
import { withCashbookDialogue, dialogueCanceled, type DialogueContext, type DialogueState } from './cashbook-dialogue'
import { answerChoice, choiceActions } from './cashbook-parties'
import type { Prisma } from '@prisma/client'

const scope = (ctx: DialogueContext) => ({ businessId: ctx.business.id, userId: ctx.user.id })

async function question(tx: Prisma.TransactionClient, ctx: DialogueContext, prefix = '') {
  const rows = await tx.shopReminder.findMany({ where: { ...scope(ctx), active: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 11 })
  const shown = rows.slice(0, 10)
  const state: DialogueState = { flow: 'restock', stage: shown.length ? 'choose' : 'complete', source: [ctx.text], choiceToken: crypto.randomUUID(), reminderOptions: shown.map(r => ({ id: r.id, subject: r.subject, revision: r.revision })) }
  return { state, step: {
    replyText: `${prefix}${shown.length ? `افتكرت تجيب ${shown.map(r => `«${r.subject}»`).join(' و')}؟ اختار اللي جبته فعلًا، أو سيب القائمة للبضاعة الجاية.${rows.length > 10 ? ' بعرض أول ١٠؛ الباقي هيظهر لما تشيل حاجة.' : ''}` : 'مفيش نواقص محفوظة ليك دلوقتي. قول مثلًا «فكرني أجيب أكياس تعبئة مع البضاعة».'} التذكير بس؛ ما سجلتش فلوس أو مخزون.`,
    ...(shown.length ? { actions: choiceActions(state.choiceToken!, [...shown.map(r => `جبت ${r.subject}`), 'لسه محتاجهم']) } : {}),
  } }
}

/** Personal shopping context, not an inventory count or permission to buy.
 * All transitions share the actor/conversation transaction and retry receipt.
 * A button is tied to the question, so an old delivery cannot clear a new list. */
export async function restockTurn(ctx: DialogueContext) {
  const t = normalizeAr(toWesternDigits(ctx.text))
  const arrival = /^(?:استلمنا بضاعه|البضاعه وصلت|استلمت بضاعه|جت البضاعه)[.!،\s]*$/.test(t)
  const list = /^(?:قايمه النواقص|قايمه الطلب|فكرني بالنواقص|ايه اللي ناقص مع البضاعه|ايه اللي فاكره من النواقص)[؟?\s]*$/.test(t)
  const explicit = t.match(/^(?:فكرني|افتكر)(?: اني)? (?:اجيب|اشتري|اطلب) (.+?)(?: (?:المره الجايه|مع البضاعه|لما البضاعه تيجي))?[.!،\s]*$/)
  const low = t.match(/^(.+?)\s+(?:قرب يخلص|قربت تخلص|ناقص|خلص)(?:\s+(?:فكرني|افتكر)(?:\s+اجيبه)?(?:\s+(?:المره الجايه|مع البضاعه|لما البضاعه تيجي))?)?[.!،\s]*$/)
  const add = (explicit || low) && mayLearnImplicitly(ctx.text) ? (explicit || low)![1].trim() : null
  const done = t.match(/^(?:جبت|اشتريت) (.+?)(?: خلاص)?[.!،\s]*$/)
  const forget = t.match(/^(?:متفكرنيش ب|متفكرنيش بـ|الغ تذكير |الغي تذكير )(.+?)[.!،\s]*$/)
  // Do not consume an arbitrary new financial request just because a list is open.
  const reply = /^اختيار [a-z0-9-]+ رقم \d+$/.test(t) || /^\d+$/.test(t) || dialogueCanceled(t) || /^(?:لسه محتاجهم|لسه مجبتهاش|لسه ما جبتهاش)$/.test(t)
  if (!arrival && !list && !add && !done && !forget && !reply) return null
  return withCashbookDialogue(ctx, async (tx, previous) => {
    if (add) {
      await requirePermission(ctx.business.id, ctx.user.id, 'memory.manage', tx)
      if (add.length > 100 || !/^[\p{L}\p{N} /%+.-]+$/u.test(add) || /(?:^|\s)(?:جنيه|قرش|سلفت|حصلت|صرفت|سددت|بعت|جبت|اشتريت|دفعت|بمبلغ|علي الحساب)(?:\s|$)/.test(add)) {
        return { state: previous ?? { flow: 'restock', stage: 'complete', source: [] }, step: { replyText: 'قول اسم الحاجة لوحده باختصار؛ قائمة النواقص مش لتسجيل مبالغ أو أوامر مالية.' } }
      }
      const existing = (await tx.shopReminder.findMany({ where: scope(ctx) })).filter(r => normalizeAr(r.subject) === add)
      const subject = originalName(ctx.text, add)
      if (existing.length) await tx.shopReminder.updateMany({ where: { ...scope(ctx), id: { in: existing.map(r => r.id) } }, data: { active: true, revision: { increment: 1 } } })
      else await tx.shopReminder.create({ data: { ...scope(ctx), subject } })
      await tx.auditEvent.create({ data: { businessId: ctx.business.id, actor: ctx.user.id, action: 'restock.remember', detail: JSON.stringify({ subject, source: explicit ? 'explicit_request' : 'reported_shortage' }) } })
      return { state: { flow: 'restock', stage: 'complete', source: [ctx.text] }, step: { replyText: `هفتكر «${existing[0]?.subject ?? subject}». أول ما تقولّي البضاعة وصلت هسألك جبتها ولا لأ؛ مش هسجل شراء أو أغير المخزون من نفسي.` } }
    }
    if (arrival || list) return question(tx, ctx, arrival ? 'حمد لله على وصولها. ' : '')
    if (done || forget) {
      const name = (done ?? forget)![1].trim()
      const matching = (await tx.shopReminder.findMany({ where: { ...scope(ctx), active: true } })).filter(r => normalizeAr(r.subject) === name)
      if (!matching.length) return null // a purchase with prices belongs to finance, not this checklist
      await requirePermission(ctx.business.id, ctx.user.id, 'memory.manage', tx)
      await tx.shopReminder.updateMany({ where: { ...scope(ctx), id: { in: matching.map(r => r.id) }, active: true }, data: { active: false, revision: { increment: 1 } } })
      await tx.auditEvent.create({ data: { businessId: ctx.business.id, actor: ctx.user.id, action: done ? 'restock.done' : 'restock.forget', detail: JSON.stringify({ ids: matching.map(r => r.id) }) } })
      return question(tx, ctx, done ? 'تمام، شلتها من الحاجات اللي بفكرك بيها. ' : 'تمام، مش هفكرك بيها تاني. ')
    }
    if (previous?.flow !== 'restock' || previous.stage !== 'choose') return null
    if (dialogueCanceled(t) || /^(?:لسه محتاجهم|لسه مجبتهاش|لسه ما جبتهاش)$/.test(t)) return { state: { ...previous, stage: 'complete' }, step: { replyText: 'تمام، النواقص فضلت محفوظة للبضاعة الجاية. قفلت السؤال بس؛ ما سجلتش فلوس أو مخزون.' } }
    const options = previous.reminderOptions ?? []
    const selected = answerChoice(ctx.text, previous.choiceToken!, options.length + 1)
    if (selected.index == null) return question(tx, ctx, 'الاختيار ده قديم أو مش من القائمة الحالية؛ النواقص ما اتغيرتش. ')
    if (selected.index === options.length) return { state: { ...previous, stage: 'complete' }, step: { replyText: 'تمام، هفضل فاكرهم للبضاعة الجاية؛ لا فلوس ولا مخزون اتغيروا.' } }
    await requirePermission(ctx.business.id, ctx.user.id, 'memory.manage', tx)
    const option = options[selected.index]
    if (!Number.isSafeInteger(option.revision)) return question(tx, ctx, 'القائمة قديمة؛ راجع الاختيارات الجديدة. ')
    const changed = await tx.shopReminder.updateMany({ where: { ...scope(ctx), id: option.id, subject: option.subject, revision: option.revision, active: true }, data: { active: false, revision: { increment: 1 } } })
    if (changed.count) await tx.auditEvent.create({ data: { businessId: ctx.business.id, actor: ctx.user.id, action: 'restock.done', detail: JSON.stringify({ ids: [option.id] }) } })
    return question(tx, ctx, changed.count ? `تمام، شلت «${option.subject}» من النواقص. ` : 'القائمة اتغيرت من وقت السؤال؛ راجع الباقي. ')
  })
}
