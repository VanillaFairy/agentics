// lib/boundaries/leaf-close.mjs — the close of a producer's round: what its stored return decides,
// the locus it kept or broke, the measurement, and the record or the message the decision makes.
//
// Design: docs/DESIGN.md#boundaries.

import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { commandsOf, deleteGotcha, gotchaId, writeGotcha } from '../gotchas.mjs'
import { readLog } from '../ledger.mjs'
import { admits } from '../locus.mjs'
import { measure } from '../measure.mjs'
import { approvedHead, journalsOf } from '../resume.mjs'
import { branchOf, closePath, git, isTestPath, posix, readJson, returnPath, revParse, worktreeOf, writeJson } from '../store.mjs'
import { cycleOf, cycleTestLocus, isHuman, ownReview, ownerOf, readTree, testLocusAdmits } from '../tree.mjs'
import { auditGap, closeDecision, fixNotConverging, greenRoundRole, heldMutations, measurementOk } from '../verdict.mjs'
import { worktreeProblem } from '../verify.mjs'
import { approved, escalated, faultRecords, message, parked, recordAll } from './records.mjs'

const PARK = ['needs_decision', 'contract_changed']
const ROUTE = ['needs_context', 'needs_locus', 'decompose', 'unsplittable', 'premise_mismatch']
const DONE = ['done', 'done_with_concerns']
const OUTSIDE_SUBJECT = 'agentics: outside locus'
const REVERT_SUBJECT = 'agentics: revert outside locus'

const list = (v) => (Array.isArray(v) ? v : [])
const lines = (text) => String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)
const latest = (entries, pred) => entries.reduce((found, e) => (pred(e) && (!found || e.seq > found.seq) ? e : found), null)
const keyOf = (f) => f.check + ':' + f.claim
/** A `command-<name>` id: the investigator establishes commands, never a producer's round. */
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
 * (docs/DESIGN.md#producer-returns). `head` is the worktree's head now and `head_before` the one the
 * round opened on; `author` writes the leaf's folder; `red` is the cycle's red, whose session is the
 * cycle's tests; `answering` is the request a cycle test round answered and `carried` every request
 * its dispatch carried; a stop's `said` is `dispatch`, whose stored return holds the producer's
 * words. A leaf with no producer (`role` '') is measured.
 */
export function producerOutcome({ leaf, role, round, ret, head_before = '', head = '', author = '', red = '', answering = '', carried = [], dispatch = '' }) {
  if (!role) return { next: 'measure' }
  const status = statusOf(role, ret)
  if (status === null) return { next: 'held' }
  const node = leaf.id
  const stop = (record) => ({ next: 'stop', records: [record] })
  if (PARK.includes(status)) return stop(parked(node, status, '', dispatch))
  if (status === 'blocked') return stop(escalated(node, status, '', dispatch))
  if (ROUTE.includes(status)) {
    if (author === 'planner') return { next: 'route', to: 'planner', records: [] }
    const ask = status === 'needs_locus' ? 'needs ' + list(ret.needs_locus && ret.needs_locus.paths).join(', ') : ''
    return { next: 'route', to: 'park', records: [parked(node, status === 'needs_context' ? 'needs_context' : 'needs_respec', ask, dispatch)] }
  }
  if (status === 'needs_tests') {
    if (role !== 'implementer' || leaf.role !== 'green') return stop(escalated(node, status, '', dispatch))
    return { next: 'needs_tests', records: [message(node, 'producer:' + red, 'needs_tests', { text: String(ret.text || '') }, round + 1, 'implementer')] }
  }
  if (status === 'declined') {
    const testRound = role === 'test-author' && (leaf.role === 'green' || leaf.role === 'audit')
    if (!testRound) return stop(escalated(node, status, '', dispatch))
    // A decline of anything beside the implementer's needs_tests declines a reviewer's or code's
    // request, and sent again it would be the same request: it ends in the user's hands, even when
    // the round carried needs_tests too.
    if (answering !== 'needs_tests' || carried.some((m) => m !== 'needs_tests')) return { next: 'declined', records: [escalated(node, 'tests_declined', '', dispatch)] }
    return { next: 'declined', records: [message(node, 'producer:' + node, 'declined', { why: String(ret.text || '') }, round + 1, 'test-author')] }
  }
  if (role === 'implementer' && round > 1 && head_before && head === head_before) {
    return stop(escalated(node, 'fix_without_commits', 'round ' + round + ' returned no commits', dispatch))
  }
  return { next: 'measure' }
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

/** The commands verification runs: `command` gotchas an investigator wrote, else the envelope's. */
function commandsFor(xc) {
  const given = (xc.envelope() || {}).commands || {}
  const found = commandsOf(xc.repo, xc.effort)
  const pick = (name) => found[name] || given[name] || ''
  const absent = (name) => Boolean((found.absent && found.absent[name]) || (given.absent && given.absent[name]))
  return {
    build: pick('build'), typecheck: pick('typecheck'), suite: pick('suite'), suiteFast: pick('suite_fast'), testOne: pick('test_one'),
    buildAbsent: absent('build'), typecheckAbsent: absent('typecheck'), suiteAbsent: absent('suite'), suiteFastAbsent: absent('suite_fast'),
  }
}

/**
 * Every path `git status` reports in the worktree, untracked ones included, forward-slashed. A
 * rename is the deletion of one path and the addition of another, so both are put back or kept.
 */
function uncommitted(worktree) {
  const fields = git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']).stdout.split('\0')
  return fields.filter((f) => f.length >= 4).map((f) => posix(f.slice(3)))
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

/** The close record of the round before `round` of `node` in this execution, or null. */
function previousClose(xc, events, node, round) {
  if (round <= 1) return null
  const d = latest(events, (e) => e.kind === 'dispatched' && e.node === node && e.round === round - 1)
  return d ? readJson(closePath(xc.repo, xc.effort, xc.execution, node, d.role || 'none', round - 1)) : null
}

/**
 * Close one producer round of `node`, in-process: read the stored return; on measure, commit a
 * shell-less author's admitted files, take what lies outside the locus out in a commit of its own
 * (measuring the head before it too), journal the series, measure, write the gotchas, decide, and
 * record the decision or the next round's message (docs/DESIGN.md#boundaries). Run again, it
 * converges: commits and reverts already made are read from git, a measurement already journalled
 * at the same key is reused, and `recordAll` lands no record twice.
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
  const ret = role ? readJson(returnPath(xc.dir, dispatch)) : null
  const status = statusOf(role, ret) || ''
  const { answering, carried } = answeringOf(tree.events, dispatch)
  const close = {
    node, role, round, thread, dispatch, status, head_sha: revParse(worktree, 'HEAD'), measurement: null,
    raise: false, answering, breach: null, gotchas_written: [], gotchas_deleted: [], committed: '', notes: [],
  }
  const finish = (decision, records, route = null) => {
    const { stops } = recordAll(xc, records)
    writeJson(closePath(xc.repo, xc.effort, xc.execution, node, role || 'none', round), { ...close, decision })
    return { decision, raise: close.raise, stops, ...(route ? { route } : {}) }
  }
  const state = () => readLog(xc.repo, xc.effort, 'state:' + xc.execution).entries
  const routeTo = (status, text, paths) => ({ to: 'planner', folder: parentId, request: { node, status, text, paths } })

  const out = producerOutcome({ leaf, role, round, ret, head_before, head: close.head_sha, author, red, answering, carried, dispatch })
  if (out.next === 'held') {
    const records = faultRecords(node, 'role', 'the ' + role + ' dispatch ' + dispatch + ' returned nothing', { nodes: tree.nodes, events: tree.events, state: state() })
    return finish({ next: 'stop', reason: 'held', failures: [] }, records)
  }
  if (out.next === 'route' && out.to === 'planner') {
    return finish({ next: 'route', reason: status, failures: [] }, [], routeTo(status, String(ret.text || ''), list(ret.needs_locus && ret.needs_locus.paths)))
  }
  if (out.next === 'needs_tests') return finish({ next: 'fix', reason: 'needs_tests', failures: [] }, out.records)
  if (out.next === 'declined' && out.records[0].kind === 'message') return finish({ next: 'fix', reason: 'declined', failures: [] }, out.records)
  if (out.next !== 'measure') {
    const f = out.records[0].fields
    return finish({ next: 'stop', reason: f.reason || f.return, failures: [] }, out.records)
  }

  // ---- the locus: a shell-less author's files committed, everything outside taken out
  const broken = worktreeProblem(worktree)
  const testRound = role === 'test-author' && (leaf.role === 'green' || leaf.role === 'audit')
  const scope = leaf.role === 'green' || leaf.role === 'audit' ? cycleTestLocus(tree.nodes, tree.status, leaf) : null
  const parentHead = revParse(xc.repo, 'refs/heads/' + branchOf(xc.effort, parentId))
  const isNew = (p) => Boolean(parentHead) && !git(xc.repo, ['cat-file', '-e', parentHead + ':' + p]).ok
  const baseFiles = base_sha ? lines(git(worktree, ['ls-tree', '-r', '--name-only', base_sha]).stdout) : []
  const held = [...new Set([...tree.nodes.values()]
    .filter((n) => n.kind === 'leaf' && n.id !== node && !cycle.includes(n.id) && (tree.status.get(n.id) || {}).status !== 'merged')
    .flatMap((n) => n.locus))]
  const admitsLeaf = (p) => admits({ locus: leaf.locus, path: p, baseFiles, held, tests: leaf.role !== 'green' && leaf.role !== 'audit' })
  const admitsRound = testRound ? (p) => testLocusAdmits(scope, p, isNew) : admitsLeaf
  const shellLess = role === 'test-author' || role === 'auditor'
  if (broken) close.notes.push('nothing committed or reverted: ' + broken.message)

  if (shellLess && !broken) {
    const mine = uncommitted(worktree).filter(admitsRound)
    if (mine.length) {
      git(worktree, ['add', '-A', '--', ...mine])
      const sha = commitStaged(worktree, (ret && ret.commit) || 'test(' + node + '): ' + leaf.title).sha
      if (sha) recordAll(xc, [{ kind: 'authored', fields: { node, role, round, sha } }])
      else close.notes.push('the commit of ' + mine.join(', ') + ' failed')
    }
  }
  const authored = journalsOf(xc.repo, xc.effort, xc.execution).filter((e) => e.kind === 'authored' && e.node === node)
  close.committed = (latest(authored, (e) => e.round === round) || {}).sha || ''
  const fences = {}
  if (scope && base_sha && !broken) {
    const range = new Set(lines(git(worktree, ['rev-list', base_sha + '..HEAD']).stdout))
    for (const e of authored) {
      if (e.role === 'test-author' && range.has(e.sha)) fences[e.sha] = [...new Set([...scope.tests, ...filesOf(worktree, e.sha).filter((p) => testLocusAdmits(scope, p, isNew))])]
    }
  }

  const cmd = commandsFor(xc)
  const earlier = readLog(xc.repo, xc.effort, 'journal:' + xc.execution).entries.filter((e) => e.kind === 'verify-observed' && e.node === node)
  const redHead = testRound && red ? approvedHead(tree.events, red) : ''
  const options = {
    worktree, node, branch, mode: 'order', base: base_sha, locus: leaf.locus, fences, held,
    approved: redHead ? scope.tests.filter((f) => git(xc.repo, ['cat-file', '-e', redHead + ':' + f]).ok).map((file) => ({ file, sha: redHead })) : [],
    ...cmd, mutations: heldMutations(leaf, earlier, list(ret && ret.mutations)), rigor: leaf.rigor, role: leaf.role, producer: role,
    checks: leaf.acceptance.filter((a) => !isHuman(a) && a.check.trim()).map((a) => a.check), tests: scope ? scope.tests : [],
  }
  const checkout = (detail) => faultRecords(node, 'checkout', detail, { nodes: tree.nodes, events: tree.events, state: state() })

  let pre = null
  if (!broken) {
    const subject = git(worktree, ['log', '-1', '--format=%s']).stdout.trim()
    if (subject === REVERT_SUBJECT) {
      // A close run again after its revert: the breach and the head before it are read back.
      const sha = revParse(worktree, 'HEAD')
      const before = revParse(worktree, 'HEAD^')
      const line = latest(earlier, (e) => e.head_sha === before)
      pre = { paths: filesOf(worktree, sha), sha, pre_sha: before, payload: line }
    } else {
      // A close run again after it took the round's stray files into a commit of their own goes
      // on from that commit: those files are the loose ones, and the head before it the start.
      const aside = subject === OUTSIDE_SUBJECT
      const start = revParse(worktree, aside ? 'HEAD^' : 'HEAD')
      const fenced = new Set(Object.values(fences).flat())
      const net = base_sha ? lines(git(worktree, ['diff', '--name-only', '--no-renames', base_sha + '...HEAD']).stdout).map(posix) : []
      const stray = uncommitted(worktree)
      // Committed outside the leaf's locus: back to the base. Written outside the round's and never
      // committed: back to the head. Either way taken out in a commit of its own.
      const series = net.filter((p) => !admitsLeaf(p) && !fenced.has(p))
      const loose = (aside ? filesOf(worktree, 'HEAD') : stray.filter((p) => !admitsRound(p))).filter((p) => !series.includes(p))
      const outside = [...series, ...loose]
      const inside = stray.filter((p) => !outside.includes(p))
      if (inside.length) {
        putBack(worktree, 'HEAD', inside)
        close.notes.push('uncommitted ' + inside.join(', ') + ' put back to the head before measuring')
      }
      if (outside.length) {
        const taking = outside.filter((p) => stray.includes(p))
        if (taking.length) {
          git(worktree, ['add', '-A', '--', ...taking])
          if (commitStaged(worktree, OUTSIDE_SUBJECT).failed) close.notes.push('the commit of ' + taking.join(', ') + ' outside the locus failed')
        }
        const before = revParse(worktree, 'HEAD')
        const taken = await measure(xc, { ...options, locus: [...leaf.locus, ...outside], held: [] }, ports)
        if (taken.moved || (taken.payload.error && taken.payload.error.kind === 'watch_failed')) {
          close.measurement = taken.payload
          return finish({ next: 'stop', reason: 'checkout', failures: [] }, checkout("the user's checkout moved while " + node + ' was measured'))
        }
        putBack(worktree, base_sha || start, series)
        putBack(worktree, start, loose)
        const reverting = commitStaged(worktree, REVERT_SUBJECT)
        if (reverting.failed) close.notes.push('the revert commit of ' + outside.join(', ') + ' failed')
        pre = { paths: outside, sha: reverting.sha || before, pre_sha: before, payload: taken.payload, unrecorded: !reverting.sha }
      }
    }
    if (pre) {
      const known = state().some((e) => e.kind === 'breach_reverted' && e.node === node && e.sha === pre.sha)
      if (!known && !pre.unrecorded) recordAll(xc, [{ kind: 'breach_reverted', fields: { node, paths: pre.paths, sha: pre.sha } }])
    }
  }

  const head = revParse(worktree, 'HEAD')
  close.head_sha = head
  if (DONE.includes(status)) {
    const commits = seriesOf(worktree, base_sha)
    if (commits.length) recordAll(xc, [{ kind: 'series-done', fields: { node, branch, head_sha: head, commits } }])
  }

  const { payload: m, moved } = await measure(xc, options, ports)
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

  const history = earlier.filter((e) => e.head_sha !== head && (!pre || e.head_sha !== pre.pre_sha))
  const decision = closeDecision(m, leaf, history, role)
  const claims = decision.failures.map((f) => f.claim).join('; ')
  const passed = pre && pre.payload ? measurementOk(pre.payload, leaf, role).ok : false
  if (pre) close.breach = { paths: pre.paths, sha: pre.sha, pre_sha: pre.pre_sha, pre_passed: passed }

  if (passed && m.stop_reason === 'completed' && !measurementOk(m, leaf, role).ok) {
    const text = 'leaf-close took ' + pre.paths.join(', ') + ' out of the series: the head with them passed, the head without them fails'
    if (author === 'planner') return finish({ ...decision, next: 'route', reason: 'needs_locus' }, [], routeTo('needs_locus', text, pre.paths))
    return finish({ ...decision, next: 'stop', reason: 'needs_respec' }, [parked(node, 'needs_respec', 'needs ' + pre.paths.join(', '), dispatch)])
  }

  // A round that answered the implementer's needs_tests and measured hands the implementer its tests.
  const ready = testRound && leaf.role === 'green' && answering === 'needs_tests'
    ? [message(node, 'producer:' + node, 'tests_ready', { files: (close.committed ? filesOf(worktree, close.committed) : []).filter(isTestPath) }, round + 1)]
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
    const previous = previousClose(xc, tree.events, node, round)
    if (fixNotConverging(previous, decision, head)) {
      return finish({ ...decision, next: 'stop', reason: 'verify_not_converging' },
        [escalated(node, 'verify_not_converging', 'two consecutive measurements failed identically: ' + claims)])
    }
    const before = previous && previous.decision && previous.decision.next === 'fix' ? list(previous.decision.failures).map(keyOf) : []
    const now = new Set(decision.failures.map(keyOf))
    close.raise = before.length > 0 && before.every((k) => now.has(k))
    const surviving = list(m.mutations).filter((x) => x && x.applied && !x.bites)
    if (leaf.role === 'audit' && surviving.length) {
      const mutations = surviving.map((x) => ({ file: x.file, find: x.find, replace: x.replace, expect_failing: list(x.expect_failing) }))
      return finish(decision, [message(node, 'producer:' + red, 'surviving_mutations', { mutations }, round + 1)])
    }
    const next = leaf.role === 'green'
      ? (greenRoundRole({ close: { role, status: close.status, decision } }) === 'test-author' ? 'producer:' + red : 'producer:' + node)
      : leaf.role === 'audit' && auditGap([...earlier, m]) ? 'producer:' + red : thread
    const records = [message(node, next, 'failures', { source: 'verification', failures: decision.failures }, round + 1)]
    return finish(decision, next === 'producer:' + node ? [...records, ...ready] : records)
  }
  if (decision.next === 'finding') {
    const records = [escalated(node, 'verify_finding', claims)]
    if (author === 'planner') return finish({ ...decision, next: 'route' }, records, routeTo('verify_finding', claims, []))
    records.push(parked(parentId, 'needs_respec', 'verify leaf ' + node + ' found: ' + claims))
    return finish({ ...decision, next: 'stop' }, records)
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
