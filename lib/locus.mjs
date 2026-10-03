// lib/locus.mjs — what a leaf may write: its listed files, everything under its directory entries,
// and new test files beside its listed files; and the permission rules that confine it to that.
//
// Design: docs/DESIGN.md#the-locus.

import { inLocus, isTestPath, posix } from './store.mjs'

export const TEST_GLOBS = ['*.test.*', '*.spec.*', 'test_*', '*_test.*', '*Test.*', '*Tests.*', '*Spec.*']
export const GIT_DENY = ['Bash(git commit --amend:*)', 'Bash(git -C:*)', 'Bash(git --git-dir:*)',
  'Bash(git --work-tree:*)', 'Bash(git diff --output:*)']
/** The folder names `isTestPath` reads as tests: what a producer barred from tests may not write under a directory entry. */
const TEST_DIRS = ['test', 'tests', 'spec', '__tests__']

const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i) }
/** The folders of a locus's listed files, the repository root left out: where new tests may go. */
const besideDirs = (locus) => [...new Set(locus.map(posix).filter((e) => !e.endsWith('/')).map(dirOf).filter((d) => d !== ''))]

/** Pure. Whether a leaf may write `path`. */
export function admits({ locus, path, baseFiles = [], held = [], tests = true }) {
  const p = posix(path)
  if (inLocus(held, p)) return false
  if (!tests && isTestPath(p)) return false
  if (inLocus(locus, p)) return true
  return tests && isTestPath(p) && !baseFiles.map(posix).includes(p) && besideDirs(locus).includes(dirOf(p))
}

/** Pure. The permission rules of one producer call. */
export function permissionsFor({ locus, baseFiles = [], held = [], tests = true, commands = [], denyRead = [] }) {
  const allowed = []
  const disallowed = []
  const both = (out, p) => out.push('Edit(' + p + ')', 'Write(' + p + ')')
  for (const e of locus.map(posix)) {
    const dir = e.endsWith('/')
    const rule = dir ? e + '**' : e
    if (!tests && isTestPath(dir ? e + 'x' : e)) { both(disallowed, rule); continue }
    both(allowed, rule)
    if (!tests && dir) {
      for (const g of TEST_GLOBS) both(disallowed, e + '**/' + g)
      for (const t of TEST_DIRS) both(disallowed, e + '**/' + t + '/**')
    }
  }
  const dirs = tests ? besideDirs(locus) : []
  for (const d of dirs) for (const g of TEST_GLOBS) both(allowed, d + '/' + g)
  for (const f of baseFiles.map(posix)) {
    if (isTestPath(f) && dirs.includes(dirOf(f)) && !inLocus(locus, f)) both(disallowed, f)
  }
  for (const h of held.map(posix)) both(disallowed, h.endsWith('/') ? h + '**' : h)
  for (const r of denyRead.map(posix)) disallowed.push('Read(' + r + ')')
  for (const c of commands) allowed.push(c === '*' ? 'Bash' : 'Bash(' + c + ':*)')
  if (commands.length) disallowed.push(...GIT_DENY)
  return { allowed: [...new Set(allowed)], disallowed: [...new Set(disallowed)] }
}
