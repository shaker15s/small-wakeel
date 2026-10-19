import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import {
  parseSkillMd,
  locateSkillMd,
  execHarness,
  registerHarness,
  learnedHarnesses,
  readFileBounded,
  type SkillMd,
} from '@/lib/agent/cli-anything/harness-installer'
import { db } from '@/lib/db'

/**
 * R46 Mode 2 — harness-installer: the REAL CLI-Anything integration surface.
 * Contract under test:
 *  • SKILL.md parsing extracts the executable command surface (lenient on format)
 *  • everything fails CLOSED with an honest status (no fabricated success)
 *  • registered harnesses persist per-business and load back cleanly
 */

// A realistic CLI-Anything SKILL.md (github.com/HKUDS/CLI-Anything style)
const SAMPLE_SKILL = `# Zotero CLI (cli-anything-zotero)

Manage your Zotero library from the command line.

## Commands

\`\`\`
cli-anything-zotero note list --json
cli-anything-zotero note add --title "X" --json
cli-anything-zotero collection create "Books" --json
cli-anything-zotero item search --query "AI" --json
\`\`\`

## State
Uses a local cache at ~/.cli-anything/zotero/state.json
`

describe('harness-installer — parseSkillMd', () => {
  it('extracts the executable command surface from a real SKILL.md', () => {
    const skill: SkillMd = parseSkillMd(SAMPLE_SKILL, 'zotero')
    expect(skill.app).toBe('zotero')
    expect(skill.commands.length).toBeGreaterThanOrEqual(3)
    expect(skill.commands.some((c) => c.command.startsWith('cli-anything-zotero note'))).toBe(true)
    expect(skill.commands.some((c) => c.command.includes('collection'))).toBe(true)
  })

  it('falls back to line-based extraction when the regex finds nothing', () => {
    const raw = ['```bash', 'cli-anything-daftra invoice list', 'cli-anything-daftra payment collect', '```'].join('\n')
    const skill = parseSkillMd(raw, 'daftra')
    expect(skill.commands.length).toBeGreaterThanOrEqual(2)
    expect(skill.commands[0].command).toContain('cli-anything-daftra')
  })

  it('never crashes on empty/garbage input', () => {
    const skill = parseSkillMd('no commands here', 'x')
    expect(skill.commands).toEqual([])
    expect(skill.app).toBe('x')
  })
})

describe('harness-installer — fail-closed execution', () => {
  it('execHarness reports failure honestly for a missing binary', async () => {
    const r = await execHarness(
      { command: 'definitely-not-a-real-binary-wkl-test', argsTemplate: '--json {args}' },
      'ghost',
      'list',
    )
    expect(r.ok).toBe(false)
    expect(r.raw.length).toBeGreaterThan(0)
  })

  it('locateSkillMd returns null when nothing is installed', () => {
    expect(locateSkillMd('cli-anything-ghostapp-wkl-test')).toBeNull()
  })
})

describe('harness-installer — persistence round-trip', () => {
  let businessId: string
  let userId: string
  const APP = 'wkl_test_harness_app'

  beforeAll(async () => {
    const biz = await db.business.create({ data: { name: 'R46 harness test biz', type: 'supermarket' } })
    businessId = biz.id
    const u = await db.user.create({ data: { businessId, name: 'Tamer T', role: 'owner' } })
    userId = u.id
  })

  afterAll(async () => {
    if (businessId) await db.business.deleteMany({ where: { id: businessId } })
  })

  it('registerHarness upserts idempotently and loads back the same surface', async () => {
    const skill = parseSkillMd(SAMPLE_SKILL, APP)
    const r1 = await registerHarness({
      businessId,
      userId,
      app: APP,
      display: 'تطبيق اختبار',
      source: 'prebuilt',
      skill,
    })
    expect(r1.ok).toBe(true)

    // second registration = update, not duplicate
    const r2 = await registerHarness({
      businessId,
      userId,
      app: APP,
      display: 'تطبيق اختبار 2',
      source: 'generated',
      skill,
    })
    expect(r2.ok).toBe(true)

    const loaded = await learnedHarnesses(businessId)
    expect(loaded.length).toBe(1)
    expect(loaded[0].app).toBe(APP)
    expect(loaded[0].source).toBe('generated')
    expect(loaded[0].display).toBe('تطبيق اختبار 2')
    expect(loaded[0].commands.length).toBe(skill.commands.length)
    expect(loaded[0].argsTemplate).toBe('--json {args}')
  })

  it('other businesses see nothing (per-business isolation)', async () => {
    const other = await db.business.create({ data: { name: 'R46 other biz', type: 'gym' } })
    try {
      const loaded = await learnedHarnesses(other.id)
      expect(loaded.length).toBe(0)
    } finally {
      await db.business.deleteMany({ where: { id: other.id } })
    }
  })
})

describe('harness-installer — readFileBounded', () => {
  it('reads a real file bounded', async () => {
    const r = await readFileBounded('package.json', 500)
    expect(r.length).toBeLessThanOrEqual(500)
    expect(r.length).toBeGreaterThan(0)
  })
})
