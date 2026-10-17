// وكيل — «تأمل وكيل» confidence arithmetic.
//
// The confidence number is shown to the owner on the draft card, so it must be
// deterministic and monotonically worse as findings get heavier — never a
// model-generated vibe.
import { describe, expect, test } from 'bun:test'
import { scoreAudit } from '../../src/lib/domain/audit'
import type { AuditFinding } from '../../src/lib/domain/audit'

const f = (severity: AuditFinding['severity'], code: AuditFinding['code']): AuditFinding => ({
  code,
  severity,
  message: 'ملاحظة',
})

describe('audit.scoreAudit', () => {
  test('a clean draft is fully trusted but never claims 100+', () => {
    expect(scoreAudit([])).toBe(100)
  })

  test('worse findings cost strictly more', () => {
    const info = scoreAudit([f('info', 'unknown_entity')])
    const warn = scoreAudit([f('warn', 'price_anomaly')])
    const danger = scoreAudit([f('danger', 'oversell')])
    expect(info).toBeGreaterThan(warn)
    expect(warn).toBeGreaterThan(danger)
  })

  test('penalties stack', () => {
    const one = scoreAudit([f('warn', 'duplicate')])
    const two = scoreAudit([f('warn', 'duplicate'), f('warn', 'price_anomaly')])
    expect(two).toBeLessThan(one)
  })

  test('the score never collapses below the floor (a flagged draft is still approvable)', () => {
    const many = scoreAudit([
      f('danger', 'oversell'),
      f('danger', 'price_anomaly'),
      f('danger', 'duplicate'),
      f('danger', 'overpay'),
      f('danger', 'expense_spike'),
      f('danger', 'unknown_entity'),
    ])
    expect(many).toBeGreaterThanOrEqual(20)
    expect(many).toBeLessThan(40)
  })

  test('is deterministic for the same input', () => {
    const input = [f('warn', 'oversell'), f('info', 'duplicate')]
    expect(scoreAudit(input)).toBe(scoreAudit(input))
  })
})
