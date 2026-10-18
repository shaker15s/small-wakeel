import { FormData } from 'undici'
import { db } from '@/lib/db'
import { providerFetch, providerUrl } from '@/lib/security/provider-network'
import { decryptProviderKey } from '@/lib/security/provider-secrets'

export const AUDIO_LIMIT = 4 * 1024 * 1024
export class SpeechError extends Error { constructor(message: string, readonly status = 422) { super(message) } }
const types: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3' }
export async function speechSelection() {
  const setting = await db.speechSettings.findUnique({ where: { id: 'global' }, include: { provider: true } })
  if (!setting || !await db.modelConfig.findFirst({ where: { providerId: setting.providerId, remoteId: setting.remoteId, enabled: true } })) return null
  return setting
}
export async function readAudio(req: Request): Promise<{ bytes: Uint8Array; type: string; extension: string }> {
  const type = req.headers.get('content-type')?.split(';')[0].trim() ?? ''
  if (!types[type]) throw new SpeechError('نوع التسجيل مش مدعوم', 415)
  if (Number(req.headers.get('content-length')) > AUDIO_LIMIT) throw new SpeechError('التسجيل أكبر من ٤ ميجابايت؛ جرّب مقطع أقصر', 413)
  const reader = req.body?.getReader()
  if (!reader) throw new SpeechError('التسجيل فاضي')
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > AUDIO_LIMIT) { await reader.cancel(); throw new SpeechError('التسجيل أكبر من ٤ ميجابايت', 413) }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  if (size < 44) throw new SpeechError('التسجيل فاضي أو قصير جدًا')
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  const ascii = (a: number, b: number) => String.fromCharCode(...bytes.slice(a, b))
  const matches = type.includes('wav') ? ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE' : type === 'audio/webm' ? bytes.slice(0, 4).every((v, i) => v === [0x1a, 0x45, 0xdf, 0xa3][i]) : type === 'audio/ogg' ? ascii(0, 4) === 'OggS' : type === 'audio/mp4' ? ascii(4, 8) === 'ftyp' : ascii(0, 3) === 'ID3' || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0
  if (!matches) throw new SpeechError('محتوى الملف مش مطابق لنوع التسجيل', 415)
  return { bytes, type, extension: types[type] }
}
/** Audio is transient. Only the returned, user-reviewed text may become a chat message. */
export async function transcribeAudio(audio: Awaited<ReturnType<typeof readAudio>>, selected: NonNullable<Awaited<ReturnType<typeof speechSelection>>>, signal?: AbortSignal) {
  const base = providerUrl(selected.provider.baseUrl).toString().replace(/\/$/, '')
  const form = new FormData()
  form.append('model', selected.remoteId); form.append('language', 'ar'); form.append('response_format', 'json')
  form.append('file', new Blob([new Uint8Array(audio.bytes)], { type: audio.type }), `recording.${audio.extension}`)
  let response
  try {
    response = await providerFetch(`${base}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${decryptProviderKey(selected.provider.apiKey)}` }, body: form, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000) })
  } catch { throw new SpeechError('خدمة تحويل الصوت للنص مش متاحة دلوقتي؛ النص الموجود محفوظ', 502) }
  if (!response.ok) { await response.body?.cancel(); throw new SpeechError('المزوّد ما قدرش يحوّل التسجيل؛ راجع دعم موديل الصوت في الإعدادات', 502) }
  // Bound provider responses too; never persist raw provider errors or audio.
  const reader = response.body?.getReader(); if (!reader) throw new SpeechError('المزوّد رجّع رد فاضي', 502)
  let raw = ''; const decoder = new TextDecoder(); let count = 0
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; count += chunk.value.length; if (count > 65_536) { await reader.cancel(); throw new SpeechError('رد خدمة الصوت أكبر من الحد المسموح', 502) }; raw += decoder.decode(chunk.value, { stream: true }) } raw += decoder.decode() } finally { reader.releaseLock() }
  let text: unknown
  try { text = JSON.parse(raw).text } catch { throw new SpeechError('خدمة الصوت رجعت رد غير صالح', 502) }
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new SpeechError('ما اتلقطش كلام واضح؛ جرّب تاني أو كمّل كتابة')
  return text.trim()
}
