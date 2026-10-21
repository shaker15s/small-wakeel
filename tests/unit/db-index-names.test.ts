import { describe, expect, test } from 'bun:test'
import { parseIndexDirectives } from '../../scripts/lib/db-index-names'

describe('Prisma physical index names', () => {
  test('uses _idx for @@index and _key for @@unique', () => {
    const parsed = parseIndexDirectives(`
model AgentEvent {
  traceId String
  sequence Int
  @@index([traceId, sequence])
}
model User {
  tenantId String
  email String
  @@unique([tenantId, email])
}
`)
    expect(parsed.AgentEvent[0].name).toBe('AgentEvent_traceId_sequence_idx')
    expect(parsed.User[0].name).toBe('User_tenantId_email_key')
  })

  test('honors explicit map names even when map is not the first attribute', () => {
    const parsed = parseIndexDirectives(`
model CashbookEntry {
  businessId String
  dueOn DateTime
  openAmount Int
  @@index([businessId, dueOn, openAmount], type: BTree, map: "CashbookEntry_businessId_dueOn_openAmount_idx")
}
`)
    expect(parsed.CashbookEntry[0].name).toBe('CashbookEntry_businessId_dueOn_openAmount_idx')
    expect(parsed.CashbookEntry[0].fields).toEqual(['businessId', 'dueOn', 'openAmount'])
  })

  test('removes sort modifiers from indexed field names', () => {
    const parsed = parseIndexDirectives(`
model Task {
  status String
  scheduledFor DateTime
  @@index([status, scheduledFor(sort: Desc)])
}
`)
    expect(parsed.Task[0].name).toBe('Task_status_scheduledFor_idx')
    expect(parsed.Task[0].fields).toEqual(['status', 'scheduledFor'])
  })
})
