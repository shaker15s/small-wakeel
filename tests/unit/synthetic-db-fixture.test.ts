import { describe, expect, test } from 'bun:test'
import { syntheticFixtureSafetyViolations } from '../../scripts/lib/synthetic-db-fixture.mjs'

const safe = {
  tracked: true,
  regularFile: true,
  symlink: false,
  workingTreeMatchesHead: true,
  indexMatchesHead: true,
  sidecars: [],
}

describe('synthetic SQLite fixture safety', () => {
  test('accepts only an unchanged, tracked regular fixture without active sidecars', () => {
    expect(syntheticFixtureSafetyViolations(safe)).toEqual([])
  })

  test('rejects modified, staged, missing, untracked or symlinked local databases', () => {
    expect(syntheticFixtureSafetyViolations({ ...safe, workingTreeMatchesHead: false }).join(' ')).toMatch(/differs from HEAD/)
    expect(syntheticFixtureSafetyViolations({ ...safe, indexMatchesHead: false }).join(' ')).toMatch(/staged/)
    expect(syntheticFixtureSafetyViolations({ ...safe, tracked: false }).join(' ')).toMatch(/not tracked/)
    expect(syntheticFixtureSafetyViolations({ ...safe, regularFile: false }).join(' ')).toMatch(/regular file/)
    expect(syntheticFixtureSafetyViolations({ ...safe, symlink: true }).join(' ')).toMatch(/symlink/)
  })

  test('rejects non-empty or symlinked SQLite sidecars instead of copying an active DB', () => {
    expect(syntheticFixtureSafetyViolations({ ...safe, sidecars: [{ name: '-wal', size: 24, symlink: false }] }).join(' ')).toMatch(/non-empty/)
    expect(syntheticFixtureSafetyViolations({ ...safe, sidecars: [{ name: '-journal', size: 0, symlink: true }] }).join(' ')).toMatch(/sidecar.*symlink/)
  })
})
