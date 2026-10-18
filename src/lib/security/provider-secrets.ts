// AES-256-GCM envelopes. The encryption key lives OUTSIDE SQLite/backups.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const PREFIX = 'wakil:v1:'

function key(): Buffer | null {
  const raw = process.env.WAKIL_SECRETS_KEY
  if (raw === undefined && process.env.NODE_ENV !== 'production') return null
  if (!raw || !/^[a-fA-F0-9]{64}$/.test(raw)) throw new Error('Provider secrets key is missing or invalid')
  return Buffer.from(raw, 'hex')
}

export function encryptProviderKey(plaintext: string): string {
  const secret = key()
  if (!secret) return plaintext // local synthetic demo only
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', secret, iv)
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
}

export function decryptProviderKey(envelope: string): string {
  if (!envelope.startsWith(PREFIX)) {
    if (process.env.NODE_ENV === 'production') throw new Error('Legacy provider key requires encryption migration')
    return envelope
  }
  const secret = key()
  if (!secret) throw new Error('Provider secrets key is missing')
  try {
    const bytes = Buffer.from(envelope.slice(PREFIX.length), 'base64')
    if (bytes.length < 29) throw new Error('invalid envelope')
    const decipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12))
    decipher.setAuthTag(bytes.subarray(12, 28))
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('Provider key could not be decrypted')
  }
}
