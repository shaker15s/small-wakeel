// Synthetic provider boundary only; prove production search never consults a fixture.
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
let available = false, networkCalls = 0
mock.module('../../src/lib/agent/llm', () => ({ zaiAvailable: () => available }))
mock.module('../../src/lib/security/provider-network', () => ({ publicFetch: async () => { networkCalls++; throw new Error('No synthetic HTTP fallback is permitted') } }))
mock.module('z-ai-web-dev-sdk', () => ({ default: { create: async () => { throw new Error('Synthetic SDK failure') } } }))
delete process.env.WAKIL_SEARCH_URL; delete process.env.WAKIL_NO_MOCK_SEARCH
process.env.WAKIL_MOCK_PROVIDER_URL = 'http://localhost:3031'
const { searchBackend, searchWeb } = await import('../../src/lib/agent/websearch')
assert.equal(searchBackend(), 'none')
assert.equal((await searchWeb('query')).backend, 'none')
assert.equal(networkCalls, 0)
available = true
const result = await searchWeb('query')
assert.equal(result.backend, 'zai'); assert.equal(result.results.length, 0); assert.ok(result.error)
assert.equal(networkCalls, 0, 'SDK failure must not reach a local fixture')
console.log('PASS: no default mock search and no synthetic fallback after provider failure')
