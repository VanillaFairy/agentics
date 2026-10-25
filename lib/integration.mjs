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

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { readLog } from './ledger.mjs'
import { mergeBranch, mergeForRebase, mergeInProgress, unmergedPaths } from './merge.mjs'
import {
  ROOT_ID, STAMP, ancestorsOf, branchOf, effortStateDir, executionsRoot, git, isTestPath, posix, readJson,
  revParse, worktreeOf, mkdirState,
} from './store.mjs'
import { cycleOf, ownerOf, unitsOf } from './tree.mjs'

const list = (v) => (Array.isArray(v) ? v : [])

/** Whether `a` is an ancestor of (or equal to) `b`. */
export const contains = (repo, b, a) => a !== '' && b !== '' && git(repo, ['merge-base', '--is-ancestor', a, b]).ok

/** Pure. Each integration branch a `merged` record names, with its latest record, by seq. */
function recordedMerges(events) {
  const latest = new Map()
  for (const e of events) if (e.kind === 'merged' && e.into && e.merged_sha && (e.seq || 0) >= ((latest.get(e.into) || {}).seq || 0)) latest.set(e.into, e)
  return latest
}

/**
 * The integration branches that no longer hold their latest recorded merge: gone, or reset under
 * it. Each names the merged head and the local branches that still hold it.
 */
export function lostMerges(repo, events) {
  const out = []
  for (const [branch, e] of recordedMerges(events)) {
    const head = revParse(repo, 'refs/heads/' + branch)
    if (head && contains(repo, head, e.merged_sha)) continue
    const holders = git(repo, ['branch', '--contains', e.merged_sha, '--format=%(refname:short)'])
    out.push({
      branch, exists: head !== '', node: e.node, merged_sha: e.merged_sha,
      reachable_from: holders.ok ? holders.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [],
    })
  }
  return out
}

/** Where the effort branch was cut, recorded once when it is created. */
const branchFile = (repo, effort) => join(effortStateDir(repo, effort), 'branch.json')
export const effortBase = (repo, effort) => readJson(branchFile(repo, effort)) || { base_branch: '', base_sha: '' }

/**
 * Where the effort branch was cut: `branch.json`'s cut when agentics cut it, else the newest
 * execution envelope's base (an effort branch that existed before the first execution has no
 * `branch.json`); empty when neither exists. Preflight and the adopt check read the root's cut here.
 */
export function rootBase(repo, effort) {
  const cut = effortBase(repo, effort)
  if (cut.base_sha) return { base_branch: cut.base_branch || '', base_sha: cut.base_sha }
  let stamps = []
  try {
    stamps = readdirSync(executionsRoot(repo, effort)).filter((s) => STAMP.test(s)).sort().reverse()
  } catch {
    stamps = []
  }
  for (const stamp of stamps) {
    const env = readJson(join(executionsRoot(repo, effort), stamp, 'execution.json'))
    if (env && env.base_sha) return { base_branch: env.base_branch || '', base_sha: env.base_sha }
  }
  return { base_branch: '', base_sha: '' }
}

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
    if (detach(repo, other) === 'dirty') return { ok: false, error: branch + ' is checked out, dirty, at ' + other + ' — never forced; a human decides' }
  }
  // A registration whose folder is gone would refuse the add; nothing else needs a prune.
  if ([...known.keys()].some((p) => !existsSync(p))) git(repo, ['worktree', 'prune'])
  mkdirState(dirname(path))
  const add = git(repo, ['worktree', 'add', path, branch])
  if (!add.ok) return { ok: false, error: 'git worktree add failed: ' + add.stderr.trim() }
  return { ok: true, path: posix(path) }
}

/**
 * Remove the worktree git knows at `path` when it is clean; a dirty one is never forced. The branch
 * stays. Returns `removed`, `dirty` or `absent`.
 */
export function detach(repo, path) {
  if (!worktrees(repo).has(posix(path))) return 'absent'
  if (git(path, ['status', '--porcelain']).stdout.trim()) return 'dirty'
  git(repo, ['worktree', 'remove', path])
  return 'removed'
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
  const created = []
  const refreshed = []
  for (const { branch, run } of integrationSteps(repo, effort, id, envelope, { isGroup })) {
    // Each branch is created, attached and refreshed under its own lock: two leaf-opens under one
    // fresh composite would otherwise both run `git worktree add` for it, and a refresh would race
    // a merge-batch resetting that branch mid-bisect.
    const step = branch === held ? (fn) => fn() : (fn) => lock(branch, fn)
    const done = step(() => run(created, refreshed))
    if (!done.ok) return done
  }
  const branch = branchOf(effort, id)
  return { ok: true, branch, worktree: worktreeOf(repo, effort, id), head: revParse(repo, 'refs/heads/' + branch), created, refreshed }
}

/**
 * The integration branches `id` stands on, the root's first and its own last, each with the step
 * that creates, attaches and refreshes it: `run(created, refreshed)` → `{ok, error?}`. Each step
 * must run under its own branch's lock, one at a time and in this order; `ensureIntegration` runs
 * them under a synchronous lock, a caller whose event loop must keep running awaits its own.
 */
export function integrationSteps(repo, effort, id, envelope, { isGroup = () => false } = {}) {
  const upOf = (at) => ancestorsOf(at).find((a) => !isGroup(a))
  const chain = [...ancestorsOf(id)].filter((a) => !isGroup(a)).reverse().concat(id === ROOT_ID ? [] : [id])
  if (id === ROOT_ID || chain[0] !== ROOT_ID) chain.unshift(ROOT_ID)
  return [...new Set(chain)].map((at) => ({
    branch: branchOf(effort, at),
    run: (created = [], refreshed = []) => ensureOne(repo, effort, at, upOf(at), envelope, created, refreshed),
  }))
}

/** One integration branch: created from its parent's head when absent, attached, refreshed. */
function ensureOne(repo, effort, at, parent, envelope, created, refreshed) {
  {
    const branch = branchOf(effort, at)
    const path = worktreeOf(repo, effort, at)
    const parentHead = at === ROOT_ID ? '' : revParse(repo, 'refs/heads/' + branchOf(effort, parent))
    let head = revParse(repo, 'refs/heads/' + branch)
    if (!head) {
      // Cut again from its base, a branch whose merges are recorded would drop them without a word.
      const recorded = recordedMerges(readLog(repo, effort, 'events').entries).get(branch)
      if (recorded) {
        return { ok: false, error: branch + ' is gone, yet ' + recorded.node + ' is recorded merged into it at ' + recorded.merged_sha.slice(0, 8) +
          ': it is never cut again from its base' }
      }
      let from = parentHead
      if (at === ROOT_ID) {
        from = envelope.base_sha
        if (!from) return { ok: false, error: 'no base commit to cut the effort branch from' }
        mkdirState(effortStateDir(repo, effort))
        if (!existsSync(branchFile(repo, effort))) {
          writeFileSync(branchFile(repo, effort), JSON.stringify({ base_branch: envelope.base_branch || '', base_sha: from }) + '\n')
        }
      }
      const made = git(repo, ['branch', branch, from])
      if (!made.ok) return { ok: false, error: 'could not create ' + branch + ': ' + made.stderr.trim() }
      created.push(branch)
      head = revParse(repo, 'refs/heads/' + branch)
    }
    const wt = attach(repo, branch, path)
    if (!wt.ok) return { ok: false, error: wt.error }
    if (at !== ROOT_ID) {
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

const revOf = (repo, run) => (ref) => {
  const r = run(repo, ['rev-parse', '--verify', '--quiet', ref + '^{commit}'])
  return r.ok ? r.stdout.trim() : ''
}

/**
 * The paths leaf `id`'s branch changed since it was cut from its folder's integration branch, a
 * rename as both its paths; a cycle member's since its red's cut, so a cycle reads as one change.
 * Read at `at` (the branch head when none is given); [] while the branch or its folder's does not exist.
 */
export function leafNet(repo, effort, nodes, id, at = '') {
  const cycle = cycleOf(nodes, id)
  const head = at || revParse(repo, 'refs/heads/' + branchOf(effort, id))
  const parent = revParse(repo, 'refs/heads/' + branchOf(effort, ownerOf(nodes, cycle[0] || id)))
  if (!head || !parent) return []
  const cut = git(repo, ['merge-base', head, parent])
  if (!cut.ok) return []
  const r = git(repo, ['diff', '--name-only', '--no-renames', cut.stdout.trim(), head])
  return r.ok ? r.stdout.split('\n').map((l) => posix(l.trim())).filter(Boolean) : []
}

/** The test files the cycle's red changed on its branch: what a green is measured on, and its test round's brief lists. */
export const cycleTests = (repo, effort, nodes, id) => {
  const red = cycleOf(nodes, id)[0]
  return red ? leafNet(repo, effort, nodes, red).filter(isTestPath) : []
}

/**
 * Where composite `id`'s own work lies on its integration branch: its `head`, the heads its cut
 * does not count (`parentHead`; the root's `baseHead`), the `cut` and the `^`-exclusions that walk
 * from it. Null when the branch does not exist. A cut git cannot place (a failed merge-base, a
 * parent branch gone, a root with no recorded base) is `error`, never an empty cut: that would
 * read the whole history as the folder's. Both the accounted-commits walk and the adoption check
 * read it, so they never disagree about what is the folder's.
 */
export function folderSpan(repo, effort, id, { nodes, base = { base_branch: '', base_sha: '' } }, run = git) {
  const branch = branchOf(effort, id)
  const rev = revOf(repo, run)
  const head = rev('refs/heads/' + branch)
  if (!head) return null
  const isRoot = id === ROOT_ID
  const parentHead = isRoot ? '' : rev('refs/heads/' + branchOf(effort, ownerOf(nodes, id)))
  const baseHead = isRoot && base.base_branch ? rev('refs/heads/' + base.base_branch) : ''
  let cut = isRoot ? base.base_sha || '' : ''
  let error = ''
  if (isRoot) {
    if (!cut) error = 'no cut is known for ' + branch + ': it has no recorded base'
  } else if (!parentHead) {
    error = 'the parent of ' + branch + ' has no integration branch to cut it from'
  } else {
    const mb = run(repo, ['merge-base', head, parentHead])
    if (mb.ok && mb.stdout.trim()) cut = mb.stdout.trim()
    else error = 'cannot find where ' + branch + ' left its parent: ' + String(mb.stderr || '').trim()
  }
  return { branch, head, parentHead, baseHead, cut, error, exclude: [cut, baseHead].filter(Boolean).map((c) => '^' + c) }
}

/**
 * The heads that account for the commits a merge brought into composite `id`'s branch: every
 * `merged` or `approved` leaf head a record names, and each child composite's branch head (a merge
 * killed before its record leaves only these).
 */
export function accountingHeads(repo, effort, id, { nodes, events }, run = git) {
  const rev = revOf(repo, run)
  const heads = new Set()
  for (const e of list(events)) {
    if (e && (e.kind === 'merged' || e.kind === 'approved') && typeof e.head_sha === 'string' && e.head_sha) heads.add(e.head_sha)
  }
  for (const k of unitsOf(nodes, id)) {
    if (nodes.get(k).kind === 'leaf') continue
    const h = rev('refs/heads/' + branchOf(effort, k))
    if (h) heads.add(h)
  }
  return heads
}

/**
 * The commits on composite `id`'s integration branch no record accounts for, walked along its
 * first-parent line from its cut to its head: null when the branch does not exist. A merge is
 * reported by its own sha. A git read that fails is `error`, never an empty list.
 * See docs/DESIGN.md#integration-branches.
 */
export function unaccountedOf(repo, effort, id, { nodes, events, base }, run = git) {
  const span = folderSpan(repo, effort, id, { nodes, base }, run)
  if (!span) return null
  const { branch, head, parentHead, baseHead } = span
  if (span.error) return { branch, commits: [], error: span.error }
  const holds = (b, a) => a !== '' && b !== '' && run(repo, ['merge-base', '--is-ancestor', a, b]).ok
  const walk = run(repo, ['rev-list', '--first-parent', '--reverse', '--parents', head, ...span.exclude])
  if (!walk.ok) return { branch, commits: [], error: 'cannot walk ' + branch + ': ' + String(walk.stderr || '').trim() }

  const named = new Set()
  for (const e of list(events)) {
    if (!e || typeof e !== 'object') continue
    if (e.kind === 'merged' || e.kind === 'outside') for (const c of list(e.commits)) named.add(c)
    if (e.kind === 'merged' && e.merged_sha) named.add(e.merged_sha)
  }
  const heads = accountingHeads(repo, effort, id, { nodes, events }, run)

  const commits = []
  for (const line of walk.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const [sha, first, ...others] = line.split(' ')
    if (named.has(sha)) continue
    if (others.length && others.every((p) => holds(parentHead, p) || holds(baseHead, p))) continue
    if (others.length) {
      const input = [...others, '^' + first, ...[...heads].map((h) => '^' + h)].join('\n') + '\n'
      const brought = run(repo, ['rev-list', '--stdin', '--ignore-missing'], input)
      if (!brought.ok) return { branch, commits: [], error: 'cannot read what ' + sha + ' merged: ' + String(brought.stderr || '').trim() }
      if (brought.stdout.split('\n').map((l) => l.trim()).filter(Boolean).every((c) => named.has(c))) continue
    }
    commits.push(sha)
  }
  return { branch, commits, error: '' }
}

/**
 * Ensure a leaf's branch and worktree. A new branch is cut from `from` (the parent's integration
 * head, or a cycle predecessor's head). The parent's head is merged in whenever it has moved — a
 * cycle member's only at the cut — and the base is `leafBase`: the series keeps the leaf's own
 * commits, and its baseline holds what the parent held when it was last merged in.
 * See docs/DESIGN.md#integration-branches.
 *
 * A rebase round (`rebase`) keeps a conflicting refresh in the worktree for its producer instead of
 * refusing it, and an open run again takes a merge already in progress as that refresh.
 *
 * @returns {{ok, branch, worktree, head, base, conflicts, error?}}
 */
export function ensureLeaf(repo, effort, id, { from, parentBranch, cycleMember = false, rebase = false }) {
  const branch = branchOf(effort, id)
  const path = worktreeOf(repo, effort, id)
  let head = revParse(repo, 'refs/heads/' + branch)
  const fresh = !head
  if (fresh) {
    const made = git(repo, ['branch', branch, from])
    if (!made.ok) return { ok: false, error: 'could not create ' + branch + ': ' + made.stderr.trim() }
    head = revParse(repo, 'refs/heads/' + branch)
  }
  const wt = attach(repo, branch, path)
  if (!wt.ok) return { ok: false, error: wt.error }

  // A cycle member takes its parent only at the cut: its series starts past its predecessor's
  // commits, which the parent does not hold, so a later refresh would count them as its own.
  // A merge in progress is a rebase round's, left for its producer: it is the refresh.
  const parentHead = parentBranch ? revParse(repo, 'refs/heads/' + parentBranch) : ''
  const conflicts = mergeInProgress(path) ? unmergedPaths(path) : []
  if (!mergeInProgress(path) && parentHead && (!cycleMember || fresh) && !contains(repo, head, parentHead)) {
    const m = rebase ? mergeForRebase(path, parentBranch) : mergeBranch(path, parentBranch)
    if (!m.ok) return { ok: false, error: 'refreshing ' + branch + ' from ' + parentBranch + ' failed: ' + m.reason }
    if (m.merged_sha) head = m.merged_sha
    conflicts.push(...m.conflicts)
  }
  // A rebase round's series is measured from what it merges: once the producer concludes the merge,
  // that head is where its own work starts.
  const merging = mergeInProgress(path) ? revParse(path, 'MERGE_HEAD') : ''
  const base = merging || leafBase(repo, branch, { pred: cycleMember ? from : '', parentHead }) || from
  return { ok: true, branch, worktree: posix(path), head, base, conflicts }
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
