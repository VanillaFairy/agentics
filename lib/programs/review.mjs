// lib/programs/review.mjs — the review program: one fresh reviewer over an inline task's change,
// read from a snapshot of the user's working tree in a throwaway worktree, and the exit computed
// from its rulings and the prior round's.
//
// Design: docs/DESIGN.md#execution-modes.

import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { guidanceOf } from '../brief.mjs'
import { reviewBrief } from '../briefs/review.mjs'
import { git, mkdirState, posix, readConfig, readJson, resultPath } from '../store.mjs'
import { reviewExit, unitsOpen } from '../verdict.mjs'
import { coverageOf, dispatch, dispatchJudge, step, threadOf } from './common.mjs'

export const ARGS = {
  base: { kind: 'ref', required: true },
  criteria_file: { kind: 'file', required: true, as: 'criteria' },
  prior: { kind: 'run' },
}

/** Pure. A review is the checkout it reads and the base it reviews from. */
export const scopeOf = (args, { root = '' } = {}) => ({ root: posix(root), base: args.base })

/**
 * The user's tree as it stands, committed on HEAD under the run's private ref through a temporary
 * index, so their tree, index and stash are never touched. Repeating it takes the snapshot again.
 * The temporary index is removed whether or not a step fails.
 */
function snapshotOf(ctx) {
  const index = join(ctx.dir, 'review.index')
  const run = (args) => {
    const r = git(ctx.root, args, undefined, { env: { GIT_INDEX_FILE: index } })
    if (!r.ok) throw new Error('the review could not snapshot the tree: git ' + args.join(' ') + ': ' + r.stderr.trim())
    return r.stdout.trim()
  }
  mkdirState(ctx.dir)
  try {
    run(['read-tree', 'HEAD'])
    run(['add', '-A', '--', '.', ':(exclude).agentics', ':(exclude).claude/worktrees'])
    const tree = run(['write-tree'])
    const sha = run(['commit-tree', tree, '-p', 'HEAD', '-m', 'agentics review snapshot ' + ctx.run])
    const ref = 'refs/agentics/review/' + ctx.run
    run(['update-ref', ref, sha])
    return { ref, sha }
  } finally {
    rmSync(index, { force: true })
  }
}

function dropWorktree(root, path) {
  git(root, ['worktree', 'remove', '--force', path])
  rmSync(path, { recursive: true, force: true })
  git(root, ['worktree', 'prune'])
}

/** A throwaway worktree at the snapshot; one a cut-off run left behind is removed and made again. */
function worktreeAt(ctx, sha) {
  const path = join(ctx.root, '.claude', 'worktrees', 'review-' + ctx.run)
  dropWorktree(ctx.root, path)
  const r = git(ctx.root, ['worktree', 'add', '--detach', path, sha])
  if (!r.ok) throw new Error('the review could not check out its snapshot: ' + r.stderr.trim())
  return path
}

/** Pure. The criteria file's lines, a leading `- [ ] ` or `- ` dropped: the reviewer's numbered from 1, and the user's. */
function criteriaOf(text) {
  const lines = String(text).split('\n').map((l) => l.trim().replace(/^- (\[ \] )?/, '').trim()).filter(Boolean)
  return {
    criteria: lines.filter((l) => !l.startsWith('HUMAN:')).map((text, i) => ({ unit: 'criterion:' + (i + 1), text })),
    human: lines.filter((l) => l.startsWith('HUMAN:')),
  }
}

/** The files the change touches, from the base to the snapshot. */
function filesOf(ctx, base, sha) {
  const r = git(ctx.root, ['diff', '--name-only', '-z', base, sha])
  if (!r.ok) throw new Error('the review could not list the change: ' + r.stderr.trim())
  return r.stdout.split('\0').filter(Boolean)
}

/** The prior round's exit, or `{}` and why it could not be carried. */
function priorOf(ctx, run) {
  if (!run) return { exit: {}, lost: '' }
  const result = readJson(resultPath(ctx.repo, run))
  const exit = result && result.exit && typeof result.exit === 'object' ? result.exit : null
  return exit ? { exit, lost: '' } : { exit: {}, lost: 'the prior run ' + run + ' left no review exit: its open findings were not ruled again' }
}

function resultOf(ctx, { base, snapshot, units, out, exit, failed, lost }) {
  return {
    base, snapshot, units: out.units, findings: out.findings, fix_rulings: out.fix_rulings,
    approved: exit.next === 'approve', open: exit.open.map((f) => f.id), next: exit.next, reason: exit.reason,
    exit: { open: exit.open, unfixed: exit.unfixed, clean_streak: exit.clean_streak },
    coverage: coverageOf({
      incomplete: unitsOpen(units, out.units), failed_channels: failed ? ['reviewer'] : [], unreached: lost ? [lost] : [],
      resumable: ctx.resumable,
    }),
  }
}

export async function review(ctx, args) {
  const snapshot = await step(ctx, 'snapshot', () => snapshotOf(ctx))
  const { criteria, human } = criteriaOf(args.criteria)
  const files = filesOf(ctx, args.base, snapshot.sha)
  const units = [...criteria.map((c) => c.unit), ...files.map((f) => 'file:' + f)]
  const prior = priorOf(ctx, args.prior)
  const brief = reviewBrief({
    base: args.base, sha: snapshot.sha, criteria, files, human, prior: Array.isArray(prior.exit.open) ? prior.exit.open : [],
    guidance: guidanceOf(ctx.root, { config: readConfig(ctx.repo) }),
  })
  const path = worktreeAt(ctx, snapshot.sha)
  try {
    const judge = { session: threadOf(ctx, { role: 'reviewer', thread: 'reviewer' }).session, thread: 'reviewer' }
    const reply = await dispatchJudge({
      producer: { session: ctx.env.CLAUDE_CODE_SESSION_ID || '', thread: 'inline' },
      judge,
      run: () => dispatch(ctx, { role: 'reviewer', schema: 'reviewer', thread: 'reviewer', brief, cwd: path }),
    })
    const failed = reply.status !== 'returned'
    const out = failed ? { units: [], findings: [], fix_rulings: [] } : reply.output
    const exit = reviewExit({ findings: out.findings, verdicts: out.fix_rulings, prior: prior.exit, units, rulings: out.units })
    return resultOf(ctx, { base: args.base, snapshot, units, out, exit, failed, lost: prior.lost })
  } finally {
    dropWorktree(ctx.root, path)
  }
}
