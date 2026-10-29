// lib/permissions.mjs — the permission rules of one call: what its role may write in its worktree,
// what it may not read, and which commands it may run.
//
// Design: docs/DESIGN.md#the-agent-runner, docs/DESIGN.md#role-rules.

import { TEST_PATTERNS, isTestPath, posix } from './store.mjs'

/** `--amend` and `--output` follow other arguments, so their rules match them anywhere: a `git diff:*` allow rule would pass `git diff HEAD --output=x` past a prefix deny. */
export const GIT_DENY = ['Bash(git *--amend*)', 'Bash(git -C:*)', 'Bash(git --git-dir:*)',
  'Bash(git --work-tree:*)', 'Bash(git *--output*)']

/**
 * A permission pattern follows gitignore rules, and a leading `/` anchors it at the call's working
 * folder. A listed path goes in literally: its glob characters are escaped, so `app/[slug]/page.tsx`
 * names that file and not `app/s/page.tsx`.
 */
const literal = (p) => '/' + posix(p).replace(/[*?[\]()]/g, '\\$&')

/**
 * Pure. The commands a command line runs, each as the host checks it: split at `&&`, `||`, `;`,
 * `|` and newlines outside quotes, a leading `!` dropped, and each `$(…)` inside one a command of
 * its own. The host allows a compound line only when it allows every part, so a rule for the whole
 * line admits nothing, and one per part admits the line and each part run alone.
 */
function commandParts(line) {
  const parts = []
  let cur = ''
  let quote = ''
  const push = () => {
    const part = cur.trim().replace(/^!\s*/, '').trim()
    if (part) parts.push(part)
    cur = ''
  }
  const text = String(line)
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '$' && text[i + 1] === '(' && quote !== "'") {
      let depth = 1
      let j = i + 2
      for (; j < text.length && depth > 0; j++) depth += text[j] === '(' ? 1 : text[j] === ')' ? -1 : 0
      parts.push(...commandParts(text.slice(i + 2, j - 1)))
      cur += text.slice(i, j)
      i = j - 1
      continue
    }
    if (quote) {
      if (c === quote) quote = ''
      cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
      continue
    }
    const two = text.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      push()
      i++
      continue
    }
    if (c === ';' || c === '|' || c === '\n') {
      push()
      continue
    }
    cur += c
  }
  push()
  return [...new Set(parts)]
}

const both = (out, p) => out.push('Edit(' + p + ')', 'Write(' + p + ')')

/** The test-file table as rules at any depth of the worktree: each file glob, and everything under each test folder. */
const TEST_RULES = [
  ...TEST_PATTERNS.filter((t) => !t.folder).map((t) => '/**/' + t.glob),
  ...TEST_PATTERNS.filter((t) => t.folder).map((t) => '/**/' + t.glob + '/**'),
]

/** The store's folder in a worktree: no role writes it. */
const STORE = '/.agentics/**'

/**
 * Pure. What a producer round may write (docs/DESIGN.md#role-rules): `tests` for the test-author of
 * a cycle's test round (a green's or an audit's) and of a `tests-only` leaf; `no-tests` for a green's
 * implementer and an auditor; `all` for every other writer, a red's test-author among them, whose
 * stubs of the files its green builds are no test.
 */
export function writesOf(role, leaf) {
  if (role === 'auditor') return 'no-tests'
  if (role === 'implementer') return leaf.role === 'green' ? 'no-tests' : 'all'
  if (role === 'test-author') return leaf.role === 'green' || leaf.role === 'audit' || leaf.rigor === 'tests-only' ? 'tests' : 'all'
  return 'all'
}

/** Pure. Whether a role that writes `writes` may change `path`: what the series' `role-breach` holds a commit to. */
export function roleAdmits(writes, path) {
  const p = posix(path)
  if (p === '.agentics' || p.startsWith('.agentics/')) return false
  if (writes === 'tests') return isTestPath(p)
  if (writes === 'no-tests') return !isTestPath(p)
  return true
}

/**
 * Pure. The permission rules of one producer call: its worktree by its role's rule (`writesOf`),
 * never the store's folder; Read denied on `denyRead`; a Bash rule per command and, with any,
 * `GIT_DENY`.
 */
export function rolePermissions({ writes = 'all', commands = [], denyRead = [] } = {}) {
  const allowed = []
  const disallowed = []
  if (writes === 'tests') for (const r of TEST_RULES) both(allowed, r)
  else both(allowed, '/**')
  if (writes === 'no-tests') for (const r of TEST_RULES) both(disallowed, r)
  both(disallowed, STORE)
  for (const r of denyRead) disallowed.push('Read(' + literal(r) + ')')
  for (const c of commands.flatMap((k) => (k === '*' ? [k] : commandParts(k)))) allowed.push(c === '*' ? 'Bash' : 'Bash(' + c + ':*)')
  if (commands.length) disallowed.push(...GIT_DENY)
  return { allowed: [...new Set(allowed)], disallowed: [...new Set(disallowed)] }
}

/** Pure. The rules of a call that writes exactly `paths` (a planner, its folder's spec) and runs nothing. */
export function writePermissions(paths) {
  const allowed = []
  for (const p of paths) both(allowed, literal(p))
  return { allowed: [...new Set(allowed)], disallowed: [] }
}

/** The tools a role that writes nothing is allowed by their bare names. */
export const READ_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']
/** The search server's tools as the host names them: allowed by their exact names, like READ_TOOLS. */
export const MCP_TOOL_PREFIX = 'mcp__search__'

/** Pure. The permission rules of a role that writes nothing. */
export function readOnlyPermissions({ tools, commands = [] }) {
  const allowed = [...tools.filter((t) => READ_TOOLS.includes(t) || t.startsWith(MCP_TOOL_PREFIX)), ...commands.flatMap(commandParts).map((c) => 'Bash(' + c + ':*)')]
  return { allowed: [...new Set(allowed)], disallowed: commands.length ? [...GIT_DENY] : [] }
}

/** Programs a producer reaches for instead of its Read, Grep, Edit and Write tools: never a project's own command. */
const AD_HOC = new Set(['cd', 'cat', 'head', 'tail', 'less', 'more', 'sed', 'awk', 'perl', 'ruby', 'echo', 'printf', 'tee', 'ls',
  'dir', 'find', 'grep', 'rg', 'wc', 'sort', 'uniq', 'cut', 'tr', 'xargs', 'cp', 'mv', 'rm', 'mkdir', 'touch', 'chmod', 'true', 'test', 'git'])
/** Shell control around a command: a project command wrapped in one is still not one line the role was given. */
const SHELL_CONTROL = new Set(['eval', 'for', 'do', 'done', 'while', 'until', 'if', 'then', 'else', 'elif', 'fi', 'case', 'esac',
  'function', 'source', '.', 'export', 'set', 'exec', 'sh', 'bash'])
/** Interpreters that are ad hoc when handed a script inline rather than a project's file. */
const INLINE = new Set(['python', 'python3', 'py', 'node', 'deno', 'bun'])

/**
 * Pure. Whether a denied shell line is ad hoc — reading or rewriting files, or an inline script —
 * rather than a project command (a build, a test run, a generator) its entry's `runs` could name:
 * every part of it, split at `;`, `&&`, `||` and `|`, is one of those programs, shell control
 * (`eval`, a loop, `sh -c`) — around a project command too, which runs as one plain line — or an
 * interpreter given `-c`, `-e`, `-p`, `-` or a heredoc.
 */
export function adHocCommand(line) {
  const parts = String(line || '').split(/;|&&|\|\||\|/).map((p) => p.trim()).filter(Boolean)
  return parts.length > 0 && parts.every((part) => {
    const words = part.split(/\s+/).filter((w) => !/^\w+=/.test(w))
    const program = String(words[0] || '').split(/[\/]/).pop().replace(/\.exe$/i, '').toLowerCase()
    if (AD_HOC.has(program) || SHELL_CONTROL.has(program)) return true
    return INLINE.has(program) && (words.length === 1 || ['-c', '-e', '-p', '-'].includes(words[1]) || part.includes('<<'))
  })
}
