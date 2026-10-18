// Real audio only; no mocked ASR transport. No ledger writes, no raw transcript in report.
// Configure ASR via Settings, set WAKIL_VOICE_AUDIO and WAKIL_VOICE_EXPECTED explicitly.
import { ensureTestDatabase } from '../tests/helpers/test-db'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
ensureTestDatabase()
const { db } = await import('../src/lib/db')
const { speechSelection, readAudio, transcribeAudio } = await import('../src/lib/speech')
const { normalizeAr, toWesternDigits } = await import('../src/lib/agent/arabic')
const report: Record<string, unknown> = { date: new Date().toISOString(), status: 'blocked', realAudioRequired: true, microphoneHardwareVerified: false }
let requested = false
try {
  if (process.env.WAKIL_OFFLINE === '1') throw new Error('Offline mode: no live ASR attempted')
  const selected = await speechSelection()
  if (!selected) throw new Error('No enabled ASR selected by deployment admin; chat model is not assumed to support audio')
  const path = process.env.WAKIL_VOICE_AUDIO, expected = process.env.WAKIL_VOICE_EXPECTED
  if (!path || !expected) throw new Error('A consented real audio file and expected transcript are required')
  const extension = path.split('.').pop()?.toLowerCase()
  const type = ({ wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4' } as Record<string, string>)[extension ?? '']
  if (!type) throw new Error('Unsupported audio extension')
  const audio = await readAudio(new Request('http://localhost/parse-only', { method: 'POST', headers: { 'content-type': type }, body: readFileSync(path) }))
  requested = true
  const start = performance.now()
  const transcript = await transcribeAudio(audio, selected)
  const canonical = (s: string) => normalizeAr(toWesternDigits(s)).replace(/[،,.!؟?]/g, '').replace(/\s+/g, ' ').trim()
  report.durationMs = Math.round(performance.now() - start)
  report.transcriptHash = createHash('sha256').update(transcript).digest('hex')
  report.expectedExactMatch = canonical(transcript) === canonical(expected)
  if (!report.expectedExactMatch) throw new Error('Live transcript did not match the expected name/amount/date utterance; no approval or financial execution attempted')
  report.status = 'passed'; process.exitCode = 0
} catch (e) {
  report.status = requested ? 'failed' : 'blocked'
  report.reason = e instanceof Error ? e.message : 'Voice acceptance could not complete'
  process.exitCode = requested ? 1 : 2
} finally {
  mkdirSync('.ci-results', { recursive: true }); writeFileSync('.ci-results/live-voice-acceptance.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2)); await db.$disconnect()
}
