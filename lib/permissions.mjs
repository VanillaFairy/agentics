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

/** Pure. The index just past the `close` that ends what opens at `from` in `text`, quotes and escapes respected; text.length when none does. */
function closing(text, from, open, close) {
  let depth = 1
  let quote = ''
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (c === '\\' && quote !== "'") {
      i++
      continue
    }
    if (quote) {
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (open && c === open) depth++
    else if (c === close && --depth === 0) return i + 1
  }
  return text.length
}

/**
 * Pure. The commands a command line runs, each as the host checks it: split at `&&`, `||`, `;`,
 * `|`, a lone `&` and newlines outside quotes and escapes, a leading `!` dropped, a `( … )`
 * subshell's commands its own, and each `$(…)` or backquoted command inside one a command of its
 * own. The host allows a compound line only when it allows every part, so a rule for the whole line
 * admits nothing, and one per part admits the line and each part run alone. The one parser of
 * command lines: the rules a role is granted, the class of a line the host denied, and the `runs`
 * an entry may name all read it.
 */
export function commandParts(line) {
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
    if (c === '\\' && quote !== "'") {
      cur += text.slice(i, i + 2)
      i++
      continue
    }
    // `$((…))` is arithmetic, no command.
    if (quote !== "'" && c === '$' && text.startsWith('((', i + 1)) {
      const end = Math.min(text.length, closing(text, i + 3, '(', ')') + 1)
      cur += text.slice(i, end)
      i = end - 1
      continue
    }
    if (quote !== "'" && ((c === '$' && text[i + 1] === '(') || c === '`')) {
      const start = c === '`' ? i + 1 : i + 2
      const end = c === '`' ? closing(text, start, '', '`') : closing(text, start, '(', ')')
      parts.push(...commandParts(text.slice(start, end - 1)))
      cur += text.slice(i, end)
      i = end - 1
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
    if (c === '(' && cur.trim() === '') {
      const end = closing(text, i + 1, '(', ')')
      parts.push(...commandParts(text.slice(i + 1, end - 1)))
      i = end - 1
      continue
    }
    const two = text.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      push()
      i++
      continue
    }
    // A heredoc's lines, up to its delimiter, are the input of the command that opened it, never commands.
    const heredoc = c === '\n' && /(?:^|[^<])<<-?\s*(['"]?)(\w+)\1/.exec(cur)
    if (heredoc) {
      const end = text.slice(i + 1).split('\n').findIndex((l) => l.trim() === heredoc[2])
      const body = end < 0 ? text.slice(i) : text.slice(i, i + 1 + text.slice(i + 1).split('\n').slice(0, end + 1).join('\n').length)
      cur += body
      i += body.length - 1
      push()
      continue
    }
    // `&` alone sends a command to the background; in `2>&1` and `&>` it is a redirect.
    const lone = c === '&' && !'<>'.includes(text[i - 1] || '') && text[i + 1] !== '>'
    if (c === ';' || c === '|' || c === '\n' || lone) {
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
 * Pure. The permission rules of one producer call: its worktree by its role's rule (`writesOf`)
 * and the conflicted paths a rebase round resolves (`resolves`), never the store's folder; Read
 * denied on `denyRead`; a Bash rule per command and, with any, `GIT_DENY`. A deny wins over every
 * allow, so a test path to resolve lifts a `no-tests` call's test denials: what else of the tests
 * it writes, the series check finds.
 */
export function rolePermissions({ writes = 'all', commands = [], denyRead = [], resolves = [] } = {}) {
  const allowed = []
  const disallowed = []
  if (writes === 'tests') for (const r of TEST_RULES) both(allowed, r)
  else both(allowed, '/**')
  for (const p of resolves) both(allowed, literal(p))
  if (writes === 'no-tests' && !resolves.some(isTestPath)) for (const r of TEST_RULES) both(disallowed, r)
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

/** Runners that fetch and run a package by name: given nothing more, a rule for one admits any package. */
const FETCHERS = new Set(['npx', 'bunx', 'uvx', 'pipx'])

/** Pure. A command part's words with leading `NAME=value` assignments and every redirect (`> f`, `2>&1`, `<f`) dropped. */
function bareWords(part) {
  const words = String(part).trim().split(/\s+/).filter(Boolean)
  const out = []
  let i = 0
  while (i < words.length && /^\w+=/.test(words[i])) i++
  for (; i < words.length; i++) {
    const w = words[i]
    if (/^(\d*|&)(>>?|<)$/.test(w)) i++
    else if (!/^(\d*|&)(>>?|<)/.test(w)) out.push(w)
  }
  return out
}

/** Pure. A command part's program, its path and `.exe` dropped, lowercased. */
const programOf = (words) => String(words[0] || '').split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase()

/** Pure. Whether a part is ad hoc: a program the role's tools stand in for, shell control, or an interpreter handed a script inline. */
function adHocPart(part) {
  const words = bareWords(part)
  const program = programOf(words)
  if (AD_HOC.has(program) || SHELL_CONTROL.has(program)) return true
  return INLINE.has(program) && (words.length === 1 || ['-c', '-e', '-p', '-'].includes(words[1]) || part.includes('<<'))
}

/** Pure. Whether the rule granted for command `grant` (`Bash(<grant>:*)`) admits `part`; `*` admits every one. */
const admits = (grant, part) => grant === '*' || part === grant || part.startsWith(grant + ' ')

/**
 * Pure. What a command line the host denied a producer is, against the commands it was granted
 * (`roleCommands`): `unlisted` when a part runs a project command no grant names, even bare of its
 * assignments and redirects — a gap in the entry's `runs`; else `adhoc` when a part reads or
 * rewrites files, is shell control or an inline script, or wraps a granted command in a `cd`, an
 * assignment or a redirect — the producer's to change, with its tools or as one plain line; else
 * `mismatch`: every part is granted as it stands, and the host still denied it — the plugin's rules
 * and the host's disagree.
 */
export function deniedClass(line, grants) {
  // A part that is only an assignment or a redirect runs nothing to class.
  const parts = commandParts(line).filter((p) => bareWords(p).length > 0)
  const rules = grants.flatMap((g) => (g === '*' ? [g] : commandParts(g)))
  const granted = (p) => rules.some((g) => admits(g, p))
  if (parts.some((p) => !adHocPart(p) && !granted(p) && !granted(bareWords(p).join(' ')))) return 'unlisted'
  if (parts.some((p) => adHocPart(p) || !granted(p) || bareWords(p).join(' ') !== p.replace(/\s+/g, ' '))) return 'adhoc'
  return 'mismatch'
}

/**
 * Pure. Why a command an entry's `runs` names cannot be granted, or '': the grant is a prefix rule, so
 * a `runs` entry is one plain command — no chain, pipe, background, substitution, redirect or
 * assignment, nothing the role's own tools do, no shell control, no inline script, and never a bare
 * interpreter or package runner, whose rule would admit any script or package.
 */
export function runsProblem(entry) {
  const c = String(entry).trim()
  if (c === '' || c.includes('*')) return 'a command is named literally, without *'
  const parts = commandParts(c)
  if (parts.length !== 1 || parts[0] !== c || /[`<>\n]|\$\(/.test(c)) return 'a command is one plain line: no chain, pipe, background, substitution or redirect'
  const words = c.split(/\s+/)
  if (/^\w+=/.test(words[0])) return 'a command sets no variables before it'
  const program = programOf(words)
  const dlx = ['pnpm', 'yarn'].includes(program) && words[1] === 'dlx'
  if ((FETCHERS.has(program) || INLINE.has(program) || dlx) && words.length < (dlx ? 3 : 2)) return program + ' alone would admit any script or package: name what it runs'
  if (adHocPart(c)) return program + ' is no project command: the role reads and writes files with its tools'
  return ''
}
