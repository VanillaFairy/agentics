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
      const worktree = git(key, ['config', '--get', 'core.worktree'])
      if (worktree.ok && worktree.stdout.trim()) found = posix(resolve(common, worktree.stdout.trim()))
      else if (common.endsWith('/.git')) found = common.slice(0, -'/.git'.length)
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
/** Where an evidence agent writes its full return, a file per dispatch named by the workflow, for `lib/` to read. */
export const evidenceInboxDir = (repo) => join(evidenceStoreDir(repo), 'inbox')
export const evidenceSnapshotsDir = (repo) => join(evidenceStoreDir(repo), 'snapshots')
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

/** Where the brief for one dispatch is written. */
export const briefPath = (repo, effort, stamp, id, role, round) =>
  posix(join(executionDir(repo, effort, stamp), 'briefs', fileStem(id, role, round) + '.md'))

/** Where an executor writes its report for one dispatch. */
export const reportPath = (repo, effort, stamp, id, role, round) =>
  posix(join(effortStateDir(repo, effort), 'reports', stamp + '-' + fileStem(id, role, round) + '.md'))

/** Where an executor keeps its progress through one dispatch, for the viewer to draw. */
export const progressPath = (repo, effort, stamp, id, role, round) =>
  posix(join(effortStateDir(repo, effort), 'reports', stamp + '-' + fileStem(id, role, round) + '.json'))

/** Where leaf-close writes everything it measured and decided for one dispatch. */
export const closePath = (repo, effort, stamp, id, role, round) =>
  posix(join(executionDir(repo, effort, stamp), 'closes', fileStem(id, role, round) + '.json'))

/**
 * Where the agents of one execution write, in full, what a record only points at: a question for
 * the user, what a blocked executor needs, an analyst's rulings, a review. The author writes it
 * itself, so no courier ever retypes it.
 */
export const saidDir = (repo, effort, stamp) => posix(join(executionDir(repo, effort, stamp), 'said'))

/**
 * What a stop, a ruling or a review says in full: the file its author wrote (`said`), or, when
 * there is none or it cannot be read, the short line on the record itself.
 */
export function saidOf(e) {
  if (!e) return ''
  const line = e.kind === 'parked' ? e.question : e.kind === 'escalated' ? e.detail : e.why
  if (e.said) {
    try {
      const text = readFileSync(e.said, 'utf8').trim()
      if (text) return text
    } catch {
      // The record's own line stands in for a file that is gone.
    }
    if (!line) return '(its author did not write ' + e.said + ')'
  }
  return String(line || '')
}

/** The file a record points at (`said`) when its author wrote it, else ''. */
export const saidFile = (e) => (e && e.said && existsSync(e.said) ? e.said : '')

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

/** Where schedule writes a launch's card, named by `unit`, the node and the digest of its content. */
export const cardPath = (repo, effort, stamp, unit, id, digest) =>
  posix(join(executionDir(repo, effort, stamp), 'cards', unit + '-' + stemKey(id) + '-' + digest + '.json'))

/** Where leaf-review keeps what one review round of a leaf left open, which the next round reads. */
export const reviewPath = (repo, effort, stamp, id, reviewRound) =>
  posix(join(executionDir(repo, effort, stamp), 'reviews', stemKey(id) + '-r' + reviewRound + '.json'))

/** Where whoever decided a node's next round writes the failures that round must clear. */
export const fixesPath = (repo, effort, stamp, id, round) =>
  posix(join(executionDir(repo, effort, stamp), 'fixes', stemKey(id) + '-r' + round + '.json'))

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
 * A UTC stamp, to the second: `YYYYMMDD-HHMMSS`. A workflow script cannot read a clock, so the
 * session mints an execution's stamp with this and passes it in.
 */
export function stampNow(now) {
  const d = now instanceof Date ? now : new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
}

export const STAMP = /^\d{8}-\d{6}(-\d+)?$/

/**
 * Pure. A repo-relative, forward-slashed path that cannot climb, or null. Locus, reads, ground
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
 * Pure. Whether a locus holds a repo-relative file: an entry names it, or ends in `/` and the
 * file lies under it.
 */
export const inLocus = (locus, file) => {
  const f = posix(file)
  return (Array.isArray(locus) ? locus : []).some((entry) => {
    const e = posix(entry)
    return e.endsWith('/') ? f.startsWith(e) : f === e
  })
}

/** Pure. Whether two locus entries can name the same file. */
export const entriesOverlap = (a, b) => inLocus([a], b) || inLocus([b], a)

// Which paths are tests, by a CLOSED table rather than by judgment: verification counts a change's
// tests by it, a test-author round of a cycle writes only paths it admits, and its globs are the
// test-file rules of a producer call's permissions (lib/locus.mjs), so what a call may write and
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
 */
function stale(path, seen) {
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
    if (!stale(holder, seen)) continue
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

// Couriers carry handles, never data (docs/DESIGN.md#p2--code-does-what-is-deterministic-models-only-judge).

/** Keys whose value is a path, which may hold a space; no other handle does. */
const PATH_KEY = /(^|_)(path|file|dir|worktree|brief|record|said|card|context|repo|root|from|fix|hits|plan|frame|assessed|present|history|docs|ground|subtree)s?$/
const HANDLE_MAX = 400

/** Whether `value`, carried under `key`, is a handle: a number, a boolean, or one short line with no space unless it is a path. */
function isHandle(key, value) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return true
  if (typeof value !== 'string') return false
  if (value.length > HANDLE_MAX || /[\r\n\t"`]/.test(value)) return false
  return !/ /.test(value) || PATH_KEY.test(key)
}

/** Every place in `value` that is not a handle, as a dotted key path; [] when it carries handles only. */
function nonHandles(value, at = '') {
  if (Array.isArray(value)) return value.flatMap((v, i) => nonHandles(v, at + '[' + i + ']'))
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => nonHandles(v, at ? at + '.' + k : k))
  }
  const key = at.replace(/\[\d+\]$/, '').split('.').pop()
  return isHandle(key, value) ? [] : [at]
}

/**
 * The one line a courier-carried CLI prints: handles only, under their digest. A payload that
 * carries data is a defect in the CLI, so it throws rather than print one.
 */
export function handleEnvelope(payload) {
  const bad = nonHandles(payload)
  if (bad.length) throw new Error('a courier payload carries data, not handles, at ' + bad.join(', '))
  return envelope(payload)
}

/**
 * The arguments a courier carried: `--name value` flags whose values are handles. `spec` maps
 * each name to `one` (a string, '' when absent), `many` (the flag repeated, an array), `int` or
 * `bool` (`1` or `0`). Checked against `--digest`, taken over `canonical` of the same object, when
 * one is given. Returns `{value, problem}` and never throws: a damaged argument is a typed refusal.
 */
export function handleArgs(argv, spec) {
  const value = {}
  for (const [name, kind] of Object.entries(spec)) {
    if (kind === 'many') value[name] = flagsOf(argv, name)
    else if (kind === 'int') value[name] = Number(flagOf(argv, name) || 0)
    else if (kind === 'bool') value[name] = flagOf(argv, name) === '1'
    else value[name] = flagOf(argv, name)
  }
  const bad = nonHandles(value)
  if (bad.length || Object.values(value).some((v) => Number.isNaN(v))) {
    return { value: null, problem: { kind: 'args_unreadable', message: 'not a handle: ' + bad.join(', ') } }
  }
  const expected = flagOf(argv, 'digest')
  const actual = fnv1a(canonical(value))
  if (expected && expected !== actual) {
    return {
      value: null,
      problem: { kind: 'digest_mismatch', message: 'the caller minted ' + expected + ', the arguments are ' + actual },
    }
  }
  return { value, problem: null }
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
  renameSync(staged, path)
}

/** The project's settings (`.agentics/config.json`, the one file there a person edits); {} when absent or unreadable. */
export function readConfig(repo) {
  const value = readJson(configPath(repo))
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export const exists = existsSync
