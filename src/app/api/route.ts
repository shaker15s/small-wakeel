// GET /api — API index. A tiny, self-documenting map of the surface (handy when
// curling a deployment to see what it actually serves) plus a liveness ping.
import { NextResponse } from 'next/server'
import { guard } from './_lib/guard'
import { db } from '@/lib/db'
import pkg from '../../../package.json'

export const dynamic = 'force-dynamic'

const ENDPOINTS: { method: string; path: string; what: string }[] = [
  { method: 'GET', path: '/api', what: 'فهرس الـ API + نبضة حياة' },
  { method: 'GET', path: '/api/health', what: 'حالة النظام (قاعدة بيانات، موديلات، سكجولر، نسخة)' },
  { method: 'GET', path: '/api/bootstrap', what: 'الأنشطة والمستخدمين والمزوّدين' },
  { method: 'GET', path: '/api/overview?businessId&userId', what: 'لوحة اليوم' },
  { method: 'GET|POST', path: '/api/chat', what: 'المحادثة (POST = بث SSE)' },
  { method: 'GET|POST', path: '/api/operations', what: 'سجل العمليات' },
  { method: 'POST', path: '/api/operations/:id/confirm', what: 'اعتماد/رفض عملية' },
  { method: 'GET', path: '/api/items?businessId', what: 'المخزون كامل بالتقارير' },
  { method: 'POST', path: '/api/items/import', what: 'استيراد مخزون من CSV' },
  { method: 'GET', path: '/api/members?businessId', what: 'العملاء/الأعضاء' },
  { method: 'GET|POST|PATCH|DELETE', path: '/api/memories', what: 'ذاكرة وكيل' },
  { method: 'GET|POST|PATCH|DELETE', path: '/api/notes', what: 'ورقة وكيل' },
  { method: 'GET|POST|PATCH|DELETE', path: '/api/tools', what: 'أدوات بتاعتك' },
  { method: 'GET|POST|PATCH|DELETE', path: '/api/quick-commands', what: 'الأوامر السريعة' },
  { method: 'GET|POST', path: '/api/tasks', what: 'المهام المجدولة' },
  { method: 'POST', path: '/api/tasks/tick', what: 'تشغيل المهام المستحقة' },
  { method: 'GET', path: '/api/reports?businessId&range=7d|30d', what: 'التقارير' },
  { method: 'GET', path: '/api/usage?businessId', what: 'تليمتري الأداء' },
  { method: 'GET', path: '/api/search?businessId&q=', what: 'بحث شامل' },
  { method: 'GET', path: '/api/export?businessId', what: 'نسخة احتياطية JSON' },
  { method: 'POST', path: '/api/restore', what: 'استرجاع كتالوج من نسخة (preview|merge)' },
  { method: 'GET|POST|DELETE', path: '/api/providers', what: 'مزوّدو الموديلات' },
  { method: 'GET', path: '/api/suggestions?businessId&userId', what: 'اقتراحات' },
  { method: 'GET', path: '/api/radar?businessId&userId', what: 'رادار الملاحظات' },
  { method: 'GET', path: '/api/conversations?businessId&userId', what: 'الجلسات' },
]

export async function GET(req: Request) {
  const gate = await guard(req, { scope: 'open' })
  if (!gate.ok) return gate.res
  const businesses = await db.business.count().catch(() => -1)
  return NextResponse.json({
    name: 'وكيل — Wakil API',
    version: pkg.version,
    time: new Date().toISOString(),
    db: businesses >= 0 ? 'ok' : 'unreachable',
    businesses,
    endpoints: ENDPOINTS,
  })
}
