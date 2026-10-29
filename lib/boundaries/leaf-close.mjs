// lib/boundaries/leaf-close.mjs — the close of a producer's round: what its stored return decides,
// a shell-less author's files committed by its role's rule, the measurement, and the record or the
// message the decision makes.
//
// Design: docs/DESIGN.md#boundaries.

import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { commandsOf, deleteGotcha, gotchaId, writeGotcha } from '../gotchas.mjs'
import { readLog } from '../ledger.mjs'
import { cycleTests } from '../integration.mjs'
import { fnv1a } from '../plan-digest.mjs'
import { measure } from '../measure.mjs'
import { mergeInProgress, unmergedPaths } from '../merge.mjs'
import { deniedClass, roleAdmits, writesOf } from '../permissions.mjs'
import { approvedHead, journalsOf } from '../resume.mjs'
import { loadRole, roleCommands } from '../roles.mjs'
import {
  branchOf, closePath, git, isTestPath, mainCheckout, posix, readJson, returnPath, revParse, sameBlob, worktreeOf, writeJson,
} from '../store.mjs'
import { clearedAt, cycleOf, isHuman, ownReview, ownerOf, readTree } from '../tree.mjs'
import { CONSOLIDATION, auditGap, closeDecision, greenRoundRole, heldMutations, netsAt } from '../verdict.mjs'
import { undoLeftover, worktreeProblem } from '../verify.mjs'
import { readCheckout, sharedWatch } from '../watch.mjs'
import { failuresKey, sendBack, sentBackFiles, sendBacks } from './loop-guard.mjs'
import { approved, commandsFor, escalated, faultRecords, message, parked, recordAll } from './records.mjs'

const PARK = ['needs_decision', 'contract_changed']
const ROUTE = ['needs_context', 'decompose', 'unsplittable', 'premise_mismatch']
const DONE = ['done', 'done_with_concerns']
/** Pure. Whether an `unread` entry names a source file first: a path that is no test, no document and nothing in the store. */
function namesSource(entry) {
  const path = (String(entry).match(/[\w.@-]+(?:\/[\w.@-]+)+\.\w+|[\w@-]+\.\w+/) || [''])[0]
  return path !== '' && !isTestPath(path) && !/\.(md|txt|rst|adoc)$/i.test(path) && !path.startsWith('.agentics/')
}

/** The messages a cycle test round may be asked to answer with tests, beside the implementer's `needs_tests`. */
const REQUESTS_OF_TESTS = ['findings', 'surviving_mutations', 'failures']

const list = (v) => (Array.isArray(v) ? v : [])
const lines = (text) => String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)
const latest = (entries, pred) => entries.reduce((found, e) => (pred(e) && (!found || e.seq > found.seq) ? e : found), null)
const keyOf = (f) => f.check + ':' + f.claim
/** A `command-<name>` id: the investigator and the session establish commands, never a producer's round. */
const isCommandId = (id) => String(id).startsWith('command-')

/**
 * Pure. The status a round's stored return reports, or null when there is none to read. An auditor
 * judges and its schema has no `status`: any object it returns reads `done`, a `status` in it ignored.
 */
function statusOf(role, ret) {
  if (!ret || typeof ret !== 'object' || Array.isArray(ret)) return null
  if (role === 'auditor') return 'done'
  return typeof ret.status === 'string' ? ret.status : null
}

/**
 * Pure. What a producer's stored return decides before anything is measured
 * (docs/DESIGN.md#producer-returns). `author` writes the leaf's folder; `red` is the cycle's red,
 * whose session is the cycle's tests; `answering` is the request a cycle test round answered and
 * `carried` every request its dispatch carried; a stop's `said` is `dispatch`, whose stored return
 * holds the producer's words; `denied` the command lines the host denied the dispatch, read against
 * `grants`, the commands the round was granted (`deniedClass`): a project command its entry's `runs`
 * does not name is a spec gap (`command_not_in_runs`), a line the producer's own tools or one plain
 * line would do goes back to it (`adhoc`), and a granted line the host denied anyway is the plugin's
 * (`mismatch`). A round that returned no commits is measured like any other: the branch as it stands
 * decides. A leaf with no producer (`role` '') is measured.
 */
export function producerOutcome({ leaf, role, round, ret, author = '', red = '', answering = '', carried = [], dispatch = '', denied = [], grants = [] }) {
  if (!role) return { next: 'measure' }
  const status = statusOf(role, ret)
  if (status === null) return { next: 'held' }
  const node = leaf.id
  const stop = (record) => ({ next: 'stop', records: [record] })
  if (PARK.includes(status)) return stop(parked(node, status, '', dispatch))
  if (status === 'blocked') {
    const text = String(ret.text || '')
    const of = (cls) => denied.filter((line) => deniedClass(line, grants) === cls)
    if (of('unlisted').length) return stop(escalated(node, 'command_not_in_runs', [...of('unlisted'), text].filter(Boolean).join('\n\n'), dispatch))
    if (of('mismatch').length) return { next: 'mismatch', denied: of('mismatch') }
    if (denied.length) return { next: 'adhoc', denied, text }
    return stop(escalated(node, status, text, dispatch))
  }
  if (ROUTE.includes(status)) {
    if (author === 'planner') return { next: 'route', to: 'planner', records: [] }
    return { next: 'route', to: 'park', records: [parked(node, status === 'needs_context' ? 'needs_context' : 'needs_respec', '', dispatch)] }
  }
  if (status === 'needs_tests') {
    if (role !== 'implementer' || leaf.role !== 'green') return stop(escalated(node, status, '', dispatch))
    return { next: 'needs_tests', text: String(ret.text || '') }
  }
  if (status === 'declined') {
    const testRound = role === 'test-author' && (leaf.role === 'green' || leaf.role === 'audit')
    if (!testRound) return stop(escalated(node, status, '', dispatch))
    // A decline of a reviewer's or code's request (REQUESTS_OF_TESTS), sent again, would be the same
    // request: it ends in the user's hands, even when the round carried needs_tests too. What else
    // a dispatch carries (brief_changed) asks nothing.
    if (answering !== 'needs_tests' || carried.some((m) => REQUESTS_OF_TESTS.includes(m))) return { next: 'declined', records: [escalated(node, 'tests_declined', '', dispatch)] }
    return { next: 'declined', records: [message(node, 'producer:' + node, 'declined', { why: String(ret.text || '') }, round + 1, 'test-author')] }
  }
  // Work done against a document its producer could not read is a guess, whatever the rigor: it
  // stops before it is measured, reviewed or merged. A cycle's test round is kept from the
  // implementation by design: an entry naming a source file there is no document it was told to follow.
  const blind = role === 'test-author' && (leaf.role === 'green' || leaf.role === 'audit')
  const unread = list(ret.unread).map((u) => String(u).trim()).filter(Boolean).filter((u) => !(blind && namesSource(u)))
  if (unread.length) return stop(escalated(node, 'unread_reference', unread.join('\n'), dispatch))
  return { next: 'measure' }
}

/**
 * Pure. The route a close record decided, or null: the request its folder's planner answers, from
 * the record and the return its close read. The run that routed holds the route in memory alone, so
 * a relaunch rebuilds it here rather than opening a round its producer has nothing to be told in.
 */
export function routeOf(nodes, close, ret) {
  if (!close || !close.decision || close.decision.next !== 'route') return null
  const node = close.node
  const request = ROUTE.includes(close.status)
    ? { node, status: close.status, text: String((ret && ret.text) || ''), paths: [] }
    : { node, status: 'verify_finding', text: list(close.decision.failures).map((f) => f.claim).join('; '), paths: [] }
  return { to: 'planner', folder: ownerOf(nodes, node), request }
}

/**
 * What a dispatch carried: `carried`, the `msg` of each message its `dispatched` line names, oldest
 * first, and `answering`, the one request the close record names: `needs_tests` when one is carried,
 * else the latest, else ''.
 */
function answeringOf(events, dispatch) {
  const d = latest(events, (e) => e.kind === 'dispatched' && e.dispatch === dispatch)
  const named = new Set(list(d && d.carries))
  const carried = events.filter((e) => e.kind === 'message' && named.has(e.seq)).sort((a, b) => a.seq - b.seq).map((e) => e.msg)
  return { carried, answering: carried.includes('needs_tests') ? 'needs_tests' : carried.length ? carried[carried.length - 1] : '' }
}

/** The Bash command lines the host denied `dispatch`, from its latest `returned` line, each once. */
function deniedCommands(entries, dispatch) {
  const back = latest(entries, (e) => e.kind === 'returned' && e.dispatch === dispatch)
  const lines = list(back && back.denials).filter((d) => d && d.tool_name === 'Bash' && d.tool_input && typeof d.tool_input.command === 'string')
  return [...new Set(lines.map((d) => d.tool_input.command.trim()))]
}

/** The round of the latest `needs_tests` of `node` that no `tests_ready` or `declined` has answered yet, or 0. */
function openNeedsTests(events, node) {
  const mine = events.filter((e) => e.kind === 'message' && e.node === node)
  const asked = Math.max(0, ...mine.filter((e) => e.msg === 'needs_tests').map((e) => e.round))
  return asked > 0 && !mine.some((e) => (e.msg === 'tests_ready' || e.msg === 'declined') && e.round > asked) ? asked : 0
}

const UNREAD = { head: '', branch: '', status: {}, paths: [] }

/**
 * The worktree's HEAD, branch and status, read once and read again only after the close writes git
 * there (`wrote`). A read git refuses reads as an empty, unborn worktree, as `revParse` and a
 * failed `git status` did, and is not kept: `held` is only ever a read that succeeded. A rename is
 * the deletion of one path and the addition of another, so `paths` holds both.
 */
function worktreeReads(worktree) {
  let at = null
  return {
    now() {
      if (at) return at
      try {
        at = readCheckout(worktree)
        return at
      } catch {
        return UNREAD
      }
    },
    wrote() { at = null },
    held: () => at,
  }
}

/** Put `paths` back to what `at` holds: restored where it has them, removed where it has none. */
function putBack(worktree, at, paths) {
  for (const p of paths) {
    if (at && git(worktree, ['cat-file', '-e', at + ':' + p]).ok) git(worktree, ['checkout', at, '--', p])
    else {
      git(worktree, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', p])
      rmSync(join(worktree, p), { recursive: true, force: true })
    }
  }
}

/** Commit what is staged under `subject`: the new head, '' when nothing was staged, `failed` when git refused. */
function commitStaged(worktree, subject) {
  if (git(worktree, ['diff', '--cached', '--quiet']).ok) return { sha: '', failed: false }
  const c = git(worktree, ['commit', '-q', '-m', subject])
  return c.ok ? { sha: revParse(worktree, 'HEAD'), failed: false } : { sha: '', failed: true }
}

/** The series a producer finished, from git: every commit of its own over `base`, oldest first. */
function seriesOf(worktree, base) {
  if (!base) return []
  const r = git(worktree, ['log', '--reverse', '--no-merges', '--format=%H%x09%s', base + '..HEAD'])
  return r.ok ? lines(r.stdout).map((l) => ({ sha: l.slice(0, l.indexOf('\t')), subject: l.slice(l.indexOf('\t') + 1) })) : []
}

const filesOf = (worktree, sha) => lines(git(worktree, ['show', '--name-only', '--format=', sha]).stdout).map(posix)

/** The close record of the round before `round` of `node`, in the execution that dispatched it, or null. */
function previousClose(xc, events, node, round) {
  if (round <= 1) return null
  const d = latest(events, (e) => e.kind === 'dispatched' && e.node === node && e.round === round - 1)
  return d ? readJson(closePath(xc.repo, xc.effort, d.execution || xc.execution, node, d.role || 'none', round - 1)) : null
}

/**
 * The commit a shell-less author's close made for the round, found in git: the one directly over
 * `head_before`. A close cut off between that commit and its `authored` line finds it again here
 * ('' when the round made none).
 */
function authorCommit(worktree, head_before) {
  const since = revParse(worktree, head_before)
  if (!since) return ''
  const log = git(worktree, ['log', '--reverse', '--format=%H%x09%P', since + '..HEAD'])
  for (const l of log.ok ? lines(log.stdout) : []) {
    const [sha, parents] = l.split('\t')
    if (parents === since) return sha
  }
  return ''
}

/**
 * Close one producer round of `node`, in-process: read the stored return; on measure, commit a
 * shell-less author's files its role may write (`roleAdmits`), put every other uncommitted file
 * back to the head, journal the series, measure, write the gotchas, decide, and record the
 * decision or the next round's message (docs/DESIGN.md#boundaries). Run again, it converges:
 * commits already made are read from git, a measurement already journalled
 * at the same key is reused, and `recordAll` lands no record twice. A round closed again with no
 * `dispatch` has no return to read: what its branch holds — commits made on it by hand since its
 * close — is measured as no producer's, and the decision goes where the round's would.
 * @param {object} xc an execution's context (`executionContext`)
 * @param {{node: string, role: string, round: number, thread: string, dispatch: string, head_before?: string, base_sha?: string}} args
 * @param {{spawn?: Function, watch?: object}} [ports] what `measure` takes, passed through
 */
export async function leafClose(xc, { node, role, round, thread, dispatch, head_before = '', base_sha = '' }, ports = {}) {
  const tree = readTree(xc.repo, xc.effort)
  const leaf = tree.nodes.get(node)
  if (!leaf || leaf.kind !== 'leaf') throw new Error(node + ' is not a leaf of ' + xc.effort)
  const parentId = ownerOf(tree.nodes, node)
  const author = (tree.nodes.get(parentId) || {}).author || ''
  const cycle = cycleOf(tree.nodes, node)
  const red = cycle[0] || ''
  const worktree = worktreeOf(xc.repo, xc.effort, node)
  const branch = branchOf(xc.effort, node)
  // What a verify cut off in this worktree left is put right before anything reads the worktree.
  const broken = worktreeProblem(worktree)
  const left = broken ? [] : undoLeftover(worktree, branch)
  // Nothing read here outlives this call: the worktree's reads and the watch's last snapshot.
  const reads = worktreeReads(worktree)
  const measuring = { ...ports, watch: ports.watch || sharedWatch(mainCheckout(xc.repo)) }
  const producer = dispatch ? role : ''
  const ret = producer ? readJson(returnPath(xc.dir, dispatch)) : null
  const status = statusOf(producer, ret) || ''
  const { answering, carried } = answeringOf(tree.events, dispatch)
  const close = {
    node, role, round, thread, dispatch, status, head_sha: reads.now().head, measurement: null,
    raise: false, answering, gotchas_written: [], gotchas_deleted: [], committed: '', notes: [...left],
  }
  const finish = (decision, records, route = null) => {
    const { stops } = recordAll(xc, records)
    writeJson(closePath(xc.repo, xc.effort, xc.execution, node, role || 'none', round), { ...close, decision })
    return { decision, raise: close.raise, stops, ...(route ? { route } : {}) }
  }
  const state = () => readLog(xc.repo, xc.effort, 'state:' + xc.execution).entries
  const routed = (decision) => finish(decision, [], routeOf(tree.nodes, { ...close, decision }, ret))

  const prior = previousClose(xc, tree.events, node, round)
  // The head the producer returned, before this close commits or reverts anything.
  const returned = close.head_sha
  const loaded = producer ? loadRole(producer) : null
  const grants = loaded && loaded.ok ? roleCommands(loaded.role, commandsOf(xc.repo, xc.effort), leaf) : []
  const out = producerOutcome({ leaf, role: producer, round, ret, author, red, answering, carried, dispatch, denied: deniedCommands(state(), dispatch), grants })
  // Every send-back of this close goes through the loop guard, over the node's since it was cleared.
  const history = sendBacks(tree.events, node, clearedAt(tree.nodes, tree.events, node), round + 1)
  const back = (to, msg, payload, guard, from) => sendBack(history, { node, thread: to, msg, payload, round: round + 1, from, guard })
  const sent = (decision, out, extra = [], detail = '') => (out.stop
    ? finish({ ...decision, next: 'stop', reason: out.stop.reason },
      [escalated(node, out.stop.reason, [out.stop.detail, detail || decision.failures.map((f) => f.claim).join('; ')].filter(Boolean).join(': '), dispatch)])
    : finish(decision, [out.record, ...extra]))
  if (out.next === 'held') {
    const records = faultRecords(node, 'role', 'the ' + role + ' dispatch ' + dispatch + ' returned nothing', { nodes: tree.nodes, events: tree.events, state: state() })
    return finish({ next: 'stop', reason: 'held', failures: [] }, records)
  }
  // A cycle's consolidation round never holds the cycle up: whatever it does not finish, the leaf is
  // approved as its review left it (docs/DESIGN.md#rigor).
  const consolidating = producer === 'test-author' && carried.includes('consolidate')
  const settle = (reason, failures = []) => {
    if (!broken) {
      const stray = reads.now().paths
      if (stray.length) putBack(worktree, 'HEAD', stray)
      reads.wrote()
    }
    close.head_sha = broken ? close.head_sha : reads.now().head
    return finish({ next: 'approve', reason, failures }, [approved(node, close.head_sha, 0, false)])
  }
  if (consolidating && !DONE.includes(status)) return settle('consolidation_declined')
  if (out.next === 'route' && out.to === 'planner') {
    return routed({ next: 'route', reason: status, failures: [] })
  }
  if (out.next === 'needs_tests') {
    return sent({ next: 'fix', reason: 'needs_tests', failures: [] },
      back('producer:' + red, 'needs_tests', { text: out.text }, { kind: 'needs_tests', key: '', at: returned }, 'implementer'))
  }
  if (out.next === 'mismatch') {
    return finish({ next: 'stop', reason: 'held', failures: [] }, faultRecords(node, 'program', 'the host denied ' + out.denied.join(' / ') +
      ', which the round was granted: the plugin\'s rules and the host\'s disagree', { nodes: tree.nodes, events: tree.events, state: state() }))
  }
  if (out.next === 'adhoc') {
    const failures = out.denied.map((line) => ({
      check: 'ad_hoc_command', claim: 'the shell refused: ' + line,
      evidence: 'read files with Read, Grep and Glob and change them with Edit and Write; a script, a redirect or a chain of shell tools is denied, and a command your brief allows runs as one plain line, never inside a loop, eval or sh -c',
    }))
    // Told once; refused again, the round is blocked on something its tools cannot do: the session's.
    return sent({ next: 'fix', reason: 'ad_hoc_command', failures },
      back(thread, 'failures', { source: 'the permission check', failures }, { kind: 'adhoc', key: 'adhoc', at: returned }), [],
      [...out.denied, out.text].filter(Boolean).join('\n\n'))
  }
  if (out.next === 'declined' && out.records[0].kind === 'message') return finish({ next: 'fix', reason: 'declined', failures: [] }, out.records)
  if (out.next !== 'measure') {
    const f = out.records[0].fields
    return finish({ next: 'stop', reason: f.reason || f.return, failures: [] }, out.records)
  }

  // ---- a rebase round's merge: measured only once its producer concluded it
  if (!broken && mergeInProgress(worktree)) {
    const unmerged = unmergedPaths(worktree)
    const failures = [{
      check: 'merge',
      claim: 'the merge of the folder head into this branch is not concluded' + (unmerged.length ? ': resolve ' + unmerged.join(', ') + ',' : ':') +
        ' then git add the files and git commit to conclude it',
      evidence: '',
    }]
    // A rebase round that left its merge unconcluded returned the head it was sent: the loop guard stops it.
    return sent({ next: 'fix', reason: 'merge_unconcluded', failures },
      back(thread, 'failures', { source: 'the rebase', failures }, { kind: 'merge', key: unmerged.join('\n'), at: close.head_sha }))
  }

  // ---- the round's files: a shell-less author's committed by its role's rule, the rest put back
  const testRound = producer === 'test-author' && (leaf.role === 'green' || leaf.role === 'audit')
  const cycleMember = leaf.role === 'green' || leaf.role === 'audit'
  const tests = cycleMember ? cycleTests(xc.repo, xc.effort, tree.nodes, node) : []
  const shellLess = producer === 'test-author' || producer === 'auditor'
  // HEAD as this close last left it: every commit below hands back its sha, so nothing asks git again.
  let at = close.head_sha
  if (broken) close.notes.push('nothing committed or put back: ' + broken.message)

  if (shellLess && !broken) {
    // A close cut off after it committed and before it journalled finds its commit in git.
    const made = authorCommit(worktree, head_before)
    if (made) recordAll(xc, [{ kind: 'authored', fields: { node, role, round, sha: made } }])
    const writes = writesOf(producer, leaf)
    const mine = reads.now().paths.filter((p) => roleAdmits(writes, p))
    if (mine.length) {
      git(worktree, ['add', '-A', '--', ...mine])
      reads.wrote()
      const sha = commitStaged(worktree, (ret && ret.commit) || 'test(' + node + '): ' + leaf.title).sha
      if (sha) {
        at = sha
        recordAll(xc, [{ kind: 'authored', fields: { node, role, round, sha } }])
      }
      else close.notes.push('the commit of ' + mine.join(', ') + ' failed')
    }
  }
  const authored = journalsOf(xc.repo, xc.effort, xc.execution).filter((e) => e.kind === 'authored' && e.node === node)
  close.committed = (latest(authored, (e) => e.round === round) || {}).sha || ''
  if (consolidating) {
    // A second commit of the round is the revert of its first, made by a close cut off before its record.
    const made = new Set(authored.filter((e) => e.round === round).map((e) => e.sha)).size
    if (made === 0 || broken) return settle('consolidation_empty')
    if (made > 1) return settle('consolidation_dropped')
  }
  // The cycle test session's commits on a green or an audit are held to what a test round writes,
  // the leaf's own to its role: neither writes the other's files.
  const fences = {}
  if (cycleMember && base_sha && !broken) {
    const range = new Set(lines(git(worktree, ['rev-list', base_sha + '..HEAD']).stdout))
    for (const e of authored) if (e.role === 'test-author' && range.has(e.sha)) fences[e.sha] = 'tests'
  }

  const cmd = commandsFor(xc)
  // Every measurement of the leaf in every execution.
  const earlier = journalsOf(xc.repo, xc.effort, xc.execution).filter((e) => e.kind === 'verify-observed' && e.node === node)
  const redHead = testRound && red ? approvedHead(tree.events, red) : ''
  // A consolidation round is measured as `consolidation`, the one test round its approved cases do not bind.
  const measuredAs = consolidating ? CONSOLIDATION : producer
  const options = {
    worktree, node, branch, mode: 'order', base: base_sha, expects: leaf.expects, fences,
    exclude: cycleMember ? cycle.slice(0, cycle.indexOf(node)).map((id) => approvedHead(tree.events, id)).filter(Boolean) : [],
    approved: redHead && !consolidating ? tests.filter((f) => git(xc.repo, ['cat-file', '-e', redHead + ':' + f]).ok).map((file) => ({ file, sha: redHead })) : [],
    ...cmd, mutations: heldMutations(leaf, earlier, list(ret && ret.mutations)), rigor: leaf.rigor, role: leaf.role, producer: measuredAs,
    checks: leaf.acceptance.filter((a) => !isHuman(a) && a.check.trim()).map((a) => a.check), tests,
  }
  const checkout = (detail) => faultRecords(node, 'checkout', detail, { nodes: tree.nodes, events: tree.events, state: state() })

  if (!broken) {
    // What the round left uncommitted is no part of what is measured: back to the head.
    const stray = reads.now().paths
    if (stray.length) {
      putBack(worktree, 'HEAD', stray)
      reads.wrote()
      close.notes.push('uncommitted ' + stray.join(', ') + ' put back to the head before measuring')
    }
  }

  const head = at
  close.head_sha = head
  if (DONE.includes(status)) {
    const commits = seriesOf(worktree, base_sha)
    if (commits.length) recordAll(xc, [{ kind: 'series-done', fields: { node, branch, head_sha: head, commits } }])
  }

  const { payload: m, moved } = await measure(xc, options, measuring, { at: reads.held() })
  reads.wrote()
  close.measurement = m
  for (const g of list(ret && ret.gotchas)) {
    if (isCommandId(gotchaId(g))) {
      close.notes.push('gotcha refused: ' + gotchaId(g) + ': a producer does not establish commands')
      continue
    }
    const w = writeGotcha(xc.repo, xc.effort, g, { observed_at: head, source: { node, role } })
    if (w.ok) close.gotchas_written.push(w.id)
    else close.notes.push('gotcha refused: ' + w.error)
  }
  for (const id of list(ret && ret.gotchas_stale)) {
    if (isCommandId(id)) close.notes.push('stale gotcha kept: ' + id + ': a producer does not retire commands')
    else if (deleteGotcha(xc.repo, xc.effort, id).deleted) close.gotchas_deleted.push(id)
  }
  if (moved || (m.error && m.error.kind === 'watch_failed')) {
    return finish({ next: 'stop', reason: 'checkout', failures: [] }, checkout("the user's checkout moved while " + node + ' was measured'))
  }

  const settled = earlier
  const nets = (netsAt(tree.events, node, head, (a, b, file) => sameBlob(xc.repo, a, b, file)) || { files: [] }).files
  const decision = closeDecision(m, leaf, measuredAs, { nets, sentBack: sentBackFiles(history) })
  const claims = decision.failures.map((f) => f.claim).join('; ')

  if (consolidating) {
    if (decision.next === 'review' || decision.next === 'approve') return settle('consolidated')
    // It lost something the cycle caught: the round's commit is reverted, never rewritten, and the
    // leaf is approved on the tree its review approved.
    const undone = git(worktree, ['revert', '--no-edit', close.committed])
    reads.wrote()
    if (!undone.ok) {
      return finish({ ...decision, next: 'stop', reason: 'consolidation_unrevertable' }, [escalated(node, 'consolidation_unrevertable',
        'the consolidation commit ' + close.committed.slice(0, 8) + ' failed its measurement and could not be reverted: ' + undone.stderr.trim())])
    }
    recordAll(xc, [{ kind: 'authored', fields: { node, role, round, sha: revParse(worktree, 'HEAD') } }])
    return settle('consolidation_dropped', decision.failures)
  }

  // The implementer's needs_tests stays open until a test round of the green is measured and goes to
  // review, to approval or back to the implementer: that round hands the implementer the test files
  // the cycle's test session committed since the request, whatever the round itself carried.
  const asked = testRound && leaf.role === 'green' ? openNeedsTests(tree.events, node) : 0
  const ready = asked
    ? [message(node, 'producer:' + node, 'tests_ready', {
      files: [...new Set(authored.filter((e) => e.round >= asked).flatMap((e) => filesOf(worktree, e.sha)).filter(isTestPath))],
    }, round + 1)]
    : []

  if (decision.next === 'approve') return finish(decision, [approved(node, head, 0, !ownReview(leaf)), ...ready])
  if (decision.next === 'review') return finish(decision, ready)
  if (decision.next === 'command_unknown') {
    // Established once an investigator of this execution has returned: one still in flight, or
    // whose call failed, has established nothing yet.
    const answered = new Set(state().filter((e) => e.kind === 'returned' && e.status === 'returned').map((e) => e.dispatch))
    const established = tree.events.some((e) => e.kind === 'dispatched' && e.role === 'investigator' && e.execution === xc.execution && answered.has(e.dispatch))
    if (!established) return finish(decision, [])
    return finish({ ...decision, next: 'stop' }, [escalated(node, 'command_unknown', 'no build or test command could be established for this repository')])
  }
  if (decision.next === 'fix') {
    const before = prior && prior.decision && prior.decision.next === 'fix' ? list(prior.decision.failures).map(keyOf) : []
    const now = new Set(decision.failures.map(keyOf))
    close.raise = before.length > 0 && before.every((k) => now.has(k))
    const surviving = list(m.mutations).filter((x) => x && x.applied && !x.bites)
    if (leaf.role === 'audit' && surviving.length) {
      const mutations = surviving.map((x) => ({ file: x.file, find: x.find, replace: x.replace, expect_failing: list(x.expect_failing) }))
      const key = mutations.map((x) => x.file + ':' + JSON.stringify([x.find, x.replace])).sort().join('\n')
      return sent(decision, back('producer:' + red, 'surviving_mutations', { mutations }, { kind: 'mutations', key, at: head }))
    }
    const next = leaf.role === 'green'
      ? (greenRoundRole({ close: { role: close.role, status: close.status, decision } }) === 'test-author' ? 'producer:' + red : 'producer:' + node)
      : leaf.role === 'audit' && auditGap([...settled, m]) ? 'producer:' + red : thread
    // A test round may answer with mutations it redeclared and no commit: they are part of where it left the work.
    const declared = list(ret && ret.mutations).map((x) => JSON.stringify([x.file, x.find, x.replace, list(x.expect_failing)])).sort()
    const at = declared.length ? head + '+' + fnv1a(declared.join('\n')) : head
    const told = decision.reason === 'discriminator_sent_back'
      ? { kind: 'discriminator', key: list(decision.files).join('\n'), at }
      : { kind: 'verification', key: failuresKey(decision.failures), at }
    return sent(decision, back(next, 'failures', { source: 'verification', failures: decision.failures }, told), next === 'producer:' + node ? ready : [])
  }
  if (decision.next === 'finding') {
    // Under a planner's folder the finding is the route: the planner replans the folder, and no
    // escalation of the leaf is left to outlive that replan. The folder the user wrote is parked,
    // and the leaf stays escalated until its spec is re-approved.
    if (author === 'planner') return routed({ ...decision, next: 'route' })
    return finish({ ...decision, next: 'stop' }, [escalated(node, 'verify_finding', claims), parked(parentId, 'needs_respec', 'verify leaf ' + node + ' found: ' + claims)])
  }
  return finish({ ...decision, next: 'stop' }, [escalated(node, decision.reason || 'escalated', claims)])
}

/**
 * Write the command gotchas an investigator returned, as an investigator's, so verification reads
 * them (`commandsOf`). What it could not establish, and every gotcha refused, is `unresolved`.
 * @returns {{written: string[], unresolved: string[]}}
 */
export function recordCommands(xc, { dispatch }) {
  const ret = readJson(returnPath(xc.dir, dispatch))
  if (!ret) return { written: [], unresolved: ['the investigator dispatch ' + dispatch + ' returned nothing'] }
  const observed_at = revParse(xc.repo, 'HEAD')
  const written = []
  const unresolved = list(ret.unresolved).map(String)
  for (const g of list(ret.commands)) {
    const w = writeGotcha(xc.repo, xc.effort, g, { observed_at, source: { role: 'investigator' } })
    if (w.ok) written.push(w.id)
    else unresolved.push(((g && g.command && g.command.name) || 'a command') + ': ' + w.error)
  }
  return { written, unresolved }
}
