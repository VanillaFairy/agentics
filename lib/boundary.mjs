// lib/boundary.mjs — the session's own calls: landing an effort on the user's word, adopting work
// done outside an execution on it, clearing or annotating a stopped node (`retry`, `note`) and
// accepting the drift an integration review found (`accept`), ruling a leaf's non-discriminating
// test files regression nets (`net`), and pausing and resuming a running execution (`pause`, `resume`).
// Every other boundary runs in-process inside the execute program (`lib/boundaries/`).
//
// Design: docs/DESIGN.md#session-calls.
//
// What it never does: touch the user's branch except in `land`, which only the session runs, on
// the user's confirmed go; or repair a record.

import { pathToFileURL } from 'node:url'

import { adopt } from './adopt.mjs'
import { actToken } from './approval.mjs'
import { openExecutions, pausedAt } from './boundaries/execution.mjs'
import { parked } from './boundaries/records.mjs'
import { askLine, confirmAct } from './host.mjs'
import { changedFiles, contains, effortBase, worktrees } from './integration.mjs'
import { append, readLog, runState } from './ledger.mjs'
import { renderLanding } from './render.mjs'
import { launch } from './run.mjs'
import { sweepTrees } from './search/pin.mjs'
import {
  ROOT_ID, AGENTICS_DIR, branchOf, executionDir, flagOf, git, handleArgs, isAncestorOrSelf, nodeBranchGlob, posix, readJson, resolveHandle,
  returnPath, revParse, runHome, safeSlug, saidOf, specPath, textFlag,
} from './store.mjs'
import { claimsOf, isHuman, readTree, standingReview, unsettledClaims } from './tree.mjs'
import { integrationPark, netsIn, netsOf, retires } from './verdict.mjs'

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

const DRIFT = ['under', 'over', 'deviates']
const declined = (kind, message) => ({ ok: false, error: { kind, message } })

/**
 * The session's acceptance of drift claims an integration review found (docs/DESIGN.md#session-calls):
 * `input` is `{claims: [{claim, why}]}`, each `claim` as the folder's standing review records it.
 * Records one `claims` event under the review's execution, the accepted claims' ruling `accepted`
 * with the ruling they had and the reason, and, when what remains still earns a park, that park.
 * Refuses, writing nothing, where the verdict is not the session's to give: see the `kind`s.
 */
export function acceptDrift(repo, effort, folder, input) {
  const tree = readTree(repo, effort)
  const node = tree.nodes.get(folder)
  if (!node || node.kind !== 'composite') return declined('not_a_folder', JSON.stringify(folder) + ' is not a live composite: only a folder has an integration review')
  const review = standingReview(tree.nodes, tree.events, folder)
  if (!review || review.review !== 'done') return declined('no_review', 'no integration review of ' + folder + ' stands')
  const now = tree.status.get(folder) || {}
  const stop = now.status === 'parked' ? now.last : null
  if (!stop || stop.return !== 'integration_critical' || !review.said || stop.said !== review.said) {
    return declined('not_a_drift_park', folder + " is not parked integration_critical by the review that stands: only that park is the session's to judge")
  }
  const ret = review.execution ? readJson(returnPath(executionDir(repo, effort, review.execution), review.said)) : null
  if (!ret || typeof ret !== 'object') return declined('no_return', "the review's stored return is gone, so no critical finding can be ruled out")
  if (list(ret.findings).some((f) => f && f.severity === 'critical' && !retires(f)) || list(review.open).length) {
    return declined('critical_finding', 'the review found a critical, or left one open: a critical is never accepted')
  }
  const listed = input && Array.isArray(input.claims) ? input.claims : null
  if (!listed) return declined('bad_file', 'the file holds no claims list: {claims: [{claim, why}]}')
  if (listed.length === 0) return declined('no_claims', 'no claim is listed')
  const why = new Map()
  for (const c of listed) {
    const text = c && typeof c.claim === 'string' ? c.claim : ''
    const reason = c && typeof c.why === 'string' ? c.why.trim() : ''
    if (why.has(text)) return declined('bad_file', 'the claim is listed twice: ' + JSON.stringify(text))
    const ruled = review.claims.find((r) => r.claim === text)
    if (!ruled) return declined('not_acceptable', 'the review made no such claim: ' + JSON.stringify(text))
    if (!DRIFT.includes(ruled.ruling)) return declined('not_acceptable', 'only a drift is accepted, and this claim was ruled ' + ruled.ruling + ': ' + JSON.stringify(text))
    if (!reason) return declined('no_reason', 'an acceptance records why: ' + JSON.stringify(text))
    why.set(text, reason)
  }
  const accepted = []
  const claims = review.claims.map((c) => {
    if (!why.has(c.claim) || !DRIFT.includes(c.ruling)) return c
    accepted.push({ claim: c.claim, was: c.ruling, why: why.get(c.claim) })
    return { claim: c.claim, ruling: 'accepted' }
  })
  const park = integrationPark([], claims, posix(specPath(repo, effort, folder)))
  const at = { node: folder, execution: review.execution }
  const records = [
    { kind: 'claims', ...at, head_sha: review.head_sha, review: 'done', claims, open: list(review.open), said: review.said, ...(review.anchors ? { anchors: review.anchors } : {}), accepted: [...list(review.accepted), ...accepted], by: 'session' },
    ...(park ? [{ kind: 'parked', ...at, ...parked(folder, park.why, park.question, review.said).fields }] : []),
  ]
  const out = append(repo, effort, 'events', records)
  return out.ok ? { ok: true, accepted_n: accepted.length, park: park ? park.why : null } : declined('append_failed', String(out.error))
}

/**
 * The user's ruling, recorded by the session, that test files of a leaf escalated
 * `discriminator_undecidable` are regression nets (docs/DESIGN.md#session-calls): `input` is
 * `{nets: [{file, why}]}`, each `file` a changed test file the measurement behind the escalation
 * found passing now and passing at base. Records one `nets` event, each net keyed by the file's blob
 * in that measurement (`netsOf`); `all` in the answer when no file that adds a test is left to
 * discriminate there. Refuses, writing nothing, where the ruling is not the session's to record: see
 * the `kind`s.
 */
export function ruleNets(repo, effort, id, input) {
  const tree = readTree(repo, effort)
  const leaf = tree.nodes.get(id)
  if (!leaf || leaf.kind !== 'leaf') return declined('not_a_leaf', JSON.stringify(id) + ' is not a live leaf')
  const now = tree.status.get(id) || {}
  const stop = now.status === 'escalated' ? now.last : null
  if (!stop || stop.reason !== 'discriminator_undecidable') {
    return declined('not_undecidable', id + ' is not escalated discriminator_undecidable: only that stop is ruled this way')
  }
  const measured = readLog(repo, effort, 'journal:' + stop.execution).entries
    .filter((e) => e.kind === 'verify-observed' && e.node === id && e.seq < stop.seq).pop()
  if (!measured || !measured.head_sha) return declined('no_measurement', 'the measurement ' + id + ' escalated on is not in its journal')
  const disc = list(measured.discriminator)
  const listed = input && Array.isArray(input.nets) ? input.nets : null
  if (!listed) return declined('bad_file', 'the file holds no nets list: {nets: [{file, why}]}')
  if (listed.length === 0) return declined('no_nets', 'no test file is listed')
  const nets = []
  for (const n of listed) {
    const file = n && typeof n.file === 'string' ? n.file : ''
    const why = n && typeof n.why === 'string' ? n.why.trim() : ''
    if (nets.some((x) => x.file === file)) return declined('bad_file', 'the file is listed twice: ' + JSON.stringify(file))
    const d = disc.find((x) => x && x.test_id === file)
    if (!d) return declined('not_measured', 'the measurement names no changed test file ' + JSON.stringify(file))
    if (!d.passes_now || d.failed_on_base) {
      return declined('not_a_net', file + ' is ' + (d.passes_now ? 'a test that discriminates' : 'not passing now') + ': only a file that passes at base and now is a net')
    }
    if (!why || /[\r\n]/.test(why)) return declined('no_reason', 'a net records why, on one line: ' + JSON.stringify(file))
    // A net keyed by no blob would stand nowhere, and the leaf would escalate on the file again.
    if (!d.blob) return declined('no_blob', 'the measurement records no blob of ' + file + ': measure the leaf again (retry), then rule')
    nets.push({ file, blob: d.blob, why })
  }
  const out = append(repo, effort, 'events', [{ kind: 'nets', node: id, execution: stop.execution, head_sha: measured.head_sha, nets, by: 'session' }])
  const all = netsIn(measured, [...netsOf(tree.events, id), ...nets]).all
  return out.ok ? { ok: true, head_sha: measured.head_sha, nets_n: nets.length, all } : declined('append_failed', String(out.error))
}

// ------------------------------------------------------------------ pause and resume

/** The execution a run names, `{run, effort, stamp}`, or `{error}`: only an execution's run pauses. */
function executionOfRun(repo, given) {
  const found = resolveHandle(repo, 'run', given)
  if (!found.ok) return { error: found.error }
  const home = runHome(repo, found.value)
  if (!home.stamp) return { error: { kind: 'not_an_execution', message: found.value + ' is no execution\'s run: only an execution pauses' } }
  return { run: found.value, effort: home.effort, stamp: home.stamp }
}

/**
 * The session's pause of execution `stamp`: a `paused` event, which the running program reads at its
 * next tick and every leaf before its next round: what runs finishes and records, nothing new
 * starts, and the run ends `stopped: pause` once nothing runs. It stands, over a relaunch too,
 * until `resumeExecution`. Refuses a closed execution; a pause already standing is not written again.
 */
function pauseExecution(repo, effort, stamp) {
  const standing = pausedAt(readLog(repo, effort, 'events').entries, stamp)
  if (standing) return { ok: true, paused: standing, already: true }
  if (readLog(repo, effort, 'state:' + stamp).entries.some((e) => e.kind === 'closed')) return declined('closed', 'execution ' + stamp + ' is closed: there is nothing to pause')
  const r = append(repo, effort, 'events', [{ kind: 'paused', node: '', execution: stamp, by: 'session' }])
  return r.ok ? { ok: true, paused: r.seqs[0], already: false } : declined('append_failed', String(r.error))
}

/** The session's resume of execution `stamp`: a `resumed` event after the pause that stands, or nothing when none does. */
function resumeExecution(repo, effort, stamp) {
  if (!pausedAt(readLog(repo, effort, 'events').entries, stamp)) return { ok: true, resumed: 0 }
  const r = append(repo, effort, 'events', [{ kind: 'resumed', node: '', execution: stamp, by: 'session' }])
  return r.ok ? { ok: true, resumed: r.seqs[0] } : declined('append_failed', String(r.error))
}

/** The arguments that only shape a new execution, or stop a run once more: a relaunch of an open one leaves them off. */
const NOT_RELAUNCHED = ['pause', 'pace', 'base_ref', 'commands_file']

/** Pure. The `run.mjs execute` arguments that start a stopped run of `meta` (its run.json) again, from what it was given. */
function relaunchArgv(meta) {
  const raw = (meta && meta.raw) || {}
  const flags = Object.entries(raw).filter(([key]) => !NOT_RELAUNCHED.includes(key))
    .flatMap(([key, value]) => ['--' + key.replace(/_/g, '-'), ...(value === true ? [] : [String(value)])])
  return ['execute', ...flags]
}

/**
 * Pause a run (`pauseExecution` on the execution it names) and say whether it is live: a run that
 * is not stays paused when started again.
 */
export function pauseRun(repo, given) {
  const at = executionOfRun(repo, given)
  if (at.error) return { ok: false, error: at.error }
  const out = pauseExecution(repo, at.effort, at.stamp)
  return out.ok ? { ...out, run: at.run, live: runState(repo, at.run).state === 'live' } : out
}

/**
 * Resume a run: clear the pause that stands, and when the run is no longer live start it again,
 * detached, with the arguments it was given (`relaunchArgv`), as `run.mjs` prints a start.
 * `launchRun` is `launch` in lib/run.mjs.
 */
export async function resumeRun(repo, given, { launchRun = launch } = {}) {
  const at = executionOfRun(repo, given)
  if (at.error) return { ok: false, error: at.error }
  const out = resumeExecution(repo, at.effort, at.stamp)
  if (!out.ok) return out
  const started = await relaunchRun(repo, at.run, { launchRun })
  return started.ok ? { ...out, run: at.run, relaunched: started.relaunched } : started
}

/**
 * Start execution run `run` again, detached, with the arguments it was given (`relaunchArgv`),
 * unless it is live: `{relaunched}`, the start as `run.mjs` prints it or null. A start whose child
 * died before recording is no refusal here (`relaunch`), so a cleared pause is not lost to it. A start racing this
 * one is refused by the claim's lock. `launchRun` is `launch` in lib/run.mjs.
 */
export async function relaunchRun(repo, run, { launchRun = launch } = {}) {
  const st = runState(repo, run)
  if (st.state === 'live') return { ok: true, relaunched: null }
  if (!st.run || st.run.program !== 'execute') return declined('no_launch', run + ' has no run.json to start it from: start it with run.mjs execute')
  return { ok: true, relaunched: await launchRun({ argv: [...relaunchArgv(st.run), '--repo', repo, '--detach'], cwd: repo, relaunch: true }) }
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
  land: { '--repo': 'path', '--effort': 'handle', '--action': 'handle', '--head': 'handle' },
  adopt: { '--repo': 'path', '--effort': 'handle', '--folder': 'handle', '--map-file': 'path', '--action': 'handle' },
  accept: { '--repo': 'path', '--effort': 'handle', '--node': 'handle', '--file': 'path' },
  net: { '--repo': 'path', '--effort': 'handle', '--node': 'handle', '--file': 'path' },
  pause: { '--repo': 'path', '--run': 'handle' },
  resume: { '--repo': 'path', '--run': 'handle' },
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
      unsettled_claims: unsettledClaims(tree.nodes, tree.events),
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
  return { action, ok: false, error: 'unknown action ' + JSON.stringify(action) + ' — check, merge or record' }
}

/**
 * Record the landing of an effort whose work the user's checked-out branch already holds: it moves
 * no branch, so it asks for no token. `head` is the effort's merged head the user names; it, the
 * effort branch when one stands must both be in `HEAD`, or nothing is written. A recorded merge
 * `HEAD` does not hold did not land and is listed (`left_out`), as are the nodes still parked or
 * escalated, closed with the effort. Then it sweeps.
 */
export function recordLanding(repo, effort, head) {
  const tree = readTree(repo, effort)
  const into = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
  const now = revParse(repo, 'HEAD')
  const named = head ? revParse(repo, head) : ''
  const refused = (kind, message) => ({ ok: false, error: { kind, message } })
  if (!named) return refused('no_such_commit', 'no commit ' + JSON.stringify(String(head || '')) + ' to record as landed')
  if (!contains(repo, now, named)) return refused('not_in_branch', into + ' does not hold ' + named.slice(0, 8) + ': land it with --action merge')
  const effortHead = revParse(repo, 'refs/heads/' + branchOf(effort, ROOT_ID))
  if (effortHead && !contains(repo, now, effortHead)) {
    return refused('effort_branch_ahead', 'the effort branch is at ' + effortHead.slice(0, 8) + ', which ' + into + ' does not hold: land it with --action merge')
  }
  const left_out = tree.events.filter((e) => e.kind === 'merged' && e.merged_sha && !contains(repo, now, e.merged_sha))
    .map((e) => ({ node: e.node, merged_sha: e.merged_sha }))
  const closed = [...tree.status].filter(([, s]) => s.status === 'escalated' || s.status === 'parked').map(([id, s]) => ({ node: id, status: s.status }))
  const landedSha = (tree.events.findLast((e) => e.kind === 'landed' && e.node === ROOT_ID) || {}).merged_sha || ''
  const already = landedSha !== '' && contains(repo, landedSha, named)
  if (!already) append(repo, effort, 'events', { kind: 'landed', node: ROOT_ID, execution: '', into, merged_sha: named, by: 'session' })
  return { ok: true, into, merged_sha: named, already, closed, left_out, ...sweep(repo, effort, now, into) }
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
        : action === 'record' ? recordLanding(repo, effort, flagOf(argv, 'head')) : land(repo, effort, action)
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
    if (name === 'accept' || name === 'net') {
      const bad = handleArgs(argv, SESSION_FLAGS[name])
      if (bad) {
        console.log(JSON.stringify({ ok: false, error: argsRefusal(bad, name) }, null, 1))
        process.exit(0)
      }
      sessionContext(repo, effort)
      const file = resolveHandle(repo, 'file', flagOf(argv, 'file'))
      const rule = name === 'accept' ? acceptDrift : ruleNets
      const out = !file.ok ? { ok: false, error: file.error } : rule(repo, effort, flagOf(argv, 'node'), readJson(file.value))
      console.log(JSON.stringify(out, null, 1))
      process.exit(0)
    }
    if (name === 'pause' || name === 'resume') {
      const bad = handleArgs(argv, SESSION_FLAGS[name])
      const out = bad ? { ok: false, error: argsRefusal(bad, name) }
        : name === 'pause' ? pauseRun(repo, flagOf(argv, 'run')) : await resumeRun(repo, flagOf(argv, 'run'))
      console.log(JSON.stringify(out, null, 1))
      process.exit(0)
    }
    throw new Error('unknown session call ' + JSON.stringify(name) + ': land, adopt, retry, note, accept, net, pause or resume')
  } catch (err) {
    process.stderr.write(String(err && err.stack ? err.stack : err) + '\n')
    console.log(JSON.stringify({ error: 'program_failed' }))
    process.exit(1)
  }
}
