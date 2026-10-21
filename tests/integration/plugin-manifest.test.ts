// R78 / PR-009 — الخطة النهائية v2 §8.3: plugin manifest permissions +
// version rollback. «plugin لا يكسب صلاحيات بنفسه»:
//
//   • a plugin's grant is COMPUTED by the server from its pipeline modules —
//     any permissions array it declares is ignored;
//     every supported module is read-only (the plugin boundary);
//   • the grant is LOCKED at install; execution refuses a pipeline that
//     needs anything beyond the stored grant (out-of-band tamper);
//   • upgrades keep a version history; rollback restores it (audited);
//   • enable/disable gates execution.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { testDb } from '../helpers/test-db'
import {
  allPluginModulesReadOnly,
  effectivePluginPermissions,
  executePlugin,
  installOrUpdatePlugin,
  MODULE_PERMISSIONS,
  rollbackPlugin,
  STARTER_PLUGIN_CATALOG,
  togglePluginActive,
} from '@/lib/agent/plugin-harness'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let business: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let user: any

beforeAll(async () => {
  db = await testDb()
  business = await db.business.create({ data: { name: randomUUID(), type: 'supermarket' } })
  user = await db.user.create({ data: { businessId: business.id, name: 'owner', role: 'owner' } })
})
afterAll(async () => {
  await db.business.deleteMany({ where: { id: business.id } })
  await db.$disconnect?.()
})

// names carry a uuid: same-name installs are treated as UPGRADES of the
// same plugin (by design) — tests must stay isolated.
const spec = (version: string, pipeline: Array<{ module: 'inventory_audit' | 'sales_analytics' | 'margin_audit' | 'expiry_shield'; label: string; params?: Record<string, unknown> }>) => ({
  slug: `plugin_test_${randomUUID().slice(0, 8)}`,
  name: `بلاجن اختبار ${version}-${randomUUID().slice(0, 6)}`,
  description: 'اختبار عقد البلاجن',
  category: 'inventory' as const,
  icon: 'boxes' as const,
  version,
  author: 'wakil-core' as const,
  triggers: ['اختبار'],
  capabilities: ['قراءة تحليلية'],
  pipeline,
  proactiveRules: [],
  quickPrompt: 'شغّل الاختبار',
})

describe('manifest — permissions are server-computed, never self-declared', () => {
  test('every supported module is read-only (the plugin boundary)', () => {
    expect(allPluginModulesReadOnly()).toBe(true)
    expect(Object.values(MODULE_PERMISSIONS).every((p) => p.startsWith('read:'))).toBe(true)
  })

  test('the grant is computed from the pipeline modules (sorted, deduped)', () => {
    expect(effectivePluginPermissions([
      { module: 'inventory_audit', label: 'a' },
      { module: 'margin_audit', label: 'b' },
      { module: 'inventory_audit', label: 'c' },
    ])).toEqual(['read:financial', 'read:inventory'])
  })

  test('a spec that declares extra permissions gets exactly the computed grant', async () => {
    const s = spec('1.0.0', [{ module: 'inventory_audit', label: 'مخزون' }])
    // the lie: the spec claims cash-write powers
    const lying = { ...s, permissions: ['write:cash', 'admin:everything'] } as any
    const installed = await installOrUpdatePlugin({ businessId: business.id, userId: user.id, spec: lying })
    expect(installed.permissions).toEqual(['read:inventory'])
    expect(installed.permissions).not.toContain('write:cash')
  })

  test('every starter plugin in the catalog carries a computed grant', () => {
    for (const s of STARTER_PLUGIN_CATALOG) {
      expect(s.permissions, s.slug).toEqual(effectivePluginPermissions(s.pipeline))
      expect((s.permissions ?? []).length).toBeGreaterThan(0)
    }
  })
})

describe('manifest — the grant is locked at install, enforced at execution', () => {
  test('tampering the stored pipeline beyond the grant is refused', async () => {
    const s = spec('1.0.0', [{ module: 'inventory_audit', label: 'مخزون' }])
    const installed = await installOrUpdatePlugin({ businessId: business.id, userId: user.id, spec: s })

    // out-of-band rewrite: add a financial-scope module (still a legal
    // module — but outside the grant locked at install time)
    await db.customTool.update({
      where: { id: installed.id },
      data: {
        config: JSON.stringify({
          ...JSON.parse((await db.customTool.findUniqueOrThrow({ where: { id: installed.id } })).config),
          pipeline: [
            { module: 'inventory_audit', label: 'مخزون' },
            { module: 'margin_audit', label: 'ربحية' },
          ],
        }),
      },
    })

    await expect(executePlugin({ businessId: business.id, pluginOrSlug: installed.slug }))
      .rejects.toThrow(/plugin_scope_violation/)
  })

  test('an untouched installed plugin still executes', async () => {
    const s = spec('1.0.0', [{ module: 'sales_analytics', label: 'مبيعات' }])
    const installed = await installOrUpdatePlugin({ businessId: business.id, userId: user.id, spec: s })
    const res = await executePlugin({ businessId: business.id, pluginOrSlug: installed.slug })
    expect(res.plugin.slug).toBe(installed.slug)
  })
})

describe('manifest — version history + one-step rollback', () => {
  test('upgrade archives the previous version; rollback restores it (audited)', async () => {
    const s1 = spec('1.0.0', [{ module: 'inventory_audit', label: 'مخزون' }])
    const v1 = await installOrUpdatePlugin({ businessId: business.id, userId: user.id, spec: s1 })

    const s2 = { ...s1, version: '2.0.0', pipeline: [{ module: 'inventory_audit' as const, label: 'مخزون' }, { module: 'expiry_shield' as const, label: 'صلاحية' }] }
    const v2 = await installOrUpdatePlugin({ businessId: business.id, userId: user.id, spec: s2 })
    expect(v2.version).toBe('2.0.0')
    expect(v2.permissions).toEqual(['read:inventory'])

    const row = await db.customTool.findUniqueOrThrow({ where: { id: v2.id } })
    const cfg = JSON.parse(row.config)
    expect(cfg.previousVersions).toHaveLength(1)
    expect(cfg.previousVersions[0].version).toBe('1.0.0')

    const rolled = await rollbackPlugin(v2.id, business.id, user.id)
    expect(rolled?.version).toBe('1.0.0')
    expect(rolled?.pipeline.map((p: any) => p.module)).toEqual(['inventory_audit'])

    const audits = await db.auditEvent.findMany({ where: { businessId: business.id, action: { in: ['plugin.upgraded', 'plugin.rolled_back'] } } })
    expect(audits.some((a: any) => a.action === 'plugin.upgraded')).toBe(true)
    expect(audits.some((a: any) => a.action === 'plugin.rolled_back')).toBe(true)
  })

  test('rollback without history is a clean no-op result', async () => {
    const s = spec('1.0.0', [{ module: 'inventory_audit', label: 'مخزون' }])
    const installed = await installOrUpdatePlugin({ businessId: business.id, userId: user.id, spec: s })
    expect(await rollbackPlugin(installed.id, business.id, user.id)).toBeNull()
  })
})

describe('manifest — enable/disable gates execution', () => {
  test('a disabled plugin cannot execute; re-enabling works', async () => {
    const s = spec('1.0.0', [{ module: 'sales_analytics', label: 'مبيعات' }])
    const installed = await installOrUpdatePlugin({ businessId: business.id, userId: user.id, spec: s })
    await togglePluginActive(installed.id, false, business.id, user.id)
    await expect(executePlugin({ businessId: business.id, pluginOrSlug: installed.slug })).rejects.toThrow(/متوقفة/)
    await togglePluginActive(installed.id, true, business.id, user.id)
    const res = await executePlugin({ businessId: business.id, pluginOrSlug: installed.slug })
    expect(res.plugin.active).toBe(true)
  })
})
