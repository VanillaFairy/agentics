// test/harness/develop-sim.mjs — lib/boundary.mjs, simulated, for scenario tests of
// agentics-develop.
//
// The workflow's arithmetic — readiness, cycles, review-loop exits, merge routing, coverage — is
// what these scenarios test, so the boundaries are answered from an in-memory tree rather than a
// repository. Every answer is carried exactly the way a real courier carries one: an envelope
// with a digest, inside a CARRIED return. `lib/boundary.mjs` itself is tested against real git in
// test/boundary.test.mjs; the two meet at the payload shapes, which live in docs/DESIGN.md#boundaries.

import { carriedEnvelope } from './workflow-host.mjs'

const decode = (token) => JSON.parse(Buffer.from(token, 'base64').toString('utf8'))

/** A preflight row with every field the workflow reads, defaults filled. */
export function row(id, extra = {}) {
  const leaf = extra.kind === undefined || extra.kind === 'leaf'
  return {
    id, title: 'do ' + id, kind: 'leaf', author: 'you', rigor: leaf ? 'tdd' : '', role: 'none',
    deps: [], locus: leaf ? ['src/' + id + '.js'] : [], reads: [], provides: [], consumes: [],
    decisions: [], dispatch: {}, ground_known: true, status: 'planned',
    children: [], acceptance_n: 1, human: [], own_review: false, coupled: false, integration: null,
    spec_path: '/repo/.agentics/e1/' + (id === '.' ? '' : id + '/') + 'DESIGN.md',
    ...extra,
  }
}

export const composite = (id, extra = {}) => row(id, { kind: 'composite', ...extra })

/**
 * A simulated disk. `nodes` are preflight rows; `script` overrides any boundary's answer:
 *   script.preflight(args, sim) → payload fields
 *   script.close[id] = [decision per call] | (args, n) => decision
 *   script.merge(args, n) → payload fields
 *   script.open[id] = [status per call]
 *   script.specCheck(args, n, sim) → spec-check payload fields
 *   script.prepare(args, n, sim) → spec-prepare payload fields
 *   script.gate(args, n, sim) → spec-gate payload fields, over the computed ones
 */
export function simulate(nodes, script = {}) {
  const sim = {
    nodes: new Map(nodes.map((n) => [n.id, { ...n }])),
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
  const count = (key) => {
    const n = sim.counts.get(key) || 0
    sim.counts.set(key, n + 1)
    return n
  }

  const rows = () => [...sim.nodes.values()].map((n) => ({ ...n }))

  const answer = {
    preflight(args) {
      const base = {
        boundary: 'preflight', ok: true, error: null, checkpoint: null,
        envelope: { root: args.root, base_branch: 'main', base_sha: 'base0', dial: args.dial, pace: args.pace, resumed: false },
        nodes: rows(), leaves: [], gaps: [], untraced: [], atomicity: [], coupled: [], freed: [],
        dirty_worktrees: [], commands: null, max_parallel: 4, todos: [], notes: [],
      }
      const extra = script.preflight ? script.preflight(args, sim, count('preflight')) || {} : {}
      return { ...base, ...extra }
    },
    'leaf-open'(args) {
      sim.opens.push(args.node)
      const plan = script.open && script.open[args.node]
      const n = count('open:' + args.node)
      const st = Array.isArray(plan) ? plan[n] || 'opened' : 'opened'
      const stuck = st === 'stuck'
      if (stuck) return { boundary: 'leaf-open', ok: true, error: null, status: 'locus_held', stuck: true, held_by: [{ node: 'x', status: 'escalated' }], todos: [] }
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
      return {
        boundary: 'merge-batch', ok: true, error: null, status: 'done', target: args.target,
        target_branch: 'agentics/e' + (args.target === '.' ? '' : '--' + args.target),
        target_worktree: '/wt/' + args.target, target_base: 'base0', head_sha: 'm-' + args.target + '-' + n,
        merged: args.children.map((c) => ({ id: c.id, merged_sha: 'm-' + c.id })),
        conflict: null, verified: true, measurement: {}, failed_alone: [], combination: [], todos: [],
        ...extra,
      }
    },
    postflight() {
      return { boundary: 'postflight', ok: true, error: null, cleanup: [], closed: true, todos: [] }
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
      return {
        boundary: 'spec-prepare', ok: true, error: null, status: 'prepared', hash: 'h',
        compile: { ok: true, problems: [], written: [args.node], retired: [], parked: [], flagged: [], skipped: [] },
        todos: [], notes: [], ...extra,
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
    const payload = JSON.parse(JSON.stringify(answer[name](args)))
    const damage = script.damage && script.damage(name, args, count('damage:' + name))
    return carriedEnvelope(payload, damage || undefined)
  }

  sim.courier = courier
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
      return { ...out, task_ids: [], task_tools: 'skipped' }
    }
    if (type === 'implementer' || type === 'test-author' || type === 'auditor') {
      return { status: 'done', detail: '', concerns: [], commits: [{ sha: 'c1', subject: 'do it' }] }
    }
    if (type === 'reviewer') return { findings: [], fix_verdicts: [], claims: [], notes: '' }
    throw new Error('unscripted agent: ' + type + ' ' + label)
  }
}

export const recordsOf = (sim, kind) => sim.records.filter((r) => r.entry && r.entry.kind === kind).map((r) => r.entry)
