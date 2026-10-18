import { expect, test } from 'bun:test'
test('chat customization executes real scoped changes and capabilities; synthetic model boundary is isolated', async () => {
  const child = Bun.spawn(['bun', 'tests/helpers/workspace-scenario.ts'], { stdout: 'pipe', stderr: 'pipe' })
  const [exit, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (exit) throw new Error(output + errors)
  expect(output).toContain('PASS:')
}, 60_000)
test('production search never falls back to local synthetic results', async () => {
  const child = Bun.spawn(['bun', 'tests/helpers/search-scenario.ts'], { stdout: 'pipe', stderr: 'pipe' })
  const [exit, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (exit) throw new Error(output + errors)
  expect(output).toContain('PASS:')
})
