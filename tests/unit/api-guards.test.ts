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

describe('api.guards', () => {
  test('the route scan actually found routes', () => {
    expect(routes.length).toBeGreaterThan(20)
  })

  for (const file of routes) {
    const rel = file.replace(`${process.cwd()}/`, '')
    test(`${rel} calls guard()`, () => {
      const src = readFileSync(file, 'utf8')
      expect(src).toContain('guard(')
      expect(src).toMatch(/from '.*_lib\/guard'|from '@\/app\/api\/_lib\/guard'/)
    })
  }

  test('EVERY exported HTTP handler awaits guard and returns denials', () => {
    for (const file of routes) {
      const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      for (const node of ast.statements) {
        if (!ts.isFunctionDeclaration(node) || !node.name || !node.body) continue
        if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(node.name.text)) continue
        const body = node.body.getText(ast)
        expect(body, `${file} ${node.name.text}`).toMatch(/await guard\(/)
        expect(body, `${file} ${node.name.text}`).toMatch(/if \(!gate\.ok\) return gate\.res/)
      }
    }
  })

  test('no route writes to the database without a guard in the same file', () => {
    for (const file of routes) {
      const src = readFileSync(file, 'utf8')
      const writes =
        src.includes('.create(') || src.includes('.update(') || src.includes('.delete(') || src.includes('.upsert(')
      if (writes) expect(src).toContain('guard(')
    }
  })

  test('mutating handlers never trust a businessId without the guard result', () => {
    for (const file of routes) {
      const src = readFileSync(file, 'utf8')
      if (!/export async function (POST|PATCH|DELETE|PUT)/.test(src)) continue
      // the guard call must be awaited and its failure branch returned
      expect(src).toMatch(/if \(!gate\.ok\) return gate\.res/)
    }
  })
})
