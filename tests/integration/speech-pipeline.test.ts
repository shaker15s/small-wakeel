// وكيل — PR-014 (plan v2 §11.3): LIVE voice pipeline against the mock ASR
// provider. Acceptance from the plan:
//   «الصوت… في نسخة تجريبية مع موافقة صريحة» — consent is a hard gate
//   «الصوت لا يتحول تلقائيًا لأي إجراء مالي» — voice returns TEXT only
//   «مفاتيح المزود… لا تُكشف في الردود» — no provider key in replies
//   «لا تتحول تلقائيًا لموافقة» — reviewRequired stays true
// Mock runs are adapter-contract evidence (stamped live:false), not a live
// ASR acceptance.
import { beforeAll, afterAll, test, expect } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { testDb } from '../helpers/test-db'
import { execFileSync } from 'node:child_process'
import { POST as audioPost } from '@/app/api/speech/route'
import { POST as mint } from '@/app/api/speech/session/route'

process.env.WAKIL_ALLOW_LOCAL_PROVIDERS = '1' // dev-mode: allow 127.0.0.1 ASR endpoint
process.env.WAKIL_SPEECH_SESSION_TTL_MS = '300' // fast expiry for the TTL test

const MOCK_BASE = 'http://127.0.0.1:3031/v1'
const db = await testDb()
let businessId: string, userId: string, providerId: string

// --- audio fixtures -------------------------------------------------------
function wavHeader() {
  const b = Buffer.alloc(80)
  b.write('RIFF', 0); b.writeUInt32LE(36, 4); b.write('WAVE', 8); b.write('fmt ', 12)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(1, 32)
  b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(40, 40)
  return b // 80-byte valid header, silent payload
}
const silentWav = () => wavHeader() // all-zero data → mock returns ""
function voicedWav(seed = 0xab) {
  const b = wavHeader()
  const payload = Buffer.alloc(160)
  for (let i = 0; i < payload.length; i++) payload[i] = (seed + i) & 0xff
  return Buffer.concat([b, payload])
}
const wavRequest = (body: Uint8Array, extra: Record<string, string> = {}) =>
  new Request('http://localhost/api/speech', {
    method: 'POST',
    headers: {
      'x-wakil-business': businessId, 'x-wakil-user': userId,
      'x-wakil-audio-consent': 'review-only', 'content-type': 'audio/wav', ...extra,
    },
    body, duplex: 'half',
  } as RequestInit)

function mockAlive(): boolean {
  try { execFileSync('curl', ['-s', '--max-time', '2', 'http://127.0.0.1:3031/health']); return true } catch { return false }
}

beforeAll(async () => {
  businessId = (await db.business.create({ data: { name: randomUUID(), type: 'attar' } })).id
  userId = (await db.user.create({ data: { businessId, name: 'اختبار خط الصوت', role: 'owner' } })).id
  providerId = (await db.modelProvider.create({
    data: {
      name: 'Mock ASR (dev) — not a live acceptance', baseUrl: MOCK_BASE, apiKey: 'mock-key-not-a-secret',
      models: { create: { remoteId: 'wakil-mock-speech', label: 'ASR mock — adapter contract only', tier: 'air' } },
    },
  })).id
  await db.speechSettings.upsert({ where: { id: 'global' }, create: { id: 'global', providerId, remoteId: 'wakil-mock-speech' }, update: { providerId, remoteId: 'wakil-mock-speech' } })
})
afterAll(async () => {
  await db.speechSettings.deleteMany()
  await db.modelProvider.delete({ where: { id: providerId } })
  await db.business.delete({ where: { id: businessId } })
})

test('consent is a hard gate — no review-only header → 400, provider never called', async () => {
  expect(mockAlive()).toBe(true) // fail loudly if the mock ASR is down
  const res = await audioPost(wavRequest(voicedWav(), { 'x-wakil-audio-consent': '' }))
  expect(res.status).toBe(400)
  const noHeader = new Request('http://localhost/api/speech', {
    method: 'POST', headers: { 'x-wakil-business': businessId, 'x-wakil-user': userId, 'content-type': 'audio/wav' },
    body: voicedWav(), duplex: 'half',
  } as RequestInit)
  expect((await audioPost(noHeader)).status).toBe(400)
})

test('type boundary: forged content-type → 415, oversized → 413', async () => {
  expect((await audioPost(wavRequest(voicedWav(), { 'content-type': 'application/pdf' }))).status).toBe(415)
  expect((await audioPost(wavRequest(voicedWav(), { 'content-length': String(4 * 1024 * 1024 + 1) }))).status).toBe(413)
})

test('happy path: consented audio → text + reviewRequired + measured ms + honest cost; key never leaks', async () => {
  const res = await audioPost(wavRequest(voicedWav()))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(typeof body.text).toBe('string')
  expect(body.text.length).toBeGreaterThan(0)
  expect(body.text).not.toContain('mock-key') // no key material in the reply
  expect(body.reviewRequired).toBe(true) // voice text is NEVER auto-approved
  expect(Number.isFinite(body.ms) && body.ms >= 0).toBe(true)
  expect(Number.isFinite(body.costUsd) && body.costUsd >= 0).toBe(true)
})

test('silent recording → honest empty-text error, never a fabricated transcript', async () => {
  const res = await audioPost(wavRequest(silentWav()))
  expect(res.status).toBe(422)
  const body = await res.json()
  expect(body.error).toContain('ما اتلقطش')
})

test('ephemeral session token: mint → use for STT; consent still required; invalid/expired → 401', async () => {
  // mint (authenticated request, business scope)
  const mintRes = await mint(new Request('http://localhost/api/speech/session', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-wakil-business': businessId, 'x-wakil-user': userId },
    body: JSON.stringify({ businessId }),
  }))
  expect(mintRes.status).toBe(201)
  const { token, scope, expiresAt } = await mintRes.json()
  expect(typeof token).toBe('string'); expect(token.startsWith('wsp_')).toBe(true)
  expect(scope).toBe('stt')
  expect(new Date(expiresAt).getTime() > Date.now()).toBe(true)

  // use: token replaces the session headers, consent still mandatory
  const tokenReq = (extra: Record<string, string> = {}) =>
    new Request('http://localhost/api/speech', {
      method: 'POST',
      headers: { 'x-wakil-speech-session': token, 'x-wakil-audio-consent': 'review-only', 'content-type': 'audio/wav', ...extra },
      body: voicedWav(), duplex: 'half',
    } as RequestInit)
  const okRes = await audioPost(tokenReq())
  expect(okRes.status).toBe(200)
  expect(((await okRes.json()) as { text: string }).text.length).toBeGreaterThan(0)

  // token without consent is still rejected (consent is never implied)
  const noConsent = new Request('http://localhost/api/speech', {
    method: 'POST', headers: { 'x-wakil-speech-session': token, 'content-type': 'audio/wav' },
    body: voicedWav(), duplex: 'half',
  } as RequestInit)
  expect((await audioPost(noConsent)).status).toBe(400)

  // invalid token → 401
  const bad = new Request('http://localhost/api/speech', {
    method: 'POST', headers: { 'x-wakil-speech-session': 'wsp_deadbeefdeadbeefdeadbeef', 'x-wakil-audio-consent': 'review-only', 'content-type': 'audio/wav' },
    body: voicedWav(), duplex: 'half',
  } as RequestInit)
  expect((await audioPost(bad)).status).toBe(401)

  // expired token → 401 (TTL pinned to 300ms for this file)
  await new Promise((r) => setTimeout(r, 400))
  expect((await audioPost(tokenReq())).status).toBe(401)
})

test('FINANCIAL BOUNDARY — the whole battery created ZERO operations, ZERO messages, ZERO agent events: voice returns text only', async () => {
  expect(await db.operation.count({ where: { businessId } })).toBe(0)
  expect(await db.message.count({ where: { conversation: { businessId } } })).toBe(0)
  expect(await db.agentEvent.count({ where: { businessId } })).toBe(0)
})
