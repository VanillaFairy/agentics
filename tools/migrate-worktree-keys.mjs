// tools/migrate-worktree-keys.mjs — the one-shot move of every framework worktree to the bounded
// directory its branch names (docs/DESIGN.md#storage), run once, on the user's go.
//
// Design: docs/DESIGN.md#self-checks (a format change ships a one-shot migration, never a
// permanent second reader).
//
// A worktree under `.claude/worktrees/` holding an `agentics/` branch is moved, with `git worktree
// move`, to `worktreeOfBranch` of that branch when it is not there already. Only a name longer than
// WORKTREE_KEY_MAX moves. Nothing else changes: branches, records and state files never name a
// worktree's directory. A target that exists refuses that worktree. A second run finds nothing to
// do. The default is a dry run; `--yes` moves.

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { worktrees } from '../lib/integration.mjs'
import { git, posix, worktreeOfBranch } from '../lib/store.mjs'

/** The moves a repository needs, without performing them. */
export function plan(repo) {
  const root = resolve(repo)
  const under = posix(join(root, '.claude', 'worktrees')) + '/'
  const out = { root: posix(root), worktrees: [], refused: [] }
  for (const [path, w] of worktrees(root)) {
    if (!w.branch.startsWith('agentics/') || !path.startsWith(under)) continue
    const to = worktreeOfBranch(root, w.branch)
    if (to === path) continue
    if (existsSync(to)) out.refused.push({ branch: w.branch, from: path, why: to + ' exists — the worktree was left where it is' })
    else out.worktrees.push({ branch: w.branch, from: path, to })
  }
  return out
}

/** Perform what the plan lists. */
export function apply(p) {
  for (const w of p.worktrees) {
    const r = git(p.root, ['worktree', 'move', w.from, w.to])
    if (!r.ok) throw new Error('git worktree move ' + w.from + ' failed: ' + r.stderr)
  }
  return { worktrees: p.worktrees.length }
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  const argv = process.argv.slice(2)
  const repo = argv.find((a) => !a.startsWith('--')) || '.'
  const p = plan(repo)
  const applied = argv.includes('--yes')
  if (applied) apply(p)
  console.log(JSON.stringify({ applied, ...p }, null, 1))
}
