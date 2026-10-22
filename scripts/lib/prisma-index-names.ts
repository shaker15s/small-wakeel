export type PrismaIndexKind = 'index' | 'unique'

/**
 * Prisma's default SQLite names use `_idx` for @@index and `_key` for
 * @@unique. `db-sync` must compare the same names as Prisma migrations.
 */
export function defaultPrismaIndexName(
  model: string,
  fields: string[],
  kind: PrismaIndexKind,
  mappedName?: string,
): string {
  return mappedName || `${model}_${fields.join('_')}_${kind === 'unique' ? 'key' : 'idx'}`
}
