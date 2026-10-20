// R74 / PR-006 — الخطة النهائية v2 §0: ALL 10 sectors from the first
// commercial release. «تعريف وقدرات كل قطاع معلنة ومختبرة»:
//
//   • every preset sector has a COMPLETE, non-empty definition;
//   • every CAPABILITY a sector declares is a REAL registered tool
//     (declared = executable; the registry is the single source of truth);
//   • every sector carries a curated playbook + a UI label;
//   • the 10th sector «أدوات ومعدات» (tools) is present and complete.
import { describe, expect, test } from 'bun:test'
import { VERTICALS, getVertical } from '@/lib/verticals'
import { TOOL_NAME_SET } from '@/lib/agent/tool-schemas'
import { BUSINESS_PLAYBOOKS } from '@/lib/agent/business-knowledge'
import { VERTICAL_LABELS } from '@/lib/labels'
import type { PresetVertical } from '@/lib/types'

const PRESETS: PresetVertical[] = [
  'supermarket', 'gym', 'pharmacy', 'attar', 'restaurant',
  'clinic', 'electronics', 'wholesale', 'clothing', 'tools',
]

describe('sector contracts — 10 sectors, declared = executable', () => {
  test('exactly the 10 planned presets are defined', () => {
    const keys = Object.keys(VERTICALS)
    expect(keys.length).toBe(10)
    for (const p of PRESETS) expect(keys, `missing preset ${p}`).toContain(p)
  })

  test('every sector definition is complete and non-empty', () => {
    for (const key of Object.keys(VERTICALS)) {
      const v = VERTICALS[key as PresetVertical]
      expect(v.key).toBe(key)
      for (const field of ['label', 'shortLabel', 'description', 'welcome', 'headerLabel'] as const) {
        expect(String(v[field]).trim().length > 0, `${key}.${field} empty`).toBe(true)
      }
      expect(v.chips.length >= 3, `${key}.chips`).toBe(true)
      expect(v.examples.length >= 3, `${key}.examples`).toBe(true)
      expect(v.tools.length >= 5, `${key}.tools`).toBe(true)
      expect(v.units.length >= 2, `${key}.units`).toBe(true)
      expect(typeof v.features.expiry).toBe('boolean')
      expect(typeof v.features.grams).toBe('boolean')
      expect(typeof v.features.memberships).toBe('boolean')
      expect(typeof v.features.sessions).toBe('boolean')
      // no duplicate tool declarations
      expect(new Set(v.tools).size).toBe(v.tools.length)
    }
  })

  test('every declared capability is a REAL registered tool', () => {
    const problems: string[] = []
    for (const key of Object.keys(VERTICALS)) {
      for (const tool of VERTICALS[key as PresetVertical].tools) {
        if (!TOOL_NAME_SET.has(tool)) problems.push(`${key} declares unregistered tool ${tool}`)
      }
    }
    expect(problems).toEqual([])
  })

  test('every sector has a curated playbook and a UI label', () => {
    for (const key of Object.keys(VERTICALS)) {
      const pb = BUSINESS_PLAYBOOKS[key]
      expect(pb, `playbook missing for ${key}`).toBeTruthy()
      expect(pb.focus.trim().length > 0).toBe(true)
      expect(pb.workflow.trim().length > 0).toBe(true)
      expect(pb.gaps.trim().length > 0).toBe(true)
      expect(pb.sources.length >= 1).toBe(true)
      expect(String(VERTICAL_LABELS[key as PresetVertical] ?? '').trim().length > 0, `label missing for ${key}`).toBe(true)
    }
  })

  test('the 10th sector «أدوات ومعدات» is live end to end', () => {
    const v = getVertical('tools')
    expect(v.shortLabel).toBe('أدوات ومعدات')
    expect(v.icon).toBe('wrench')
    expect(v.units).toEqual(expect.arrayContaining(['piece', 'roll', 'meter']))
    expect(v.features.memberships).toBe(false)
    expect(v.features.expiry).toBe(false)
    // its money tools are the real registry ones
    for (const t of ['record_sale', 'record_purchase', 'record_stock_adjustment', 'record_expense']) {
      expect(v.tools).toContain(t)
    }
    expect(BUSINESS_PLAYBOOKS['tools']).toBeTruthy()
  })

  test('unknown business types still fall back safely', () => {
    expect(getVertical('supermarket').key).toBe('supermarket')
    expect(getVertical('custom:مقهى').key).toBe('custom:مقهى')
    expect(getVertical('').key).toBe('supermarket')
  })
})
