import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { streamChat } from '@/lib/agent/llm'

let server: Server
let baseUrl = ''
let requests = 0

beforeAll(async () => {
  server = createServer((_req, res) => {
    requests += 1
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'close',
    })
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}/v1`
})

afterAll(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

describe('offline LLM network boundary', () => {
  test('streaming an external model rejects before making any HTTP request', async () => {
    const oldOffline = process.env.WAKIL_OFFLINE
    const oldAllowLocal = process.env.WAKIL_ALLOW_LOCAL_PROVIDERS
    process.env.WAKIL_OFFLINE = '1'
    process.env.WAKIL_ALLOW_LOCAL_PROVIDERS = '1'
    requests = 0

    const model = {
      key: 'ext:offline-boundary-test',
      label: 'Offline boundary test',
      tier: 'air' as const,
      source: 'external' as const,
      remoteModel: 'mock-offline-test',
      baseUrl,
    }

    try {
      const consumeStream = async () => {
        for await (const _chunk of streamChat(model, [{ role: 'user', content: 'test' }])) {
          // Consume every chunk: a hidden late request must not be missed.
        }
      }
      await expect(consumeStream()).rejects.toThrow(/offline mode/i)
      expect(requests).toBe(0)
    } finally {
      if (oldOffline === undefined) delete process.env.WAKIL_OFFLINE
      else process.env.WAKIL_OFFLINE = oldOffline
      if (oldAllowLocal === undefined) delete process.env.WAKIL_ALLOW_LOCAL_PROVIDERS
      else process.env.WAKIL_ALLOW_LOCAL_PROVIDERS = oldAllowLocal
    }
  })
})
