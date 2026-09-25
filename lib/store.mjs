// lib/store.mjs — where everything agentics writes lives, and the few primitives every writer
// shares: names, paths, the lock file, the argument transport and the printed envelope.
//
// Design: docs/DESIGN.md#storage.
//
// Why one module. Every path under `.claude/agentics/` and every branch name the framework owns
// is computed, never typed, because a name typed in two places is two names the day one of them
// changes. Interrupted work is found by its name — a leaf's branch, an execution's directory —
// so the function that makes the name is also the function that finds it, and there is one.
//
// Why branch names are not `agentics/<effort>/<node-id>`. Git stores a branch as a file under
// `refs/heads/`, so `agentics/e` and `agentics/e/auth` cannot both exist: one would have to be a
// file and a directory at once. Nested node ids collide the same way (`auth` and `auth/session`).
// So the effort branch keeps the short name and every node branch is its sibling:
// `agentics/<effort>--<flat>`, where `flat` spells the id's `/` as `.` — node-id segments carry no
// dot, so the spelling is reversible — and effort slugs carry no `--`, so the prefix is too.

import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { canonical, fnv1a } from './plan-digest.mjs'

export const AGENTICS_DIR = '.claude/agentics'
export const SLOTS_DIR = '.claude/agentics/slots'
export const EFFORTS_DIR = '.claude/agentics/efforts'
export const WORKTREES_DIR = '.claude/worktrees'
export const DESIGNS_DIR = 'docs/agentics/designs'

/** The effort root's node id. Every other id is a `/`-joined path of segments below it. */
export const ROOT_ID = '.'

export const posix = (p) => String(p == null ? '' : p).split('\\').join('/')

// ------------------------------------------------------------------ names

/**
 * Pure. An effort slug this plugin will accept, or null.
 *
 * One path segment, so no traversal; no `--`, so a node branch's prefix is unambiguous.
 */
export function safeSlug(value) {
  if (typeof value !== 'string') return null
  const slug = value.trim()
  if (slug === '' || slug.length > 120) return null
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) return null
  if (slug.includes('..') || slug.includes('--')) return null
  return slug
}

const SEGMENT = /^[a-z0-9][a-z0-9-]*$/

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

export const slotsDir = (repo) => join(repo, ...SLOTS_DIR.split('/'))
export const effortsRoot = (repo) => join(repo, ...EFFORTS_DIR.split('/'))
export const effortDir = (repo, effort) => join(effortsRoot(repo), effort)
export const executionDir = (repo, effort, stamp) => join(effortDir(repo, effort), 'executions', stamp)

const fileStem = (id, role, round) => (id === ROOT_ID ? 'root' : flat(id)) + '-' + (role || 'none') + '-r' + round

/** Where the brief for one dispatch is written. */
export const briefPath = (repo, effort, stamp, id, role, round) =>
  posix(join(executionDir(repo, effort, stamp), 'briefs', fileStem(id, role, round) + '.md'))

/** Where an executor writes its report for one dispatch. */
export const reportPath = (repo, effort, stamp, id, role, round) =>
  posix(join(effortDir(repo, effort), 'reports', stamp + '-' + fileStem(id, role, round) + '.md'))

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
 * Whether a lock file's holder is gone. A holder on this host whose pid no longer exists is gone;
 * so is any holder older than ten minutes, because no step that takes a lock holds it that long
 * (the long waits happen OUTSIDE the lock, by polling) and a lock nobody can release is worse
 * than a lock broken late.
 */
function stale(path) {
  try {
    const held = JSON.parse(readFileSync(path, 'utf8'))
    if (held && held.host === HOST && Number.isInteger(held.pid) && !alive(held.pid)) return true
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
  mkdirSync(dirname(path), { recursive: true })
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
 * Decode the argument object a workflow minted: `--b64 <token>` or `--b64-file <path>`, checked
 * against `--digest` when one is given. Returns `{value, problem}` — never throws, because a
 * damaged argument is a typed refusal the caller prints, not a crash.
 */
export function decodeArgs(argv) {
  const flag = (name) => {
    const i = argv.indexOf('--' + name)
    return i === -1 || i + 1 >= argv.length ? '' : argv[i + 1]
  }

  let token = flag('b64')
  const file = flag('b64-file')
  if (!token && file) {
    try {
      token = readFileSync(file, 'utf8').trim()
    } catch (err) {
      return { value: null, problem: { kind: 'args_unreadable', message: 'could not read ' + file + ': ' + err.message } }
    }
  }
  if (!token) return { value: {}, problem: null }

  let value
  try {
    value = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
  } catch (err) {
    return { value: null, problem: { kind: 'args_unreadable', message: 'the argument token is not base64 JSON: ' + err.message } }
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
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input,
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

export const exists = existsSync
