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
// `agentics/<effort>--<flat>`, where `flat` spells the id's `/` as `.` — node-id segments carry no
// dot, so the spelling is reversible — and effort slugs carry no `--`, so the prefix is too.

import { spawnSync } from 'node:child_process'
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
  writeSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'

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

/** Pure. The id spelled for a branch or a file name: `a/b/c` → `a.b.c`. */
export const flat = (id) => (id === ROOT_ID ? '' : id.split('/').join('.'))

/** Pure. The branch a node owns: the effort branch for the root, a sibling of it otherwise. */
export const branchOf = (effort, id) =>
  id === ROOT_ID ? 'agentics/' + effort : 'agentics/' + effort + '--' + flat(id)

/** Pure. The glob every branch of one effort matches, the effort branch aside. */
export const nodeBranchGlob = (effort) => 'agentics/' + effort + '--*'

/** The worktree a node's branch is checked out in, absolute and forward-slashed. */
export const worktreeOf = (repo, effort, id) =>
  posix(join(resolve(repo), ...WORKTREES_DIR.split('/'),
    id === ROOT_ID ? effort : effort + '--' + flat(id)))

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

const fileStem = (id, role, round) => (id === ROOT_ID ? 'root' : flat(id)) + '-' + (role || 'none') + '-r' + round

/** Where the brief for one dispatch is written. */
export const briefPath = (repo, effort, stamp, id, role, round) =>
  posix(join(executionDir(repo, effort, stamp), 'briefs', fileStem(id, role, round) + '.md'))

/** Where an executor writes its report for one dispatch. */
export const reportPath = (repo, effort, stamp, id, role, round) =>
  posix(join(effortStateDir(repo, effort), 'reports', stamp + '-' + fileStem(id, role, round) + '.md'))

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

// ------------------------------------------------------------------ the lock file

/** Sleep without spinning, and without an event loop — the CLIs are synchronous on purpose. */
export function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms))
}

const HOST = hostname()
const STALE_MS = 10 * 60 * 1000

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/**
 * Whether a lock file's holder is gone. A holder on this host is gone exactly when its pid is.
 * A holder on another host (a shared filesystem) cannot be asked, so age decides: ten minutes,
 * because a lock nobody can release is worse than a lock broken late.
 */
function stale(path) {
  try {
    const held = JSON.parse(readFileSync(path, 'utf8'))
    // On this host the pid is the whole answer: a live holder is never broken, however long it
    // holds (a merge-batch verifies under its branch lock), and a dead one always is.
    if (held && held.host === HOST && Number.isInteger(held.pid)) return !alive(held.pid)
  } catch {
    // An unreadable lock file is one being written right now, or one a crash truncated. Age decides.
  }
  try {
    return Date.now() - statSync(path).mtimeMs > STALE_MS
  } catch {
    return false
  }
}

/**
 * Run `fn` while holding an exclusive lock file. `wx` creation is the atomic step: exactly one
 * process can create a file that does not exist. Waits up to `waitMs` (default 30s), breaking a
 * stale lock; throws when it cannot get the lock in time rather than proceeding without it.
 */
export function withLock(path, fn, { waitMs = 30000 } = {}) {
  mkdirState(dirname(path))
  const until = Date.now() + waitMs
  let fd = null

  for (;;) {
    try {
      fd = openSync(path, 'wx')
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      if (stale(path)) {
        rmSync(path, { force: true })
        continue
      }
      if (Date.now() > until) throw new Error('could not take the lock ' + posix(path) + ' within ' + waitMs + 'ms')
      sleepMs(25)
    }
  }

  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, host: HOST, at: new Date().toISOString() }))
    closeSync(fd)
    fd = null
    return fn()
  } finally {
    if (fd !== null) closeSync(fd)
    rmSync(path, { force: true })
  }
}

// ------------------------------------------------------------------ transport

/**
 * The text of a `--json-file`: one line of JSON with `~` written `~t` and `\` written `~b`,
 * because the layer between a model's Bash call and the shell decodes backslash escapes even
 * inside a quoted heredoc. Written in heredoc chunks, so every line break is a chunk seam and is
 * dropped (JSON.stringify never emits one).
 */
export const jsonFileText = (text) =>
  text.replace(/\r?\n/g, '').replace(/~([tb])/g, (_, c) => (c === 't' ? '~' : '\\'))

/**
 * Decode the argument object a workflow minted: `--b64 <token>`, `--b64-file <path>`, or
 * `--json-file <path>` (see `jsonFileText`). Checked against `--digest` when one is given.
 * Returns `{value, problem}` — never throws, because a damaged argument is a typed refusal the
 * caller prints, not a crash.
 */
export function decodeArgs(argv) {
  const flag = (name) => {
    const i = argv.indexOf('--' + name)
    return i === -1 || i + 1 >= argv.length ? '' : argv[i + 1]
  }
  const read = (file) => {
    try {
      return { text: readFileSync(file, 'utf8') }
    } catch (err) {
      return { problem: { kind: 'args_unreadable', message: 'could not read ' + file + ': ' + err.message } }
    }
  }

  let json = ''
  const jsonFile = flag('json-file')
  if (jsonFile) {
    const got = read(jsonFile)
    if (got.problem) return { value: null, problem: got.problem }
    json = jsonFileText(got.text)
  } else {
    let token = flag('b64')
    const file = flag('b64-file')
    if (!token && file) {
      const got = read(file)
      if (got.problem) return { value: null, problem: got.problem }
      token = got.text.trim()
    }
    if (!token) return { value: {}, problem: null }
    json = Buffer.from(token, 'base64').toString('utf8')
  }

  let value
  try {
    value = JSON.parse(json)
  } catch (err) {
    return { value: null, problem: { kind: 'args_unreadable', message: 'the argument is not JSON: ' + err.message } }
  }

  const expected = flag('digest')
  const actual = fnv1a(canonical(value))
  if (expected && expected !== actual) {
    return {
      value: null,
      problem: {
        kind: 'digest_mismatch',
        message: 'the caller minted ' + expected + ', the argument decodes to ' + actual +
          ' — the token changed in transit; copy it again exactly',
      },
    }
  }
  return { value, problem: null }
}

/** The one printed object every courier-carried CLI emits. */
export const envelope = (payload) => ({ payload, payload_digest: fnv1a(canonical(payload)) })

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

/** Run git in `cwd`. Never throws. */
export function git(cwd, args, input) {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input, windowsHide: true,
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

/** The project's settings (`.agentics/config.json`, the one file there a person edits); {} when absent or unreadable. */
export function readConfig(repo) {
  const value = readJson(configPath(repo))
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export const exists = existsSync
