import { execFileSync } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Pure validation of the worktree fixture. A committed blob is not enough if
 * the worktree/index was changed: refuse ambiguous local DB state explicitly.
 */
export function syntheticFixtureSafetyViolations(state) {
  const reasons = []
  if (!state.tracked) reasons.push('db/custom.db is not tracked by Git')
  if (!state.regularFile) reasons.push('db/custom.db is missing or is not a regular file')
  if (state.symlink) reasons.push('db/custom.db must not be a symlink')
  if (!state.workingTreeMatchesHead) reasons.push('working db/custom.db differs from HEAD')
  if (!state.indexMatchesHead) reasons.push('staged db/custom.db differs from HEAD')
  for (const sidecar of state.sidecars ?? []) {
    if (sidecar.symlink) reasons.push(`SQLite sidecar ${sidecar.name} must not be a symlink`)
    else if (sidecar.size > 0) reasons.push(`SQLite sidecar ${sidecar.name} is non-empty; stop database writers first`)
  }
  return reasons
}

function gitOk(root, args) {
  try {
    execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
    return true
  } catch {
    return false
  }
}

function gitText(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  }).trim()
}

/**
 * Return bytes from HEAD:db/custom.db, never bytes from the mutable worktree.
 * First fail closed on a modified/untracked/symlinked source or live sidecars.
 */
export function readCommittedSyntheticSqlite(root) {
  const source = join(root, 'db', 'custom.db')
  let regularFile = false
  let symlink = false
  try {
    const st = lstatSync(source)
    symlink = st.isSymbolicLink()
    regularFile = st.isFile() && !symlink
  } catch {
    regularFile = false
  }

  const tracked = gitOk(root, ['ls-files', '--error-unmatch', '--', 'db/custom.db'])
  let headBlob = ''
  let indexBlob = ''
  let worktreeBlob = ''
  try { headBlob = gitText(root, ['rev-parse', 'HEAD:db/custom.db']) } catch { /* missing HEAD blob */ }
  try { indexBlob = gitText(root, ['rev-parse', ':db/custom.db']) } catch { /* missing index entry */ }
  try { worktreeBlob = gitText(root, ['hash-object', '--', 'db/custom.db']) } catch { /* missing/unreadable worktree */ }

  const sidecars = []
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const path = source + suffix
    try {
      // lstat catches dangling symlinks too; existsSync alone would miss those.
      const st = lstatSync(path)
      sidecars.push({ name: suffix, size: st.size, symlink: st.isSymbolicLink() })
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue
      sidecars.push({ name: suffix, size: 1, symlink: true })
    }
  }

  const violations = syntheticFixtureSafetyViolations({
    tracked,
    regularFile,
    symlink,
    workingTreeMatchesHead: Boolean(headBlob && worktreeBlob && headBlob === worktreeBlob),
    indexMatchesHead: Boolean(headBlob && indexBlob && headBlob === indexBlob),
    sidecars,
  })
  if (violations.length) {
    throw new Error('Refusing to use local SQLite fixture: ' + violations.join('; '))
  }

  // The data used for tests comes from the immutable commit object, avoiding
  // a TOCTOU race with a local app that might mutate db/custom.db after checks.
  return execFileSync('git', ['show', 'HEAD:db/custom.db'], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}
