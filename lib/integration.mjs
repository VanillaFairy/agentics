// lib/integration.mjs — the branches and worktrees the framework owns, and the merge-batch.
//
// Design: docs/DESIGN.md#integration-branches and docs/DESIGN.md#merging.
//
// Integration is assigned per composite, lazily: a composite gets its branch and worktree the
// first time something needs it, cut from its own parent's integration head, and the effort
// root's branch is the effort branch — the one landed into the user's branch. Nothing here ever
// touches the user's branch or working tree; every git command runs in a worktree under
// `.claude/worktrees/` or reads refs.
//
// Everything is idempotent, because a boundary re-run after an unobserved outcome must converge
// on the same state: a branch that exists is attached, a worktree that exists is reused, a merge
// already contained is skipped.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { mergeBranch } from './merge.mjs'
import {
  ROOT_ID, ancestorsOf, branchExists, branchOf, effortStateDir, git, posix, readJson,
  revParse, worktreeOf, mkdirState,
} from './store.mjs'

/** Whether `a` is an ancestor of (or equal to) `b`. */
export const contains = (repo, b, a) => a !== '' && b !== '' && git(repo, ['merge-base', '--is-ancestor', a, b]).ok

/** Where the effort branch was cut, recorded once when it is created. */
const branchFile = (repo, effort) => join(effortStateDir(repo, effort), 'branch.json')
export const effortBase = (repo, effort) => readJson(branchFile(repo, effort)) || { base_branch: '', base_sha: '' }

/** Worktrees git knows about: path → {branch, head, detached}. */
export function worktrees(repo) {
  const out = new Map()
  const r = git(repo, ['worktree', 'list', '--porcelain'])
  if (!r.ok) return out
  let cur = null
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: posix(line.slice(9).trim()), branch: '', head: '', detached: false }
      out.set(cur.path, cur)
    } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5).trim()
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '')
    else if (cur && line === 'detached') cur.detached = true
  }
  return out
}

/**
 * A worktree with `branch` checked out at `path`, reusing what exists. A branch already checked
 * out at some other path (a dead invocation's leftover) is released from there first when that
 * checkout is clean; a dirty one is never forced, and is reported.
 */
export function attach(repo, branch, path) {
  const known = worktrees(repo)
  const here = known.get(posix(path))
  if (here && here.branch === branch) return { ok: true, path: posix(path) }
  if (here && here.branch !== branch) {
    return { ok: false, error: 'worktree ' + path + ' has ' + (here.branch || 'a detached HEAD') + ' checked out, not ' + branch }
  }
  for (const [other, w] of known) {
    if (w.branch !== branch || other === posix(path)) continue
    const dirty = git(other, ['status', '--porcelain']).stdout.trim()
    if (dirty) return { ok: false, error: branch + ' is checked out, dirty, at ' + other + ' — never forced; a human decides' }
    git(repo, ['worktree', 'remove', other])
  }
  git(repo, ['worktree', 'prune'])
  mkdirState(dirname(path))
  const add = git(repo, ['worktree', 'add', path, branch])
  if (!add.ok) return { ok: false, error: 'git worktree add failed: ' + add.stderr.trim() }
  return { ok: true, path: posix(path) }
}

/**
 * Ensure the integration branch and worktree of `id` (a composite, a design node or the root),
 * creating it cut from its parent's integration head and bringing it up to date with that head
 * when the parent has moved — which is how a leaf's dependency, merged elsewhere in the tree,
 * reaches the branch the leaf is cut from. A group has no branch, so `isGroup` names the ancestors
 * to pass over: a composite inside a group is cut from the group's folder.
 *
 * @returns {{ok, branch, worktree, head, created: string[], refreshed: string[], error?}}
 */
export function ensureIntegration(repo, effort, id, envelope, { lock = (_branch, fn) => fn(), held = '', isGroup = () => false } = {}) {
  const upOf = (at) => ancestorsOf(at).find((a) => !isGroup(a))
  const chain = [...ancestorsOf(id)].filter((a) => !isGroup(a)).reverse().concat(id === ROOT_ID ? [] : [id])
  if (id === ROOT_ID || chain[0] !== ROOT_ID) chain.unshift(ROOT_ID)
  const unique = [...new Set(chain)]
  const created = []
  const refreshed = []

  for (const at of unique) {
    const branch = branchOf(effort, at)
    // Each branch is created, attached and refreshed under its own lock: two leaf-opens under one
    // fresh composite would otherwise both run `git worktree add` for it, and a refresh would race
    // a merge-batch resetting that branch mid-bisect.
    const step = branch === held ? (fn) => fn() : (fn) => lock(branch, fn)
    const done = step(() => ensureOne(repo, effort, at, upOf(at), envelope, created, refreshed))
    if (!done.ok) return done
  }
  const branch = branchOf(effort, id)
  return { ok: true, branch, worktree: worktreeOf(repo, effort, id), head: revParse(repo, 'refs/heads/' + branch), created, refreshed }
}

/** One integration branch: created from its parent's head when absent, attached, refreshed. */
function ensureOne(repo, effort, at, parent, envelope, created, refreshed) {
  {
    const branch = branchOf(effort, at)
    const path = worktreeOf(repo, effort, at)
    if (!branchExists(repo, branch)) {
      let from = ''
      if (at === ROOT_ID) {
        from = envelope.base_sha
        if (!from) return { ok: false, error: 'no base commit to cut the effort branch from' }
        mkdirState(effortStateDir(repo, effort))
        if (!existsSync(branchFile(repo, effort))) {
          writeFileSync(branchFile(repo, effort), JSON.stringify({ base_branch: envelope.base_branch || '', base_sha: from }) + '\n')
        }
      } else {
        from = revParse(repo, 'refs/heads/' + branchOf(effort, parent))
      }
      const made = git(repo, ['branch', branch, from])
      if (!made.ok) return { ok: false, error: 'could not create ' + branch + ': ' + made.stderr.trim() }
      created.push(branch)
    }
    const wt = attach(repo, branch, path)
    if (!wt.ok) return { ok: false, error: wt.error }
    if (at !== ROOT_ID) {
      const parentHead = revParse(repo, 'refs/heads/' + branchOf(effort, parent))
      const head = revParse(repo, 'refs/heads/' + branch)
      if (parentHead && !contains(repo, head, parentHead)) {
        const m = mergeBranch(path, branchOf(effort, parent))
        if (!m.ok) return { ok: false, error: 'refreshing ' + branch + ' from its parent failed: ' + m.reason, conflicts: m.conflicts }
        refreshed.push(branch)
      }
    }
  }
  return { ok: true }
}

/**
 * The commit a leaf's series is measured from, read off the branch alone, so every call on the
 * same branch answers the same: the oldest commit on its first-parent line, from where it left its
 * cycle predecessor, that holds what it took from its parent. For a cycle member refreshed at the
 * cut that is the refresh merge, otherwise the predecessor's head; for any other leaf, the parent
 * head it was last brought up to. See docs/DESIGN.md#integration-branches.
 *
 * @param {{pred?: string, parentHead?: string}} at   `pred`: the cycle predecessor's head
 * @param {Function} [run]   the git runner
 * @returns {string} the base, or '' when git cannot place it
 */
export function leafBase(repo, branch, { pred = '', parentHead = '' }, run = git) {
  const fork = (ref) => {
    const r = run(repo, ['merge-base', branch, ref])
    return r.ok ? r.stdout.trim() : ''
  }
  const took = parentHead ? fork(parentHead) : ''
  if (!pred) return took
  const cut = fork(pred)
  if (!cut || !took) return cut
  const line = run(repo, ['rev-list', '--first-parent', '--reverse', cut + '..' + branch])
  const after = line.ok ? line.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : []
  return [cut, ...after].find((c) => run(repo, ['merge-base', '--is-ancestor', took, c]).ok) || cut
}

/**
 * Ensure a leaf's branch and worktree. A new branch is cut from `from` (the parent's integration
 * head, or a cycle predecessor's head). The parent's head is merged in whenever it has moved — a
 * cycle member's only at the cut — and the base is `leafBase`: the series keeps the leaf's own
 * commits, and its baseline holds what the parent held when it was last merged in.
 * See docs/DESIGN.md#integration-branches.
 *
 * @returns {{ok, branch, worktree, head, base, error?}}
 */
export function ensureLeaf(repo, effort, id, { from, parentBranch, cycleMember = false }) {
  const branch = branchOf(effort, id)
  const path = worktreeOf(repo, effort, id)
  let fresh = false
  if (!branchExists(repo, branch)) {
    const made = git(repo, ['branch', branch, from])
    if (!made.ok) return { ok: false, error: 'could not create ' + branch + ': ' + made.stderr.trim() }
    fresh = true
  }
  const wt = attach(repo, branch, path)
  if (!wt.ok) return { ok: false, error: wt.error }

  // A cycle member takes its parent only at the cut: its series starts past its predecessor's
  // commits, which the parent does not hold, so a later refresh would count them as its own.
  const parentHead = parentBranch ? revParse(repo, 'refs/heads/' + parentBranch) : ''
  if (parentHead && (!cycleMember || fresh) && !contains(repo, revParse(repo, 'refs/heads/' + branch), parentHead)) {
    const m = mergeBranch(path, parentBranch)
    if (!m.ok) return { ok: false, error: 'refreshing ' + branch + ' from ' + parentBranch + ' failed: ' + m.reason }
  }
  const head = revParse(repo, 'refs/heads/' + branch)
  const base = leafBase(repo, branch, { pred: cycleMember ? from : '', parentHead }) || from
  return { ok: true, branch, worktree: posix(path), head, base }
}

/**
 * Merge a batch of approved children into one integration branch, in the order given, with the
 * merge-result contract: success is `stop_reason`, `merged_sha` and `conflicts` together, and a
 * conflict stops the batch. A child whose head the branch already contains is skipped — the
 * batch was re-run after an unobserved outcome.
 *
 * @param {{worktree, units: {ids, branch, head}[]}} batch units merge through one branch each
 *   (a cycle merges through its tip and lands every member)
 * @returns {{merged: {ids, merged_sha}[], conflict: null|{ids, paths, reason}}}
 */
export function mergeUnits(repo, worktree, units) {
  const merged = []
  for (const u of units) {
    const now = revParse(worktree, 'HEAD')
    if (contains(repo, now, u.head)) {
      merged.push({ ids: u.ids, merged_sha: now, already: true })
      continue
    }
    // The branch by name when it is still at the approved head (a readable merge subject), the
    // approved sha otherwise: what merges is what was approved, never what moved since.
    const ref = u.branch && revParse(repo, 'refs/heads/' + u.branch) === u.head ? u.branch : u.head
    const m = mergeBranch(worktree, ref)
    if (!m.ok) return { merged, conflict: { ids: u.ids, paths: m.conflicts || [], reason: m.reason } }
    merged.push({ ids: u.ids, merged_sha: m.merged_sha, already: false })
  }
  return { merged, conflict: null }
}

/** Move an integration branch back to a known green head, in its own worktree. */
export const resetTo = (worktree, sha) => git(worktree, ['reset', '--hard', sha]).ok

/** Files changed between two commits. */
export function changedFiles(repo, from, to) {
  const r = git(repo, ['diff', '--name-only', from, to])
  return r.ok ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []
}

export const readText = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
