import { beforeAll, afterAll, test, expect } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { testDb } from '../helpers/test-db'
import { readAudio, AUDIO_LIMIT, speechSelection, transcribeAudio } from '@/lib/speech'
import { GET, POST } from '@/app/api/speech/route'
import { POST as configure } from '@/app/api/speech/settings/route'
import type { SpeechSettings } from '@prisma/client'
const db = await testDb()
let businessId: string, userId: string, providerId: string, original: SpeechSettings | null
const headers = () => ({ 'x-wakil-business': businessId, 'x-wakil-user': userId, 'x-wakil-audio-consent': 'review-only', 'content-type': 'audio/wav' })
function wave() { const b = Buffer.alloc(100); b.write('RIFF'); b.write('WAVE', 8); return b }
const request = (body: BodyInit, extra: Record<string, string> = {}) => new Request('http://localhost/api/speech', { method: 'POST', headers: { ...headers(), ...extra }, body })
beforeAll(async () => {
  businessId = (await db.business.create({ data: { name: randomUUID(), type: 'attar' } })).id
  userId = (await db.user.create({ data: { businessId, name: 'اختبار الصوت', role: 'owner' } })).id
  original = await db.speechSettings.findUnique({ where: { id: 'global' } })
  await db.speechSettings.deleteMany()
  providerId = (await db.modelProvider.create({ data: { name: 'Test config only — not a working ASR', baseUrl: 'https://127.0.0.1/v1', apiKey: 'never-output-this-secret', models: { create: { remoteId: 'speech-test', label: 'ASR test configuration', tier: 'air' } } } })).id
})
afterAll(async () => {
  await db.modelProvider.delete({ where: { id: providerId } })
  await db.speechSettings.deleteMany()
  if (original) await db.speechSettings.create({ data: original })
  await db.business.delete({ where: { id: businessId } })
})
test('unconfigured ASR is explicitly unavailable, requires consent, never invokes model or financial execution', async () => {
  const res = await GET(new Request('http://localhost/api/speech', { headers: headers() }))
  expect(await res.json()).toEqual({ available: false, providerLabel: null })
  expect((await POST(request(wave(), { 'x-wakil-audio-consent': '' }))).status).toBe(400)
  expect((await POST(request(wave()))).status).toBe(503)
  expect((await GET(new Request('http://localhost/api/speech'))).status).toBe(400)
  expect(await db.operation.count({ where: { businessId } })).toBe(0)
})
test('audio reader bounds streamed bytes, checks container signatures, and refuses forged types', async () => {
  const audio = await readAudio(request(wave()))
  expect(audio.type).toBe('audio/wav'); expect(Buffer.from(audio.bytes)).toEqual(wave())
  await expect(readAudio(request('{}'))).rejects.toThrow()
  await expect(readAudio(request(wave(), { 'content-type': 'text/html' }))).rejects.toThrow('نوع التسجيل')
  await expect(readAudio(request(wave(), { 'content-length': String(AUDIO_LIMIT + 1) }))).rejects.toThrow('أكبر')
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(AUDIO_LIMIT)); c.enqueue(new Uint8Array(1)); c.close() } })
  await expect(readAudio(request(stream))).rejects.toThrow('أكبر')
})
test('explicit provider selection revalidates enabled model, protects stored unsafe URLs, exposes no key', async () => {
  const config = (body: object) => new Request('http://localhost/api/speech/settings', { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify(body) })
  expect((await configure(config({ providerId, remoteId: 'does-not-exist' }))).status).toBe(422)
  expect((await configure(config({ providerId, remoteId: 'speech-test' }))).status).toBe(200)
  const selected = await speechSelection(); expect(selected?.remoteId).toBe('speech-test')
  // HERMETIC: stored-URL protection is the PRODUCTION contract. A parallel
  // test file may hold the dev flag WAKIL_ALLOW_LOCAL_PROVIDERS=1 (bun runs
  // every file in one process) — pin the strict semantics for every
  // flag-sensitive assertion (the 'Non-public' throw AND the 500 mapping) so
  // the suite is green under any scheduling.
  const hadAllowLocal = 'WAKIL_ALLOW_LOCAL_PROVIDERS' in process.env
  const prevAllowLocal = process.env.WAKIL_ALLOW_LOCAL_PROVIDERS
  delete process.env.WAKIL_ALLOW_LOCAL_PROVIDERS
  try {
    await expect(transcribeAudio(await readAudio(request(wave())), selected!)).rejects.toThrow('Non-public')
    const res = await POST(request(wave())); expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('never-output-this-secret')
  } finally {
    if (hadAllowLocal) process.env.WAKIL_ALLOW_LOCAL_PROVIDERS = prevAllowLocal
  }
  expect(await db.operation.count({ where: { businessId } })).toBe(0)
  await db.modelConfig.updateMany({ where: { providerId }, data: { enabled: false } })
  expect(await speechSelection()).toBeNull()
  expect((await configure(config({ disabled: true }))).status).toBe(200)
})
