import { createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'wakil-business-tools'
export const inject = ['tools']

function errorResult(message) {
  return { ok: false, error: message }
}

function resolveBridgeUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('عنوان WAKIL غير صالح؛ اضبط WAKIL_DSH_BASE_URL')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('WAKIL_DSH_BASE_URL لازم يكون أصلًا فقط بدون بيانات دخول أو مسار أو query')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('عنوان WAKIL لازم يكون HTTPS، باستثناء loopback المحلي')
  }
  return new URL('/api/dsh/bridge', url.origin).toString()
}

async function callWakil(action, args, exec) {
  const token = process.env.WAKIL_DSH_BRIDGE_TOKEN || ''
  if (token.length < 32) {
    return errorResult('ربط WAKIL غير مُعدّ في بيئة DSH: اضبط WAKIL_DSH_BRIDGE_TOKEN بدون وضعه في المحادثة أو ملف التعليمات.')
  }

  const base = process.env.WAKIL_DSH_BASE_URL || 'http://127.0.0.1:3000'
  let url
  try {
    url = resolveBridgeUrl(base)
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : 'عنوان WAKIL غير صالح')
  }

  const body = { action, ...args }
  if (action === 'prepare_draft') {
    const callId = exec && exec.callId != null ? String(exec.callId) : ''
    const sessionId = exec && exec.agent && exec.agent.id != null ? String(exec.agent.id) : ''
    if (!callId || !sessionId) {
      return errorResult('تعذر إنشاء مفتاح تكرار آمن من معرف جلسة واستدعاء DSH؛ لم يتم إرسال المسودة.')
    }
    // DSH's public Agent.id is the session identity. Do not use an arbitrary
    // fallback, or identical call IDs from different sessions could collide
    // in WAKIL's globally-unique idempotency key.
    body.requestId = createHash('sha256').update(sessionId + ':' + callId).digest('hex')
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: exec.signal,
      redirect: 'error',
    })
    let result
    try {
      result = await response.json()
    } catch {
      return errorResult('خادم WAKIL رجّع ردًا غير صالح؛ لم يتم التأكد من نتيجة الطلب.')
    }
    if (!response.ok || result?.ok !== true) {
      return errorResult(typeof result?.error === 'string' ? result.error : 'خادم WAKIL رفض الطلب برمز HTTP ' + response.status)
    }
    return result
  } catch {
    return errorResult('تعذر الاتصال بخادم WAKIL المحلي أو الآمن. لم أعتبر العملية ناجحة؛ راجع عنوان الخادم وحالته ثم اقرأ المسودات المعلقة قبل إعادة المحاولة.')
  }
}

function output() {
  return {
    schema: { type: 'json' },
    render: (_args, value) => [{
      type: 'text',
      text: JSON.stringify(value, null, 2),
    }],
  }
}

function register(ctx, definition) {
  ctx.tools.register(defineTool({
    ...definition,
    timeoutMs: 20_000,
    output: output(),
    async execute(args, exec) {
      return callWakil(definition.action, args, exec)
    },
  }))
}

export function apply(ctx) {
  register(ctx, {
    name: 'wakil_business_overview',
    description: 'اقرأ ملخص النشاط الحقيقي من دفتر وكيل: رصيد الدفتر، الذمم، عدد الأصناف والمسودات المعلقة. هذا الرصيد ليس عدًّا فعليًا للخزنة.',
    action: 'overview',
    parameters: {},
  })

  register(ctx, {
    name: 'wakil_search_catalog',
    description: 'ابحث في كتالوج النشاط عن الأصناف ومعرّفاتها وأسعارها وكمياتها المسجلة. القيم null غير مسجلة وليست صفرًا.',
    action: 'catalog',
    parameters: {
      query: { type: 'string', description: 'اسم الصنف أو جزء منه أو الباركود.' },
      limit: { type: 'integer', description: 'عدد النتائج من 1 إلى 100.' },
    },
  })

  register(ctx, {
    name: 'wakil_list_parties',
    description: 'اعرض حسابات العملاء أو الموردين بالأسماء والمعرّفات والأرصدة المسجلة، واستخدم المعرف الصحيح في مسودات التحصيل أو السداد.',
    action: 'parties',
    parameters: {
      partyType: { type: 'string', enum: ['customers', 'suppliers'], required: true },
      query: { type: 'string', description: 'اسم أو جزء من الاسم أو رقم الهاتف.' },
      limit: { type: 'integer', description: 'عدد النتائج من 1 إلى 100.' },
    },
  })

  register(ctx, {
    name: 'wakil_pending_operations',
    description: 'اعرض آخر المسودات التي تنتظر اعتماد المالك. افحص هذه القائمة قبل تجهيز طلب متكرر.',
    action: 'pending_operations',
    parameters: {
      limit: { type: 'integer', description: 'عدد المسودات من 1 إلى 50.' },
    },
  })

  register(ctx, {
    name: 'wakil_prepare_operation_draft',
    description: 'جهّز مسودة عملية فقط؛ لا تعتمدها ولا تنفذها. operationType واحدة من sale, purchase, expense, collection, payment, cashbook, membership, attendance. المبالغ في payload بالجنيه المصري EGP. البيع والشراء: payload={lines:[{itemId,qty,unitPriceEgp?}],paidEgp?,customerId?,customerName?} أو المورد في الشراء. المصروف: {totalEgp,reason}. التحصيل: {amountEgp,customerId أو customerName}. السداد: {amountEgp,supplierId أو supplierName}. العضوية: {totalEgp,paidEgp?,customerId أو customerName,months?,plan?}. الحضور: {customerId أو customerName}. دفتر الكاش: {kind,amountEgp,occurredOn:"YYYY-MM-DD",dueOn?,note,partyName?,customerId?,supplierId?,expectedCashEgp? لعدّ الخزنة}. لا تخمّن IDs أو أسعارًا أو تواريخ؛ اسأل المالك إذا كانت معلومة لازمة ناقصة.',
    action: 'prepare_draft',
    parameters: {
      operationType: {
        type: 'string',
        enum: ['sale', 'purchase', 'expense', 'collection', 'payment', 'cashbook', 'membership', 'attendance'],
        required: true,
      },
      summary: { type: 'string', required: true, description: 'وصف عربي قصير ودقيق للمسودة.' },
      payload: { type: 'object', required: true, additionalProperties: true, description: 'تفاصيل العملية حسب operationType؛ المبالغ بالجنيه المصري لا بالقروش.' },
    },
  })
}
