export type IndexKind = 'index' | 'unique'
export interface IndexDirective {
  name: string
  kind: IndexKind
  fields: string[]
  raw: string
}

// Prisma's default physical index suffixes are _idx and _key, not the
// literal directive names _index and _unique. A wrong suffix makes db-sync
// report existing, correctly migrated indexes as missing.
export function parseIndexDirectives(schema: string): Record<string, IndexDirective[]> {
  const out: Record<string, IndexDirective[]> = {}
  const modelRe = /model\s+(\w+)\s*\{([^}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = modelRe.exec(schema))) {
    const [, model, body] = match
    for (const line of body.split('\n')) {
      const raw = line.trim()
      const directive = /^@@(index|unique)\(\[([^\]]+)\](?:,\s*(.*?))?\)\s*$/.exec(raw)
      if (!directive) continue
      const kind = directive[1] as IndexKind
      const fields = directive[2].split(',').map((field) => field.trim().replace(/\(.*\)$/, ''))
      const attributes = directive[3] ?? ''
      const mapName = /\bmap:\s*"([^"]+)"/.exec(attributes)?.[1]
      const suffix = kind === 'index' ? 'idx' : 'key'
      const name = mapName || model + '_' + fields.join('_') + '_' + suffix
      ;(out[model] ??= []).push({ name, kind, fields, raw })
    }
  }
  return out
}
