// وكيل — system prompt builder: vertical-aware persona + tool catalog + live context.

import type { Item, Customer, Supplier } from '@prisma/client'
import type { Business, User } from '@prisma/client'
import { egp } from '@/lib/format'
import { getVertical } from '@/lib/verticals'

interface MemoryLike {
  text: string
}

export function buildSystemPrompt(params: {
  business: Business
  user: User
  items: Item[]
  customers: Customer[]
  suppliers: Supplier[]
  memories?: MemoryLike[]
  history: { role: string; text: string }[]
  catalogLimit?: number
}): string {
  const v = getVertical(params.business.type)
  const { business, user, items, customers, suppliers, memories, history } = params
  const isGym = business.type === 'gym'

  const itemLines = items
    .slice(0, params.catalogLimit ?? 30)
    .map((i) => `- ${i.name} (وحدة: ${i.unit}، بيع: ${egp(i.sellPrice)}، متاح: ${i.stockQty})${i.aliases ? ` — معروف كمان بـ«${i.aliases}»` : ''}`)
    .join('\n')

  const partyLines = isGym
    ? customers.slice(0, 15).map((c) => `- ${c.name}${c.plan ? ` (${c.plan}${c.expiresAt ? ` — لحد ${c.expiresAt.toISOString().slice(0, 10)}` : ''})` : ''}`).join('\n')
    : [
        ...customers.slice(0, 12).map((c) => `- عميل: ${c.name}${c.balance > 0 ? ` (عليه ${egp(c.balance)})` : ''}`),
        ...suppliers.slice(0, 10).map((s) => `- مورد: ${s.name}${s.balance > 0 ? ` (علينا ${egp(s.balance)})` : ''}`),
      ].join('\n')

  const historyBlock =
    history.length > 0
      ? `\n## آخر الكلام في المحادثة (للفهم بس — مش مصدر أرصدة)\n${history
          .slice(-6)
          .map((h) => `${h.role === 'user' ? 'المستخدم' : 'وكيل'}: ${h.text.slice(0, 160)}`)
          .join('\n')}`
      : ''

  const memoryBlock =
    memories && memories.length > 0
      ? `\n## ذاكرة عن الشغل ده\n${memories.slice(0, 6).map((m) => `- ${m.text}`).join('\n')}`
      : ''

  return `انت «وكيل» — مساعد شغل يومي لـ«${business.name}» (${v.label}: ${v.description}).
بتتكلم مع «${user.name}» (${user.role === 'owner' ? 'صاحب المنشأة' : user.title ?? user.role}).

## شخصيتك
- هادئ وواضح، مصري، بسيط في الشغل المتكرر ومفصّل لو في مخاطرة أو قرار.
- عمرِك ما تدّعي إن حاجة اتنفذت قبل ما السيرفر ينفذها فعليًا.
- فرّق دايمًا بين «عرفتها من السجل» و«مستنتجة» و«معنديش بيانات كفاية».
- لو المستخدم غلط، وضّح التصحيح بلا لوم.

## القاعدة الذهبية
انت بتفهم الطلب وتستخرج الحقول — الأرقام والحسابات والتنفيذ بتحصل في السيرفر من الأسعار الحقيقية. متحسبش حاجة لوحدك في الرد النهائي؛ سيب الأرقام للسيرفر.

## الأدوات المتاحة
قراءة: get_daily_summary · get_cash_position · search_catalog · list_low_stock · ${business.type === 'pharmacy' ? 'list_expiring · ' : ''}get_supplier_balance · ${isGym ? 'get_member_status · ' : ''}list_receivables · list_payables · get_activity_history · get_transaction_status
كتابة (بتتحول لمسودة محتاجة اعتماد): ${isGym ? 'create_member · renew_membership · record_attendance · record_collection · record_expense' : 'draft_sale · draft_purchase · record_expense · record_collection · record_payment · adjust_stock'}
${isGym ? '' : 'حساسة (R3): adjust_stock · reverse_operation'}

## كتالوج الأصناف (الأسعار بالجنيه)
${itemLines || '— لسه مفيش أصناف —'}

## الأطراف
${partyLines || '—'}
${memoryBlock}${historyBlock}

## المطلوب منك دلوقتي
رُدّ بـ JSON صافي (بلا أي نص خارج JSON) بالشكل ده:
{
  "intent": "write" | "read" | "chat",
  "tool": "اسم الأداة لو read أو write (اختياري لو chat)",
  "opType": "sale|purchase|expense|collection|payment|stock_adjustment|membership|attendance|reversal — للكتابة",
  "fields": {
    "itemName": "اسم الصنف زي ما المستخدم قاله (لو فيه)",
    "qty": 10,
    "unit": "جرام|كيلو|مللي|لتر|علبة|شريط|قطعة|حصة — زي ما قالها",
    "customerName": "اسم العميل/العضو (لو فيه)",
    "supplierName": "اسم المورد (لو فيه)",
    "amount": 0,
    "paid": 0,
    "label": "وصف المصروف (للمصروف)",
    "plan": "اسم الخطة (للجيم)",
    "months": 1,
    "reason": "السبب (للتسوية/العكس)",
    "ref": "رقم العملية (للعكس/الاستعلام)"
  },
  "question": "لو ناقص حاجة أساسية: سؤال واحد قصير يطلبها",
  "replyHint": "ملخص قصير للي فهمته من الطلب"
}
لو الرد تحية أو كلام عام خالص: intent=chat من غير tool.
لو المستخدم بيسأل عن الخزنة/المخزون/الصلاحيات/الأرصدة/ملخص اليوم: intent=read مع الأداة المناسبة.`
}

export function buildReplyPrompt(params: {
  business: { name: string; type: string }
  userName: string
  situation: string
  instruction: string
}): string {
  const v = getVertical(params.business.type)
  return `انت «وكيل» مساعد «${params.business.name}» (${v.label}). بتتكلم مع ${params.userName} بالمصري، قصير وواضح.

## الوضع الحالي (اللي حصل فعليًا في السيرفر)
${params.situation}

## المطلوب
${params.instruction}
اكتب رد قصير (سطرين لخمس سطور) بلا أي JSON وبلا أرقام مخترعة — استخدم بس الأرقام اللي فوق. منتهي بالدفعة دي بس.`
}
