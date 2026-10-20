// وكيل — R69: per-system contract coherence.
//
// The system registry (src/lib/agent/system-contracts.ts) is the «the catalog
// can never lie» gate one level above R64: every tool the model can call must
// have exactly ONE responsible system, every write tool must sit under a
// system whose risk ceiling covers it, and every system must carry a real
// contract (role, failure modes, gate) — no empty shells.
import { describe, expect, test } from 'bun:test'
import { brainToolDescriptions, brainToolCount } from '@/lib/agent/tool-schemas'
import { WRITE_TOOL_MAP } from '@/lib/agent/registry'
import { SYSTEMS, contractProblems, contractToolNames, systemMapLine, type SystemContract } from '@/lib/agent/system-contracts'

const riskRank = (r: SystemContract['risk']) => ({ R0: 0, R1: 1, R2: 2, R3: 3 })[r]

describe('system contracts (R69)', () => {
  test('bidirectional coverage: every SPECS tool has exactly one system', () => {
    const problems = contractProblems()
    expect(problems).toEqual([])
    const names = contractToolNames()
    expect(new Set(names).size).toBe(names.length) // no tool in two systems
    expect(names.length).toBe(brainToolCount())
  })

  test('every write tool sits in a system with risk ≥ R2', () => {
    const byTool = new Map<string, SystemContract>()
    for (const s of SYSTEMS) for (const t of s.tools) byTool.set(t, s)
    for (const t of Object.keys(WRITE_TOOL_MAP)) {
      const s = byTool.get(t)
      expect(s).toBeDefined()
      expect(riskRank(s!.risk)).toBeGreaterThanOrEqual(2)
    }
  })

  test('the R3 ceiling is real: sensitive + desktop systems drive R3 ops', () => {
    const ids = new Set(SYSTEMS.filter((s) => s.risk === 'R3').map((s) => s.id))
    expect(ids.has('sensitive')).toBe(true)
    expect(ids.has('desktop')).toBe(true)
  })

  test('every system carries a complete contract (no empty shells)', () => {
    for (const s of SYSTEMS) {
      expect(s.labelAr.length).toBeGreaterThan(2)
      expect(s.roleAr.length).toBeGreaterThan(10)
      expect(s.failureModes.length).toBeGreaterThanOrEqual(1)
      expect(s.gateAr.length).toBeGreaterThan(5)
      expect(s.tools.length).toBeGreaterThanOrEqual(1)
    }
  })

  test('the prompt map line names every system exactly once', () => {
    const line = systemMapLine()
    for (const s of SYSTEMS) {
      expect(line).toContain(`${s.labelAr} (${s.risk})`)
    }
    expect(line.split(' · ').length).toBe(SYSTEMS.length)
  })

  test('contracts cover the full brain surface (72 tools at R69 baseline)', () => {
    // R64 baseline: 72 tools. If this grows, the coverage test above forces
    // the new tool to be claimed by a system in the same change.
    expect(brainToolCount()).toBeGreaterThanOrEqual(72)
    expect(Object.keys(brainToolDescriptions()).length).toBe(brainToolCount())
  })
})
