// lib/boundary.mjs — the session's own calls: landing an effort on the user's word, and clearing or
// annotating a stopped node (`retry`, `note`). Every other boundary runs in-process inside the
// execute program (`lib/boundaries/`).
//
// Design: docs/DESIGN.md#session-calls.
//
// What it never does: touch the user's branch except in `land`, which only the session runs, on
// the user's confirmed go; or repair a record.

import { pathToFileURL } from 'node:url'

import { actToken } from './approval.mjs'
import { openExecutions } from './boundaries/execution.mjs'
import { askLine, confirmAct } from './host.mjs'
import { changedFiles, contains, effortBase, worktrees } from './integration.mjs'
import { append } from './ledger.mjs'
import { renderLanding } from './render.mjs'
import {
  ROOT_ID, AGENTICS_DIR, branchOf, flagOf, git, isAncestorOrSelf, nodeBranchGlob, posix, revParse, safeSlug, saidOf,
} from './store.mjs'
import { claimsOf, isHuman, readTree } from './tree.mjs'

const list = (v) => (Array.isArray(v) ? v : [])

// ------------------------------------------------------------------ retry and note

/**
 * Clear the named nodes' stops: a `replanned` event, reason `retry_escalated`, newer than each
 * stop. A running execution's next schedule sees the node ready again and relaunches it.
 * `executionOf(id)` names the execution each event is recorded under.
 */
function retryEscalated(ctx, tree, ids, executionOf) {
  const retry = list(ids).filter((id) => tree.nodes.has(id))
  if (retry.length === 0) return { retried: [], error: null }
  const r = append(ctx.repo, ctx.effort, 'events', retry.map((id) => ({ kind: 'replanned', node: id, execution: executionOf(id), reason: 'retry_escalated', by: 'session' })))
  return { retried: r.ok ? retry : [], error: r.ok ? null : r.error }
}

/**
 * Record what the session learned about a node: a `noted` event, under the open execution that
 * holds the node. It is an observation, so its actor records it; it is not a status, and no status
 * is derived from it.
 */
function noteNode(ctx, tree, id, text) {
  if (!tree.nodes.has(id)) return { noted: '', error: 'no live node ' + JSON.stringify(id) }
  const said = String(text || '').trim()
  if (!said) return { noted: '', error: '--text must say what was learned' }
  const r = append(ctx.repo, ctx.effort, 'events', [{ kind: 'noted', node: id, execution: holdingExecution(ctx, id), by: 'session', text: said }])
  return { noted: r.ok ? id : '', error: r.ok ? null : r.error }
}

/** The latest open execution whose root is the node or above it, or '' when none holds it. */
function holdingExecution(ctx, id) {
  const held = openExecutions({ ...ctx, execution: '' }).filter((e) => isAncestorOrSelf(e.root, id)).pop()
  return held ? held.stamp : ''
}

/** A session call's context: the effort alone, no execution of its own. */
function sessionContext(repo, effort) {
  if (!safeSlug(effort)) throw new Error('not an effort name: ' + JSON.stringify(effort))
  return { repo: posix(repo), effort }
}

const SESSION_FLAGS = { retry: ['--repo', '--effort', '--node'], note: ['--repo', '--effort', '--node', '--text'] }

/** The first flag of `<verb> --flag value …` that `known` does not hold, or ''. */
function unknownFlag(argv, known) {
  for (let i = 1; i < argv.length; i += 2) if (!known.includes(argv[i])) return argv[i]
  return ''
}

const badArg = (flag, verb) => ({ kind: 'bad_arg', message: 'no flag ' + flag + ' for ' + verb })

// ------------------------------------------------------------------ land

/**
 * Landing: the one ask. `check` reports what the user needs to decide, and the token their answer
 * must hold; `merge` merges the effort branch into the user's checked-out branch, refusing over an
 * open escalation, a parked node or a dirty tree, records who landed it (`by`), and then sweeps the
 * branches it merged. Given `askedHead`, the effort head the user's token named, a branch that has
 * moved on since is refused.
 */
export function land(repo, effort, action, { by = 'user', askedHead } = {}) {
  const tree = readTree(repo, effort)
  const effortBranch = branchOf(effort, ROOT_ID)
  const open = [...tree.status].filter(([, s]) => s.status === 'escalated' || s.status === 'parked')
  const human = [...tree.nodes.values()].flatMap((n) => n.acceptance.filter(isHuman).map((a) => ({ node: n.id, text: a.text })))
  const base = effortBase(repo, effort)
  const head = revParse(repo, 'HEAD')
  const into = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
  const effortHead = revParse(repo, 'refs/heads/' + effortBranch)

  const report = () => {
    const userCommits = base.base_sha && head ? git(repo, ['log', '--oneline', base.base_sha + '..' + head]).stdout.split('\n').filter(Boolean) : []
    const userFiles = base.base_sha && head ? changedFiles(repo, base.base_sha, head) : []
    const effortFiles = base.base_sha && effortHead ? changedFiles(repo, base.base_sha, effortHead) : []
    return {
      action, effort, into, effort_branch: effortBranch, effort_head: effortHead,
      open_escalations: open.filter(([, s]) => s.status === 'escalated').map(([id, s]) => ({ node: id, reason: (s.last && s.last.reason) || '' })),
      parked: open.filter(([, s]) => s.status === 'parked').map(([id, s]) => ({ node: id, question: saidOf(repo, effort, s.last) })),
      human,
      drift: { base_sha: base.base_sha, base_moved: userCommits.length > 0, commits: userCommits, overlap: effortFiles.filter((f) => userFiles.includes(f)) },
      root_status: (tree.status.get(ROOT_ID) || {}).status || 'planned',
      root_claims: claimsOf(tree.events, ROOT_ID),
      landing: renderLanding(repo, effort),
      token: actToken({ act: 'land', effort, hash: effortHead }),
    }
  }

  // A landing that swept its own branch is landed still: asked again, it only sweeps.
  const landedSha = (tree.events.findLast((e) => e.kind === 'landed' && e.node === ROOT_ID) || {}).merged_sha || ''
  const swept = !effortHead && landedSha !== '' && contains(repo, head, landedSha)
  const noBranch = { kind: 'no_effort_branch', message: 'there is no effort branch ' + effortBranch }

  if (action === 'check') {
    if (!effortHead && !swept) return { ...report(), token: '', ok: false, error: noBranch }
    return { ...report(), ok: true }
  }

  if (action === 'merge') {
    const r = report()
    if (askedHead !== undefined && askedHead !== effortHead) {
      return { ...r, ok: false, error: { kind: 'head_moved', message: 'the effort branch is at ' + (effortHead.slice(0, 8) || 'nothing') + ', not at the ' +
        (askedHead.slice(0, 8) || 'nothing') + ' the user was asked to land: ask again' } }
    }
    if (r.open_escalations.length || r.parked.length) return { ...r, ok: false, error: 'never lands over an open escalation or a parked node' }
    const dirty = git(repo, ['status', '--porcelain']).stdout.split('\n')
      .filter((l) => l && !l.slice(3).startsWith('.claude/') && !l.slice(3).startsWith(AGENTICS_DIR + '/'))
    if (dirty.length) return { ...r, ok: false, error: 'the working tree is dirty: ' + dirty.slice(0, 5).join(', ') }
    if (swept) return { ...r, ok: true, merged_sha: landedSha, already: true, ...sweep(repo, effort, head, into) }
    if (!effortHead) return { ...r, ok: false, error: noBranch }
    if (contains(repo, head, effortHead)) {
      // Merged with no record of this head (a landing killed before its record, or a merge by
      // hand, the first or a later one): this call's word records it.
      if (!contains(repo, landedSha, effortHead)) append(repo, effort, 'events', { kind: 'landed', node: ROOT_ID, execution: '', into, merged_sha: head, by })
      return { ...r, ok: true, merged_sha: head, already: true, ...sweep(repo, effort, head, into) }
    }
    // The head as read, never the branch by name: the branch can move on before the merge runs.
    const m = git(repo, ['merge', '--no-ff', '--no-edit', '-m', 'Merge agentics effort ' + effort, effortHead])
    if (!m.ok) {
      git(repo, ['merge', '--abort'])
      return { ...r, ok: false, error: 'the merge failed and was aborted: ' + (m.stderr || m.stdout).trim() }
    }
    const sha = revParse(repo, 'HEAD')
    append(repo, effort, 'events', { kind: 'landed', node: ROOT_ID, execution: '', into, merged_sha: sha, by })
    return { ...r, ok: true, merged_sha: sha, ...sweep(repo, effort, sha, into) }
  }
  return { action, ok: false, error: 'unknown action ' + JSON.stringify(action) + ' — check or merge' }
}

/**
 * Landing on the user's confirmed word (docs/DESIGN.md#the-users-word): the check's token goes to
 * `confirmAct`, and the merge is bound to the effort head that token named and records who gave it.
 */
export async function landAct(repo, effort, { env = process.env, stdinIsTTY = false, ask } = {}) {
  const check = land(repo, effort, 'check')
  if (!check.ok) return check
  const { token, effort_head: askedHead } = check
  const word = await confirmAct({ token, option: 'Land', env, stdinIsTTY, ask })
  if (!word.ok) return word
  return land(repo, effort, 'merge', { by: word.by, askedHead })
}

/**
 * The effort's branches `head` holds, and the clean worktrees on them, removed — from the checkout
 * whose `head` took the landing merge, which is the only place "merged" can be read. `git branch
 * -d` only: a branch git does not see merged is kept, as is a dirty worktree, each with why.
 */
function sweep(repo, effort, head, into) {
  const removed = []
  const kept = []
  git(repo, ['worktree', 'prune'])
  const listed = git(repo, ['branch', '--list', branchOf(effort, ROOT_ID), nodeBranchGlob(effort), '--format=%(refname:short)']).stdout.split('\n').filter(Boolean)
  const known = worktrees(repo)
  for (const branch of listed) {
    if (!contains(repo, head, revParse(repo, 'refs/heads/' + branch))) {
      kept.push({ branch, why: 'not merged into ' + into })
      continue
    }
    const wt = [...known.values()].find((w) => w.branch === branch)
    if (wt) {
      if (git(wt.path, ['status', '--porcelain']).stdout.trim()) {
        kept.push({ branch, why: 'its worktree ' + wt.path + ' is dirty' })
        continue
      }
      const gone = git(repo, ['worktree', 'remove', wt.path])
      if (!gone.ok) {
        kept.push({ branch, why: 'its worktree ' + wt.path + ' could not be removed: ' + gone.stderr.trim() })
        continue
      }
    }
    const d = git(repo, ['branch', '-d', branch])
    if (d.ok) removed.push(branch)
    else kept.push({ branch, why: 'git branch -d refused: ' + d.stderr.trim() })
  }
  return { removed, kept }
}


// ------------------------------------------------------------------ CLI

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  const argv = process.argv.slice(2)
  const [name] = argv
  const repo = flagOf(argv, 'repo') || '.'
  const effort = flagOf(argv, 'effort')
  try {
    if (name === 'retry') {
      const ctx = sessionContext(repo, effort)
      const bad = unknownFlag(argv, SESSION_FLAGS.retry)
      const ids = argv.filter((a, i) => argv[i - 1] === '--node')
      const out = bad ? { retried: [], error: badArg(bad, name) }
        : retryEscalated(ctx, readTree(ctx.repo, ctx.effort), ids, (id) => holdingExecution(ctx, id))
      console.log(JSON.stringify(out, null, 1))
      process.exit(0)
    }
    if (name === 'note') {
      const ctx = sessionContext(repo, effort)
      const bad = unknownFlag(argv, SESSION_FLAGS.note)
      const out = bad ? { noted: '', error: badArg(bad, name) }
        : noteNode(ctx, readTree(ctx.repo, ctx.effort), flagOf(argv, 'node'), flagOf(argv, 'text'))
      console.log(JSON.stringify(out, null, 1))
      process.exit(0)
    }
    if (name === 'land') {
      const action = flagOf(argv, 'action')
      const out = action === 'merge'
        ? await landAct(repo, effort, { stdinIsTTY: process.stdin.isTTY === true, ask: askLine })
        : land(repo, effort, action)
      console.log(JSON.stringify(out, null, 1))
      process.exit(0)
    }
    throw new Error('unknown session call ' + JSON.stringify(name) + ': land, retry or note')
  } catch (err) {
    process.stderr.write(String(err && err.stack ? err.stack : err) + '\n')
    console.log(JSON.stringify({ error: 'program_failed' }))
    process.exit(1)
  }
}
