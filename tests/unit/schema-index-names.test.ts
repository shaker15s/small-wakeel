import { describe, expect, test } from 'bun:test'
import { defaultPrismaIndexName } from '../../scripts/lib/prisma-index-names'

describe('Prisma-generated SQLite index names', () => {
  test('ordinary indexes use the _idx suffix used by migrations', () => {
    expect(defaultPrismaIndexName('AgentEvent', ['traceId', 'sequence'], 'index')).toBe('AgentEvent_traceId_sequence_idx')
    expect(defaultPrismaIndexName('ScheduledTask', ['status', 'nextRetryAt'], 'index')).toBe('ScheduledTask_status_nextRetryAt_idx')
  })
  test('unique constraints use the _key suffix', () => {
    expect(defaultPrismaIndexName('User', ['email'], 'unique')).toBe('User_email_key')
  })
  test('an explicit Prisma map name wins over the default', () => {
    expect(defaultPrismaIndexName('AgentEvent', ['traceId'], 'index', 'custom_trace_idx')).toBe('custom_trace_idx')
  })
})
