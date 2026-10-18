import { afterEach, describe, expect, test } from 'bun:test'
import { runUserTool } from '@/lib/agent/userTools'
import { db } from '@/lib/db'
import { publicAddress, publicAddresses, providerUrl, providerFetch } from '@/lib/security/provider-network'
import { encryptProviderKey, decryptProviderKey } from '@/lib/security/provider-secrets'

const oldKey = process.env.WAKIL_SECRETS_KEY
const oldEnv = process.env.NODE_ENV
const oldLocal = process.env.ALLOW_LOCAL_WEBHOOKS
const oldAllowLocal = process.env.WAKIL_ALLOW_LOCAL_PROVIDERS
const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
afterEach(() => { restore('WAKIL_SECRETS_KEY', oldKey); restore('NODE_ENV', oldEnv); restore('ALLOW_LOCAL_WEBHOOKS', oldLocal); restore('WAKIL_ALLOW_LOCAL_PROVIDERS', oldAllowLocal) })

describe('provider SSRF defence', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.1', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '2001:db8::1', '64:ff9b::7f00:1']) {
    test(`blocks non-public address ${address}`, () => { expect(publicAddress(address)).toBe(false) })
  }
  test('accepts globally routable addresses', () => {
    expect(publicAddress('8.8.8.8')).toBe(true)
    expect(publicAddress('2606:4700:4700::1111')).toBe(true)
  })
  for (const url of ['http://api.example.com/v1', 'file:///etc/passwd',
    'https://user:password@api.example.com/v1', 'https://api.example.com/v1?redirect=x',
    'https://api.example.com/v1#fragment']) {
    test(`rejects unsafe URL ${url}`, () => { expect(() => providerUrl(url)).toThrow() })
  }
  // Loopback URLs are the DEV-ONLY demo-provider escape hatch (the preview's
  // local mock LLM on 127.0.0.1 must be reachable). The hatch requires the
  // EXPLICIT WAKIL_ALLOW_LOCAL_PROVIDERS=1 flag — never the environment alone.
  for (const url of ['https://localhost/v1', 'https://127.1/v1', 'https://2130706433/v1', 'https://[::1]/v1']) {
    test(`rejects loopback URL without the local-providers flag ${url}`, () => {
      delete process.env.WAKIL_ALLOW_LOCAL_PROVIDERS
      expect(() => providerUrl(url)).toThrow('Non-public')
    })
    test(`rejects loopback URL in production even with the flag ${url}`, () => {
      Object.assign(process.env, { NODE_ENV: 'production', WAKIL_ALLOW_LOCAL_PROVIDERS: '1' })
      expect(() => providerUrl(url)).toThrow('Non-public')
    })
    test(`allows loopback URL with the local-providers flag ${url}`, () => {
      process.env.WAKIL_ALLOW_LOCAL_PROVIDERS = '1'
      expect(() => providerUrl(url)).not.toThrow()
    })
  }
  test('production webhooks cannot enable the development local-network escape hatch', async () => {
    Object.assign(process.env, { NODE_ENV: 'production', ALLOW_LOCAL_WEBHOOKS: '1' })
    const owner = await db.user.findFirstOrThrow({ where: { role: 'owner' } })
    const tool = await db.customTool.create({ data: {
      businessId: owner.businessId, userId: owner.id, kind: 'webhook', name: 'private endpoint test',
      config: JSON.stringify({ url: 'https://127.0.0.1/metadata', method: 'GET' }),
    } })
    try { expect((await runUserTool(tool, 'test')).ok).toBe(false) }
    finally { await db.customTool.delete({ where: { id: tool.id } }) }
  })
  test('allows HTTPS provider paths', () => {
    expect(providerUrl('https://api.example.com/v1').pathname).toBe('/v1')
  })
  test('checks every DNS answer including mixed A/AAAA sets', async () => {
    await expect(publicAddresses('api.example.com', async () => [
      { address: '8.8.8.8', family: 4 }, { address: '::ffff:10.0.0.1', family: 6 },
    ])).rejects.toThrow('Non-public')
    await expect(publicAddresses('api.example.com', async () => [])).rejects.toThrow()
  })
  test('a rebinding/private DNS response is not reused as a trusted hostname', async () => {
    let calls = 0
    const resolve = async () => [{ address: ++calls === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }]
    expect((await publicAddresses('rebind.example.com', resolve))[0].address).toBe('8.8.8.8')
    await expect(publicAddresses('rebind.example.com', resolve)).rejects.toThrow()
    // The guarded transport also rejects literal URLs BEFORE any HTTP call.
    expect(() => providerFetch('https://169.254.169.254/latest/meta-data')).toThrow()
  })
})

describe('provider secrets at rest', () => {
  test('encrypts with a fresh authenticated IV and round-trips', () => {
    process.env.WAKIL_SECRETS_KEY = 'ab'.repeat(32)
    const a = encryptProviderKey('secret-api-key')
    const b = encryptProviderKey('secret-api-key')
    expect(a).not.toBe(b)
    expect(a).not.toContain('secret-api-key')
    expect(decryptProviderKey(a)).toBe('secret-api-key')
  })
  test('wrong keys and tampered ciphertext fail without exposing the secret', () => {
    process.env.WAKIL_SECRETS_KEY = 'ab'.repeat(32)
    const envelope = encryptProviderKey('sensitive-key')
    process.env.WAKIL_SECRETS_KEY = 'cd'.repeat(32)
    expect(() => decryptProviderKey(envelope)).toThrow('could not be decrypted')
    process.env.WAKIL_SECRETS_KEY = 'ab'.repeat(32)
    const bytes = Buffer.from(envelope.slice('wakil:v1:'.length), 'base64')
    bytes[bytes.length - 1] ^= 1
    expect(() => decryptProviderKey('wakil:v1:' + bytes.toString('base64'))).toThrow('could not be decrypted')
  })
  test('production rejects plaintext reads and absent encryption configuration', () => {
    Object.assign(process.env, { NODE_ENV: 'production' })
    delete process.env.WAKIL_SECRETS_KEY
    expect(() => encryptProviderKey('secret')).toThrow('missing or invalid')
    expect(() => decryptProviderKey('plaintext-key')).toThrow('migration')
    process.env.WAKIL_SECRETS_KEY = 'bad-key'
    expect(() => encryptProviderKey('secret')).toThrow('missing or invalid')
  })
})
