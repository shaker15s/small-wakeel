// وكيل — PR-012 (plan v2 §10.2 Level A + §10.3): Excel reconciliation +
// trial connector. Acceptance from the plan:
//   «لا write قبل dry-run/owner approval»
//   «mapping / read-back / malformed files»
//
// Battery:
//   1. MALFORMED FILES — BOM, Arabic-Indic digits, «،» decimals, currency
//      noise, ragged rows, duplicates within the file, negative prices,
//      unknown headers, header-only file, over-limit file → per-row honest
//      verdicts, never a silent skip
//   2. DRY-RUN — field-level diffs against the live catalog, ZERO writes
//   3. APPLY — only the exact previewed contentHash; acknowledgement
//      mandatory; tampered hash refused
//   4. READ-BACK — every applied row re-fetched from the DB and compared
//      field-by-field; evidence stored (verified / mismatched)
//   5. CONNECTOR CONTRACT — full §10.3 manifest; connection_state COMPUTED
//      (NOT_CONFIGURED before, PENDING_APPROVAL at draft, CONNECTED after a
//      clean read-back); unimplemented levels say NOT_CONFIGURED
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { testDb } from '../helpers/test-db'
import { createNewBusinessWithDefaults } from '@/lib/domain/business-builder'
import { POST as reconcilePOST } from '@/app/api/items/reconcile/route'

let db: Awaited<ReturnType<typeof testDb>>
const ids: string[] = []

beforeAll(async () => {
  db = await testDb()
})

afterAll(async () => {
  await db.business.deleteMany({ where: { id: { in: ids } } })
})

async function shop() {
  const created = await createNewBusinessWithDefaults({ name: `reconcile-${randomUUID()}`, type: 'supermarket' })
  ids.push(created.id)
  // the owner grants file-import consent (the R75 gate this flow respects)
  const { setProfileConsent } = await import('@/lib/domain/onboarding-profile')
  await setProfileConsent(created.id, 'importFromFiles', true)
  return {
    business: await db.business.findUniqueOrThrow({ where: { id: created.id } }),
    user: await db.user.findUniqueOrThrow({ where: { id: created.users[0].id } }),
  }
}

function post(body: Record<string, unknown>, businessId: string, userId: string) {
  return reconcilePOST(new Request('http://test/api/items/reconcile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ businessId, userId, ...body }),
  }))
}

const HDR = 'اسم الصنف,التصنيف,الوحدة,سعر الشراء,سعر البيع,الكمية'

describe('PR-012 — malformed files: honest per-row verdicts', () => {
  test('BOM + Arabic digits + «،» decimals + currency noise + ragged row + duplicate', async () => {
    const { business, user } = await shop()
    const file =
      '\uFEFF' + HDR + '\n' +
      'شاي العروسة ٢٥٠ جرام,مشروبات,كيس,10٫5,15 جنيه,100\n' + // Arabic digits + «،» decimal + currency
      'حليب نيدو,ألبان,علبة,25,30\n' + // ragged row (missing stock)
      'شاي العروسة 250 جرام,مشروبات,كيس,10.5,15,90\n' + // duplicate within file (digit folding)
      'تفاح سالب,فواكه,كجم,-5,8,10\n' + // negative cost
      'زيت بدون سعر,زيتات,كرتون,,,5\n' // no price at all
    const res = await post({ action: 'dry-run', file, fileName: 'bad.xlsx' }, business.id, user.id)
    expect(res.status).toBe(201)
    const rep = (await res.json()) as {
      created: number; updated: number; skipped: number; errors: number
      rows: Array<{ row: number; status: string; name: string | null; reason?: string }>
    }
    expect(rep.created).toBe(2) // الشاي (first occurrence) + حليب نيدو (ragged but valid: stock defaults to 0)
    expect(rep.errors).toBe(2) // negative price + no price
    expect(rep.skipped).toBe(1) // the in-file duplicate
    const byRow = new Map(rep.rows.map((r) => [r.row, r]))
    expect(byRow.get(2)!.status).toBe('create')
    expect(byRow.get(4)!.status).toBe('skip')
    expect(byRow.get(4)!.reason).toContain('مكرر')
    expect(byRow.get(5)!.status).toBe('error')
    expect(byRow.get(5)!.reason).toContain('سالب')
    expect(byRow.get(6)!.status).toBe('error')
    expect(byRow.get(6)!.reason).toContain('مفيش سعر')
    // zero writes
    expect(await db.item.count({ where: { businessId: business.id } })).toBe(0)
  })

  test('header-only file and unknown headers are reported, not guessed', async () => {
    const { business, user } = await shop()
    const r1 = await post({ action: 'dry-run', file: HDR }, business.id, user.id)
    expect(r1.status).toBe(400)
    const r2 = await post({ action: 'dry-run', file: HDR + ',عمود غريب\nصنف1,منوع,قطعة,10,12,5\nعمود,غريب' }, business.id, user.id)
    expect(r2.status).toBe(201)
    const rep2 = (await r2.json()) as { unknownHeaders: string[] }
    expect(rep2.unknownHeaders.some((h) => h.includes('عمود غريب'))).toBe(true)
  })
})

describe('PR-012 — dry-run: field-level diffs, zero writes', () => {
  test('an existing item with a new price produces a DIFF, not a clobber', async () => {
    const { business, user } = await shop()
    await db.item.create({
      data: { businessId: business.id, name: 'سكر 5 كجم', category: 'أساسيات', unit: 'كيس', costPrice: 3000, sellPrice: 3500, stockQty: 40, lowStockThreshold: 5 },
    })
    const file = HDR + '\nسكر 5 كجم,أساسيات,كيس,30,40,40'
    const res = await post({ action: 'dry-run', file }, business.id, user.id)
    expect(res.status).toBe(201)
    const rep = (await res.json()) as {
      updated: number
      created: number
      rows: Array<{ status: string; diff?: Record<string, { from: number; to: number }> }>
    }
    expect(rep.updated).toBe(1)
    expect(rep.created).toBe(0)
    const row = rep.rows[0]
    expect(row.diff).toBeTruthy()
    expect(row.diff!.sellPrice).toEqual({ from: 3500, to: 4000 })
    // unchanged fields are NOT in the diff
    expect(row.diff!.costPrice).toBeUndefined()
    const item = await db.item.findFirstOrThrow({ where: { businessId: business.id } })
    expect(item.sellPrice).toBe(3500)
  })
})

describe('PR-012 — apply: bound to the preview, owner-acknowledged', () => {
  async function preview(businessId: string, userId: string, file: string) {
    const res = await post({ action: 'dry-run', file }, businessId, userId)
    expect(res.status).toBe(201)
    return (await res.json()) as { reportId: string; contentHash: string; created: number; updated: number }
  }

  test('apply refuses a tampered contentHash and a missing acknowledgement', async () => {
    const { business, user } = await shop()
    const p = await preview(business.id, user.id, HDR + '\nقهوة محوجة,مشروبات,كيس,80,120,10')
    const tampered = await post({ action: 'apply', reportId: p.reportId, contentHash: 'f'.repeat(64), acknowledge: true }, business.id, user.id)
    expect(tampered.status).toBe(409)
    const noAck = await post({ action: 'apply', reportId: p.reportId, contentHash: p.contentHash, acknowledge: false }, business.id, user.id)
    expect(noAck.status).toBe(403)
    expect(await db.item.count({ where: { businessId: business.id } })).toBe(0)
  })

  test('apply with the exact preview writes, then READS BACK every row', async () => {
    const { business, user } = await shop()
    await db.item.create({
      data: { businessId: business.id, name: 'أرز 10 كجم', category: 'أساسيات', unit: 'كيس', costPrice: 12000, sellPrice: 14000, stockQty: 20, lowStockThreshold: 3 },
    })
    const p = await preview(
      business.id, user.id,
      HDR + '\nأرز 10 كجم,أساسيات,كيس,120,150,25\nزيت عباد 1.5,زيتات,زجاجة,60,85,30',
    )
    expect(p.created).toBe(1)
    expect(p.updated).toBe(1)

    const res = await post({ action: 'apply', reportId: p.reportId, contentHash: p.contentHash, acknowledge: true }, business.id, user.id)
    expect(res.status).toBe(200)
    const out = (await res.json()) as { status: string; readback: { verified: number; mismatched: number; details: number[] } }
    expect(out.status).toBe('APPLIED')
    expect(out.readback.verified).toBe(2)
    expect(out.readback.mismatched).toBe(0)

    // the DB really holds the source values (independent re-read):
    const rice = await db.item.findFirstOrThrow({ where: { businessId: business.id, name: 'أرز 10 كجم' } })
    expect(rice.sellPrice).toBe(15000)
    expect(rice.stockQty).toBe(25)
    expect(await db.item.findFirst({ where: { businessId: business.id, name: 'زيت عباد 1.5' } })).not.toBeNull()

    // applying the same report again is refused (it is no longer DRAFT):
    const again = await post({ action: 'apply', reportId: p.reportId, contentHash: p.contentHash, acknowledge: true }, business.id, user.id)
    expect(again.status).toBe(409)

    // cross-tenant: another business cannot apply someone else's report:
    const other = await shop()
    const stolen = await post({ action: 'apply', reportId: p.reportId, contentHash: p.contentHash, acknowledge: true }, other.business.id, other.user.id)
    expect(stolen.status).toBe(404)
  })
})

describe('PR-012 — connector contract (§10.3) with a COMPUTED state', () => {
  test('NOT_CONFIGURED → PENDING_APPROVAL → CONNECTED, each from verified facts', async () => {
    const { business, user } = await shop()
    const connector = async () => {
      const res = await post({ action: 'connector' }, business.id, user.id)
      expect(res.status).toBe(200)
      return (await res.json()) as { manifest: { connectionState: string; health: string; lastVerifiedAt: string | null; testEvidence: object; capabilities: string[] } ; plannedLevels: Array<{ level: string; state: string }> }
    }

    const before = await connector()
    expect(before.manifest.connectionState).toBe('NOT_CONFIGURED')
    expect(before.manifest.lastVerifiedAt).toBeNull()

    // a dry-run verifies the READ side → pending approval
    const dry = await post({ action: 'dry-run', file: HDR + '\nملح 1 كجم,أساسيات,كيس,5,10,50' }, business.id, user.id)
    expect(dry.status).toBe(201)
    const mid = await connector()
    expect(mid.manifest.connectionState).toBe('CONNECTED_WRITE_PENDING_APPROVAL')

    // approved apply with a clean read-back → CONNECTED
    const rep = (await dry.json()) as { reportId: string; contentHash: string }
    const applied = await post({ action: 'apply', reportId: rep.reportId, contentHash: rep.contentHash, acknowledge: true }, business.id, user.id)
    expect(applied.status).toBe(200)
    const after = await connector()
    expect(after.manifest.connectionState).toBe('CONNECTED')
    expect(after.manifest.health).toBe('ok')
    expect(after.manifest.lastVerifiedAt).not.toBeNull()

    // the full §10.3 manifest fields exist:
    const m = after.manifest as unknown as Record<string, unknown>
    for (const f of ['provider', 'app', 'version', 'environment', 'capabilities', 'readScopes', 'writeScopes', 'health', 'lastVerifiedAt', 'connectionState', 'dataMapping', 'idempotency', 'reconciliation', 'limits', 'approvalPolicy', 'disconnect', 'testEvidence']) {
      expect(m[f], `manifest missing ${f}`).toBeDefined()
    }

    // unimplemented levels are honest: NOT_CONFIGURED, never implied
    const levels = new Map(before.plannedLevels.map((l) => [l.level, l.state]))
    expect(levels.get('B')).toBe('NOT_CONFIGURED')
    expect(levels.get('E')).toBe('NOT_CONFIGURED')
  })
})
