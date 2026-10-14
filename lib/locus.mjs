// lib/locus.mjs — what a leaf may write: its listed files, everything under its directory entries,
// and new test files beside its listed files; and the permission rules that confine it to that.
//
// Design: docs/DESIGN.md#the-locus.

import { TEST_PATTERNS, inLocus, isTestPath, posix } from './store.mjs'

/** The test-file table's file globs: the test names a listed file's folder admits. */
export const TEST_GLOBS = TEST_PATTERNS.filter((t) => !t.folder).map((t) => t.glob)

/** `--amend` and `--output` follow other arguments, so their rules match them anywhere: a `git diff:*` allow rule would pass `git diff HEAD --output=x` past a prefix deny. */
export const GIT_DENY = ['Bash(git *--amend*)', 'Bash(git -C:*)', 'Bash(git --git-dir:*)',
  'Bash(git --work-tree:*)', 'Bash(git *--output*)']
/** The test-file table's folder globs: what a producer barred from tests may not write under a directory entry. */
const TEST_DIRS = TEST_PATTERNS.filter((t) => t.folder).map((t) => t.glob)

/**
 * A permission pattern follows gitignore rules. A listed path goes in literally: its glob characters are escaped, so
 * `app/[slug]/page.tsx` names that file and not `app/s/page.tsx`.
 */
const literal = (p) => p.replace(/[*?[\]()]/g, '\\$&')
/** A pattern with no slash matches at any depth: anchored, `package.json` is the root's and not every one below it. */
const anchored = (rule) => (rule.includes('/') ? rule : '/' + rule)

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

/**
 * Pure. The permission rules of one producer call. `testDirs` are further folders where new test
 * files may go, beside the folders of the locus's listed files: a cycle's test round writes beside
 * every member's locus (`cycleTestLocus` in lib/tree.mjs). The root is never one.
 */
export function permissionsFor({ locus, baseFiles = [], held = [], tests = true, commands = [], denyRead = [], testDirs = [] }) {
  const allowed = []
  const disallowed = []
  const both = (out, p) => out.push('Edit(' + anchored(p) + ')', 'Write(' + anchored(p) + ')')
  for (const e of locus.map(posix)) {
    const dir = e.endsWith('/')
    const at = literal(e)
    const rule = dir ? at + '**' : at
    if (!tests && isTestPath(dir ? e + 'x' : e)) { both(disallowed, rule); continue }
    both(allowed, rule)
    if (!tests && dir) {
      for (const g of TEST_GLOBS) both(disallowed, at + '**/' + g)
      for (const t of TEST_DIRS) both(disallowed, at + '**/' + t + '/**')
    }
  }
  const extra = testDirs.map((d) => posix(d).replace(/\/+$/, '')).filter((d) => d !== '')
  const dirs = tests ? [...new Set([...besideDirs(locus), ...extra])] : []
  for (const d of dirs) for (const g of TEST_GLOBS) both(allowed, literal(d) + '/' + g)
  for (const f of baseFiles.map(posix)) {
    if (isTestPath(f) && dirs.includes(dirOf(f)) && !inLocus(locus, f)) both(disallowed, literal(f))
  }
  for (const h of held.map(posix)) both(disallowed, h.endsWith('/') ? literal(h) + '**' : literal(h))
  for (const r of denyRead.map(posix)) disallowed.push('Read(' + anchored(literal(r)) + ')')
  for (const c of commands) allowed.push(c === '*' ? 'Bash' : 'Bash(' + c + ':*)')
  if (commands.length) disallowed.push(...GIT_DENY)
  return { allowed: [...new Set(allowed)], disallowed: [...new Set(disallowed)] }
}

/** The tools a role that writes nothing is allowed by their bare names. */
export const READ_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']
/** The search server's tools as the host names them: allowed by their exact names, like READ_TOOLS. */
export const MCP_TOOL_PREFIX = 'mcp__search__'

/** Pure. The permission rules of a role that writes nothing. */
export function readOnlyPermissions({ tools, commands = [] }) {
  const allowed = [...tools.filter((t) => READ_TOOLS.includes(t) || t.startsWith(MCP_TOOL_PREFIX)), ...commands.map((c) => 'Bash(' + c + ':*)')]
  return { allowed: [...new Set(allowed)], disallowed: commands.length ? [...GIT_DENY] : [] }
}
