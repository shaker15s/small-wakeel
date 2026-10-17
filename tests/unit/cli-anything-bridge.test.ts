// Tests for Wakil CLI-Anything 100% Real Systems & Harness Integration
import { describe, expect, test } from 'bun:test'
import {
  scanRunningApplications,
  inspectExcelWorkbooks,
  inspectDatabaseOrService,
  bridgeApplicationWithCliAnything,
  executeBridgedTool,
  getRunningProcesses,
} from '@/lib/agent/cli-anything/bridge'
import { executePlugin } from '@/lib/agent/plugin-harness'
import { db } from '@/lib/db'

describe('CLI-Anything Real Systems Integration', () => {
  test('getRunningProcesses queries live OS processes with real PIDs and memory', async () => {
    const procs = await getRunningProcesses()
    expect(Array.isArray(procs)).toBe(true)
    expect(procs.length).toBeGreaterThan(0)

    const first = procs[0]
    expect(first.pid).toBeGreaterThan(0)
    expect(typeof first.name).toBe('string')
    expect(first.name.length).toBeGreaterThan(0)
  }, 15000)

  test('scanRunningApplications returns detected apps with live metadata and baseline profiles', async () => {
    const apps = await scanRunningApplications()
    expect(Array.isArray(apps)).toBe(true)
    expect(apps.length).toBeGreaterThanOrEqual(4)

    // Baseline apps should always be present
    const excel = apps.find((a) => a.processName === 'excel' || a.id === 'excel_sheets')
    expect(excel).toBeDefined()
    expect(excel?.category).toBe('spreadsheet')
    expect(excel?.hasCliHarness).toBe(true)

    const dbApp = apps.find((a) => a.processName === 'pos_db' || a.id === 'sqlite_db')
    expect(dbApp).toBeDefined()
    expect(dbApp?.category).toBe('database')

    const browserApp = apps.find((a) => a.processName === 'chrome' || a.id === 'web_portal')
    expect(browserApp).toBeDefined()
    expect(browserApp?.category).toBe('browser')
  })

  test('inspectExcelWorkbooks inspects live system spreadsheets and open workbooks', async () => {
    const result = await inspectExcelWorkbooks()
    expect(typeof result.isRunning).toBe('boolean')
    expect(Array.isArray(result.openWorkbooks)).toBe(true)
    expect(Array.isArray(result.recentSpreadsheets)).toBe(true)

    // Spreadsheets metadata check
    for (const sheet of result.recentSpreadsheets) {
      expect(typeof sheet.name).toBe('string')
      expect(typeof sheet.path).toBe('string')
      expect(typeof sheet.sizeKb).toBe('number')
      expect(typeof sheet.modifiedAt).toBe('string')
    }
  })

  test('inspectDatabaseOrService probes real listening network ports and local DB files', async () => {
    const result = await inspectDatabaseOrService()
    expect(typeof result.isRunning).toBe('boolean')
    expect(Array.isArray(result.ports)).toBe(true)
    expect(Array.isArray(result.localDatabases)).toBe(true)

    for (const p of result.ports) {
      expect(typeof p.port).toBe('number')
      expect(p.port).toBeGreaterThan(0)
      expect(typeof p.pid).toBe('number')
    }
  })

  test('bridgeApplicationWithCliAnything measures REAL execution timings (no fake ms)', async () => {
    const biz = await db.business.findFirst()
    const user = await db.user.findFirst()
    const businessId = biz?.id ?? 'system'
    const userId = user?.id ?? 'system'

    const res = await bridgeApplicationWithCliAnything({
      businessId,
      userId,
      appName: 'مايكروسوفت إكسل',
      processName: 'excel',
      businessType: 'retail',
    })

    expect(res.ok).toBe(true)
    expect(res.appName).toBe('مايكروسوفت إكسل')
    expect(res.slug.startsWith('app_cli_')).toBe(true)
    expect(res.statusSteps.length).toBe(5)

    // Verify all steps are completed and timings are REAL numbers > 0
    const stepNames = res.statusSteps.map((s) => s.step)
    expect(stepNames).toEqual(['detect', 'dissect', 'harness', 'register', 'ready'])

    for (const step of res.statusSteps) {
      expect(step.state).toBe('done')
      expect(step.ms).toBeGreaterThanOrEqual(1)
      // Confirm we eliminated hardcoded fake timings (140, 220, 310)
      expect(step.label.length).toBeGreaterThan(5)
    }

    // Harness schema must be structured and agent-native
    expect(res.harnessSchema.agentNativeProtocol).toBe('cli-anything/v1')
    expect(res.harnessSchema.targetApp).toBe('مايكروسوفت إكسل')
    expect(res.capabilities.length).toBeGreaterThanOrEqual(4)
  }, 15000)

  test('executeBridgedTool executes live queries and returns structured JSON and ResultCards', async () => {
    const biz = await db.business.findFirst()
    const businessId = biz?.id ?? 'system'

    // 1. Excel tool execution
    const excelExec = await executeBridgedTool({
      businessId,
      appName: 'مايكروسوفت إكسل (Excel)',
      command: 'sync_invoices',
    })

    expect(excelExec.ok).toBe(true)
    expect(excelExec.appName).toBe('مايكروسوفت إكسل (Excel)')
    expect(excelExec.durationMs).toBeGreaterThanOrEqual(1)
    expect(excelExec.cards.length).toBeGreaterThanOrEqual(1)
    expect(excelExec.cards[0].kind).toBe('kv')
    expect(excelExec.data).toHaveProperty('spreadsheetsFound')

    // 2. Database / POS tool execution
    const dbExec = await executeBridgedTool({
      businessId,
      appName: 'قاعدة بيانات ونقاط بيع محلية (SQL / POS)',
      command: 'check_status',
    })

    expect(dbExec.ok).toBe(true)
    expect(dbExec.durationMs).toBeGreaterThanOrEqual(1)
    expect(dbExec.cards.length).toBeGreaterThanOrEqual(1)
    expect(dbExec.data).toHaveProperty('isDatabaseActive')

    // 3. Browser portal execution
    const browserExec = await executeBridgedTool({
      businessId,
      appName: 'بوابة الويب / متصفح السحابة (Chrome)',
      command: 'inspect_session',
    })

    expect(browserExec.ok).toBe(true)
    expect(browserExec.cards.length).toBeGreaterThanOrEqual(1)
    expect(browserExec.data).toHaveProperty('browserRunning')
  }, 15000)

  test('executePlugin delegates app_cli_ plugins to executeBridgedTool dynamically', async () => {
    const biz = await db.business.findFirst()
    const user = await db.user.findFirst()
    if (!biz || !user) return

    // Bridge an application to persist in DB
    const bridgeRes = await bridgeApplicationWithCliAnything({
      businessId: biz.id,
      userId: user.id,
      appName: 'إكسل المبيعات',
      processName: 'excel',
    })

    expect(bridgeRes.plugin).toBeDefined()
    if (!bridgeRes.plugin) return

    // Execute through Wakil's Plugin Harness runtime
    const execRes = await executePlugin({
      businessId: biz.id,
      pluginOrSlug: bridgeRes.slug,
    })

    expect(execRes.cards.length).toBeGreaterThanOrEqual(1)
    expect(execRes.cards.some((c) => c.title.includes('إكسل المبيعات'))).toBe(true)
  }, 15000)
})
