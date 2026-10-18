import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex')
export const newToken = () => randomBytes(32).toString('base64url')
export const csrfFor = (token: string) => createHmac('sha256', token).update('wakil-csrf-v1').digest('base64url')
export class SaasError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'invalid_request') { super(message); this.name = 'SaasError' }
}
let hashing = 0
async function derive(password: string, salt: string): Promise<Buffer> {
  if (hashing >= 3) throw new SaasError('طلبات دخول كثيرة؛ جرّب بعد لحظات', 429, 'busy')
  hashing++
  try {
    return await new Promise((resolve, reject) => scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => err ? reject(err) : resolve(key)))
  } finally { hashing-- }
}
export async function hashPassword(password: string) {
  if (password.length < 12 || password.length > 128 || Buffer.byteLength(password) > 256 || /^(password|123456|qwerty)/i.test(password)) throw new SaasError('استخدم كلمة مرور قوية من 12 إلى 128 حرفًا')
  const salt = randomBytes(16).toString('hex')
  return `scrypt-v1$${salt}$${(await derive(password, salt)).toString('hex')}`
}
export async function verifyPassword(password: string, encoded?: string | null) {
  const parts = (encoded ?? '').split('$')
  const valid = parts.length === 3 && parts[0] === 'scrypt-v1' && /^[a-f0-9]{32}$/.test(parts[1]) && /^[a-f0-9]{128}$/.test(parts[2])
  const actual = await derive(password.slice(0, 128), valid ? parts[1] : '00000000000000000000000000000000')
  const expected = valid ? Buffer.from(parts[2], 'hex') : Buffer.alloc(64)
  return timingSafeEqual(actual, expected) && valid
}
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export function newTotpSecret() {
  const bytes = randomBytes(20)
  let bits = 0, value = 0, result = ''
  for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { result += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5 } }
  return result
}
export function totp(secret: string, step: number): string {
  let bits = 0, value = 0
  const bytes: number[] = []
  for (const char of secret) { const n = ALPHABET.indexOf(char); if (n < 0) throw new Error('Invalid MFA secret'); value = (value << 5) | n; bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8 } }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step))
  const hash = createHmac('sha1', Buffer.from(bytes)).update(counter).digest()
  const offset = hash[19] & 15
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}
export function matchTotp(secret: string, code: string, lastStep = -1, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const step = Math.floor(now / 30_000)
  for (const candidate of [step, step - 1, step + 1]) {
    if (candidate > lastStep && timingSafeEqual(Buffer.from(totp(secret, candidate)), Buffer.from(code))) return candidate
  }
  return null
}
