// lib/boundary.mjs — the session's own calls: landing an effort on the user's word, adopting work
// done outside an execution on it, and clearing or annotating a stopped node (`retry`, `note`).
// Every other boundary runs in-process inside the execute program (`lib/boundaries/`).
//
// Design: docs/DESIGN.md#session-calls.
//
// What it never does: touch the user's branch except in `land`, which only the session runs, on
// the user's confirmed go; or repair a record.

import { pathToFileURL } from 'node:url'

import { adopt } from './adopt.mjs'
import { actToken } from './approval.mjs'
import { openExecutions } from './boundaries/execution.mjs'
import { askLine, confirmAct } from './host.mjs'
import { changedFiles, contains, effortBase, worktrees } from './integration.mjs'
import { append } from './ledger.mjs'
import { renderLanding } from './render.mjs'
import { sweepTrees } from './search/pin.mjs'
import {
  ROOT_ID, AGENTICS_DIR, branchOf, flagOf, git, handleArgs, isAncestorOrSelf, nodeBranchGlob, posix, resolveHandle, revParse, safeSlug, saidOf,
  textFlag,
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

/**
 * The flags each session call takes, each by its kind: a skill's session passes handles only, and
 * the one line of `--text` it writes itself, or a file it wrote under `--text-file` (`handleArgs`
 * and `textFlag` in lib/store.mjs, whose walk reads a flag where a value was due as a flag, and a
 * text that starts with `--` as a value).
 */
const SESSION_FLAGS = {
  retry: { '--repo': 'path', '--effort': 'handle', '--node': 'handle' },
  note: { '--repo': 'path', '--effort': 'handle', '--node': 'handle', '--text': 'text', '--text-file': 'path' },
  land: { '--repo': 'path', '--effort': 'handle', '--action': 'handle' },
  adopt: { '--repo': 'path', '--effort': 'handle', '--folder': 'handle', '--map-file': 'path', '--action': 'handle' },
}

const badArg = (flag, verb) => ({ kind: 'bad_arg', message: 'no flag ' + flag + ' for ' + verb })

/** A refusal of a call's arguments as the call prints one: a flag it does not take is `bad_arg`, naming it. */
const argsRefusal = (bad, verb) => (bad.kind === 'unknown_flag' ? badArg(bad.token, verb) : { kind: bad.kind, message: bad.message })

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
 * Adopting on the user's confirmed word (docs/DESIGN.md#the-users-word): the check's token goes to
 * `confirmAct`, and the act is bound to the digest that token named and records who gave it.
 */
export async function adoptAct(repo, effort, folder, mapFile, { env = process.env, stdinIsTTY = false, ask } = {}) {
  const check = adopt(repo, effort, folder, mapFile, 'check')
  if (!check.ok) return check
  const word = await confirmAct({ token: check.token, option: 'Adopt', env, stdinIsTTY, ask })
  if (!word.ok) return word
  return adopt(repo, effort, folder, mapFile, 'act', { by: word.by, askedDigest: check.digest })
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
  sweepTrees(repo, effort)
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
      const bad = handleArgs(argv, SESSION_FLAGS.retry)
      const ctx = bad ? null : sessionContext(repo, effort)
      const ids = argv.filter((a, i) => argv[i - 1] === '--node')
      const out = bad ? { retried: [], error: argsRefusal(bad, name) }
        : retryEscalated(ctx, readTree(ctx.repo, ctx.effort), ids, (id) => holdingExecution(ctx, id))
      console.log(JSON.stringify(out, null, 1))
      process.exit(0)
    }
    if (name === 'note') {
      const bad = handleArgs(argv, SESSION_FLAGS.note)
      const text = bad ? null : textFlag(argv, 'text')
      const ctx = bad ? null : sessionContext(repo, effort)
      const out = bad ? { noted: '', error: argsRefusal(bad, name) }
        : !text.ok ? { noted: '', error: text.error }
          : noteNode(ctx, readTree(ctx.repo, ctx.effort), flagOf(argv, 'node'), text.value)
      console.log(JSON.stringify(out, null, 1))
      process.exit(0)
    }
    if (name === 'land') {
      const bad = handleArgs(argv, SESSION_FLAGS.land)
      if (bad) {
        console.log(JSON.stringify({ ok: false, error: argsRefusal(bad, name) }, null, 1))
        process.exit(0)
      }
      const action = flagOf(argv, 'action')
      const out = action === 'merge'
        ? await landAct(repo, effort, { stdinIsTTY: process.stdin.isTTY === true, ask: askLine })
        : land(repo, effort, action)
      console.log(JSON.stringify(out, null, 1))
      process.exit(0)
    }
    if (name === 'adopt') {
      const bad = handleArgs(argv, SESSION_FLAGS.adopt)
      if (bad) {
        console.log(JSON.stringify({ ok: false, error: argsRefusal(bad, name) }, null, 1))
        process.exit(0)
      }
      sessionContext(repo, effort)
      const file = resolveHandle(repo, 'file', flagOf(argv, 'map-file'))
      if (!file.ok) {
        console.log(JSON.stringify({ ok: false, error: file.error }, null, 1))
        process.exit(0)
      }
      const folder = flagOf(argv, 'folder')
      const action = flagOf(argv, 'action')
      const out = action === 'act'
        ? await adoptAct(repo, effort, folder, file.value, { stdinIsTTY: process.stdin.isTTY === true, ask: askLine })
        : adopt(repo, effort, folder, file.value, action)
      console.log(JSON.stringify(out, null, 1))
      process.exit(0)
    }
    throw new Error('unknown session call ' + JSON.stringify(name) + ': land, adopt, retry or note')
  } catch (err) {
    process.stderr.write(String(err && err.stack ? err.stack : err) + '\n')
    console.log(JSON.stringify({ error: 'program_failed' }))
    process.exit(1)
  }
}
