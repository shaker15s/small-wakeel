import { expect, test } from 'bun:test'
for (const mode of ['brain', 'gemini', 'sdk', 'external']) {
  test(`isolated ${mode} contract: actual harness/gateway, synthetic model boundary, no real inference`, async () => {
    const child = Bun.spawn(['bun', 'tests/helpers/brain-scenario.ts', mode], { stdout: 'pipe', stderr: 'pipe' })
    const [exit, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (exit) throw new Error(output + errors)
    expect(output).toContain('PASS:')
  }, 30_000)
}
