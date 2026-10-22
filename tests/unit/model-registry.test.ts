// وكيل — PR-013 (plan v2 §11): model registry, routing policy, cost, and the
// acceptance harness. Acceptance from the plan:
//   «أرخص موديل ناجح مثبت بالـeval» — not price alone
//   «حسابات المال…: كود حتمي وليس الموديل مهما كان أقوى»
//   «model:acceptance ينجح من بيئة credentials/شبكة صالحة ويختبر model ID
//     الفعلي لا mock» — a mock run is stamped liveAcceptance:false
import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import {
  candidatesForModelKey,
  estimateCostUsd,
  FALLBACK_LADDERS,
  getRegistryModel,
  promoteModel,
  REGISTRY,
  selectForIntent,
} from '@/lib/agent/model-registry'

const MOCK_URL = 'http://127.0.0.1:3031/v1'

function mockAlive(): boolean {
  try {
    execFileSync('curl', ['-s', '--max-time', '2', `${MOCK_URL.replace('/v1', '')}/health`])
    return true
  } catch {
    return false
  }
}

describe('PR-013 — ladders are data and behaviour-preserving', () => {
  test('candidatesForModelKey is byte-identical to the old hard-coded lists', () => {
    // deep UI keys
    expect(candidatesForModelKey('gemini-pro')).toEqual(['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-flash'])
    expect(candidatesForModelKey('builtin-deep')).toEqual(['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-flash'])
    // air
    expect(candidatesForModelKey('builtin-air')).toEqual(['gemini-3.1-flash-lite-preview', 'gemini-3-flash-preview', 'gemini-2.5-flash'])
    // balanced / auto
    expect(candidatesForModelKey('auto')).toEqual(['gemini-3-flash-preview', 'gemini-2.5-flash'])
    expect(candidatesForModelKey(undefined)).toEqual(['gemini-3-flash-preview', 'gemini-2.5-flash'])
  })
})

describe('PR-013 — routing policy', () => {
  test('deterministic money math is NEVER a model job', () => {
    const d = selectForIntent('deterministic')
    expect(d.modelId).toBeNull()
    expect(d.ladder).toEqual([])
    expect(d.reason).toContain('حتمي')
  })

  test('intents map to the right tier; the cheapest passing model wins', () => {
    const air = selectForIntent('fast_text')
    expect(air.modelId).toBe('gemini-3.1-flash-lite-preview') // cheapest deployed air
    const ctx = selectForIntent('context')
    expect(ctx.modelId).toBe('gemini-3-flash-preview')
    const deep = selectForIntent('deep')
    expect(deep.modelId).toBe('gemini-3.1-pro-preview')
    // plan candidates are present but NOT yet promoted (no live eval passed)
    expect(getRegistryModel('gemini-3.5-flash-lite')!.status).toBe('candidate')
    expect(air.ladder).not.toContain('gemini-3.5-flash-lite')
  })

  test('a candidate only enters routing after its eval passes (promotion)', () => {
    // run LAST: promotion mutates the in-process registry. A promoted
    // candidate PREPENDS its ladder (the deployed order is a quality
    // decision — 2.5-flash is a last-resort rung, not price-sorted).
    promoteModel('gemini-3.5-flash-lite', { suite: 'tests/live/flash-lite-eval', at: '2026-10-20', sha: 'abcdef123456' })
    const air = selectForIntent('fast_text')
    expect(air.modelId).toBe('gemini-3.5-flash-lite')
    expect(air.ladder[0]).toBe('gemini-3.5-flash-lite')
    expect(air.ladder).toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite-preview', 'gemini-3-flash-preview', 'gemini-2.5-flash'])
    // promoting a deployed model is refused
    expect(() => promoteModel('gemini-2.5-flash', { suite: 'x', at: 'now' })).toThrow()
    // and the ladder now carries it (order: cheapest-first among passing candidates, then deployed)
    expect(FALLBACK_LADDERS.air).toContain('gemini-3.1-flash-lite-preview')
  })
})

describe('PR-013 — cost accounting', () => {
  test('estimateCostUsd computes tokens (and live-audio minutes when applicable)', () => {
    // 1M in + 1M out of 3.8-flash candidate = 0.75 + 3.75
    expect(estimateCostUsd('gemini-3.8-flash', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(4.5, 5)
    // the plan's worked example: 1000 tasks × (1500 in / 300 out) at flash-lite
    const perTask = estimateCostUsd('gemini-3.1-flash-lite', { inputTokens: 1_500, outputTokens: 300 })
    expect(perTask * 1000).toBeCloseTo(0.825, 3)
    // live model: per-minute billing
    const live = estimateCostUsd('gemini-3.8-live', { inputTokens: 0, outputTokens: 0, audioMinutesIn: 10, audioMinutesOut: 10 })
    expect(live).toBeCloseTo(10 * 0.005 + 10 * 0.018, 5)
    expect(() => estimateCostUsd('nope', { inputTokens: 1, outputTokens: 1 })).toThrow()
  })
})

describe('PR-013 — model:acceptance harness', () => {
  test('runs against the mock: adapter contract proven, liveAcceptance stamped false', async () => {
    if (!mockAlive()) {
      // honest skip-reason: the mock is not running in this environment
      throw new Error('الموك مش شغال على :3031 — شغّل mini-services/mock-provider')
    }
    const reportPath = join(process.cwd(), '.tmp-acceptance-report.json')
    try {
      const out = execFileSync(
        process.execPath,
        ['scripts/model-acceptance.mjs', '--report', reportPath],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            WAKIL_ACCEPTANCE_BASE_URL: MOCK_URL,
            WAKIL_ACCEPTANCE_MODELS: 'wakil-mock-flash',
          },
          encoding: 'utf8',
          timeout: 60_000,
        },
      )
      const report = JSON.parse(out)
      expect(report.environment).toBe('mock')
      expect(report.liveAcceptance).toBe(false) // a mock run is NEVER a live acceptance
      const checks = new Map(report.results[0].checks.map((c: { id: string; pass: boolean }) => [c.id, c.pass]))
      // the adapter contract is proven on the mock:
      expect(checks.get('A1')).toBe(true) // reachable, model id accepted
      const a3 = report.results[0].checks.find((c: { id: string; pass: boolean; detail?: string }) => c.id === 'A3')
      if (a3?.pass !== true) {
        throw new Error(`A3 adapter contract failed: ${a3?.detail ?? 'missing A3 result'}`)
      }
      expect(checks.get('A3'), report.results[0].checks.find((c: { id: string }) => c.id === 'A3')?.detail ?? 'A3 missing from report').toBe(true) // tool calling round-trip
      const a4 = report.results[0].checks.find((c: { id: string; pass: boolean; detail?: string }) => c.id === 'A4')
      expect(a4?.pass, `A4 adapter contract failed: ${a4?.detail ?? 'missing A4 result'}`).toBe(true) // no write tool call
      expect(checks.get('A5')).toBe(true) // latency + cost measured
      // A2 (marker echo) is a LIVE-model behaviour — the mock is not a model,
      // so it is allowed to fail here and must be re-checked on a live run.
      expect(report.results[0].checks.length).toBeGreaterThanOrEqual(5)
    } finally {
      if (existsSync(reportPath)) rmSync(reportPath)
    }
  }, 90_000)
})
