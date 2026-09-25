// lib/gc.mjs — the tidy-up after a run is accepted, as a script rather than as an afterthought.
//
// The develop skill has always said what happens once the human accepts the merged result:
// remove each implemented worktree, then delete the order branches. Nothing ever did it. In the
// field it was done by hand — 10 worktrees and 23 branches swept in one afternoon on 2026-08-27,
// 11 stale branches on 2026-08-20 — and one of those sweeps found a test stranded on a branch
// tip whose feature had already shipped without it.
//
// The gate does not move: this runs behind the human's acceptance, exactly where the skill
// already put it. What moves is who performs it.
//
// THE REFERENCE POINT IS THE WHOLE SAFETY. `git branch -d` refuses a branch that is not merged
// into HEAD, which is precisely the property worth having — but only when HEAD is the checkout
// that contains the integration merge. Run from anywhere else it either refuses everything (a
// checkout behind the merge) or, worse, answers a question about a tree nobody meant to ask
// about. So this file establishes the reference point first and refuses to do anything at all
// until it holds.
//
// Everything after that is keyed on ONE property: is this branch in HEAD? A merged branch's
// worktree is pruned and the branch is deleted; an unmerged one keeps both. That single test is
// why nothing here needs to read the run's ledger. An escalated order never merged, so its
// branch and worktree survive without gc being told which orders escalated; a held red whose
// green never landed survives for the same reason. The safety and the salvage are the same
// question asked once.
//
// Scope, deliberately narrow: refs matching `agentics/<runstamp>-*` and the worktrees checked out on
// them. Not the harness's own `wf_*` worktrees, which are shared territory across plugins, and
// not tags — a tag pointing into a deleted branch keeps its commits reachable, which is exactly
// what a salvage marker is for.

import { spawnSync } from 'node:child_process'

import { canonical, fnv1a } from './plan-digest.mjs'

/** Run one git command. Never throws; the caller reads the fields. */
function git(cwd, args) {
  const run = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  return {
    status: run.status === null ? -1 : run.status,
    stdout: (run.stdout || '').trim(),
    stderr: (run.stderr || '').trim(),
    failedToStart: Boolean(run.error),
    message: run.error ? run.error.message : '',
  }
}

const posix = (p) => String(p || '').split('\\').join('/')

/** Worktree path per branch, from git's own porcelain listing. */
function worktreesByBranch(root) {
  const out = new Map()
  const res = git(root, ['worktree', 'list', '--porcelain'])
  if (res.status !== 0) return out

  let path = ''
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('worktree ')) path = posix(line.slice('worktree '.length).trim())
    else if (line.startsWith('branch ')) out.set(line.slice('branch refs/heads/'.length).trim(), path)
  }
  return out
}

/** Exit 0 is yes, 1 is no, anything else is git unable to answer — which is not a no. */
const containedIn = (root, ref, head) => {
  const res = git(root, ['merge-base', '--is-ancestor', ref, head])
  return { yes: res.status === 0, asked: res.status === 0 || res.status === 1 }
}

/**
 * Collect a run's finished worktrees and branches, from the checkout that accepted it.
 *
 * Returns the payload the courier pastes back. Every exit is a value: a reference point that
 * cannot be established is `ok: false` with a reason and an empty ledger of actions, because
 * refusing to sweep is always safe and sweeping from the wrong tree is not.
 */
export function collect(root, runstamp) {
  const kept = []
  const removedWorktrees = []
  const deletedBranches = []
  const refuse = (reason) => ({
    ok: false, runstamp, head: '', integration_branch: '', integration_head: '',
    removed_worktrees: [], deleted_branches: [], kept: [], reason,
  })

  if (!runstamp) return refuse('no runstamp was given, so there is nothing to match branches against')

  const head = git(root, ['rev-parse', 'HEAD'])
  if (head.failedToStart) return refuse('git could not be run: ' + head.message)
  if (head.status !== 0 || !head.stdout) {
    return refuse('the checkout at ' + posix(root) + ' has no readable HEAD: ' +
      (head.stderr || 'git rev-parse HEAD failed'))
  }

  const integrationBranch = 'agentics/' + runstamp + '-integration'
  const integrationHead = git(root, ['rev-parse', integrationBranch])

  if (integrationHead.status !== 0 || !integrationHead.stdout) {
    return refuse('the integration branch ' + integrationBranch + ' is not in this repository, ' +
      'so there is no reference point to judge "merged" against — nothing was swept')
  }

  const contains = containedIn(root, integrationBranch, 'HEAD')
  if (!contains.yes) {
    return refuse('HEAD (' + head.stdout + ') does not contain ' + integrationBranch + ' (' +
      integrationHead.stdout + '). Run this from the checkout that accepted the run: from ' +
      'anywhere else "merged" is a question about a tree nobody meant to ask about, and ' +
      (contains.asked ? 'every branch would be kept for the wrong reason'
        : 'git could not answer the question at all'))
  }

  // Registrations for worktree directories that were already swept by hand. Without this the
  // branches they held still read as "checked out somewhere" and `branch -d` refuses them
  // forever — which is the 2026-08-27 state exactly: trees gone, branches left behind.
  git(root, ['worktree', 'prune'])

  const listed = git(root, ['branch', '--list', 'agentics/' + runstamp + '-*',
    '--format=%(refname:short)'])
  const branches = listed.status === 0 && listed.stdout
    ? listed.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    : []

  const worktrees = worktreesByBranch(root)

  for (const branch of branches) {
    const merged = containedIn(root, branch, 'HEAD')
    const worktree = worktrees.get(branch) || ''
    const sha = git(root, ['rev-parse', branch])

    if (!merged.yes) {
      const why = merged.asked
        ? 'not in HEAD — it holds work this checkout never accepted'
        : 'git could not say whether it is in HEAD, and an unanswered question is not a yes'
      if (worktree) kept.push({ what: 'worktree', branch, path: worktree, reason: why })
      kept.push({ what: 'branch', branch, path: '', reason: why })
      continue
    }

    if (worktree) {
      // Never --force. A dirty tree is the one thing no record vouches for, and the only honest
      // move is to leave it where the human can look at it.
      const removed = git(root, ['worktree', 'remove', worktree])
      if (removed.status === 0) {
        removedWorktrees.push({ branch, path: worktree })
      } else {
        const why = 'its worktree could not be removed: ' +
          (removed.stderr || removed.stdout || 'git worktree remove failed')
        kept.push({ what: 'worktree', branch, path: worktree, reason: why })
        kept.push({ what: 'branch', branch, path: '', reason: why })
        continue
      }
    }

    // `-d`, never `-D`. Git re-asks the merged question against HEAD itself, so the last word
    // on whether a branch is disposable belongs to git rather than to the arithmetic above.
    const deleted = git(root, ['branch', '-d', branch])
    if (deleted.status === 0) deletedBranches.push({ branch, sha: sha.status === 0 ? sha.stdout : '' })
    else {
      kept.push({
        what: 'branch', branch, path: '',
        reason: 'git refused to delete it: ' + (deleted.stderr || deleted.stdout || 'git branch -d failed'),
      })
    }
  }

  return {
    ok: true,
    runstamp,
    head: head.stdout,
    integration_branch: integrationBranch,
    integration_head: integrationHead.stdout,
    removed_worktrees: removedWorktrees,
    deleted_branches: deletedBranches,
    kept,
    reason: '',
  }
}

// ---------------------------------------------------------------- the CLI

const isMain = import.meta.main ??
  (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop()))

if (isMain) {
  const [root, runstamp] = process.argv.slice(2)

  if (!root || !runstamp) {
    console.log(JSON.stringify({ error: 'usage: gc.mjs <repo-root> <runstamp>' }))
    process.exit(1)
  }

  try {
    const payload = collect(root, runstamp)
    console.log(JSON.stringify({ payload, payload_digest: fnv1a(canonical(payload)) }))
    process.exit(payload.ok ? 0 : 1)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
