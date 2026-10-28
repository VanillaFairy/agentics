// lib/store.mjs — where everything agentics writes lives, and the few primitives every writer
// shares: names, paths, the lock file, the argument transport and the printed envelope.
//
// Design: docs/DESIGN.md#storage.
//
// Why one module. Every path under `.agentics/` and every branch name the framework owns is
// computed, never typed, because a name typed in two places is two names the day one of them
// changes. Interrupted work is found by its name — a leaf's branch, an execution's directory —
// so the function that makes the name is also the function that finds it, and there is one.
//
// Why the main checkout. A leaf builds in a linked worktree, and whatever it records must land
// where the next session looks: the `.agentics/` of the checkout that owns the worktree. So every
// path starts from `mainCheckout(repo)`, never from `repo`.
//
// Why branch names are not `agentics/<effort>/<node-id>`. Git stores a branch as a file under
// `refs/heads/`, so `agentics/e` and `agentics/e/auth` cannot both exist: one would have to be a
// file and a directory at once. Nested node ids collide the same way (`auth` and `auth/session`).
// So the effort branch keeps the short name and every node branch is its sibling:
// `agentics/<effort>--<key>`, where the key is the id with its `/` spelled as `.` (node-id segments
// carry no dot), bounded by `nameKey`; effort slugs carry no `--`, so the prefix is unambiguous.
//
// Why every name is bounded. A name built from something that grows — a nested node id, a
// dispatch label listing every axis — runs past what a filesystem takes: 255 characters for one
// path component, and Windows' MAX_PATH of 260 for the whole path, which the agents' Write tool
// meets with a `.tmp.<pid>.<hex>` suffix on top. `nameKey` keeps such a name readable up to a
// fixed length and replaces the rest by its digest, so a name can never outgrow its directory.
// A worktree's directory is bounded tighter still: every project file checked out in it spends
// its path's length on the worktree's root first.

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { canonical, fnv1a } from './plan-digest.mjs'

export const AGENTICS_DIR = '.agentics'
export const STATE_DIR = '.state'
export const SPEC_FILE = 'DESIGN.md'
export const EVIDENCE_RENDER = 'evidence.md'
export const CONFIG_FILE = 'config.json'
const WORKTREES_DIR = '.claude/worktrees'

/** The effort root's node id. Every other id is a `/`-joined path of segments below it. */
export const ROOT_ID = '.'

export const posix = (p) => String(p == null ? '' : p).split('\\').join('/')

// ------------------------------------------------------------------ names

const SEGMENT = /^[a-z0-9][a-z0-9-]*$/

/**
 * Pure. The segment rule: an effort, folder or entry name this plugin accepts, or null. One path
 * segment, so no traversal; no dot, so no hidden or file-like name; no `--`, so a node branch's
 * prefix is unambiguous. Nothing is repaired: a name with a space is refused, not trimmed.
 */
export function safeSlug(value) {
  if (typeof value !== 'string' || value.length > 120) return null
  if (!SEGMENT.test(value) || value.includes('--')) return null
  return value
}

/** Pure. What is wrong with a node id, or null. */
export function nodeIdProblem(id) {
  if (typeof id !== 'string' || id === '') return 'a node id must be a non-empty string'
  if (id === ROOT_ID) return null
  if (id.length > 200) return 'node id ' + JSON.stringify(id) + ' is longer than 200 characters'
  const bad = id.split('/').find((segment) => !SEGMENT.test(segment))
  if (bad !== undefined) {
    return 'node id ' + JSON.stringify(id) + ' has segment ' + JSON.stringify(bad) +
      ' — segments are lower-case letters, digits and dashes, starting with a letter or digit'
  }
  return null
}

/** Pure. The id of a node's parent: `'.'` for a top-level id, null for the root itself. */
export function parentOf(id) {
  if (id === ROOT_ID) return null
  const at = id.lastIndexOf('/')
  return at === -1 ? ROOT_ID : id.slice(0, at)
}

/** Pure. Every ancestor of a node, nearest first, ending with the root. */
export function ancestorsOf(id) {
  const out = []
  for (let p = parentOf(id); p !== null; p = parentOf(p)) out.push(p)
  return out
}

/** Pure. True when `a` is `b` or an ancestor of it. */
export const isAncestorOrSelf = (a, b) => a === b || ancestorsOf(b).includes(a)

/** Pure. The id spelled with dots: `a/b/c` → `a.b.c`. */
export const flat = (id) => (id === ROOT_ID ? '' : id.split('/').join('.'))

/** The longest name `nameKey` returns. */
export const NAME_KEY_MAX = 40

/**
 * The longest worktree directory name. Below NAME_KEY_MAX + 3, so a branch name that carries a
 * bounded node key never fits whole and every directory name with a `_` is a bounded one.
 */
export const WORKTREE_KEY_MAX = 32

/**
 * Pure. `text` as a bounded name: itself when it fits in `max`, else its head, `_` and the digest
 * of the whole. Node keys and labels never carry `_`, so a shortened name never equals a whole
 * one, and two texts sharing a head still differ by their digests.
 */
export const nameKey = (text, max = NAME_KEY_MAX) =>
  text.length <= max ? text : text.slice(0, max - 9) + '_' + fnv1a(text)

/** Pure. A node's id as it is spelled in every branch and file name: '' for the root. */
export const nodeKey = (id) => nameKey(flat(id))

/** Pure. A node's key in a file name, `root` for the root. */
const stemKey = (id) => (id === ROOT_ID ? 'root' : nodeKey(id))

const BRANCH_PREFIX = 'agentics/'

/** Pure. The branch a node owns: the effort branch for the root, a sibling of it otherwise. */
export const branchOf = (effort, id) =>
  id === ROOT_ID ? BRANCH_PREFIX + effort : BRANCH_PREFIX + effort + '--' + nodeKey(id)

/** Pure. The glob every branch of one effort matches, the effort branch aside. */
export const nodeBranchGlob = (effort) => BRANCH_PREFIX + effort + '--*'

/**
 * Where a branch the framework owns is checked out, absolute and forward-slashed: under
 * `.claude/worktrees/`, named by the branch's name past `agentics/`, bounded by WORKTREE_KEY_MAX.
 */
export const worktreeOfBranch = (repo, branch) =>
  posix(join(resolve(repo), ...WORKTREES_DIR.split('/'), nameKey(branch.slice(BRANCH_PREFIX.length), WORKTREE_KEY_MAX)))

/** The worktree a node's branch is checked out in. */
export const worktreeOf = (repo, effort, id) => worktreeOfBranch(repo, branchOf(effort, id))

// ------------------------------------------------------------------ paths

const mains = new Map()

/** A path's identity on disk: real, forward-slashed, case-folded on Windows. '' when absent. */
function onDisk(p) {
  try {
    const real = posix(realpathSync.native(p))
    return process.platform === 'win32' ? real.toLowerCase() : real
  } catch {
    return ''
  }
}

/**
 * The main working tree that owns `repo`, absolute and forward-slashed. A linked worktree shares
 * its main checkout's common git directory; a submodule's common directory sits in the
 * superproject's `.git/modules/`, and its `core.worktree` names the checkout. A directory that is
 * not the top of a working tree — including one merely nested inside some repository — is its own
 * answer, as is one git cannot read. Memoised per `repo` string.
 */
export function mainCheckout(repo) {
  const key = String(repo)
  if (mains.has(key)) return mains.get(key)
  const here = posix(resolve(key))
  let found = here
  const r = git(key, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'])
  if (r.ok) {
    const [common = '', top = ''] = r.stdout.split('\n').map((line) => line.trim())
    if (common && top && onDisk(top) === onDisk(here)) {
      // The main checkout itself, whose `.git` is the common directory, is its own answer;
      // `core.worktree` could only name it again.
      if (onDisk(common) === onDisk(here + '/.git')) found = here
      else {
        const worktree = git(key, ['config', '--get', 'core.worktree'])
        if (worktree.ok && worktree.stdout.trim()) found = posix(resolve(common, worktree.stdout.trim()))
        else if (common.endsWith('/.git')) found = common.slice(0, -'/.git'.length)
      }
    }
  }
  mains.set(key, found)
  return found
}

export const agenticsRoot = (repo) => join(mainCheckout(repo), AGENTICS_DIR)
export const configPath = (repo) => join(agenticsRoot(repo), CONFIG_FILE)
export const projectStateDir = (repo) => join(agenticsRoot(repo), STATE_DIR)
export const slotsDir = (repo) => join(projectStateDir(repo), 'slots')
export const contextDir = (repo) => join(projectStateDir(repo), 'context')
export const evidenceStoreDir = (repo) => join(projectStateDir(repo), 'evidence')
export const evidenceItemsPath = (repo) => join(evidenceStoreDir(repo), 'items.jsonl')
export const evidenceReturnsDir = (repo) => join(evidenceStoreDir(repo), 'returns')
export const evidenceSnapshotsDir = (repo) => join(evidenceStoreDir(repo), 'snapshots')
export const evidenceAnchorsDir = (repo) => join(evidenceStoreDir(repo), 'anchors')
export const effortsRoot = (repo) => agenticsRoot(repo)
export const effortDir = (repo, effort) => join(agenticsRoot(repo), effort)
export const effortStateDir = (repo, effort) => join(effortDir(repo, effort), STATE_DIR)

/** A folder's directory: the effort's own for the root, its id's segments below it otherwise. */
export const folderDir = (repo, effort, id) =>
  (id === ROOT_ID ? effortDir(repo, effort) : join(effortDir(repo, effort), ...id.split('/')))
export const specPath = (repo, effort, id) => join(folderDir(repo, effort, id), SPEC_FILE)

/** Where a migrated effort's 3.2.0 design documents are kept for the user to read. The dot keeps
 *  the name outside the segment rule, so it never collides with a sub-effort's folder. */
export const legacyDir = (repo, effort) => join(effortDir(repo, effort), '.legacy')

/** Where compile keeps the text it built a folder from, by hash: what a later change is diffed against. */
export const specCopyPath = (repo, effort, id, hash) =>
  join(effortStateDir(repo, effort), 'specs', (id === ROOT_ID ? '_root' : nodeKey(id)) + '@' + hash + '.md')
/** Where a changed spec's brief and its rulings are written, by the hash they were ruled at. */
export const respecPath = (repo, effort, id, hash, what) =>
  posix(join(effortStateDir(repo, effort), 'respec', (id === ROOT_ID ? '_root' : nodeKey(id)) + '@' + hash + '.' + what))

export const executionsRoot = (repo, effort) => join(effortStateDir(repo, effort), 'executions')
export const executionDir = (repo, effort, stamp) => join(executionsRoot(repo, effort), stamp)

/**
 * Create a directory. One under `.agentics/` also gets that root's `.gitignore` of `*`: the
 * framework's state is local to this machine and never belongs in the repository, whatever the
 * repository's own ignore rules say.
 */
export function mkdirState(dir) {
  mkdirSync(dir, { recursive: true })
  const path = posix(resolve(dir)) + '/'
  const at = path.lastIndexOf('/' + AGENTICS_DIR + '/')
  if (at === -1) return
  const ignore = path.slice(0, at + AGENTICS_DIR.length + 1) + '/.gitignore'
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n', 'utf8')
}

const fileStem = (id, role, round) => stemKey(id) + '-' + (role || 'none') + '-r' + round

/** Where leaf-close writes everything it measured and decided for one dispatch. */
export const closePath = (repo, effort, stamp, id, role, round) =>
  posix(join(executionDir(repo, effort, stamp), 'closes', fileStem(id, role, round) + '.json'))

/** Pure. A dispatch key as `dispatchKey` mints it: one path segment, so a record cannot point outside `returns/`. */
const DISPATCH_KEY = /^[A-Za-z0-9][A-Za-z0-9.-]*$/

/** Pure. What a stored return says: its `text`, else its `notes`, else its ruling for `node` (`why`, then `question`). */
function returnSaid(ret, node) {
  const words = (s) => (typeof s === 'string' ? s.trim() : '')
  if (words(ret.text)) return words(ret.text)
  if (words(ret.notes)) return words(ret.notes)
  const ruling = Array.isArray(ret.rulings) ? ret.rulings.find((r) => r && r.node === node) : null
  return ruling ? [words(ruling.why), words(ruling.question)].filter(Boolean).join('\n') : ''
}

/**
 * What a stop, a ruling or a review says (docs/DESIGN.md#node-record-and-events): the line the lib composed
 * (`detail` on an escalation, `question` on a park), then what the dispatch its `said` names
 * returned, read from `executions/<e.execution>/returns/<e.said>.json`. The line alone when the
 * record names no dispatch or its return cannot be read.
 */
export function saidOf(repo, effort, e) {
  if (!e) return ''
  const line = String((e.kind === 'parked' ? e.question : e.kind === 'escalated' ? e.detail : '') || '')
  const named = DISPATCH_KEY.test(String(e.said || '')) && STAMP.test(String(e.execution || ''))
  const ret = named ? readJson(returnPath(executionDir(repo, effort, e.execution), e.said)) : null
  const said = ret && typeof ret === 'object' ? returnSaid(ret, e.node) : ''
  return [line, said].filter(Boolean).join('\n')
}

/** Pure. A commit in a file name: as much of its sha as tells it apart within one execution. */
const shaKey = (sha) => String(sha).slice(0, 10)

/** Where merge-batch writes everything it measured for one batch into `target`, started at `pre`. */
export const mergePath = (repo, effort, stamp, target, pre) =>
  posix(join(executionDir(repo, effort, stamp), 'merges', stemKey(target) + '-' + shaKey(pre) + '.json'))

/** Where the suite gate writes what it measured of `target`'s integration head `head`. */
export const gatePath = (repo, effort, stamp, target, head) =>
  posix(join(executionDir(repo, effort, stamp), 'gates', stemKey(target) + '-' + shaKey(head) + '.json'))

/** Where preflight writes what the ruler reads about the leaves the base branch moved under, at head `now`. */
export const stalePath = (repo, effort, stamp, now) =>
  posix(join(executionDir(repo, effort, stamp), 'stale-' + now + '.md'))

/** Where preflight writes the ruler's brief on adopted work's drift, named by the newest record it covers; its record is the `.json` beside it. */
export const adoptedPath = (repo, effort, stamp, seq) =>
  posix(join(executionDir(repo, effort, stamp), 'merges', 'adopted-' + seq + '.drift.md'))

/** Where leaf-review keeps what one review round of a leaf left open, which the next round reads. */
export const reviewPath = (repo, effort, stamp, id, reviewRound) =>
  posix(join(executionDir(repo, effort, stamp), 'reviews', stemKey(id) + '-r' + reviewRound + '.json'))

// ------------------------------------------------------------------ 5.0 ids and paths

export const AGENTICS_NAMESPACE = '6f6d7a62-6a49-4a8e-9b1f-6167656e7469'

/** Pure. RFC 4122 version-5 UUID (SHA-1) of `name` under `namespace`. */
export function uuidV5(name, namespace = AGENTICS_NAMESPACE) {
  const ns = Buffer.from(String(namespace).replace(/-/g, ''), 'hex')
  const bytes = Buffer.from(createHash('sha1').update(ns).update(String(name), 'utf8').digest().subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const h = bytes.toString('hex')
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-')
}

/** Pure. The host session id of one thread at one generation (docs/DESIGN.md#the-agent-runner). */
export const sessionOf = ({ effort, execution, node, role, thread, gen = 0 }) =>
  uuidV5(canonical({ effort, execution, node, role, thread, gen }))

/** Pure. A dispatch's file-safe key, bounded like every name minted from something that grows. */
export const dispatchKey = ({ node, role, thread, round, attempt = 0 }) =>
  nameKey(([flat(node) || 'root', role, thread, 'r' + round].join('.') + (attempt ? '.' + attempt : '')).replace(/[^A-Za-z0-9.-]+/g, '-'))

export const runsDir = (repo) => join(projectStateDir(repo), 'runs')
export const runDir = (repo, run) => join(runsDir(repo), run)
/** The lock every start of one program over one scope claims its run under. */
export const claimLockPath = (repo, program, scopeKey) => join(runsDir(repo), '.claims', program + '-' + scopeKey + '.lock')

/** Pure. An execution's run id: its effort and its stamp, neither of which holds a `.`. */
export const executionRunId = (effort, stamp) => effort + '.' + stamp

/** Where a run lives: an execution's run id in that execution's directory, any other run id in `runs/<run>`. */
export function runHome(repo, run) {
  const [effort, stamp, more] = String(run).split('.')
  if (more === undefined && safeSlug(effort) === effort && STAMP.test(stamp || '')) {
    return { dir: executionDir(repo, effort, stamp), effort, stamp }
  }
  return { dir: runDir(repo, run), effort: '', stamp: '' }
}

/** A run's log; an execution home's is its `state.jsonl`. */
export const runLogPath = (repo, run) => join(runHome(repo, run).dir, 'state.jsonl')
export const runJsonPath = (repo, run) => join(runHome(repo, run).dir, 'run.json')
export const resultPath = (repo, run) => join(runHome(repo, run).dir, 'result.json')
/** Where a detached run's child writes its stdout and stderr. */
export const runLogFile = (repo, run) => join(runHome(repo, run).dir, 'run.log')
export const returnPath = (dir, dispatch) => join(dir, 'returns', dispatch + '.json')
export const livePath = (dir, dispatch) => join(dir, 'live', dispatch + '.json')

/** Pure. Whether `run` is a run id: one path segment, so a run's directory never climbs. */
export const isRunId = (run) => typeof run === 'string' && /^[a-z0-9][a-z0-9.-]*$/.test(run)

/** Whether `path` names an existing regular file. */
const isFile = (path) => statSync(path, { throwIfNoEntry: false })?.isFile() === true

/**
 * Resolve a name a model typed, or refuse it (docs/DESIGN.md#p2--code-does-what-is-deterministic-models-only-judge).
 * A name that resolves to nothing is refused, never read as an empty thing.
 */
export function resolveHandle(repo, kind, value, { effort = '' } = {}) {
  const v = typeof value === 'string' ? value.trim() : ''
  const ok = { ok: true, value: v }
  const no = (what) => ({ ok: false, error: { kind: 'unknown_' + kind, message: 'no ' + what + ' named ' + JSON.stringify(value) } })
  const inEffort = safeSlug(effort) === effort && effort !== ''
  if (kind === 'effort') return v !== '' && safeSlug(v) === v && existsSync(effortDir(repo, v)) ? ok : no('effort')
  if (kind === 'folder') {
    const fine = inEffort && v !== '' && (v === ROOT_ID || !nodeIdProblem(v)) && existsSync(specPath(repo, effort, v))
    return fine ? ok : no('folder')
  }
  if (kind === 'execution') return inEffort && STAMP.test(v) && existsSync(executionDir(repo, effort, v)) ? ok : no('execution')
  if (kind === 'run') return isRunId(v) && existsSync(runHome(repo, v).dir) ? ok : no('run')
  if (kind === 'file') return v !== '' && isFile(resolve(v)) ? { ok: true, value: resolve(v) } : no('file')
  return { ok: false, error: { kind: 'unknown_kind', message: 'no handle kind ' + JSON.stringify(kind) } }
}

/**
 * A UTC stamp of `now`, to the second: `YYYYMMDD-HHMMSS`.
 */
export function stampNow(now) {
  const d = now instanceof Date ? now : new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
}

export const STAMP = /^\d{8}-\d{6}(-\d+)?$/

/**
 * Pure. A repo-relative, forward-slashed path that cannot climb, or null. Expects, reads, ground
 * and contract paths all pass through here, because each one is later joined to a repository
 * root and handed to git or the filesystem.
 */
export function safePath(value) {
  if (typeof value !== 'string') return null
  const p = posix(value.trim()).replace(/^\.\//, '')
  if (p === '' || p.startsWith('/') || /^[a-z]:/i.test(p)) return null
  if (p.split('/').some((seg) => seg === '..')) return null
  return p
}

/**
 * Pure. Whether a list of path entries (an `expects`, `reads`, `shared`) holds a repo-relative file:
 * an entry names it, or ends in `/` and the file lies under it.
 */
export const inPaths = (entries, file) => {
  const f = posix(file)
  return (Array.isArray(entries) ? entries : []).some((entry) => {
    const e = posix(entry)
    return e.endsWith('/') ? f.startsWith(e) : f === e
  })
}

/** Pure. Whether two path entries can name the same file. */
export const entriesOverlap = (a, b) => inPaths([a], b) || inPaths([b], a)

// Which paths are tests, by a CLOSED table rather than by judgment: verification counts a change's
// tests by it, a test-author of a cycle's test round writes only paths it admits, and its globs are
// the test-file rules of a producer call's permissions (lib/permissions.mjs), so what a call may write and
// what counts as a test agree name for name. A glob is gitignore's, over one file or folder name; a
// folder entry makes everything under a folder of that name a test. A letter written as a set
// (`[tT]`) matches in either case whether or not the host's matcher ignores case.
const caseless = (name) => name.replace(/[a-z]/gi, (c) => '[' + c.toLowerCase() + c.toUpperCase() + ']')
const testName = (name, { folder = false, anyCase = true } = {}) =>
  Object.freeze({ glob: anyCase ? caseless(name) : name, folder })

/** The test-file table, `{glob, folder}` per entry: `isTestPath` and `permissionsFor` read it. */
export const TEST_PATTERNS = Object.freeze([
  testName('test', { folder: true }),
  testName('tests', { folder: true }),
  testName('spec', { folder: true }),
  testName('__tests__', { folder: true }),
  testName('*.test.*'),
  testName('*.spec.*'),
  testName('test_*'),
  testName('*_test.*'),
  // In its own case only: `*test.*` in any case would take `latest.js`.
  testName('*Test.*', { anyCase: false }),
  testName('*Tests.*', { anyCase: false }),
  testName('*Spec.*', { anyCase: false }),
])

/** Pure. A table entry as a regular expression over a repo-relative path. */
function testPathPattern({ glob, folder }) {
  const body = glob.replace(/\[[^\]]*\]|\*|[^[*]+/g, (t) =>
    t === '*' ? '[^/]*' : t.startsWith('[') ? t : t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp('(^|/)' + body + (folder ? '/' : '$'))
}
const TEST_PATH_PATTERNS = TEST_PATTERNS.map(testPathPattern)

/** Pure. Whether a repo-relative path is a test file under the test-file table. */
export const isTestPath = (path) => {
  const p = posix(path)
  return TEST_PATH_PATTERNS.some((re) => re.test(p))
}

// Whether a changed test file ADDS a test case, by a closed set of declaration patterns matched
// on the diff's added lines. A file that adds none is upkeep — existing tests kept working, a call
// site given a new argument — and passes at base by construction, so the discriminator's base
// half is no question for it. The verdict decides what that means; this only records it.
export const TEST_CASE_PATTERNS = [
  /(^|[^\w.$])(it|test)(\.(each|concurrent|only|failing))*[(`]/, // jest, vitest, mocha, node:test
  /(^|\s)(async\s+)?def\s+test\w*\s*\(/,                          // pytest, unittest
  /(^|\s)func\s+Test\w*\s*\(/,                                    // go
  /#\[(\w+::)?test\]/,                                            // rust
  /@(Test|ParameterizedTest|TestFactory)\b/,                      // junit
  /\[(Fact|Theory|Test|TestCase|TestMethod)\b/,                   // xunit, nunit, mstest
]

// ------------------------------------------------------------------ the lock file

/** Sleep without spinning, and without an event loop — the CLIs are synchronous on purpose. */
export function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms))
}

const HOST = hostname()
const STALE_MS = 10 * 60 * 1000

/** Whether a process with this pid is running on this host. */
export const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/**
 * Whether a holder file's holder is gone. A holder on this host is gone exactly when its pid is.
 * A holder on another host (a shared filesystem) cannot be asked, so age decides: ten minutes,
 * because a lock nobody can release is worse than a lock broken late.
 *
 * A holder file never changes once it is in place, so a wait reads each one once (`seen`): on
 * Windows every open of it is a handle that keeps its holder's release pending.
 *
 * Exported for whoever must know whether a lock is held without taking it: the one judgement.
 */
export function holderGone(path, seen) {
  let held = seen.get(path)
  if (!held) {
    try {
      held = JSON.parse(readFileSync(path, 'utf8'))
      seen.set(path, held)
    } catch {
      // Unreadable: a crash truncated it, or on Windows it is being deleted. Age decides.
    }
  }
  // On this host the pid is the whole answer: a live holder is never broken, however long it
  // holds (a merge-batch verifies under its branch lock), and a dead one always is.
  if (held && held.host === HOST && Number.isInteger(held.pid)) return !pidAlive(held.pid)
  try {
    return Date.now() - statSync(path).mtimeMs > STALE_MS
  } catch {
    return false
  }
}

// What a rename onto the lock answers while someone holds it or is releasing it. POSIX refuses a
// non-empty directory as the target; Windows refuses any directory, and for a moment refuses a
// name whose delete is in flight.
const HELD = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EBUSY'])

/** Remove the lock directory if it is empty — its holder released it or was broken. */
function vacate(path) {
  try {
    rmdirSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Remove every holder file in the lock at `path` whose holder is gone, then the directory if that
 * emptied it; whether the lock is free now. A removal names the holder it judged, so a judgement
 * the lock outran — its holder released, another took it — removes nothing: the name is not in
 * the directory at `path` any more, and a directory with a holder in it is never empty. Any error
 * here is a lock mid-release or mid-break, and the next rename decides.
 */
function breakStale(path, seen) {
  let names
  try {
    names = readdirSync(path)
  } catch {
    return false
  }
  for (const name of names) {
    const holder = join(path, name)
    if (!holderGone(holder, seen)) continue
    try {
      rmSync(holder, { force: true })
    } catch {
      return false
    }
  }
  return vacate(path)
}

const LOCK_POLL_MS = 25

/**
 * This acquisition of the lock at `path`. Its holder is a directory beside the lock, `staged`,
 * holding one holder file named for it, `{pid, host, at}`; `seen` is what `stale` has read.
 */
function holderOf(path) {
  const name = process.pid + '-' + randomUUID()
  return { path, name, staged: path + '.' + name, seen: new Map() }
}

/** Build the acquisition's holder beside the lock. */
function stage(lock) {
  mkdirState(dirname(lock.path))
  mkdirSync(lock.staged)
  writeFileSync(join(lock.staged, lock.name), JSON.stringify({ pid: process.pid, host: HOST, at: new Date().toISOString() }))
}

/**
 * One attempt that never waits: whether the lock is this acquisition's now. The holder is renamed
 * onto the lock, and a rename onto a directory with a holder in it fails: that is the atomic step,
 * and a lock is never seen without its holder. A lock whose holders are all gone is broken and
 * tried again at once.
 */
function tryTake(lock) {
  for (;;) {
    // Only a rename decides; the look first spares a held lock the slow refused rename.
    if (!existsSync(lock.path)) {
      try {
        renameSync(lock.staged, lock.path)
        return true
      } catch (err) {
        if (!HELD.has(err.code)) throw err
      }
    }
    if (!breakStale(lock.path, lock.seen)) return false
  }
}

const lockTimeout = (path, waitMs) => new Error('could not take the lock ' + posix(path) + ' within ' + waitMs + 'ms')

/** Drop an acquisition that never took the lock. */
const unstage = (lock) => rmSync(lock.staged, { recursive: true, force: true })

/** Give the lock up: this acquisition's holder file, then the directory if that emptied it. */
function release(lock) {
  rmSync(join(lock.path, lock.name), { force: true })
  vacate(lock.path)
}

/**
 * Run `fn` while holding an exclusive lock on `path`. Waits up to `waitMs` (default 30s), breaking a
 * stale holder; throws when it cannot get the lock in time rather than proceeding without it. The
 * wait blocks the thread: the CLIs are synchronous on purpose.
 */
export function withLock(path, fn, { waitMs = 30000 } = {}) {
  const lock = holderOf(path)
  const until = Date.now() + waitMs
  try {
    stage(lock)
    while (!tryTake(lock)) {
      if (Date.now() > until) throw lockTimeout(path, waitMs)
      sleepMs(LOCK_POLL_MS)
    }
  } catch (err) {
    unstage(lock)
    throw err
  }
  try {
    return fn()
  } finally {
    release(lock)
  }
}

/**
 * `withLock` for a caller whose event loop must keep running: the same lock and holder, each pause
 * of the wait an awaited `sleep(ms)`, the same timeout error as a rejection. `fn` may be async: the
 * lock is held until the promise it returns settles.
 */
export async function withLockAsync(path, fn, { waitMs = 30000, sleep = delay } = {}) {
  const lock = holderOf(path)
  const until = Date.now() + waitMs
  try {
    stage(lock)
    while (!tryTake(lock)) {
      if (Date.now() > until) throw lockTimeout(path, waitMs)
      await sleep(LOCK_POLL_MS)
    }
  } catch (err) {
    unstage(lock)
    throw err
  }
  try {
    return await fn()
  } finally {
    release(lock)
  }
}

// ------------------------------------------------------------------ transport

/** The one printed object every digest-covered CLI emits. */
export const envelope = (payload) => ({ payload, payload_digest: fnv1a(canonical(payload)) })

// ------------------------------------------------------------------ the arguments a skill passes

// A skill's session hands a lib CLI only handles — a path, an id, a sha, an enum, a number, a short
// token — and free text it authors in a line only under a flag its CLI names free text; anything
// longer reaches lib as a file the session wrote, passed by path under that flag's `-file` twin
// (docs/DESIGN.md#p2--code-does-what-is-deterministic-models-only-judge). Every such CLI declares
// its flags' kinds once and asks `handleArgs`, or `argProblem` value by value when it already walks
// its own flags; it reads free text through `textFlag`.

/** A flag token: `--` and a lowercase word. A value that is not one is never taken for a flag. */
const FLAG = /^--[a-z][a-z-]*$/
export const HANDLE_MAX = 200
export const PATH_MAX = 1000
export const TEXT_MAX = 300
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * Pure. Why `value` is not an argument of `kind`, or '' when it is. `handle`: one token, no
 * whitespace, no quote or backtick, at most HANDLE_MAX; `path` (one path or a comma list of them):
 * the same, spaces allowed, at most PATH_MAX; `text` (named free text): one line of at most
 * TEXT_MAX. None may hold a line break or another control character. A text past its line is told
 * to go in a file under `fileFlag`, or, where its CLI has none, to be shortened.
 */
export function argProblem(value, kind, fileFlag = '') {
  const v = String(value)
  if (CONTROL.test(v)) return 'holds a line break or a control character'
  if (kind === 'text') {
    if (v.length <= TEXT_MAX) return ''
    return 'is ' + v.length + ' characters: free text here is one line of at most ' + TEXT_MAX +
      (fileFlag ? '; write it to a file and pass its path with ' + fileFlag : '; shorten it')
  }
  if (/["`]/.test(v)) return 'holds a quote or a backtick'
  if (kind === 'path') return v.length > PATH_MAX ? 'is longer than ' + PATH_MAX + ' characters' : ''
  if (/\s/.test(v)) return 'holds a space'
  return v.length > HANDLE_MAX ? 'is longer than ' + HANDLE_MAX + ' characters' : ''
}

/**
 * Pure. The first argument from `argv[from]` on that the CLI does not take, as a typed refusal
 * `{kind, message, token}`, or null. `kinds` maps each flag the CLI takes (`'--repo'`) to `handle`,
 * `path`, `text` or `switch` (it takes no value), and `_` to the kind of every positional (none is
 * taken without it). The token after a flag is its value unless the flag is a switch or the token
 * is itself a flag token: a text that starts with `--` is a value, and a flag where a value was due
 * is read as a flag. `unknown_flag` names a flag the CLI does not take; `args_unreadable` a value
 * not of its kind, or a positional where none is taken. A text flag is refused naming its `-file`
 * twin when `kinds` holds one, a text positional naming `positionalFile`.
 */
export function handleArgs(argv, kinds, { from = 1, positionalFile = '' } = {}) {
  for (let i = from; i < argv.length; i++) {
    const token = argv[i]
    if (FLAG.test(token)) {
      if (!Object.hasOwn(kinds, token)) return { kind: 'unknown_flag', message: 'no flag ' + token, token }
      if (kinds[token] === 'switch' || i + 1 >= argv.length || FLAG.test(argv[i + 1])) continue
      i += 1
      const why = argProblem(argv[i], kinds[token], Object.hasOwn(kinds, token + '-file') ? token + '-file' : '')
      if (why) return { kind: 'args_unreadable', message: token + ' ' + why, token }
      continue
    }
    if (!kinds._) {
      return { kind: 'args_unreadable', message: 'no positional argument is taken here: ' + JSON.stringify(token.slice(0, 40)), token: token.slice(0, 40) }
    }
    const why = argProblem(token, kinds._, positionalFile)
    if (why) return { kind: 'args_unreadable', message: 'a positional argument ' + why, token: token.slice(0, 40) }
  }
  return null
}

/** Read one `--name value` flag, or '' when absent. Repeated flags: `flags(argv, name)`. */
export const flagOf = (argv, name) => {
  const i = argv.indexOf('--' + name)
  return i === -1 || i + 1 >= argv.length ? '' : argv[i + 1]
}

export const flagsOf = (argv, name) => {
  const out = []
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === '--' + name) out.push(argv[i + 1])
  return out
}

/**
 * Every free text a CLI is given under `--name` (the line itself) and under `--name-file` (the path
 * of a file the session wrote, read whole, CRLF line ends as LF, trimmed), as `{ok: true, values}` or
 * the first file that is none, `{ok: false, error: {kind: 'unknown_file', message}}`.
 */
export function textFlags(argv, name) {
  const values = flagsOf(argv, name)
  for (const path of flagsOf(argv, name + '-file')) {
    const file = resolveHandle('', 'file', path)
    if (!file.ok) return file
    values.push(readFileSync(file.value, 'utf8').replace(/\r\n/g, '\n').trim())
  }
  return { ok: true, values }
}

/** The one free text of `--name` or `--name-file`, '' when neither is given; both is `bad_args`. */
export function textFlag(argv, name) {
  if (argv.includes('--' + name) && argv.includes('--' + name + '-file')) {
    return { ok: false, error: { kind: 'bad_args', message: 'give --' + name + ' or --' + name + '-file, not both' } }
  }
  const out = textFlags(argv, name)
  return out.ok ? { ok: true, value: out.values[0] ?? '' } : out
}

// ------------------------------------------------------------------ git

/** Run git in `cwd`, with `env` merged over the process's environment. Never throws. */
export function git(cwd, args, input, { env } = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input, windowsHide: true, ...(env ? { env: { ...process.env, ...env } } : {}),
  })
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: r.stdout || '',
    stderr: (r.stderr || '') + (r.error ? String(r.error.message) : ''),
  }
}

/** The sha a ref resolves to, or ''. */
export const revParse = (cwd, ref) => {
  const r = git(cwd, ['rev-parse', '--verify', '--quiet', ref + '^{commit}'])
  return r.ok ? r.stdout.trim() : ''
}

/** Whether `path` names one blob at commits `a` and `b`: the same content at both, never two absences. */
export const sameBlob = (cwd, a, b, path, run = git) => {
  const blob = (sha) => run(cwd, ['rev-parse', '--verify', '--quiet', sha + ':' + path])
  const [x, y] = [blob(a), blob(b)]
  return x.ok && y.ok && x.stdout.trim() === y.stdout.trim()
}

/** Whether a local branch exists. */
export const branchExists = (repo, branch) => revParse(repo, 'refs/heads/' + branch) !== ''

/** Read a JSON file, or null. */
export const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Write a JSON state file, creating its directory. */
export function writeJson(path, value) {
  mkdirState(dirname(path))
  writeFileSync(path, JSON.stringify(value), 'utf8')
}

/**
 * Replace a file whole, creating its directory: a string as it is, any other value as JSON, written
 * to a file named with the pid and renamed over `path`, so a reader never sees half of it.
 */
export function writeWhole(path, value) {
  mkdirState(dirname(path))
  const staged = path + '.' + process.pid + '.tmp'
  writeFileSync(staged, typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
  try {
    renameOver(staged, path)
  } catch (err) {
    try {
      rmSync(staged, { force: true })
    } catch {
      // held open too: `sweepStaged` removes it once its writer is gone
    }
    throw err
  }
}

/** A file `writeWhole` stages, named for its writer's pid. */
const STAGED = /\.(\d+)\.tmp$/

/**
 * Remove, under `dir` at any depth, every file `writeWhole` staged whose writer is no longer
 * running: a process killed between its write and its rename leaves one. A writer still alive keeps
 * its own; a file that cannot be removed now is left for the next sweep. The paths removed.
 */
export function sweepStaged(dir, { alive = pidAlive } = {}) {
  const removed = []
  const walk = (at) => {
    let names = []
    try {
      names = readdirSync(at, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of names) {
      const path = join(at, d.name)
      if (d.isDirectory()) walk(path)
      else if (STAGED.test(d.name)) {
        const pid = Number(STAGED.exec(d.name)[1])
        if (pid === process.pid || alive(pid)) continue
        try {
          rmSync(path, { force: true })
          removed.push(path)
        } catch {
          // held open: the next sweep takes it
        }
      }
    }
  }
  walk(dir)
  return removed
}

const RENAME_BUSY = ['EPERM', 'EACCES', 'EBUSY']
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * Rename `from` over `to`. Windows refuses a rename over a file another process holds open for a
 * moment (a status watch reading it, an indexer, antivirus) with EPERM, EACCES or EBUSY: that is
 * retried, waiting 10 ms and doubling, about a second and a quarter in all, before it is thrown.
 */
export function renameOver(from, to, rename = renameSync, pause = sleepSync) {
  for (let wait = 10; ; wait *= 2) {
    try {
      return rename(from, to)
    } catch (err) {
      if (!RENAME_BUSY.includes(err && err.code) || wait > 640) throw err
      pause(wait)
    }
  }
}

/** The project's settings (`.agentics/config.json`, the one file there a person edits); {} when absent or unreadable. */
export function readConfig(repo) {
  const value = readJson(configPath(repo))
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export const exists = existsSync
