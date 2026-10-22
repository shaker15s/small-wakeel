export interface SyntheticFixtureState {
  tracked: boolean
  regularFile: boolean
  symlink: boolean
  workingTreeMatchesHead: boolean
  indexMatchesHead: boolean
  sidecars?: Array<{name: string; size: number; symlink: boolean}>
}
export function syntheticFixtureSafetyViolations(state: SyntheticFixtureState): string[]
export function readCommittedSyntheticSqlite(root: string): Buffer
