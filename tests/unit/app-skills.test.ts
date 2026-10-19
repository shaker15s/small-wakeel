// R45 — App Skills registry (CLI-Anything SKILL.md pattern): dialect-tolerant
// app resolution and the agent-readable spec block.
import { expect, test } from 'bun:test'
import { APP_SKILLS, skillForApp, appSkillsPromptBlock } from '@/lib/agent/cli-anything/app-skills'

test('skillForApp: Arabic dialect + English spellings all resolve', () => {
  expect(skillForApp('اكسيل')?.id).toBe('excel')
  expect(skillForApp('Excel')?.id).toBe('excel')
  expect(skillForApp('كسل')?.id).toBe('excel')
  expect(skillForApp('جداول')?.id).toBe('excel')
  expect(skillForApp('دفتره')?.id).toBe('daftra')
  expect(skillForApp('الامين')?.id).toBe('ameen')
  expect(skillForApp('كويك بوكس')?.id).toBe('quickbooks')
  expect(skillForApp('برنامج غريب ما حد يعرفه')).toBeNull()
})

test('excel skill is the only native (really drivable) engine', () => {
  const native = APP_SKILLS.filter((s) => s.status === 'native')
  expect(native.map((s) => s.id)).toEqual(['excel'])
  const excel = skillForApp('excel')!
  const commands = excel.commandGroups.flatMap((g) => g.commands.map((c) => c.name))
  expect(commands).toEqual(expect.arrayContaining(['list-recent', 'summary', 'read', 'write']))
})

test('prompt block: every app id + the JSON contract are visible to the brain', () => {
  const block = appSkillsPromptBlock()
  for (const sk of APP_SKILLS) expect(block).toContain(sk.id)
  expect(block).toContain('cli_control_app')
  expect(block).toContain('JSON')
})
