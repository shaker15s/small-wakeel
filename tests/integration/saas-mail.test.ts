import { expect, test } from 'bun:test'
test('mail worker lifecycle uses isolated DB and a stub transport, never real email', async () => {
  const child = Bun.spawn(['bun', 'tests/helpers/mail-scenario.ts'], { stdout: 'pipe', stderr: 'pipe' })
  const [exit, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (exit) throw new Error(output + errors)
  expect(output).toContain('PASS: isolated encrypted mail outbox')
}, 20_000)
