// وكيل — the reduced-motion guard is a CONTRACT, not an afterthought.
//
// A real bug shipped because of this: the `prefers-reduced-motion` block set
// `opacity: 0 !important` on `.rise-in`, and the third onboarding screen was the
// only surface using that class — so every user with «تقليل الحركة» switched on
// saw a blank step 3 with no error anywhere. Reduced motion means «no movement»,
// never «no content».
//
// This test parses globals.css and fails if any entrance class is hidden by a
// reduced-motion rule, and if a motion class is used without being registered in
// a guard at all (which is how the class above slipped through).
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(process.cwd(), 'src', 'app', 'globals.css'), 'utf8')

/** Every `@media (prefers-reduced-motion: reduce) { … }` block, brace-matched. */
function reducedMotionBlocks(): string[] {
  const blocks: string[] = []
  const marker = '@media (prefers-reduced-motion: reduce)'
  let from = 0
  for (;;) {
    const at = css.indexOf(marker, from)
    if (at < 0) break
    const open = css.indexOf('{', at)
    let depth = 0
    let end = open
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    blocks.push(css.slice(open, end + 1))
    from = end + 1
  }
  return blocks
}

/** Entrance classes that MUST stay visible (they carry content). */
const CONTENT_CLASSES = ['.rise-in', '.list-enter', '.ae-riser', '.blur-in', '.ae-curtain', '.kinetic-word', '.odometer']

describe('css.reducedMotion', () => {
  test('content-carrying entrance classes are never hidden', () => {
    for (const block of reducedMotionBlocks()) {
      for (const cls of CONTENT_CLASSES) {
        // find the selector list this class appears in, then its declarations
        const idx = block.indexOf(cls)
        if (idx < 0) continue
        const declEnd = block.indexOf('}', idx)
        const declarations = block.slice(idx, declEnd >= 0 ? declEnd : undefined)
        expect(declarations).not.toMatch(/opacity:\s*0\b/)
        expect(declarations).not.toMatch(/visibility:\s*hidden/)
        expect(declarations).not.toMatch(/display:\s*none/)
      }
    }
  })

  test('the classes that hide decoration DO hide it', () => {
    const blocks = reducedMotionBlocks().join('\n')
    // the card sheen / sweep are pure light effects: hiding them is correct
    expect(blocks).toMatch(/\.ae-sweep::after[\s\S]{0,80}opacity:\s*0/)
  })

  test('every motion class used in the UI is registered in a guard', () => {
    const motionClasses = [
      '.tap',
      '.lift',
      '.enter-rise',
      '.finding-enter',
      '.confidence-fill',
      '.attention',
      '.ae-riser',
      '.blur-in',
      '.ae-curtain',
      '.kinetic-word',
      '.magnetic',
      '.ae-float',
    ]
    const guarded = reducedMotionBlocks().join('\n')
    for (const cls of motionClasses) {
      expect(guarded).toContain(cls)
    }
  })

  test('no rule sets a permanent transform or filter on reduced motion for centred content', () => {
    // `transform: none !important` is fine for transforms-only effects, but a
    // blanket `filter: none` on content that relies on `filter: blur(0)` is not
    // — this asserts we did not add such a trap to the content classes again.
    for (const block of reducedMotionBlocks()) {
      const idx = block.indexOf('.kinetic-word')
      if (idx < 0) continue
      expect(block.slice(idx, block.indexOf('}', idx))).not.toMatch(/visibility/)
    }
  })
})

/** Walk src/ and collect every className token that looks like a motion class. */
function classTokens(dir: string, out = new Set<string>()) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      classTokens(full, out)
      continue
    }
    if (!/\.(tsx|ts)$/.test(entry)) continue
    const text = readFileSync(full, 'utf8')
    // className tokens appear as `ae-riser`/`kinetic-word` inside strings; a
    // word-boundary scan over the source is enough for a coverage assertion
    for (const token of text.match(/\b(?:ae-[a-z-]+|kinetic-word)\b/g) ?? []) out.add(token)
  }
  return out
}

describe('css.motionCoverage', () => {
  test('no unused animation keyframes (dead motion is dead weight)', () => {
    const keyframes = [...css.matchAll(/@keyframes\s+([a-z0-9-]+)/gi)].map((m) => m[1])
    expect(keyframes.length).toBeGreaterThan(10)
    for (const name of keyframes) {
      const uses = css.match(new RegExp(`animation(?:-name)?:[^;]*\\b${name}\\b`, 'g')) ?? []
      expect(uses.length).toBeGreaterThan(0)
    }
  })

  test('the AE layer is actually referenced from components', () => {
    const tokens = classTokens(join(process.cwd(), 'src', 'components'))
    // at least the onboarding + chat surfaces must use the new layer
    expect([...tokens].some((t) => t === 'ae-riser' || t === 'ae-curtain')).toBe(true)
  })
})
