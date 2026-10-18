import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { guard } from '../../_lib/guard'
import { speechSelection } from '@/lib/speech'
export const dynamic = 'force-dynamic'
export async function GET(req: Request) {
  const gate = await guard(req, { scope: 'admin' }); if (!gate.ok) return gate.res
  const selected = await speechSelection()
  return NextResponse.json({ providerId: selected?.providerId ?? '', remoteId: selected?.remoteId ?? '' })
}
export async function POST(req: Request) {
  const gate = await guard(req, { scope: 'admin' }); if (!gate.ok) return gate.res
  const body = await req.json().catch(() => null)
  if (body?.disabled === true) { await db.speechSettings.deleteMany(); return NextResponse.json({ ok: true }) }
  if (typeof body?.providerId !== 'string' || typeof body?.remoteId !== 'string' || body.remoteId.length > 200) return NextResponse.json({ error: 'حدد مزود وموديل صوت صحيحين' }, { status: 400 })
  const model = await db.modelConfig.findFirst({ where: { providerId: body.providerId, remoteId: body.remoteId, enabled: true } })
  if (!model) return NextResponse.json({ error: 'الموديل مش موجود أو متوقف' }, { status: 422 })
  const data = { providerId: model.providerId, remoteId: model.remoteId }
  await db.speechSettings.upsert({ where: { id: 'global' }, create: { id: 'global', ...data }, update: data })
  return NextResponse.json({ ok: true })
}
