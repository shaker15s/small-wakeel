export type ExpectedIndexKind = 'index' | 'unique'

export interface ExpectedIndex {
  name: string
  kind: ExpectedIndexKind
  fields: string[]
}
export interface ActualIndex {
  name: string
  unique: boolean
  partial?: boolean
  fields: string[]
}

/**
 * A legacy default-named index may use a previous generated name but still
 * be structurally correct. Accept it only if its table fields, order and
 * uniqueness match. An explicit Prisma `map:` name remains name-sensitive.
 */
export function hasEquivalentIndex(
  expected: ExpectedIndex,
  actual: ActualIndex[],
  defaultName: string,
): boolean {
  const requiredUnique = expected.kind === 'unique'
  const customName = expected.name !== defaultName
  return actual.some((candidate) => {
    if (candidate.partial) return false
    if (customName && candidate.name !== expected.name) return false
    if (candidate.unique !== requiredUnique) return false
    if (candidate.fields.length !== expected.fields.length) return false
    return candidate.fields.every((field, index) => field === expected.fields[index])
  })
}
