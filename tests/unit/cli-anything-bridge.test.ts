// OS telemetry is not a connector. These are diagnostics / fail-closed tests,
// NOT integration tests against Excel, a POS backend, or a merchant's machine.
import { describe, expect, test } from 'bun:test'
import {
  scanRunningApplications, inspectExcelWorkbooks, inspectDatabaseOrService,
  bridgeApplicationWithCliAnything, executeBridgedTool, getRunningProcesses,
  inspectDesktopApplication,
} from '@/lib/agent/cli-anything/bridge'
import { executePlugin } from '@/lib/agent/plugin-harness'
import { db } from '@/lib/db'

describe('CLI host diagnostics and unverified connector safety', () => {
  test('local OS diagnostics return actual PIDs, never connection proof', async () => {
    const procs = await getRunningProcesses()
    expect(procs.length).toBeGreaterThan(0)
    expect(procs[0].pid).toBeGreaterThan(0)
    expect(procs[0].name.length).toBeGreaterThan(0)
    const apps = await scanRunningApplications()
    expect(apps.length).toBeGreaterThanOrEqual(4)
    expect(apps.every((app) => !app.hasCliHarness)).toBe(true)
    expect(Array.isArray((await inspectExcelWorkbooks()).recentSpreadsheets)).toBe(true)
    expect(Array.isArray((await inspectDatabaseOrService()).ports)).toBe(true)
  })

  test('bridge refuses success and does not persist a fake plugin', async () => {
    const before = await db.customTool.count()
    const res = await bridgeApplicationWithCliAnything({
      businessId: 'not-a-tenant', userId: 'not-a-user', appName: 'Excel', processName: 'excel',
    })
    expect(res.ok).toBe(false)
    expect(res.status).toBe('not_connected')
    expect(res.plugin).toBeUndefined()
    expect(res.capabilities).toEqual([])
    expect(res.harnessSchema).toEqual({})
    expect(res.statusSteps.some((s) => s.state === 'failed')).toBe(true)
    expect(await db.customTool.count()).toBe(before)
  })

  for (const command of ['sync_invoices', 'export_inventory', 'record_transaction', 'check_status']) {
    test(`${command} cannot fabricate external data or fall back to the ledger`, async () => {
      const res = await executeBridgedTool({ appName: 'POS', businessId: 'any', command })
      expect(res.ok).toBe(false)
      expect(res.error).toBe('not_connected')
      expect(res.data).toEqual({ source: 'none', connectionStatus: 'not_connected' })
      expect(res.cards.length).toBe(1)
      expect(res.summary).toContain('لم تُقرأ أو تُكتب')
    })
  }

  test('no inventory differences or matching claims without external records', async () => {
    const owner = await db.user.findFirstOrThrow({ where: { role: 'owner' } })
    const res = await inspectDesktopApplication('Daftra', owner.businessId)
    expect(res.reconciliation).toEqual({ matchedCount: 0, discrepancyCount: 0, items: [] })
    expect(res.summary).toContain('غير متصل')
    expect(res.cards.some((c) => c.kind === 'table')).toBe(false)
  })

  test('legacy persisted bridge is blocked before its internal-ledger pipeline', async () => {
    const owner = await db.user.findFirstOrThrow({ where: { role: 'owner' } })
    // Simulate an OLD persisted row; the new installer must reject this module.
    const legacy = {
      slug: 'app_cli_legacy_test', name: 'Legacy external POS', description: 'Unverified bridge',
      category: 'finance', icon: 'spark', version: '1', author: 'ai-synthesized',
      triggers: ['legacy test'], capabilities: [], proactiveRules: [], quickPrompt: 'test',
      pipeline: [{ module: 'custom_query', label: 'external invoices', params: { targetEntity: 'operations' } }],
    }
    const row = await db.customTool.create({ data: { businessId: owner.businessId, userId: owner.id, kind: 'plugin', name: legacy.name, config: JSON.stringify(legacy), active: true } })
    const plugin = { ...row, slug: legacy.slug }

    try {
      await expect(executePlugin({ businessId: owner.businessId, pluginOrSlug: plugin.slug })).rejects.toThrow('not_connected')
    } finally {
      await db.customTool.delete({ where: { id: plugin.id } })
      await db.quickCommand.deleteMany({ where: { businessId: owner.businessId, label: plugin.name } })
    }
  })

  test('production diagnostics never scan the server on behalf of a tenant', async () => {
    const prev = process.env.NODE_ENV
    Object.assign(process.env, { NODE_ENV: 'production' })
    try {
      expect(await getRunningProcesses()).toEqual([])
      expect(await scanRunningApplications()).toEqual([])
      expect((await inspectExcelWorkbooks()).recentSpreadsheets).toEqual([])
      expect((await inspectDatabaseOrService()).localDatabases).toEqual([])
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV')
      else Object.assign(process.env, { NODE_ENV: prev })
    }
  })
})
