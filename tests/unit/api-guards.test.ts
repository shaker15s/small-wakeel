// وكيل — every API route must run the guard.
//
// This is a structural test on purpose: a route that forgets `guard()` is a
// tenant-isolation hole that no runtime test would necessarily catch (it only
// shows up when someone guesses an id from another shop). Scanning the route
// files makes forgetting one a red CI run instead of a security incident.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const API_DIR = join(process.cwd(), 'src', 'app', 'api')

function routeFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...routeFiles(full))
    else if (entry === 'route.ts') out.push(full)
  }
  return out
}

const routes = routeFiles(API_DIR)

/**
 * Machine-authenticated routes: called by the companion bridge on the owner's
 * machine — there is NO browser session to guard. Their authentication is
 * the device HMAC (authenticateDevice: signed envelope + 60s window +
 * single-use nonce + revocation check), which is the plan §10 contract for
 * this surface. The exemption is verified below: an exempted route MUST call
 * authenticateDevice on every handler, so this list can never hide an
 * unauthenticated route.
 */
const MACHINE_AUTH_ROUTES = new Set([
  'src/app/api/companion/claim/route.ts',
  'src/app/api/companion/result/route.ts',
])

function isMachineAuth(rel: string): boolean {
  return MACHINE_AUTH_ROUTES.has(rel)
}

describe('api.guards', () => {
  test('the route scan actually found routes', () => {
    expect(routes.length).toBeGreaterThan(20)
  })

  for (const file of routes) {
    const rel = file.replace(`${process.cwd()}/`, '')
    test(`${rel} calls guard()`, () => {
      const src = readFileSync(file, 'utf8')
      if (isMachineAuth(rel)) {
        expect(src).toContain('authenticateDevice(')
        return
      }
      expect(src).toContain('guard(')
      expect(src).toMatch(/from '.*_lib\/guard'|from '@\/app\/api\/_lib\/guard'/)
    })
  }

  test('EVERY exported HTTP handler awaits guard and returns denials', () => {
    for (const file of routes) {
      const rel = file.replace(`${process.cwd()}/`, '')
      const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      for (const node of ast.statements) {
        if (!ts.isFunctionDeclaration(node) || !node.name || !node.body) continue
        if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(node.name.text)) continue
        const body = node.body.getText(ast)
        if (isMachineAuth(rel)) {
          expect(body, `${file} ${node.name.text} (machine auth)`).toMatch(/authenticateDevice\(/)
          continue
        }
        expect(body, `${file} ${node.name.text}`).toMatch(/await guard\(/)
        expect(body, `${file} ${node.name.text}`).toMatch(/if \(!gate\.ok\) return gate\.res/)
      }
    }
  })

  test('exempted machine-auth routes are genuinely machine-authenticated', () => {
    for (const rel of MACHINE_AUTH_ROUTES) {
      const src = readFileSync(join(process.cwd(), rel), 'utf8')
      expect(src, `${rel} must authenticate every handler`).toContain('authenticateDevice(')
      expect(src, `${rel} must not silently fall back to unauthenticated paths`).toMatch(/401|403/)
    }
  })

  test('no route writes to the database without a guard in the same file', () => {
    for (const file of routes) {
      const rel = file.replace(`${process.cwd()}/`, '')
      const src = readFileSync(file, 'utf8')
      const writes =
        src.includes('.create(') || src.includes('.update(') || src.includes('.delete(') || src.includes('.upsert(')
      if (writes) expect(src).toContain(isMachineAuth(rel) ? 'authenticateDevice(' : 'guard(')
    }
  })

  test('mutating handlers never trust a businessId without the guard result', () => {
    for (const file of routes) {
      const rel = file.replace(`${process.cwd()}/`, '')
      const src = readFileSync(file, 'utf8')
      if (!/export async function (POST|PATCH|DELETE|PUT)/.test(src)) continue
      if (isMachineAuth(rel)) continue // device HMAC auth — verified above
      // the guard call must be awaited and its failure branch returned
      expect(src).toMatch(/if \(!gate\.ok\) return gate\.res/)
    }
  })
})
