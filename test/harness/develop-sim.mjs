// test/harness/develop-sim.mjs — lib/boundary.mjs, simulated, for scenario tests of
// execute-approved-plan-in-worktrees.
//
// The workflow's arithmetic — review-loop exits, merge routing, coverage — is what these
// scenarios test, so the boundaries are answered from an in-memory tree and event log rather than
// a repository. What to launch is decided by the real `lib/schedule.mjs` over that log, exactly as
// the `schedule` boundary decides it on disk, and records land once each by the lib's own rule.
// Every answer is carried the way a real courier carries one: an envelope with a digest, inside a
// CARRIED return, computed when the courier is dispatched and delivered a task later, so units
// settle while a boundary is in flight as they do on a real host. `lib/boundary.mjs` itself is
// tested against real git in test/boundary.test.mjs; the two meet at the payload shapes, which
// live in docs/DESIGN.md#boundaries.

import { recordsToAppend } from '../../lib/boundary.mjs'
import { approvedHead } from '../../lib/resume.mjs'
import { schedule, summarize } from '../../lib/schedule.mjs'
import { parentOf } from '../../lib/store.mjs'
import { childrenOf, deriveStatus, normalizeNode, ownReview } from '../../lib/tree.mjs'
import { carriedEnvelope } from './workflow-host.mjs'

const decode = (token) => JSON.parse(Buffer.from(token, 'base64').toString('utf8'))

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

/**
 * A simulated disk. `nodes` are scenario rows; `script` overrides any boundary's answer:
 *   script.preflight(args, sim, n) → payload fields (a checkpoint)
 *   script.compiled(args, sim, n) → the rows of the tree after spec-prepare compiled a folder
 *   script.facts[id] → a leaf's resume facts, as the ladder computes them
 *   script.close[id] = [decision per call] | (args, n) => decision
 *   script.merge(args, n) → payload fields
 *   script.open[id] = [status per call]
 *   script.specCheck(args, n, sim) → spec-check payload fields
 *   script.prepare(args, n, sim) → spec-prepare payload fields
 *   script.gate(args, n, sim) → spec-gate payload fields, over the computed ones
 */
export function simulate(nodes, script = {}) {
  const sim = {
    nodes: new Map(),     // id -> scenario row
    events: [],           // the effort's event log
    state: [],            // this execution's state log
    integ: new Map(),     // composite id -> {branch, worktree, head, base}
    locked: new Map(),    // leaf id -> the stopped leaf whose lock it met
    calls: [],            // [{name, args}]
    opens: [],            // leaf ids in open order
    batches: [],          // merge-batch args
    records: [],          // every record the workflow handed to a boundary
    dispositions: [],     // every disposition the workflow recorded, {node, finding, outcome}
    prepared: [],         // spec-prepare args
    reviewed: [],         // spec-reviewed args, one per review round
    edited: new Set(),    // folders whose spec an incorporation edited since their last review
    counts: new Map(),
  }
  let seq = 0
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

  /** A launch's row: what a unit needs for its prompts and tiers. */
  const rowFor = (id) => {
    const r = sim.nodes.get(id)
    if (!r) return null
    return {
      id, title: r.title, kind: r.kind, author: r.author, rigor: r.rigor, role: r.role,
      provides_n: (r.provides || []).length, decisions: r.decisions, dispatch: r.dispatch, ground_known: r.ground_known,
      rev: r.rev || 0, spec_path: r.spec_path, children_n: childrenOf(sim.nodes, id).length, own_review: r.own_review === true,
    }
  }

  const parentRow = (id) => {
    const { title, kind, author, spec_path } = rowFor(parentOf(id))
    return { id: parentOf(id), title, kind, author, spec_path }
  }

  const input = (args) => {
    const nodesNow = tree()
    return {
      nodes: nodesNow, status: deriveStatus(nodesNow, sim.events), events: sim.events, state: sim.state, root: args.root || sim.root || '.',
      running: args.running || [], planning: args.planning || [], stopping: args.stopping === true, maxParallel: 4,
      integrationOf: (id) => sim.integ.get(id) || null,
      lockedBy: (id) => sim.locked.get(id) || '',
      approvedHead: (id) => approvedHead(sim.events, id),
    }
  }

  const answer = {
    preflight(args) {
      sim.root = args.root
      const extra = script.preflight ? script.preflight(args, sim, count('preflight')) || {} : {}
      return {
        boundary: 'preflight', ok: true, error: null, checkpoint: null,
        envelope: { root: args.root, base_branch: 'main', base_sha: 'base0', dial: args.dial, pace: args.pace, resumed: false },
        counts: { nodes: sim.nodes.size, leaves: [...sim.nodes.values()].filter((r) => r.kind === 'leaf').length, gaps: 0, untraced: 0 },
        freed: [], dirty_worktrees: [], commands: null, max_parallel: 4, todos: [], notes: [], ...extra,
      }
    },
    schedule(args) {
      const { launch, idle } = schedule(input(args))
      return {
        boundary: 'schedule', ok: true, error: null, idle, max_parallel: 4, commands: null, todos: [], notes: [],
        launch: launch.map((l) => (l.unit === 'merge' ? l
          : l.unit === 'leaf' ? { ...l, row: rowFor(l.id), parent: parentRow(l.id), facts: (script.facts || {})[l.id] || null }
            : l.unit === 'plan' ? { ...l, row: { ...rowFor(l.id), intent: sim.nodes.get(l.id).intent || '' } }
              : { ...l, row: rowFor(l.id) })),
      }
    },
    'leaf-open'(args) {
      sim.opens.push(args.node)
      const plan = script.open && script.open[args.node]
      const n = count('open:' + args.node)
      const st = Array.isArray(plan) ? plan[n] || 'opened' : 'opened'
      if (st === 'stuck') {
        sim.locked.set(args.node, 'x')
        return { boundary: 'leaf-open', ok: true, error: null, status: 'locus_held', stuck: true, held_by: [{ node: 'x', status: 'escalated' }], todos: [] }
      }
      if (st === 'opened') event({ kind: 'dispatched', node: args.node, role: args.role, round: args.round })
      return {
        boundary: 'leaf-open', ok: true, error: null, status: st, branch: 'agentics/e--' + args.node,
        worktree: '/wt/' + args.node, base_sha: 'b-' + args.node, head_sha: 'b-' + args.node,
        brief_path: '/briefs/' + args.node + '-r' + args.round + '.md', brief_digest: 'd' + args.round,
        report_path: '/reports/' + args.node + '-r' + args.round + '.md', max_parallel: 4, todos: [],
      }
    },
    'leaf-close'(args) {
      const n = count('close:' + args.node)
      const plan = script.close && script.close[args.node]
      const node = sim.nodes.get(args.node) || {}
      const fallback = { next: node.own_review ? 'review' : 'approve', reason: '', failures: [] }
      const decision = typeof plan === 'function' ? plan(args, n) : Array.isArray(plan) ? plan[n] || fallback : fallback
      return {
        boundary: 'leaf-close', ok: true, error: null, status: 'done', node: args.node,
        head_sha: 'h-' + args.node + '-' + args.round, measurement: {}, decision,
        gotchas_written: [], gotchas_deleted: [], mutations: [], committed: false, todos: [],
      }
    },
    'merge-batch'(args) {
      sim.batches.push(args)
      const n = count('merge:' + args.target)
      const extra = script.merge ? script.merge(args, n, sim) || {} : {}
      const out = {
        boundary: 'merge-batch', ok: true, error: null, status: 'done', target: args.target,
        target_branch: 'agentics/e' + (args.target === '.' ? '' : '--' + args.target),
        target_worktree: '/wt/' + args.target, target_base: 'base0', head_sha: 'm-' + args.target + '-' + n,
        merged: args.children.map((c) => ({ id: c.id, merged_sha: 'm-' + c.id })),
        conflict: null, verified: true, measurement: {}, failed_alone: [], combination: [], todos: [],
        ...extra,
      }
      if (out.ok === false || out.error) return out
      for (const m of out.merged) event({ kind: 'merged', node: m.id })
      sim.integ.set(args.target, { branch: out.target_branch, worktree: out.target_worktree, head: out.head_sha, base: out.target_base })
      out.failed_alone = out.failed_alone.map((f) => {
        const single = (!f.ids || f.ids.length <= 1) && (sim.nodes.get(f.id) || {}).kind === 'leaf'
        return single ? { ...f, row: rowFor(f.id), parent: parentRow(f.id), facts: (script.facts || {})[f.id] || null } : f
      })
      return out
    },
    postflight() {
      const summary = summarize(input({}))
      const where = sim.integ.get(sim.root || '.') || {}
      return {
        boundary: 'postflight', ok: true, error: null, summary, closed: summary.done,
        integration: { branch: where.branch || '', head_sha: where.head || '' }, cleanup_n: 0, unmerged_n: 0, todos: [], notes: [],
      }
    },
    'spec-check'(args) {
      const n = count('spec-check:' + args.node)
      const extra = script.specCheck ? script.specCheck(args, n, sim) || {} : {}
      return {
        boundary: 'spec-check', ok: true, error: null, node: args.node,
        spec_path: '/repo/.agentics/e1/' + (args.node === '.' ? '' : args.node + '/') + 'DESIGN.md',
        exists: true, hash: 'h' + n, decisions_n: 0, problems: [], todos: [], notes: [], ...extra,
      }
    },
    'spec-settle'(args) {
      for (const d of args.dispositions || []) sim.dispositions.push({ node: args.node, ...d })
      // An incorporated finding is an edit: no review has read the spec the planner left behind.
      if ((args.dispositions || []).some((d) => d.outcome === 'incorporated')) sim.edited.add(args.node)
      return { boundary: 'spec-settle', ok: true, error: null, recorded: (args.dispositions || []).length, todos: [], notes: [] }
    },
    'spec-reviewed'(args) {
      sim.reviewed.push(args)
      sim.edited.delete(args.node)
      return { boundary: 'spec-reviewed', ok: true, error: null, todos: [], notes: [] }
    },
    'spec-gate'(args) {
      // approvalGate over the simulated ledger: the latest review of the text as it stands, and
      // every disposition recorded for the folder in any round.
      const last = sim.edited.has(args.node) ? null : sim.reviewed.filter((r) => r.node === args.node).pop()
      const settled = new Set(sim.dispositions.filter((d) => d.node === args.node).map((d) => d.finding))
      const open = last ? (last.ambiguities || []).filter((id) => !settled.has(id)) : []
      const complete = !!last && last.complete === true
      const extra = script.gate ? script.gate(args, count('gate:' + args.node), sim) || {} : {}
      return {
        boundary: 'spec-gate', ok: true, error: null, ratifiable: complete && open.length === 0, open,
        coverage_complete: complete, remaining: last ? last.remaining : [], reviewed: !!last, todos: [], notes: [], ...extra,
      }
    },
    'spec-prepare'(args) {
      sim.prepared.push(args)
      const extra = script.prepare ? script.prepare(args, count('prepare:' + args.node), sim) || {} : {}
      const refused = extra.status && extra.status !== 'prepared'
      if (!refused && script.compiled) {
        const rows = script.compiled(args, sim, count('compiled:' + args.node))
        if (rows) apply(rows)
      }
      return {
        boundary: 'spec-prepare', ok: true, error: null, status: 'prepared', hash: 'h',
        compile: { ok: true, problems: [], written: [args.node], retired: [], parked: [], flagged: [], skipped: [] },
        row: rowFor(args.node), todos: [], notes: [], ...extra,
      }
    },
  }

  const courier = (prompt) => {
    const m = /lib\/boundary\.mjs"? (\S+) .*--b64 (\S+)/.exec(prompt)
    if (!m) throw new Error('courier prompt names no boundary: ' + prompt.slice(0, 120))
    const [, name, token] = m
    const args = decode(token)
    sim.calls.push({ name, args })
    for (const r of args.records || []) sim.records.push(r)
    const fresh = recordsToAppend(args.records, { events: sim.events, state: sim.state, execution: '20260925-120000' })
    fresh.events.forEach(event)
    for (const e of fresh.state) sim.state.push({ ...e, seq: ++seq })
    const payload = JSON.parse(JSON.stringify(answer[name](args)))
    const damage = script.damage && script.damage(name, args, count('damage:' + name))
    return carriedEnvelope(payload, damage || undefined)
  }

  sim.courier = courier
  sim.statusOf = statusOf
  return sim
}

/** Route every agent type; a scenario overrides by agentType short name or label. */
export function agents(sim, handlers = {}) {
  return (prompt, opts) => {
    const type = String(opts.agentType || '').replace('agentics:', '')
    const label = opts.label || ''
    if (handlers[label]) return handlers[label](prompt, opts, sim)
    const byPrefix = Object.keys(handlers).filter((k) => k.endsWith(':') && label.startsWith(k)).sort((a, b) => b.length - a.length)[0]
    if (byPrefix) return handlers[byPrefix](prompt, opts, sim)
    if (handlers[type]) return handlers[type](prompt, opts, sim)
    if (type === 'courier') {
      const out = sim.courier(prompt)
      return new Promise((resolve) => setTimeout(() => resolve({ ...out, task_tools: 'skipped' }), 0))
    }
    if (type === 'implementer' || type === 'test-author' || type === 'auditor') {
      return { status: 'done', detail: '', concerns: [], commits: [{ sha: 'c1', subject: 'do it' }] }
    }
    if (type === 'reviewer') return { findings: [], fix_verdicts: [], claims: [], notes: '' }
    throw new Error('unscripted agent: ' + type + ' ' + label)
  }
}

export const recordsOf = (sim, kind) => sim.records.filter((r) => r.entry && r.entry.kind === kind).map((r) => r.entry)
