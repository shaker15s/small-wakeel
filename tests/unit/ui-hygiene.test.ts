// وكيل — UI hygiene: the failure modes that only show up in a BROWSER.
//
// Live evidence (preview host, 2026-10-17): the app crashed inside its own
// error boundary with
//   «Module …/lucide-react/icons/graduation-cap.js was instantiated because it
//    was required from Onboarding.tsx, but the module factory is not available»
// The cause was a *dead import*: `GraduationCap` and `Wallet` were imported but
// never rendered, so Turbopack kept a reference to an icon chunk it never
// emitted — a typed, linted, passing-tests file that blanked the screen.
//
// `tsc` cannot see it (`noUnusedLocals` is off) and the repo's ESLint config
// does not flag unused imports, so this file is the guard: every named import
// must actually be USED in the file that imports it. It is cheap, it is
// mechanically exact, and it would have caught the crash before the user saw it.
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const SRC = join(process.cwd(), 'src')
const files = walk(SRC)

/** `import { a, b as c } from 'mod'` → the local names that must be referenced. */
function namedImports(text: string): { local: string; spec: string }[] {
  const out: { local: string; spec: string }[] = []
  for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g)) {
    for (const raw of m[1].split(',')) {
      const part = raw.trim()
      if (!part || part.startsWith('type ')) continue
      const local = part.includes(' as ') ? part.split(' as ')[1].trim() : part
      if (/^[A-Za-z_$][\w$]*$/.test(local)) out.push({ local, spec: m[2] })
    }
  }
  return out
}

describe('ui-hygiene.deadImports', () => {
  test('no component imports a symbol it never uses', () => {
    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const { local } of namedImports(text)) {
        // occurrences excluding the import line itself
        const body = text.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
        const uses = body.match(new RegExp(`\\b${local.replace(/\$/g, '\\$')}\\b`, 'g')) ?? []
        // a symbol used only in a type position still counts (JSX, generics,
        // `typeof X`) — ANY reference after the imports is enough here
        if (uses.length === 0) offenders.push(`${file.replace(process.cwd() + '/', '')} → ${local}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('lucide icons are imported from the barrel only where they are used (spot check)', () => {
    // the crash was specifically a lucide icon; assert the Onboarding screen —
    // the file that broke — imports exactly what it renders
    const onboarding = readFileSync(join(SRC, 'components', 'app', 'Onboarding.tsx'), 'utf8')
    for (const icon of ['GraduationCap', 'Wallet']) {
      expect(onboarding.includes(icon)).toBe(false)
    }
  })
})

describe('ui-hygiene.hydration', () => {
  test('the root layout suppresses hydration noise from browser extensions', () => {
    const layout = readFileSync(join(SRC, 'app', 'layout.tsx'), 'utf8')
    // <html> and <body> both: extensions (bis_status/__processed_*) rewrite the
    // body attributes and React 19 reports a mismatch the app cannot fix
    expect(layout).toContain('<html lang="ar" dir="rtl" suppressHydrationWarning>')
    expect(layout).toMatch(/<body[\s\S]{0,120}suppressHydrationWarning/)
  })
})
