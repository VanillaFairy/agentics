// lib/search/pin.mjs — the tree a search runs over: a standalone program's own checkout, or an
// execution folder's detached worktree pinned at the head its work stands on.
//
// Design: docs/DESIGN.md#autonomous-review.

import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { detach, worktrees } from '../integration.mjs'
import { ancestorsOf, branchExists, branchOf, git, posix, revParse } from '../store.mjs'

const SHA = /^[0-9a-f]{40}$/

/** The tree of a standalone program: `root`, absolute with posix separators, at its HEAD. */
export function treeOf(root) {
  return { root: posix(resolve(root)), sha: revParse(root, 'HEAD') }
}

/** The sha D2 picks for a folder: the head of the nearest existing integration branch of its chain, else the base. */
export function pinShaOf(xc, folder) {
  const branch = [folder, ...ancestorsOf(folder)].map((id) => branchOf(xc.effort, id)).find((b) => branchExists(xc.repo, b))
  if (branch) return revParse(xc.repo, 'refs/heads/' + branch)
  const base = (xc.envelope() || {}).base_sha
  if (base) return base
  throw new Error('no tree to pin for ' + folder + ': no integration branch of ' + xc.effort + ' exists and the execution has no base_sha')
}

const pinnedDir = (repo) => posix(join(resolve(repo), '.claude', 'worktrees'))

/**
 * The pinned tree of an execution's folder: a detached worktree at `sha` under `.claude/worktrees/`,
 * reused while it is registered, at the sha and clean; anything else at its path — a tree moved
 * or edited, a plain directory, a registration whose folder is gone — is cleared and made again.
 */
export function pinTree(repo, effort, sha) {
  if (!SHA.test(String(sha))) throw new Error(JSON.stringify(sha) + ' is not a commit sha: nothing to pin')
  const root = pinnedDir(repo) + '/search-' + effort + '-' + sha.slice(0, 8)
  const known = worktrees(repo).get(root)
  if (known && known.head === sha && existsSync(root) && git(root, ['status', '--porcelain']).stdout.trim() === '') return { root, sha }
  if (known) git(repo, ['worktree', 'remove', '--force', root])
  rmSync(root, { recursive: true, force: true })
  git(repo, ['worktree', 'prune'])
  const made = git(repo, ['worktree', 'add', '--detach', root, sha])
  if (!made.ok) throw new Error('the search tree at ' + sha + ' could not be made: ' + made.stderr.trim())
  return { root, sha }
}

/**
 * Remove the effort's pinned search trees whose sha `keep` does not hold: each clean one is
 * removed, a dirty one never forced and listed. Only trees named `search-<effort>-<8 hex>` under
 * `.claude/worktrees/` are this effort's.
 */
export function sweepTrees(repo, effort, keep = new Set()) {
  const dir = pinnedDir(repo) + '/'
  const name = new RegExp('^search-' + effort.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-[0-9a-f]{8}$')
  const removed = []
  const dirty = []
  for (const [path, w] of worktrees(repo)) {
    if (!path.startsWith(dir) || !name.test(path.slice(dir.length)) || keep.has(w.head)) continue
    if (detach(repo, path) === 'dirty') dirty.push(path)
    else removed.push(path)
  }
  git(repo, ['worktree', 'prune'])
  return { removed, dirty }
}
