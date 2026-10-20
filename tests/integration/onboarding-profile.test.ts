// R75 / PR-007 — الخطة النهائية v2 §7.1 + PR table: onboarding state machine.
//
// Gates accepted here:
//   • NO financial fact is assumed in the initial profile (skip ⇒ unknown,
//     never 0-as-fact; a stated opening cash becomes the ledger fact);
//   • NO duplicated question: an answered question leaves `pending` for good;
//   • NO missing field: pending is exactly the required-unanswered set;
//   • consent is recorded and ENFORCED by the import route (403 without it);
//   • the stage machine (not_started → interviewing → proposed → confirmed)
//     with a review/correct step and idempotent confirm;
//   • zero cross-tenant via the real guard.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import type { Business, User } from '@prisma/client'
import { testDb } from '../helpers/test-db'
import { resetRateLimiter } from '@/lib/security/rateLimit'
import {
  answerProfile, confirmProfile, getProfileState, hasConsent,
  profileQuestionsFor, setProfileConsent,
} from '@/lib/domain/onboarding-profile'
import { GET as getProfile, POST as answerProfileApi } from '@/app/api/onboarding/profile/route'
import { POST as consentApi } from '@/app/api/onboarding/profile/consent/route'
import { POST as confirmApi } from '@/app/api/onboarding/profile/confirm/route'
import { POST as importItems } from '@/app/api/items/import/route'

const original = { ...process.env }
const token = 'onboarding-profile-test-token-never-real'.repeat(2)
let db: Awaited<ReturnType<typeof testDb>>
let business: Business
let other: Business
let owner: User
let outsider: User

function configure(user: User) {
  Object.assign(process.env, {
    NODE_ENV: 'production',
    WAKIL_OFFLINE: '1',
    WAKIL_AUTH_CREDENTIALS: JSON.stringify([
      { userId: user.id, tokenHash: createHash('sha256').update(token).digest('hex') },
    ]),
  })
}
function req(path: string, method = 'GET', body?: unknown) {
  return new NextRequest(`http://test${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

beforeAll(async () => {
  db = await testDb()
  business = await db.business.create({ data: { name: randomUUID(), type: 'supermarket' } })
  other = await db.business.create({ data: { name: randomUUID(), type: 'tools' } })
  owner = await db.user.create({ data: { businessId: business.id, name: 'owner', role: 'owner' } })
  outsider = await db.user.create({ data: { businessId: other.id, name: 'outsider', role: 'owner' } })
  configure(owner)
})
afterEach(() => {
  for (const key of ['NODE_ENV', 'WAKIL_AUTH_CREDENTIALS', 'WAKIL_OFFLINE']) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
  resetRateLimiter()
})
afterAll(async () => {
  await db.business.deleteMany({ where: { id: { in: [business.id, other.id] } } })
  await db.$disconnect?.()
})

const ALL_REQUIRED = () => profileQuestionsFor('supermarket').filter((q) => q.required).map((q) => q.key)

describe('initial profile — no financial fact is assumed', () => {
  test('a fresh business has an empty profile: no answers, no consent, opening cash unstated', async () => {
    const state = await getProfileState(business.id)
    expect(state.stage).toBe('not_started')
    expect(Object.keys(state.answers)).toEqual([])
    expect(Object.keys(state.consents)).toEqual([])
    expect(state.openingCashStatedAt).toBeNull()
    // the ledger's opening cash is 0 BY DEFAULT — but it is NOT a stated fact
    expect((await db.business.findUniqueOrThrow({ where: { id: business.id } })).openingCash).toBe(0)
  })

  test('no missing field: pending is exactly the required-unanswered set, in interview order', async () => {
    const state = await getProfileState(business.id)
    expect(state.pending).toEqual(ALL_REQUIRED())
    expect(state.questions.map((q) => q.key)).toContain('recordedHow')
  })
})

describe('interview — one question at a time, never re-asked', () => {
  test('answering removes the question from pending for good', async () => {
    let s = await answerProfile(business.id, 'recordedHow', 'ورقة وقلم')
    expect(s.stage).toBe('interviewing')
    expect(s.pending).not.toContain('recordedHow')
    expect(s.answers['recordedHow'].value).toBe('ورقة وقلم')
    expect(s.answers['recordedHow'].skipped).toBe(false)
    expect(s.answers['recordedHow'].source).toBe('owner')
    // a second read (refresh) never re-asks it
    const again = await getProfileState(business.id)
    expect(again.pending).not.toContain('recordedHow')
  })

  test('a skipped financial fact stays UNKNOWN — not 0, not a guess', async () => {
    const s = await answerProfile(business.id, 'openingCash', null, { skip: true })
    expect(s.answers['openingCash'].skipped).toBe(true)
    expect(s.answers['openingCash'].value).toBeNull()
    expect(s.openingCashStatedAt).toBeNull()
    const b = await db.business.findUniqueOrThrow({ where: { id: business.id } })
    expect(b.openingCash).toBe(0) // default, but unstated
  })

  test('a stated opening cash becomes the ledger fact (piastres) + is marked stated', async () => {
    const s = await answerProfile(business.id, 'openingCash', 1500)
    expect(s.answers['openingCash'].value).toBe(1500)
    expect(s.answers['openingCash'].skipped).toBe(false)
    expect(s.openingCashStatedAt).toBeTruthy()
    const b = await db.business.findUniqueOrThrow({ where: { id: business.id } })
    expect(b.openingCash).toBe(150000) // piastres
  })

  test('a correction overwrites and is marked corrected', async () => {
    const s = await answerProfile(business.id, 'openingCash', 2000)
    expect(s.answers['openingCash'].corrected).toBe(true)
    expect((await db.business.findUniqueOrThrow({ where: { id: business.id } })).openingCash).toBe(200000)
  })

  test('unknown question keys and negative money are refused', async () => {
    await expect(answerProfile(business.id, 'hackTheBank', 1)).rejects.toThrow()
    await expect(answerProfile(business.id, 'openingCash', -5)).rejects.toThrow()
  })

  test('answering every required question lands the profile at proposed', async () => {
    for (const key of ALL_REQUIRED()) {
      if (key === 'recordedHow') continue // already answered
      if (key === 'openingCash') continue // already answered
      const q = profileQuestionsFor('supermarket').find((x) => x.key === key)!
      if (q.key === 'units') {
        await answerProfile(business.id, 'units', 'قطعة، كيلو')
      } else {
        await answerProfile(business.id, key, q.choices ? q.choices[0] : 'مظبوط')
      }
    }
    const s = await getProfileState(business.id)
    expect(s.pending).toEqual([])
    expect(s.stage).toBe('proposed')
  })
})

describe('stage machine + review', () => {
  test('confirm before everything is answered is refused; after, it is idempotent', async () => {
    // business `other` (tools) is still not_started
    await expect(confirmProfile(other.id)).rejects.toThrow()
    const s1 = await confirmProfile(business.id)
    expect(s1.stage).toBe('confirmed')
    const s2 = await confirmProfile(business.id)
    expect(s2.stage).toBe('confirmed') // idempotent
  })
})

describe('consents — recorded and enforced by the import route', () => {
  test('no consent on file ⇒ import refused with a clear 403', async () => {
    await setProfileConsent(other.id, 'importFromFiles', false)
    expect(await hasConsent(other.id, 'importFromFiles')).toBe(false)
    configure(outsider)
    const res = await importItems(req('/api/items/import', 'POST', {
      businessId: other.id, userId: outsider.id, csv: 'اسم الصنف,سعر البيع\nمثقاب,900',
    }))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('موافقتك')
  })

  test('granted consent allows the import; revoking it blocks again', async () => {
    await setProfileConsent(other.id, 'importFromFiles', true)
    expect(await hasConsent(other.id, 'importFromFiles')).toBe(true)
    configure(outsider)
    const ok = await importItems(req('/api/items/import', 'POST', {
      businessId: other.id, userId: outsider.id, csv: 'اسم الصنف,سعر البيع\nمثقاب,900',
    }))
    expect(ok.status).toBe(200)
    const created = (await ok.json()) as { created: number }
    expect(created.created).toBeGreaterThanOrEqual(1)

    await setProfileConsent(other.id, 'importFromFiles', false)
    const blocked = await importItems(req('/api/items/import', 'POST', {
      businessId: other.id, userId: outsider.id, csv: 'اسم الصنف,سعر البيع\nمكينة,500',
    }))
    expect(blocked.status).toBe(403)
  })

  test('an unknown consent key is refused through the API', async () => {
    configure(owner)
    const res = await consentApi(req('/api/onboarding/profile/consent', 'POST', {
      businessId: business.id, userId: owner.id, key: 'grantAdminRights', granted: true,
    }))
    expect(res.status).toBe(400)
  })
})

describe('API surface (guard + tenant scope)', () => {
  test('GET/POST profile work through the real guard', async () => {
    configure(owner)
    const res = await getProfile(req(`/api/onboarding/profile?businessId=${business.id}&userId=${owner.id}`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { stage: string; pending: string[] }
    expect(body.stage).toBe('confirmed')
    expect(body.pending).toEqual([])

    const post = await answerProfileApi(req('/api/onboarding/profile', 'POST', {
      businessId: business.id, userId: owner.id, key: 'paymentTerms', value: 'كاش',
    }))
    expect(post.status).toBe(200)
  })

  test('a user from another tenant cannot read or write this profile', async () => {
    configure(outsider)
    const read = await getProfile(req(`/api/onboarding/profile?businessId=${business.id}&userId=${outsider.id}`))
    expect([401, 403]).toContain(read.status)
    const write = await answerProfileApi(req('/api/onboarding/profile', 'POST', {
      businessId: business.id, userId: outsider.id, key: 'mainPain', value: 'spy',
    }))
    expect([401, 403]).toContain(write.status)
  })
})
