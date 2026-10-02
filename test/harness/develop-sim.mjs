// test/harness/develop-sim.mjs — lib/boundary.mjs, simulated, for scenario tests of
// execute-approved-plan-in-worktrees.
//
// The workflow's orchestration — what it dispatches, what it hands each boundary, how it routes
// what comes back — is what these scenarios test, so the boundaries are answered from an
// in-memory tree, event log and file store rather than a repository. Every courier command is
// parsed with the lib's own `handleArgs` over the lib's own `ARGS`, every payload goes through the
// lib's own `handleEnvelope`, and every decision a boundary records is computed by the same pure
// functions lib/boundary.mjs and lib/verdict.mjs compute it with, so the workflow and the lib
// cannot drift apart unseen. Agents write what they say to the files their prompts name, as the
// real ones do. Every answer is carried the way a real courier carries one, computed when the
// courier is dispatched and delivered a task later, so units settle while a boundary is in flight
// as they do on a real host. `lib/boundary.mjs` itself is tested against real git in
// test/boundary-*.test.mjs.

import {
  ARGS, approved, closeOutcome, escalated, executorOutcome, faultRecords, freshRecords, gateOutcome, launchRecords,
  mergeRecords, needsTestsFixes, parked, planOutcome, prepareOutcome, reviewFixes, reviewedOutcome, reviewedProducer, rulingOutcome,
  settleOutcome, specStops, stopsOf,
} from '../../lib/boundary.mjs'
import { approvedHead } from '../../lib/resume.mjs'
import { reviewOf, schedule, summarize } from '../../lib/schedule.mjs'
import { ancestorsOf, handleArgs, handleEnvelope, parentOf } from '../../lib/store.mjs'
import { childrenOf, deriveStatus, isYardstick, normalizeNode, ownReview } from '../../lib/tree.mjs'
import { greenRoundRole, integrationPark, reviewExit } from '../../lib/verdict.mjs'
import { carriedEnvelope } from './workflow-host.mjs'

const STAMP = '20260925-120000'

/**
 * A node as a scenario writes it, defaults filled. `status` (and `reason`) seed the event log;
 * `own_review` and `coupled` say what the tree implies, and the simulation derives the node the
 * scheduler reads from them.
 */
export function row(id, extra = {}) {
  const leaf = extra.kind === undefined || extra.kind === 'leaf'
  return {
    id, title: 'do ' + id, kind: 'leaf', author: 'you', rigor: leaf ? 'tdd' : '', role: 'none',
    deps: [], locus: leaf ? ['src/' + id + '.js'] : [], reads: [], provides: [], consumes: [],
    decisions: [], dispatch: {}, ground_known: true, own_review: false, coupled: false,
    spec_path: '/repo/.agentics/e1/' + (id === '.' ? '' : id + '/') + 'DESIGN.md',
    ...extra,
  }
}

export const composite = (id, extra = {}) => row(id, { kind: 'composite', ...extra })

/** The words of a command line: double-quoted values whole, everything else split on spaces. */
const words = (command) => [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]))

/**
 * A simulated disk. `nodes` are scenario rows; `script` overrides any boundary's answer:
 *   script.preflight(args, sim, n) → payload fields (a checkpoint, `stale` with `rows`)
 *   script.compiled(args, sim, n) → the rows of the tree after spec-prepare compiled a folder
 *   script.facts[id] → a leaf's resume facts, as the ladder computes them
 *   script.close[id] = [decision per measurement] | (args, n) => decision
 *   script.merge(args, n, sim) → what the batch observed: merged, failed_alone, combination, conflict, drift, or an error
 *   script.open[id] = [status per call]
 *   script.specCheck(args, n, sim) → spec facts: decisions_n, problems, hash
 *   script.prepare(args, n, sim) → spec-prepare facts: status, problems, compile
 *   script.gate(args, n, sim) → spec-gate fields, over the computed ones
 *   script.suiteGate(args, n, sim) → suite-gate observations: ran, passed, failures, record
 *   script.damage(name, args, n) → (envelope) => void, applied after the digest
 */
export function simulate(nodes, script = {}) {
  const sim = {
    nodes: new Map(),     // id -> scenario row
    events: [],           // the effort's event log
    state: [],            // this execution's state log
    files: new Map(),     // path -> what was written there: an agent's file, a card, a record
    integ: new Map(),     // composite id -> {branch, worktree, head, base}
    locked: new Map(),    // leaf id -> the stopped leaf whose lock it met
    underWay: new Set(),  // nodes a scenario says work already stands on
    commits: new Map(),   // executor label -> the commits its return listed
    closes: new Map(),    // node#round -> {decision, head_sha}: each close's record
    reviewRecords: new Map(), // node#review round -> the review loop's state after it
    fixes: new Map(),     // node#round -> the failures and findings that round's brief carries
    calls: [],            // [{name, args}]
    opens: [],            // leaf ids in open order
    batches: [],          // merge-batch cards
    gates: [],            // suite-gate targets
    dispositions: [],     // every disposition recorded, {node, finding, outcome}
    prepared: [],         // spec-prepare args
    reviewed: [],         // the ledger's `reviewed` lines, one per review round
    edited: new Set(),    // folders whose spec an incorporation edited since their last review
    counts: new Map(),
  }
  let seq = 0
  let cards = 0
  const revisions = new Map()   // id -> the seq of its latest revision
  const count = (key) => {
    const n = sim.counts.get(key) || 0
    sim.counts.set(key, n + 1)
    return n
  }
  const event = (entry) => sim.events.push({ ...entry, seq: ++seq })

  /** The live nodes as the scheduler reads them. */
  const tree = () => {
    const out = new Map()
    for (const r of sim.nodes.values()) {
      const n = { ...normalizeNode(r), seq: revisions.get(r.id) }
      // A scenario's `own_review` stands for whatever in the node earns a review loop.
      if (r.own_review && !ownReview(n)) n.rigor = n.rigor === 'tdd' ? 'tdd-pair' : n.rigor
      out.set(r.id, n)
    }
    for (const r of sim.nodes.values()) {
      if (r.coupled && out.has(parentOf(r.id))) out.get(parentOf(r.id)).shared.push(...r.locus)
    }
    return out
  }
  const statusOf = (id) => ((deriveStatus(tree(), sim.events).get(id)) || {}).status || 'planned'

  /** Land whichever records are not yet the word on disk, by the lib's own rule. */
  const record = (records) => {
    const nodesNow = tree()
    const fresh = freshRecords(records, { nodes: nodesNow, status: deriveStatus(nodesNow, sim.events), events: sim.events, state: sim.state })
    for (const r of fresh) {
      if (r.file === 'events') event({ execution: STAMP, ...r.entry })
      else if (r.file === 'state') sim.state.push({ ...r.entry, seq: ++seq })
    }
    return stopsOf(records)
  }
  const disk = () => ({ nodes: tree(), events: sim.events, state: sim.state })
  /** The role the simulated leaf-open dispatched a round to, as lib/boundary.mjs reads it off the event log. */
  const roleOfRound = (id, round) =>
    (sim.events.filter((e) => e.kind === 'dispatched' && e.node === id && e.round === round).pop() || {}).role || ''
  /** Whom a round is for, as lib/boundary.mjs derives it: a green's from the close and review of the round before. */
  const roundRoleOf = (id, round, given) => {
    if (normalizeNode(sim.nodes.get(id) || {}).role !== 'green') return given
    if (round <= 1) return 'implementer'
    const review = [...sim.reviewRecords.entries()].filter(([k, r]) => k.startsWith(id + '#') && r.round === round - 1).map(([, r]) => r).pop() || null
    return greenRoundRole({ close: sim.closes.get(id + '#' + (round - 1)) || null, review })
  }

  const SEED = {
    active: (r) => [{ kind: 'dispatched', node: r.id }],
    approved: (r) => [{ kind: 'dispatched', node: r.id }, { kind: 'approved', node: r.id, head_sha: r.approved_head || 'approved-' + r.id }],
    escalated: (r) => [{ kind: 'escalated', node: r.id, reason: r.reason || '' }],
    parked: (r) => [{ kind: 'parked', node: r.id, return: r.reason || '' }],
    merged: (r) => [{ kind: 'merged', node: r.id }],
  }

  /** Lay rows onto the tree: a new or revised node gets a new seq; a status it names seeds events. */
  const apply = (list) => {
    const ids = new Set(list.map((r) => r.id))
    for (const id of [...sim.nodes.keys()]) if (!ids.has(id)) sim.nodes.delete(id)
    for (const r of list) {
      const before = sim.nodes.get(r.id)
      if (!before || before.kind !== r.kind || (r.rev !== undefined && r.rev !== before.rev)) revisions.set(r.id, ++seq)
      sim.nodes.set(r.id, { ...r })
    }
    for (const r of list) if (r.status && SEED[r.status] && statusOf(r.id) !== r.status) SEED[r.status](r).forEach(event)
  }
  apply(nodes)

  /** A launch's row: the handles a unit branches on and tiers its dispatches by. */
  const rowFor = (id) => {
    const r = sim.nodes.get(id)
    if (!r) return null
    return {
      kind: r.kind, author: r.author, rigor: r.rigor, role: r.role, provides_n: (r.provides || []).length, dispatch: r.dispatch,
      ground_known: r.ground_known, rev: r.rev || 0, spec_path: r.spec_path, children_n: childrenOf(sim.nodes, id).length,
      own_review: r.own_review === true,
    }
  }

  /** A card: what lib/boundary.mjs writes for an agent to read, kept in the file store. */
  const card = (content) => {
    const path = '/cards/' + content.unit + '-' + (++cards) + '.json'
    sim.files.set(path, content)
    return path
  }
  const nodeCard = (id, unit, extra = {}) => {
    const r = sim.nodes.get(id)
    return card({ unit, id, title: r.title, kind: r.kind, author: r.author, spec_path: r.spec_path, decisions: r.decisions, intent: r.intent || '', ...extra })
  }
  const parentOfRow = (id) => {
    const p = sim.nodes.get(parentOf(id))
    return p ? { id: p.id, kind: p.kind, author: p.author, spec_path: p.spec_path } : null
  }
  const waitsOn = (id) => [...new Set([id, ...ancestorsOf(id)].flatMap((a) => (sim.nodes.get(a) || { deps: [] }).deps))]

  const input = (args) => {
    const nodesNow = tree()
    const since = Math.max(-1, ...sim.state.filter((e) => e.kind === 'invocation').map((e) => e.seq))
    return {
      nodes: nodesNow, status: deriveStatus(nodesNow, sim.events), events: sim.events, state: sim.state, root: args.root || sim.root || '.',
      running: args.running || [], planning: args.planning || [], stopping: args.stopping === true, maxParallel: 4,
      held: [...new Set(sim.state.filter((e) => e.kind === 'fault' && e.seq > since).map((e) => e.node))],
      integrationOf: (id) => sim.integ.get(id) || null,
      lockedBy: (id) => sim.locked.get(id) || '',
      approvedHead: (id) => approvedHead(sim.events, id),
    }
  }

  /** The faults a workflow names, `<node>:<channel>`, recorded as the lib records them. */
  const faultsNamed = (tokens) => (tokens || []).flatMap((t) => {
    const at = t.lastIndexOf(':')
    return sim.nodes.has(t.slice(0, at)) ? faultRecords(t.slice(0, at), t.slice(at + 1), '', disk()) : []
  })

  const ok = (boundary, extra) => ({ boundary, ok: true, error: null, stops: [], ...extra })

  const answer = {
    preflight(args) {
      sim.root = args.root
      sim.state.push({ kind: 'invocation', seq: ++seq })
      const invocation = sim.state.filter((e) => e.kind === 'invocation').length
      const extra = script.preflight ? script.preflight(args, sim, count('preflight')) || {} : {}
      let stale = null
      if (extra.stale) {
        const rows = extra.stale.rows || []
        for (const r of rows) if (r.under_way) sim.underWay.add(r.id)
        const recordPath = '/x/stale-' + extra.stale.now + '.json'
        sim.files.set(recordPath, { kind: 'stale', now: extra.stale.now, nodes: extra.stale.nodes })
        stale = { nodes: extra.stale.nodes, now: extra.stale.now, brief: extra.stale.brief, record: recordPath }
      }
      return ok('preflight', {
        checkpoint: extra.checkpoint ? { reason: extra.checkpoint.reason } : null, invocation, stale,
        counts: { nodes: sim.nodes.size, leaves: [...sim.nodes.values()].filter((r) => r.kind === 'leaf').length, gaps: 0, untraced: 0 },
        dirty_worktrees: [], said_dir: '/said', max_parallel: 4,
      })
    },
    schedule(args) {
      const faults = record(faultsNamed(args.fault))
      const now = input(args)
      const { launch, idle } = schedule(now)
      const facts = new Map(launch.filter((l) => l.unit === 'leaf').map((l) => [l.id, (script.facts || {})[l.id] || null]))
      const records = launchRecords(launch, now, facts, (id) => sim.nodes.get(id).spec_path)
      const stops = [...faults, ...record(records)]
      const designed = new Set(records.filter((r) => r.entry.kind === 'parked').map((r) => r.entry.node))
      return ok('schedule', {
        idle, max_parallel: 4, stops,
        launch: launch.filter((l) => !designed.has(l.id)).map((l) => {
          if (l.unit === 'merge') return { unit: 'merge', target: l.target, card: card({ unit: 'merge', id: l.target, children: l.children, cycles: l.cycles }) }
          if (l.unit === 'plan') return { unit: 'plan', id: l.id, why: l.why, card: nodeCard(l.id, 'plan'), row: rowFor(l.id) }
          if (l.unit === 'review') return { unit: 'review', id: l.id, card: nodeCard(l.id, 'review', { where: l.where, children: l.children, unreviewed: l.unreviewed }) }
          return { unit: 'leaf', id: l.id, card: nodeCard(l.id, 'leaf'), row: rowFor(l.id), facts: facts.get(l.id), waits_on: waitsOn(l.id) }
        }),
      })
    },
    'leaf-open'(args) {
      sim.opens.push(args.node)
      const plan = script.open && script.open[args.node]
      const n = count('open:' + args.node)
      const st = Array.isArray(plan) ? plan[n] || 'opened' : 'opened'
      if (st === 'held') {
        sim.locked.set(args.node, 'x')
        return ok('leaf-open', { status: 'locus_held', held_by: [{ node: 'x', status: 'approved' }] })
      }
      const role = roundRoleOf(args.node, args.round, args.role)
      if (st === 'opened') event({ kind: 'dispatched', node: args.node, role, round: args.round })
      return ok('leaf-open', {
        status: st, role, branch: 'agentics/e--' + args.node,
        worktree: '/wt/' + args.node, base_sha: 'b-' + args.node, head_sha: 'b-' + args.node,
        brief_path: '/briefs/' + args.node + '-r' + args.round + '.md', brief_digest: 'd' + args.round,
        report_path: '/reports/' + args.node + '-r' + args.round + '.md', max_parallel: 4,
      })
    },
    'leaf-close'(args) {
      const id = args.node
      const leafRole = normalizeNode(sim.nodes.get(id) || {}).role
      const role = leafRole === 'green' ? roleOfRound(id, args.round) || args.role : args.role
      const commits = sim.commits.get(role + ':' + id + '#' + args.round)
      const head = commits && commits.length === 0 ? args.head_before : 'h-' + id + '-' + args.round
      const recordPath = '/closes/' + id + '-r' + args.round + '.json'
      const front = executorOutcome({ node: id, role, status: args.status, said: args.said, mode: args.mode, round: args.round, head_before: args.head_before, head, leafRole })
      if (front) {
        const stops = record(front.next === 'held' ? faultRecords(id, 'dispatch', '', disk()) : front.records)
        if (front.needs_tests) {
          sim.closes.set(id + '#' + args.round, { role, status: 'needs_tests', decision: { next: 'fix', failures: [] }, head_sha: head })
          sim.fixes.set(id + '#' + (args.round + 1), needsTestsFixes(sim.fixes.get(id + '#' + args.round), args.said, sim.files.get(args.said) || ''))
        }
        return ok('leaf-close', { status: 'done', node: id, head_sha: head, decision: { next: front.next, failures_n: 0 }, raise: false, record: front.needs_tests ? recordPath : '', replan: null, stops })
      }
      const n = count('close:' + id)
      const plan = script.close && script.close[id]
      const node = sim.nodes.get(id) || {}
      const fallback = { next: node.own_review ? 'review' : 'approve', reason: '', failures: [] }
      const decision = { failures: [], ...(typeof plan === 'function' ? plan(args, n) : Array.isArray(plan) ? plan[n] || fallback : fallback) }
      const out = closeOutcome({
        node: id, leaf: tree().get(id), parent: parentOfRow(id), head, decision, record: recordPath,
        previous: sim.closes.get(id + '#' + (args.round - 1)) || null,
        established: sim.state.some((e) => e.kind === 'dispatch' && e.role === 'investigator'),
      })
      sim.closes.set(id + '#' + args.round, { role, decision, head_sha: head })
      if (out.next === 'fix') sim.fixes.set(id + '#' + (args.round + 1), decision.failures.map((f) => ({ source: 'verification', ...f })))
      const parent = parentOfRow(id)
      return ok('leaf-close', {
        status: 'done', node: id, head_sha: head, decision: { next: out.next, failures_n: decision.failures.length }, raise: Boolean(out.raise),
        record: recordPath, report_path: '/reports/' + id + '-r' + args.round + '.md',
        replan: out.replan_parent ? { id: parent.id, card: nodeCard(parent.id, 'plan'), row: rowFor(parent.id), said: recordPath } : null,
        stops: record(out.records),
      })
    },
    'leaf-review'(args) {
      const id = args.node
      const review = sim.files.get(args.review_file)
      if (!review || !Array.isArray(review.findings)) {
        return ok('leaf-review', { decision: { next: 'held', reason: '' }, raise: false, record: '', stops: record(faultRecords(id, 'dispatch', '', disk())) })
      }
      const prior = sim.reviewRecords.get(id + '#' + (args.review_round - 1)) || {}
      const leaf = normalizeNode(sim.nodes.get(id))
      const exit = reviewExit({
        yardstick: isYardstick(leaf), findings: review.findings, verdicts: review.fix_verdicts || [], prior,
        producer: reviewedProducer(leaf, roleOfRound(id, args.round)),
      })
      sim.reviewRecords.set(id + '#' + args.review_round, { ...exit, round: args.round })
      const recordPath = '/reviews/' + id + '-r' + args.review_round + '.json'
      const records = []
      if (exit.next === 'approve') records.push(approved(id, 'h-' + id + '-' + args.round, args.review_round, false))
      if (exit.next === 'escalate') records.push(escalated(id, exit.reason, exit.detail, args.review_file.replace(/\.json$/, '.md')))
      if (exit.next === 'fix') sim.fixes.set(id + '#' + (args.round + 1), reviewFixes(exit.open, leaf))
      return ok('leaf-review', { decision: { next: exit.next, reason: exit.reason }, raise: exit.raise, record: recordPath, stops: record(records) })
    },
    'merge-batch'(args) {
      const { children, cycles } = sim.files.get(args.card)
      const batch = { target: args.target, children, cycles }
      sim.batches.push(batch)
      const n = count('merge:' + args.target)
      const seen = script.merge ? script.merge(batch, n, sim) || {} : {}
      if (seen.ok === false || seen.error) {
        const stops = record(seen.error && seen.error.kind === 'integration' ? [escalated(args.target, 'merge_batch_failed', seen.error.message)] : [])
        return { boundary: 'merge-batch', ok: false, error: { kind: (seen.error && seen.error.kind) || 'integration' }, stops }
      }
      const merged = seen.merged || batch.children.map((c) => ({ id: c.id, merged_sha: 'm-' + c.id }))
      const failedAlone = (seen.failed_alone || []).map((f) => ({ ...f, ids: f.ids || [f.id] }))
      const head = 'm-' + args.target + '-' + n
      for (const m of merged) event({ kind: 'merged', node: m.id })
      sim.integ.set(args.target, { branch: 'agentics/e' + (args.target === '.' ? '' : '--' + args.target), worktree: '/wt/' + args.target, head, base: 'base0' })
      const drift = seen.drift || []
      const recordPath = '/merges/' + args.target + '-' + n + '.json'
      sim.files.set(recordPath, { target: args.target, head_sha: head, drift })
      const isLeaf = (id) => (sim.nodes.get(id) || {}).kind === 'leaf'
      const stops = record(mergeRecords(args.target, { merged, conflict: seen.conflict || null, combination: seen.combination || [], failedAlone, isLeaf }))
      return ok('merge-batch', {
        status: 'done', target: args.target, head_sha: head, verified: true, record: recordPath, merged,
        failed_alone: failedAlone.filter((f) => f.ids.length === 1 && isLeaf(f.id))
          .map((f) => ({ id: f.id, card: nodeCard(f.id, 'leaf'), row: rowFor(f.id), facts: (script.facts || {})[f.id] || null })),
        drift: drift.map((d) => ({ node: d.node, contract: d.contract, stopped: d.stopped || '' })),
        drift_brief: seen.drift_brief || (drift.length ? '/merges/' + args.target + '.drift.md' : ''), unexamined_n: 0, stops,
      })
    },
    'suite-gate'(args) {
      sim.gates.push(args.target)
      const seen = script.suiteGate ? script.suiteGate(args, count('suite-gate:' + args.target), sim) || {} : {}
      const head = (sim.integ.get(args.target) || {}).head || ''
      if (seen.passed === false) {
        const stops = record([escalated(args.target, 'fails_full_suite', (seen.failures || []).map((f) => f.claim).join('; '))])
        return ok('suite-gate', { status: 'done', target: args.target, head_sha: head, ran: true, passed: false, review: '', record: seen.record || '', stops })
      }
      const review = reviewOf(input({}), args.target)
      if (!review.earned) record([{ file: 'events', entry: { kind: 'claims', node: args.target, head_sha: head, review: 'not_earned', claims: [] } }])
      return ok('suite-gate', { status: 'done', target: args.target, head_sha: head, ran: Boolean(seen.ran), passed: true, review: review.earned ? 'earned' : 'not_earned', record: '' })
    },
    'folder-review'(args) {
      const review = sim.files.get(args.review_file)
      if (!review || !Array.isArray(review.claims)) return ok('folder-review', { status: 'no_review', stops: record(faultRecords(args.target, 'dispatch', '', disk())) })
      const theCard = sim.files.get(args.card) || {}
      const said = args.review_file.replace(/\.json$/, '.md')
      const held = integrationPark(review.findings || [], review.claims, theCard.spec_path || '')
      const records = [{ file: 'events', entry: { kind: 'claims', node: args.target, head_sha: (theCard.where || {}).head || '', review: 'done', claims: review.claims.map(({ claim, verdict }) => ({ claim, verdict })), said } }]
      if (held) records.push(parked(args.target, held.why, held.question, said))
      return ok('folder-review', { status: 'recorded', claims_n: review.claims.length, findings_n: (review.findings || []).length, stops: record(records) })
    },
    'rule-close'(args) {
      const nodesNow = tree()
      const read = sim.files.get(args.rulings_file)
      const out = rulingOutcome({
        kind: args.kind, record: sim.files.get(args.record) || {}, running: args.running,
        rulings: read && Array.isArray(read.rulings) ? new Map(read.rulings.map((r) => [r.node, r])) : null,
        nodes: nodesNow, status: deriveStatus(nodesNow, sim.events), events: sim.events, state: sim.state,
        underWay: (id) => sim.underWay.has(id), specOf: (id) => sim.nodes.get(id).spec_path,
        saidFor: (id, r, affected) => {
          const path = args.rulings_file.replace(/\.json$/, '') + '-' + id.split('/').join('.') + '.md'
          sim.files.set(path, affected ? r.question : r.why)
          return path
        },
      })
      return ok('rule-close', {
        replan: out.replan.map((r) => ({ id: r.id, card: nodeCard(r.id, 'plan'), row: rowFor(r.id), said: r.said })), stops: record(out.records),
      })
    },
    postflight(args) {
      const stops = record(faultsNamed(args.fault))
      const summary = summarize(input({}))
      const where = sim.integ.get(sim.root || '.') || {}
      return ok('postflight', {
        summary, closed: summary.done, integration: { branch: where.branch || '', head_sha: where.head || '' }, cleanup_n: 0, unmerged_n: 0, stops,
      })
    },
    'spec-check'(args) {
      if (args.said) {
        const plan = planOutcome(args.node, args.status, args.said)
        if (plan) {
          const stops = record(plan.next === 'held' ? faultRecords(args.node, 'dispatch', '', disk()) : plan.records)
          return ok('spec-check', { status: plan.next, node: args.node, stops })
        }
      }
      const n = count('spec-check:' + args.node)
      const facts = {
        spec_path: '/repo/.agentics/e1/' + (args.node === '.' ? '' : args.node + '/') + 'DESIGN.md', exists: true, hash: 'h' + n,
        decisions_n: 0, problems: [], ...(script.specCheck ? script.specCheck(args, n, sim) || {} : {}),
      }
      const stops = record(specStops(args.node, facts))
      return ok('spec-check', {
        status: stops.length ? 'stopped' : 'checked', node: args.node, spec_path: facts.spec_path, exists: true, hash: facts.hash,
        decisions_n: facts.decisions_n, problems_n: facts.problems.length, stops,
      })
    },
    'spec-reviewed'(args) {
      const findingsOf = (path) => (sim.files.get(path) || {}).findings || []
      const out = reviewedOutcome({
        node: args.node, hash: args.hash, findings: findingsOf(args.findings_file), previous: findingsOf(args.previous_file),
        previousHash: args.previous_hash, dispositions: sim.dispositions.filter((d) => d.node === args.node),
        complete: args.complete, remaining: args.remaining,
      })
      sim.reviewed.push({ node: args.node, ...out.reviewed })
      sim.edited.delete(args.node)
      const stops = record(out.records)
      return ok('spec-reviewed', { status: stops.length ? 'stopped' : 'recorded', fresh: out.fresh, stops })
    },
    'spec-settle'(args) {
      const out = settleOutcome({
        node: args.node, hash: args.hash, findings: (sim.files.get(args.findings_file) || {}).findings || [], asked: args.finding,
        refused: args.refused, status: args.status, said: args.said, dispositions: (sim.files.get(args.return_file) || {}).dispositions || [],
      })
      if (out.next === 'held') return ok('spec-settle', { status: 'held', stops: record(faultRecords(args.node, 'dispatch', '', disk())) })
      const stops = record(out.records)
      if (out.next !== 'settled') return ok('spec-settle', { status: out.next, refused: out.refused || [], stops })
      for (const d of out.dispositions) {
        if (!sim.dispositions.some((x) => x.node === args.node && x.finding === d.finding && x.outcome === d.outcome)) sim.dispositions.push({ node: args.node, ...d })
      }
      // An incorporated finding is an edit: no review has read the spec the planner left behind.
      if (out.dispositions.some((d) => d.outcome === 'incorporated')) sim.edited.add(args.node)
      return ok('spec-settle', { status: 'settled', incorporated_n: out.dispositions.filter((d) => d.outcome === 'incorporated').length })
    },
    'spec-gate'(args) {
      // approvalGate over the simulated ledger: the latest review of the text as it stands, and
      // every disposition recorded for the folder in any round.
      const last = sim.edited.has(args.node) ? null : sim.reviewed.filter((r) => r.node === args.node).pop()
      const settled = new Set(sim.dispositions.filter((d) => d.node === args.node).map((d) => d.finding))
      const open = last ? (last.ambiguities || []).filter((id) => !settled.has(id)) : []
      const complete = !!last && last.complete === true
      const gate = {
        ratifiable: complete && open.length === 0, open, coverage_complete: complete, reviewed: !!last,
        ...(script.gate ? script.gate(args, count('gate:' + args.node), sim) || {} : {}),
      }
      const stops = record(gateOutcome(args.node, gate, args.edited))
      return ok('spec-gate', { ...gate, status: gate.ratifiable ? 'open' : stops.length ? 'stopped' : 'shut', stops })
    },
    'spec-prepare'(args) {
      sim.prepared.push(args)
      const facts = script.prepare ? script.prepare(args, count('prepare:' + args.node), sim) || {} : {}
      const refused = Boolean(facts.status && facts.status !== 'prepared')
      const compile = facts.compile || { ok: true, problems: [], written: [1] }
      if (!refused && compile.ok && script.compiled) {
        const rows = script.compiled(args, sim, count('compiled:' + args.node))
        if (rows) apply(rows)
      }
      const r = rowFor(args.node)
      const row = r ? { kind: r.kind, rev: r.rev, children_n: r.children_n } : null
      const stops = record(prepareOutcome(args.node, { refused, problems: facts.problems || [], compile, row, leafRev: args.leaf_rev }))
      return ok('spec-prepare', {
        status: stops.length ? 'stopped' : 'prepared', hash: 'h', compile: { ok: compile.ok, written_n: (compile.written || []).length }, row, stops,
      })
    },
  }

  /** A courier: parse its one command as the lib does, answer it, and carry the payload back. */
  const courier = (prompt) => {
    const command = prompt.split('\n\n')[1] || ''
    const [, , name, ...argv] = words(command)
    if (!ARGS[name]) throw new Error('courier prompt names no boundary: ' + command.slice(0, 120))
    const { value: args, problem } = handleArgs(argv, ARGS[name])
    if (problem) throw new Error(name + ': ' + problem.kind + ' — ' + problem.message)
    sim.calls.push({ name, args })
    record(dispatchLines(args.dispatch))
    const payload = handleEnvelope(answer[name](args)).payload
    const damage = script.damage && script.damage(name, args, count('damage:' + name))
    return carriedEnvelope(JSON.parse(JSON.stringify(payload)), damage || undefined)
  }

  const dispatchLines = (tokens) => (tokens || []).map((t) => {
    const at = t.lastIndexOf('=')
    const [role, model, effort] = t.slice(at + 1).split('/')
    return { file: 'state', entry: { kind: 'dispatch', label: t.slice(0, at), node: '', role, model, effort } }
  })

  sim.courier = courier
  sim.statusOf = statusOf
  sim.event = event
  return sim
}

/** The file a prompt names after `pattern`: a path runs to the next space. */
const named = (prompt, pattern) => {
  const m = pattern.exec(prompt)
  return m ? m[1] : ''
}
const SAID = /in full, to (\S+) \(its first line/
const AS_JSON = /as JSON, to (\S+):/
const REVIEW_FILE = /Then return status written\.\n(\S+)$/

/**
 * Route every agent type; a scenario overrides by agentType short name or label, answering in the
 * shape the agent's work takes — a review, a settlement, a ruling, an executor's account. The
 * agent then writes it where its prompt says, as the real one does, and returns only its status.
 */
export function agents(sim, handlers = {}) {
  const asAgent = (type, label, prompt, value) => {
    if (value == null) return value
    if (type === 'implementer' || type === 'test-author' || type === 'auditor') {
      sim.commits.set(label, value.commits)
      if (value.status !== 'done' && named(prompt, SAID)) sim.files.set(named(prompt, SAID), value.detail || '')
      return { status: value.status }
    }
    if (type === 'reviewer') {
      if (value.status) return value
      sim.files.set(named(prompt, REVIEW_FILE), { claims: [], fix_verdicts: [], ...value })
      return { status: 'written' }
    }
    if (type === 'ruler') {
      if (value.status) return value
      sim.files.set(named(prompt, AS_JSON), value)
      return { status: 'written' }
    }
    if (type === 'planner') {
      if (named(prompt, AS_JSON)) sim.files.set(named(prompt, AS_JSON), { dispositions: value.dispositions || [] })
      if (!['written', 'settled'].includes(value.status) && named(prompt, SAID)) sim.files.set(named(prompt, SAID), value.question || value.detail || '')
      return { status: value.status }
    }
    if (type === 'investigator') {
      if (value.established) return value
      return { established: (value.commands || []).map((c) => c.name), unresolved: [] }
    }
    return value
  }
  return async (prompt, opts) => {
    const type = String(opts.agentType || '').replace('agentics:', '')
    const label = opts.label || ''
    const byPrefix = Object.keys(handlers).filter((k) => k.endsWith(':') && label.startsWith(k)).sort((a, b) => b.length - a.length)[0]
    const handler = handlers[label] || (byPrefix && handlers[byPrefix]) || handlers[type]
    if (handler) {
      const value = await handler(prompt, opts, sim)
      return type === 'courier' ? value : asAgent(type, label, prompt, value)
    }
    if (type === 'courier') {
      const out = sim.courier(prompt)
      return new Promise((resolve) => setTimeout(() => resolve(out), 0))
    }
    if (type === 'implementer' || type === 'test-author' || type === 'auditor') {
      return asAgent(type, label, prompt, { status: 'done', detail: '', concerns: [], commits: [{ sha: 'c1', subject: 'do it' }] })
    }
    if (type === 'reviewer') return asAgent(type, label, prompt, { findings: [], fix_verdicts: [], claims: [], notes: '' })
    throw new Error('unscripted agent: ' + type + ' ' + label)
  }
}

/** Every record of `kind` that landed, in the order it landed. */
export const recordsOf = (sim, kind) => [...sim.events, ...sim.state].filter((e) => e.kind === kind).sort((a, b) => a.seq - b.seq)
