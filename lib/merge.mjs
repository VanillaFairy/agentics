// lib/merge.mjs — the merge, as a script rather than as a model's discretion.
//
// Merging an approved branch into the run's integration worktree is entirely deterministic:
// run `git merge --no-ff`, and either it produced a commit or it produced conflicts. There is
// no judgement anywhere in it. It was nevertheless an instruction in a prompt — "run this,
// and NEVER resolve a conflict" — which is a rule enforced by the obedience of a model
// trained to be helpful, at the one point in the pipeline where being helpful is catastrophic.
//
// A silently resolved conflict does not look like a failure downstream. It produces a real
// sha, the wave verification runs against a tree that builds, and every later wave is built on
// a merge nobody reviewed and nobody knows happened. The loci in a wave were declared pairwise
// disjoint, so a conflict means the plan's independence declaration was wrong — a planner
// defect a human needs to see, not a merge for an agent to negotiate.
//
// So the abort is a `git merge --abort` in this file, and the agent's only job is to run the
// command and paste what it printed. Same shape as every boundary: a payload plus a
// digest the caller recomputes, because bytes never ride a model.

import { spawnSync } from 'node:child_process'

/** Run one git command in a worktree. Never throws; the caller reads the fields. */
function git(worktree, args) {
  const run = spawnSync('git', ['-C', worktree, ...args], { encoding: 'utf8', windowsHide: true })
  return {
    status: run.status === null ? -1 : run.status,
    stdout: (run.stdout || '').trim(),
    stderr: (run.stderr || '').trim(),
    failedToStart: Boolean(run.error),
    message: run.error ? run.error.message : '',
  }
}

/**
 * Which paths a failed merge left conflicted.
 *
 * `--diff-filter=U` is git's own answer rather than a parse of merge output, which varies by
 * version and locale. An empty list from a failed merge is itself reported — "the merge failed
 * and git names no conflicted path" is a different fact from "these three files conflict", and
 * collapsing them would send a human looking for a conflict that is not there.
 */
function conflictedPaths(worktree) {
  const out = git(worktree, ['diff', '--name-only', '--diff-filter=U'])
  return out.status === 0 && out.stdout ? out.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []
}

/**
 * Merge `branch` into whatever `worktree` has checked out.
 *
 * Returns the payload `lib/integration.mjs` reads. Every exit is a value: a merge that could not
 * even start is `ok: false` with a reason, exactly like one that conflicted, because both mean
 * the integration head did not move and the caller must not advance it.
 */
export function mergeBranch(worktree, branch, expectHead = '') {
  const before = git(worktree, ['rev-parse', 'HEAD'])

  if (before.failedToStart || before.status !== 0) {
    return {
      ok: false, merged_sha: '', head_before: '', conflicts: [],
      reason: 'the worktree could not be read: ' +
        (before.message || before.stderr || 'git rev-parse HEAD failed'),
    }
  }

  // A caller that names the head it believes it is merging into gets that belief checked. The
  // integration head is the one piece of state every later wave builds on, and a merge onto an
  // unexpected head is a merge into somebody else's work.
  if (expectHead && before.stdout !== expectHead) {
    return {
      ok: false, merged_sha: '', head_before: before.stdout, conflicts: [],
      reason: 'the worktree is at ' + before.stdout + ' but the caller expected ' + expectHead +
        ' — something moved this branch since the caller last looked',
    }
  }

  const merge = git(worktree, ['merge', '--no-ff', '--no-edit', branch])

  if (merge.failedToStart) {
    return {
      ok: false, merged_sha: '', head_before: before.stdout, conflicts: [],
      reason: 'git could not be run: ' + merge.message,
    }
  }

  if (merge.status !== 0) {
    const conflicts = conflictedPaths(worktree)
    // Aborted here, unconditionally. Leaving a conflicted index behind invites the next thing
    // that touches this worktree to finish the merge by hand, which is the outcome this whole
    // file exists to make impossible.
    const abort = git(worktree, ['merge', '--abort'])

    return {
      ok: false,
      merged_sha: '',
      head_before: before.stdout,
      conflicts,
      reason: (conflicts.length > 0
        ? 'the merge conflicted in ' + conflicts.length + ' path(s)'
        : 'the merge failed and git named no conflicted path') +
        ': ' + (merge.stderr || merge.stdout || 'no output') +
        (abort.status === 0 ? '' : ' — AND the abort failed, so this worktree needs a human'),
      aborted: abort.status === 0,
    }
  }

  const after = git(worktree, ['rev-parse', 'HEAD'])

  if (after.status !== 0 || !after.stdout) {
    return {
      ok: false, merged_sha: '', head_before: before.stdout, conflicts: [],
      reason: 'the merge reported success and the resulting head could not be read back',
    }
  }

  // Read back rather than predicted. The caller advances the integration head to this value
  // and every later wave is built on it.
  return {
    ok: true,
    merged_sha: after.stdout,
    head_before: before.stdout,
    conflicts: [],
    reason: '',
  }
}
