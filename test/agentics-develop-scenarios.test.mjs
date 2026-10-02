import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { carriedEnvelope, runWorkflow } from './harness/workflow-host.mjs'
import { agents, composite, recordsOf, row, simulate } from './harness/develop-sim.mjs'

const WF = fileURLToPath(new URL('../service-workflows/execute-approved-plan-in-worktrees.workflow.js', import.meta.url))
const ARGS = { repo: '/repo', effort: 'e1', execution: '20260925-120000', plugin_root: '/plugin' }

/**
 * A nested workflow's return as its contract hands it over: a review's findings as handles beside
 * the file that holds them in full, a survey's items in the context file a planner reads. A
 * scenario writes the findings or items whole; the file lands in the simulated store.
 */
const asNested = (sim, fn) => {
  let n = 0
  return async (ref, wargs) => {
    const out = await fn(ref, wargs)
    if (out && Array.isArray(out.findings) && !out.findings_file) {
      const file = '/probe/' + (++n) + '.json'
      sim.files.set(file, { findings: out.findings })
      return { ...out, findings: out.findings.map(({ id, item, severity, axis, section }) => ({ id, item, severity, axis, section })), findings_file: file }
    }
    if (out && Array.isArray(out.items) && !out.context) {
      const file = '/survey/' + (++n) + '.md'
      sim.files.set(file, out.items)
      return { ...out, items: out.items.map(({ id, topic, kind }) => ({ id, topic, kind, state: 'standing' })), context: file }
    }
    return out
  }
}

const run = (sim, handlers = {}, args = {}, extra = {}) =>
  runWorkflow(WF, {
    args: { ...ARGS, ...args }, agent: agents(sim, handlers), ...extra,
    ...(extra.workflow ? { workflow: asNested(sim, extra.workflow) } : {}),
  })

/** Every courier command and every agent prompt carries handles: nothing a model would retype as data. */
const DATA_ON_ARGV = /printf|--b64|--json-file|<<|--stdin/

const labels = (prompts) => prompts.map((p) => p.opts.label)

const COVERED = { complete: true, dropped: [], incomplete: [], failed_channels: [], unreached: [], resumable: { runId: 'r', remaining: [] } }

/** A probe return as attack-document-with-independent-reviewers computes it: a carried ambiguity counts as open in its own gate. */
function probeReturn(over = {}) {
  const findings = over.findings || []
  const coverage = over.coverage || COVERED
  const ambiguities = findings.filter((f) => f.severity === 'ambiguity')
  return {
    artifact: '', findings, ambiguities, ratifiable: ambiguities.length === 0 && coverage.complete === true,
    coverage, snapshot: 'snapshot:s1', review: '20260926-120000-probe', scope: { full: true, changed: [] }, unrecorded: [], ...over,
  }
}

const probeFinding = (id, severity, claim, over = {}) => ({
  id, axis: 'contract-ambiguity', severity, section: 'Design', claim, evidence: 'DESIGN.md:12',
  start: 10, end: 12, item: 'item-' + claim.toLowerCase().replace(/\W+/g, '-'), carried: false, ...over,
})

/** A scripted nested probe: each call answers the next return; an unscripted call throws. */
function probes(returns) {
  const calls = []
  const fn = (ref, args) => {
    calls.push({ scriptPath: ref && ref.scriptPath, args })
    const next = returns[calls.length - 1]
    if (!next) throw new Error('unscripted workflow call ' + calls.length + ': ' + (ref && ref.scriptPath))
    return next
  }
  fn.calls = calls
  return fn
}

const asked = (prompt) => /Findings to settle: ([^.\n]+)\./.exec(prompt)[1].split(', ')

const settled = (outcome) => (prompt) => ({
  status: 'settled', question: '', detail: '',
  dispositions: asked(prompt).map((finding) => ({ finding, outcome })),
})

test('two independent leaves: executed, approved at integration, merged, reviewed together', async () => {
  const sim = simulate([composite('.'), row('a'), row('b')])
  const { result, prompts } = await run(sim)
  assert.deepEqual(result.escalations, [])
  assert.deepEqual(result.implemented.map((i) => [i.id, i.at_integration]).sort(), [['a', true], ['b', true]])
  assert.equal(result.coverage.complete, true, JSON.stringify(result.coverage))
  const merged = sim.batches.flatMap((b) => b.children.map((c) => c.id)).sort()
  assert.deepEqual(merged, ['a', 'b'])
  assert.ok(labels(prompts).includes('review:integration:.'), 'two children with work meet: the integration review is earned')
  assert.deepEqual(recordsOf(sim, 'approved').map((e) => e.node).sort(), ['a', 'b'])
})

test('a dependency is opened only after its provider merged', async () => {
  const sim = simulate([composite('.'), row('a'), row('b', { deps: ['a'] })])
  await run(sim)
  const order = sim.calls.map((c) => c.name + ':' + (c.args.node || c.args.target || ''))
  assert.ok(order.indexOf('leaf-open:b') > order.indexOf('merge-batch:.'), order.join(' '))
})

test('a tdd-pair cycle: red held on approval, green opened on it, the pair merged in one batch', async () => {
  const sim = simulate([composite('.'),
    row('r', { rigor: 'tdd-pair', role: 'red', own_review: true }),
    row('g', { rigor: 'tdd-pair', role: 'green', deps: ['r'], own_review: true })])
  const { result, prompts } = await run(sim)
  assert.equal(result.coverage.complete, true, JSON.stringify(result.coverage.unreached))
  assert.equal(sim.batches.length >= 1, true)
  const pair = sim.batches.find((b) => b.children.some((c) => c.id === 'r'))
  assert.deepEqual(pair.children.map((c) => c.id), ['r', 'g'])
  assert.deepEqual(pair.cycles, [['r', 'g']])
  assert.ok(labels(prompts).includes('test-author:r#1'))
  assert.ok(labels(prompts).includes('implementer:g#1'))
  assert.ok(labels(prompts).includes('review:r#1') && labels(prompts).includes('review:g#1'))
})

test('the review loop: a critical fixed next round approves; the open set is computed', async () => {
  const sim = simulate([composite('.'), row('a', { own_review: true })])
  const { result, prompts } = await run(sim, {
    'review:a#1': () => ({ findings: [{ id: 'F1', severity: 'critical', claim: 'wrong', evidence: 'x:1', failure_scenario: 'y' }], fix_verdicts: [], notes: '' }),
    'review:a#2': () => ({ findings: [], fix_verdicts: [{ id: 'F1', status: 'fixed', evidence: 'ok' }], notes: '' }),
  })
  assert.deepEqual(result.escalations, [])
  assert.equal(result.implemented[0].review_rounds, 2)
  assert.ok(labels(prompts).includes('implementer:a#2'), 'the fix round went to the implementer')
  assert.deepEqual(sim.fixes.get('a#2'), [{ source: 'review critical F1', claim: 'wrong', evidence: 'x:1 — y' }],
    'the open findings reach the fix round through the file its brief is built from')
  assert.ok(!prompts.find((p) => p.opts.label === 'implementer:a#2').prompt.includes('wrong'), 'never through a prompt')
  assert.match(prompts.find((p) => p.opts.label === 'review:a#2').prompt, /Prior blockers are the `open` list in \/reviews\/a-r1\.json/,
    'the next reviewer reads what the round before left open')
})

test('a prior blocker ruled not_fixed but not re-reported stays open', async () => {
  const sim = simulate([composite('.'), row('a', { own_review: true })])
  const crit = { id: 'F1', severity: 'critical', claim: 'wrong', evidence: 'x:1', failure_scenario: 'y' }
  const { result } = await run(sim, {
    'review:a#1': () => ({ findings: [crit], fix_verdicts: [], notes: '' }),
    'review:a#2': () => ({ findings: [], fix_verdicts: [{ id: 'F1', status: 'not_fixed', evidence: 'still' }], notes: '' }),
    'review:a#3': () => ({ findings: [crit], fix_verdicts: [{ id: 'F1', status: 'not_fixed', evidence: 'still' }], notes: '' }),
  })
  assert.deepEqual(result.escalations.map((e) => [e.id, e.reason]), [['a', 'review_not_converging']])
  assert.equal(result.coverage.complete, false)
})

test('a major blocks only on a yardstick leaf — a contract, a red, an audit — and only with a failure scenario', async () => {
  const major = (scenario) => () => ({ findings: [{ id: 'M', severity: 'major', claim: 'c', evidence: 'e', failure_scenario: scenario }], fix_verdicts: [], notes: '' })
  const fixed = () => ({ findings: [], fix_verdicts: [{ id: 'M', status: 'fixed', evidence: 'ok' }], notes: '' })
  const plain = simulate([composite('.'), row('a', { own_review: true, rigor: 'tdd-pair', role: 'green' })])
  const one = await run(plain, { 'review:a#1': major('breaks consumer') })
  assert.equal(one.result.implemented[0].review_rounds, 1, 'a green is measured against its red: the major is advisory')

  for (const extra of [{ provides: [{ name: 'api', paths: ['src/'] }] }, { rigor: 'tdd-pair', role: 'red' }]) {
    const yardstick = simulate([composite('.'), row('a', { own_review: true, ...extra })])
    const two = await run(yardstick, { 'review:a#1': major('a correct implementation fails it'), 'review:a#2': fixed })
    assert.equal(two.result.implemented[0].review_rounds, 2, JSON.stringify(extra))
  }

  const vague = simulate([composite('.'), row('a', { own_review: true, provides: [{ name: 'api', paths: ['src/'] }] })])
  const three = await run(vague, { 'review:a#1': major('') })
  assert.equal(three.result.implemented[0].review_rounds, 1, 'no failure scenario: advisory even on a contract')
})

test('an escalation blocks its dependents, never its siblings', async () => {
  const sim = simulate([composite('.'), row('a'), row('b', { deps: ['a'] }), row('c')], {
    close: { a: [{ next: 'escalate', reason: 'discriminator_undecidable', failures: [] }] },
  })
  const { result } = await run(sim)
  assert.deepEqual(result.escalations.map((e) => e.id), ['a'])
  assert.deepEqual(result.blocked, [{ blocked_by: 'a', leaves_n: 1 }])
  assert.ok(result.implemented.some((i) => i.id === 'c'))
  assert.ok(!sim.opens.includes('b'))
  assert.equal(result.coverage.complete, false)
  assert.ok(result.coverage.unreached.some((u) => /1 leaf\/leaves blocked — a did not land/.test(u)))
})

test('verification fix rounds: a fix clears it; the same failure twice escalates', async () => {
  const fail = { next: 'fix', reason: '', failures: [{ check: 'suite', claim: 'test x fails', evidence: 'tail' }] }
  const once = simulate([composite('.'), row('a')], { close: { a: [fail, { next: 'approve', failures: [] }] } })
  const ok = await run(once)
  assert.deepEqual(ok.result.escalations, [])
  assert.equal(ok.result.implemented[0].rounds, 2)

  const twice = simulate([composite('.'), row('a')], { close: { a: [fail, fail] } })
  const bad = await run(twice)
  assert.deepEqual(bad.result.escalations.map((e) => e.reason), ['verify_not_converging'])
})

test('a fix round with no commits escalates', async () => {
  const fail = { next: 'fix', reason: '', failures: [{ check: 'build', claim: 'build fails', evidence: '' }] }
  const sim = simulate([composite('.'), row('a')], { close: { a: [fail] } })
  const { result } = await run(sim, { 'implementer:a#2': () => ({ status: 'done', detail: 'nothing to do', concerns: [], commits: [] }) })
  assert.deepEqual(result.escalations.map((e) => e.reason), ['fix_without_commits'])
})

test('a user-bound return parks the leaf and the rest keeps running', async () => {
  const sim = simulate([composite('.'), row('a'), row('b')])
  const { result } = await run(sim, {
    'implementer:a#1': () => ({ status: 'needs_decision', detail: 'which format?', concerns: [], commits: [] }),
  })
  assert.deepEqual(result.parked.map((p) => [p.id, p.return]), [['a', 'needs_decision']])
  assert.ok(result.implemented.some((i) => i.id === 'b'))
  assert.equal(result.coverage.complete, false)
  assert.deepEqual(recordsOf(sim, 'parked').map((e) => e.node), ['a'])
})

test('what an agent asks the user never rides a record: the record carries the file the agent wrote it to', async () => {
  const sim = simulate([composite('.'), row('a')])
  const { result, prompts } = await run(sim, {
    'implementer:a#1': () => ({ status: 'needs_decision', detail: 'which format: JSON or YAML?', concerns: [], commits: [] }),
  })
  const told = prompts.find((p) => p.opts.label === 'implementer:a#1').prompt
  const file = /in full, to (\S+) \(its first line/.exec(told)[1]
  assert.match(file, /^\/said\/\d+-\d+-implementer-a-1\.md$/)
  const [record] = recordsOf(sim, 'parked')
  assert.equal(record.said, file)
  assert.equal(record.question, '', 'no prose of the agent\'s crosses the courier')
  assert.deepEqual(result.parked, [{ id: 'a', return: 'needs_decision', said: file }], 'the session is pointed at the file')
  assert.equal(sim.files.get(file), 'which format: JSON or YAML?', 'which its author wrote')
})

const written = (path) => () => ({ status: 'written', written: [path], accepted_warnings: [], uncovered: [], question: '', detail: '' })

test('decompose: the promoted task passes its review, compiles, and its children run', async () => {
  const sim = simulate([composite('.'), row('a')], {
    compiled: () => [composite('.'), composite('a'), row('a/x'), row('a/y')],
  })
  const probe = probes([probeReturn()])
  const { result } = await run(sim, {
    'implementer:a#1': () => ({ status: 'decompose', detail: 'two concerns', concerns: [], commits: [] }),
    'plan:': written(row('a').spec_path),
  }, {}, { workflow: probe })
  assert.equal(probe.calls.length, 1)
  assert.match(probe.calls[0].scriptPath, /\/service-workflows\/attack-document-with-independent-reviewers\.workflow\.js$/)
  assert.deepEqual(sim.prepared.map((p) => p.node), ['a'])
  assert.ok(sim.opens.includes('a/x') && sim.opens.includes('a/y'))
  assert.deepEqual(sim.batches.filter((b) => b.target === 'a').flatMap((b) => b.children.map((c) => c.id)).sort(), ['a/x', 'a/y'])
  assert.equal(result.coverage.complete, true, JSON.stringify(result.coverage.unreached))
})

test('a promotion whose compile leaves the leaf as it was escalates instead of looping', async () => {
  const sim = simulate([composite('.'), row('a', { rev: 5 })], {
    compiled: () => [composite('.'), row('a', { rev: 5, status: 'active' })],
  })
  const { result, prompts } = await run(sim, {
    implementer: () => ({ status: 'decompose', detail: 'too big', concerns: [], commits: [] }),
    'plan:': written(row('a').spec_path),
  }, {}, { workflow: probes([probeReturn()]) })
  assert.deepEqual(result.escalations.map((e) => e.reason), ['replan_not_converging'])
  assert.equal(prompts.filter((p) => p.opts.label.startsWith('implementer:')).length, 1)
})

test('a design node you author is parked for design; one the planner authors is written, reviewed and built', async () => {
  const sim = simulate([composite('.'), row('a'),
    row('d', { kind: 'design', author: 'you' }), row('p', { kind: 'design', author: 'planner' })], {
    compiled: () => [composite('.'), row('a'), row('d', { kind: 'design', author: 'you', status: 'parked' }), composite('p', { author: 'planner' }), row('p/x')],
  })
  const probe = probes([probeReturn()])
  const { result, prompts } = await run(sim, { 'plan:': written(row('p').spec_path) }, {}, { workflow: probe })
  assert.deepEqual(result.parked.map((p) => [p.id, p.return]), [['d', 'needs_design']])
  assert.deepEqual(labels(prompts).filter((l) => l.startsWith('plan:')), ['plan:p'])
  assert.deepEqual(sim.prepared.map((p) => p.node), ['p'])
  assert.ok(sim.opens.includes('p/x'))
  assert.ok(result.implemented.some((i) => i.id === 'a'))
})

test('a childless folder you authored is parked, never handed to the planner', async () => {
  const sim = simulate([composite('.')])
  const { result, prompts } = await run(sim)
  assert.deepEqual(result.parked.map((p) => [p.id, p.return]), [['.', 'needs_design']])
  assert.ok(recordsOf(sim, 'parked')[0].question.includes(composite('.').spec_path), 'the question names the spec that needs a Plan')
  assert.ok(!labels(prompts).some((l) => l.startsWith('plan:')))
})

test('a preflight checkpoint dispatches nothing but the two boundaries', async () => {
  const sim = simulate([composite('.'), row('a')], {
    preflight: () => ({ checkpoint: { reason: 'existing_execution', detail: '20260924-100000 is active' } }),
  })
  const { result, prompts } = await run(sim)
  assert.equal(result.checkpoint.reason, 'existing_execution')
  assert.deepEqual(labels(prompts), ['preflight', 'postflight'])
  assert.equal(result.coverage.complete, false)
})

test('a payload damaged in transit is refetched on a stronger courier', async () => {
  const sim = simulate([composite('.'), row('a')], {
    damage: (name, args, n) => (name === 'preflight' && n === 0 ? (env) => { env.payload.max_parallel = 99 } : null),
  })
  const { result, prompts } = await run(sim)
  const pre = prompts.filter((p) => /^preflight/.test(p.opts.label))
  assert.deepEqual(pre.map((p) => p.opts.model), ['haiku', 'sonnet'])
  assert.equal(result.coverage.complete, true)
})

test('a payload no courier can carry is a plugin fault: the node is held, never escalated to the user', async () => {
  const sim = simulate([composite('.'), row('a'), row('b')], {
    damage: (name, args) => (name === 'leaf-close' && args.node === 'a' ? (env) => { env.payload.head_sha = 'retyped' } : null),
  })
  const { result } = await run(sim)
  assert.deepEqual(result.escalations, [])
  assert.deepEqual(result.faults.map((f) => [f.id, f.channel]), [['a', 'transport']])
  assert.equal(sim.statusOf('a'), 'merged', 'what the close decided stands on disk, whatever became of its courier, and the run merges from it')
  assert.deepEqual(recordsOf(sim, 'fault').map((r) => [r.node, r.channel]), [['a', 'transport']])
  assert.equal(sim.statusOf('b'), 'merged', 'the rest of the run goes on')
  assert.equal(result.coverage.complete, false)
  assert.ok(result.coverage.unreached.some((u) => /a: held on a plugin fault/.test(u)))
})

/** The program's refusal of arguments damaged in transit, pasted whole by a courier that labels the run as it sees fit. */
const refusedToken = (boundary, stop_reason) => () => ({
  ...carriedEnvelope({ boundary, ok: false, error: { kind: 'digest_mismatch' }, stops: [] }),
  stop_reason,
})

test('a token the program refused as damaged on its way in is copied again by the stronger courier', async () => {
  const sim = simulate([composite('.'), row('a')])
  // A courier may call a typed refusal a failed run: the program's output decides, not that label.
  const { result, prompts } = await run(sim, { 'close:a#1': refusedToken('leaf-close', 'failed') })
  const closes = prompts.filter((p) => /^close:a/.test(p.opts.label))
  assert.deepEqual(closes.map((p) => [p.opts.label, p.opts.model]), [['close:a#1', 'haiku'], ['close:a#1#2', 'sonnet']])
  assert.deepEqual(result.faults, [])
  assert.equal(sim.statusOf('a'), 'merged')
})

test('a token no courier copies whole is a plugin fault, never a refusal the user is asked about', async () => {
  const sim = simulate([composite('.'), row('a'), row('b')])
  const refused = refusedToken('leaf-open', 'carried')
  const { result, prompts } = await run(sim, { 'open:a#1': refused, 'open:a#1#2': refused })
  assert.deepEqual(prompts.filter((p) => /^open:a/.test(p.opts.label)).map((p) => p.opts.model), ['haiku', 'sonnet'])
  assert.deepEqual(result.escalations, [])
  assert.deepEqual(result.faults.map((f) => [f.id, f.channel]), [['a', 'transport']])
  assert.equal(sim.statusOf('b'), 'merged', 'the rest of the run goes on')
})

test('a postflight no courier can carry hands the session its command, all handles, and running it records the faults only the run saw', async () => {
  const sim = simulate([composite('.'), row('a'), row('b')], {
    damage: (name, args) => (name === 'leaf-close' && args.node === 'b' ? (env) => { env.payload.head_sha = 'retyped' } : null),
  })
  const noShell = () => ({ stop_reason: 'failed', payload_raw: '' })
  const { result } = await run(sim, {
    'implementer:a#1': () => ({ status: 'blocked', detail: 'needs a key', concerns: [], commits: [] }),
    postflight: noShell, 'postflight#2': noShell,
  })
  assert.ok(result.coverage.failed_channels.includes('postflight'))
  assert.equal(result.coverage.complete, false)
  assert.equal(sim.statusOf('a'), 'escalated', 'a stop is recorded where it is decided, never left for postflight to carry')
  assert.ok(result.notes.some((n) => n.includes('coverage.resumable.postflight')), 'the result says what to run')

  const command = result.coverage.resumable.postflight
  assert.doesNotMatch(command, DATA_ON_ARGV)
  sim.courier('Run it:\n\n' + command)
  assert.equal(sim.calls.at(-1).name, 'postflight')
  assert.deepEqual(sim.calls.at(-1).args.fault, ['b:transport'], 'the command carries the faults only the run saw, as handles')
})

test('a run whose postflight was carried hands the session no command', async () => {
  const sim = simulate([composite('.'), row('a')])
  const { result } = await run(sim)
  assert.ok(!('postflight' in result.coverage.resumable))
})

test('leaves held on plugin faults never crowd out the rest of the pool', async () => {
  const faulty = ['a', 'b', 'c', 'd']
  const sim = simulate([composite('.'), ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => row(id))], {
    damage: (name, args) => (name === 'leaf-close' && faulty.includes(args.node) ? (env) => { env.payload.head_sha = 'retyped' } : null),
  })
  const { result } = await run(sim)
  assert.deepEqual(result.faults.map((f) => f.id).sort(), faulty)
  assert.ok(sim.opens.includes('e') && sim.opens.includes('f'), 'e and f ran although four faulted leaves filled the pool: ' + sim.opens.join(','))
})

test('no slot: leaf-open is re-dispatched until the pool admits the leaf', async () => {
  const sim = simulate([composite('.'), row('a')], { open: { a: ['no_slot', 'no_slot', 'opened'] } })
  const { result } = await run(sim)
  assert.equal(sim.opens.filter((o) => o === 'a').length, 3)
  assert.equal(result.coverage.complete, true)
})

test('command_unknown: the investigator establishes commands once, then the leaf closes again', async () => {
  const sim = simulate([composite('.'), row('a'), row('b')], {
    close: { a: [{ next: 'command_unknown', reason: 'command_unknown', failures: [] }] },
  })
  const { result, prompts } = await run(sim, {
    investigator: () => ({ commands: [{ name: 'suite', value: 'npm test', absent: false, exit_status: 0 }], unresolved: [], notes: '' }),
  })
  assert.equal(labels(prompts).filter((l) => l === 'establish-commands').length, 1)
  assert.equal(result.coverage.complete, true)
})

test('a leaf failing alone on the merged head gets a fix round', async () => {
  const sim = simulate([composite('.'), row('a')], {
    merge: (args, n) => (n === 0 ? { merged: [], failed_alone: [{ id: 'a', failures: [{ check: 'suite', claim: 'breaks x', evidence: 't' }] }] } : {}),
  })
  const { result } = await run(sim)
  assert.equal(sim.opens.filter((id) => id === 'a').length, 2, 'the leaf that failed alone was opened again for its fix round')
  assert.equal(result.coverage.complete, true)
})

test('pause stops starting new leaves after the first merge-batch', async () => {
  const sim = simulate([composite('.'), row('a'), row('b', { deps: ['a'] })])
  const { result } = await run(sim, {}, { pause: true })
  assert.ok(!sim.opens.includes('b'))
  assert.equal(result.stopped, 'pause')
  assert.equal(result.coverage.complete, false)
  assert.equal(sim.statusOf('b'), 'planned', 'postflight closes nothing: b never started')
})

test('an integration critical parks the composite for the user', async () => {
  const sim = simulate([composite('.'), row('a'), row('b')])
  const { result } = await run(sim, {
    'review:integration:.': () => ({ findings: [{ id: 'I1', severity: 'critical', claim: 'a and b disagree', evidence: 'x', failure_scenario: 'y' }], fix_verdicts: [], notes: '' }),
  })
  assert.deepEqual(result.parked.map((p) => [p.id, p.return]), [['.', 'integration_critical']])
  assert.equal(result.coverage.complete, false)
})

test('the cost report counts every dispatch, and each is recorded once, by its label, by the boundary that closed it', async () => {
  const sim = simulate([composite('.'), row('a', { own_review: true })])
  const { result, prompts } = await run(sim)
  assert.equal(result.cost.dispatches, prompts.length)
  assert.deepEqual(recordsOf(sim, 'dispatch').map((d) => d.label).sort(), labels(prompts).sort())
  const role = (label) => recordsOf(sim, 'dispatch').find((d) => d.label === label).role
  assert.deepEqual([role('implementer:a#1'), role('review:a#1'), role('close:a#1')], ['implementer', 'reviewer', 'courier'])
})

test('no courier carries data: every value is a handle on a flag of its own, and a boundary run again after a lost answer lands each record once', async () => {
  const ids = Array.from({ length: 6 }, (_, i) => 'l' + i + '-' + 'x'.repeat(200))
  const sim = simulate([composite('.'), ...ids.map((id) => row(id, { own_review: true }))])
  // The boundary ran and recorded what it decided; the courier then gave up before pasting its answer.
  const lostAnswer = (prompt, opts, s) => {
    s.courier(prompt)
    return { stop_reason: 'failed', payload_raw: '' }
  }
  const { result, prompts } = await run(sim, { ['close:' + ids[0] + '#1']: lostAnswer, ['reviewed:' + ids[1] + '#1']: lostAnswer, 'schedule#2': lostAnswer })
  assert.equal(result.coverage.complete, true, JSON.stringify(result.coverage))
  for (const p of prompts) assert.doesNotMatch(p.prompt, DATA_ON_ARGV, p.opts.label)
  assert.ok(labels(prompts).includes('close:' + ids[0] + '#1#2') && labels(prompts).includes('reviewed:' + ids[1] + '#1#2'), 'both trips were sent again')
  assert.deepEqual(recordsOf(sim, 'approved').map((e) => e.node).sort(), [...ids].sort(), 'each approval landed once')
  const dispatched = recordsOf(sim, 'dispatch').map((d) => d.label)
  assert.equal(dispatched.length, new Set(dispatched).size, 'each dispatch line landed once')
})

test('bad input returns a coverage block, never undefined', async () => {
  const { result } = await runWorkflow(WF, { args: { repo: '/r' }, agent: () => { throw new Error('none') } })
  assert.equal(result.checkpoint.reason, 'bad_input')
  assert.equal(result.coverage.complete, false)
})

test('a relative repo is refused before any courier runs: it would resolve wherever a shell stands', async () => {
  for (const repo of ['.', 'sub/dir', '']) {
    const calls = []
    const { result } = await runWorkflow(WF, { args: { ...ARGS, repo }, agent: (prompt) => { calls.push(prompt); throw new Error('none') } })
    assert.equal(result.checkpoint.reason, 'bad_input', JSON.stringify(repo))
    assert.deepEqual(calls, [], 'nothing was dispatched for ' + JSON.stringify(repo))
  }
  for (const repo of ['C:/work/r', 'C:\\work\\r', '/srv/r']) {
    const { result } = await runWorkflow(WF, { args: { ...ARGS, repo }, agent: () => { throw new Error('none') } })
    assert.notEqual(result.checkpoint.reason, 'bad_input', JSON.stringify(repo) + ' is absolute')
  }
})

const B_CONSUMES = { deps: ['a'], consumes: [{ name: 'api', paths: ['src/api.js'] }] }
const driftSim = (script = {}) => simulate([composite('.'), row('a'), row('b', B_CONSUMES), row('c')], {
  merge: (args) => (args.children.some((ch) => ch.id === 'a')
    ? { drift: [{ node: 'b', contract: 'api', files: ['src/api.js'], row: row('b', B_CONSUMES) }], drift_brief: '/merges/root.drift.md' } : {}),
  ...script,
})
const ruling = (ruling, question = '') => () => ({ rulings: [{ node: 'b', ruling, why: 'because', question }] })
/** The tree after the planner rewrote b as a new revision of the same leaf. */
const bReplanned = () => [composite('.'), row('a', { status: 'merged' }), row('b', { ...B_CONSUMES, rev: 1 }), row('c')]

test('contract drift a ruler rules affected is replanned, and runs, without the user', async () => {
  const sim = driftSim({ compiled: bReplanned })
  const { result, prompts } = await run(sim, {
    'rule:drift:.': ruling('affected', 'api now returns a list: does b still read one?'),
    'plan:': written(row('b').spec_path),
  }, {}, { workflow: probes([probeReturn()]) })
  assert.deepEqual(result.parked, [])
  assert.deepEqual(result.escalations, [])
  assert.ok(sim.opens.includes('b'), 'the replanned consumer runs')
  assert.ok(result.implemented.some((i) => i.id === 'c'))
  assert.deepEqual(result.drift.map((d) => d.node), ['b'])
  assert.deepEqual(recordsOf(sim, 'drift-ruled').map((r) => [r.node, r.ruling]), [['b', 'affected']])
  const asked = prompts.find((p) => p.opts.label === 'rule:drift:.')
  assert.equal(asked.opts.agentType, 'agentics:ruler')
  assert.ok(asked.prompt.includes('Read /merges/root.drift.md.'), 'one file holds the entry and the change')
  assert.ok(!asked.prompt.includes('DESIGN.md'), 'the ruler is never sent to find a spec')
  const [ruled] = recordsOf(sim, 'drift-ruled')
  assert.match(ruled.said, /^\/said\/\d+-\d+-rule-drift-\.\.?-b\.md$/, 'each drifted consumer\'s ruling is a file of its own, which the boundary wrote')
  const plan = prompts.find((p) => p.opts.label === 'plan:b')
  assert.ok(plan.prompt.includes('Why: premise_mismatch — read ' + ruled.said), 'the planner is pointed at what moved')
})

test('a replan of drift that needs a decision parks the consumer with the planner\'s question, and the rest keeps running', async () => {
  const sim = driftSim()
  const { result, prompts } = await run(sim, {
    'rule:drift:.': ruling('affected', 'does b still read one?'),
    'plan:': () => ({ status: 'needs_decision', written: [], accepted_warnings: [], uncovered: [], question: 'a list or one item: which does b serve?', detail: '' }),
  })
  assert.deepEqual(result.parked.map((p) => [p.id, p.return]), [['b', 'needs_decision']])
  assert.equal(sim.files.get(result.parked[0].said), 'a list or one item: which does b serve?', 'the question is the planner\'s own file')
  assert.ok(!sim.opens.includes('b'))
  assert.ok(result.implemented.some((i) => i.id === 'c'))
  const asked = prompts.find((p) => p.opts.label === 'rule:drift:.')
  assert.match(asked.prompt, /as JSON, to \/said\/\d+-\d+-rule-drift-\.\.?json: \{"rulings"/, 'the ruler writes every ruling to one file')
})

test('a fix round that returns done with no commits escalates on the workflow\'s own line, pointing at no file', async () => {
  const sim = simulate([composite('.'), row('a')], { close: { a: [{ next: 'fix', reason: '', failures: [{ check: 'suite', claim: 'test x fails' }] }] } })
  const { result } = await run(sim, { 'implementer:a#2': () => ({ status: 'done', detail: 'nothing to change', concerns: [], commits: [] }) })
  assert.deepEqual(result.escalations.map((e) => [e.id, e.reason]), [['a', 'fix_without_commits']])
  const [record] = recordsOf(sim, 'escalated')
  assert.equal(record.said, undefined)
  assert.equal(record.detail, 'fix round 2 returned no commits')
})

test('contract drift an analyst rules unaffected never reaches the user: the consumer runs', async () => {
  const sim = driftSim()
  const { result } = await run(sim, { 'rule:drift:.': ruling('unaffected') })
  assert.deepEqual(result.parked, [])
  assert.ok(sim.opens.includes('b'))
  assert.deepEqual(recordsOf(sim, 'drift-ruled').map((r) => [r.node, r.ruling]), [['b', 'unaffected']])
  assert.equal(result.coverage.complete, true)
})

const staleOf = (rows) => ({ nodes: rows.map((r) => r.id), rows, now: 'n1', brief: '/x/stale-n1.md' })
const STALE_B = { node: 'b', ruling: 'affected', why: 'the parser it extends was removed', question: 'the parser b extends is gone: rebuild on the new one?' }

test('a base that moved under leaves is ruled first: an affected leaf is replanned and runs, and nothing waits for the user', async () => {
  const sim = simulate([composite('.'), row('a'), row('b'), row('c'), row('d')], {
    preflight: () => ({ stale: staleOf([row('a'), row('b'), row('d')]) }),
    compiled: () => [composite('.'), row('a'), row('b', { rev: 1 }), row('c'), row('d')],
  })
  const { result, prompts } = await run(sim, {
    'rule:stale': () => ({ rulings: [{ node: 'a', ruling: 'unaffected', why: 'only comments moved', question: '' }, STALE_B] }),
    'plan:': written(row('b').spec_path),
  }, {}, { workflow: probes([probeReturn()]) })
  const asked = prompts.find((p) => p.opts.label === 'rule:stale').prompt
  assert.ok(asked.includes('a, b, d') && asked.includes('Read /x/stale-n1.md.'), 'one file holds each entry and its change')
  assert.deepEqual(recordsOf(sim, 'stale-ruled').map((r) => [r.node, r.ruling, r.base_now]), [['a', 'unaffected', 'n1'], ['b', 'affected', 'n1']],
    'both rulings are kept, so a later head asks each only about what moved after this one')
  const ruledB = recordsOf(sim, 'stale-ruled').find((r) => r.node === 'b').said
  assert.ok(prompts.find((p) => p.opts.label === 'plan:b').prompt.includes('Why: premise_mismatch — read ' + ruledB))
  assert.deepEqual(result.parked, [])
  assert.deepEqual(result.faults.map((f) => f.id), ['d'], 'a leaf the ruling left out is held, never run unasked, and never put to the user')
  assert.ok(['a', 'b', 'c'].every((id) => sim.opens.includes(id)) && !sim.opens.includes('d'))
  assert.equal(result.checkpoint, null, 'no checkpoint stops the run')
})

test('a moved base the planner cannot answer without a decision parks the leaf with the planner\'s question', async () => {
  const sim = simulate([composite('.'), row('b'), row('c')], { preflight: () => ({ stale: staleOf([row('b')]) }) })
  const { result } = await run(sim, {
    'rule:stale': () => ({ rulings: [STALE_B] }),
    'plan:': () => ({ status: 'needs_decision', written: [], accepted_warnings: [], uncovered: [], question: 'keep the old parser or move to the new one?', detail: '' }),
  })
  assert.deepEqual(result.parked.map((p) => [p.id, p.return, sim.files.get(p.said)]), [['b', 'needs_decision', 'keep the old parser or move to the new one?']])
  assert.ok(sim.opens.includes('c') && !sim.opens.includes('b'))
})

test('a moved premise the planner answers without changing the leaf escalates instead of running it', async () => {
  const sim = simulate([composite('.'), row('b', { rev: 5 })], {
    preflight: () => ({ stale: staleOf([row('b', { rev: 5 })]) }),
    compiled: () => [composite('.'), row('b', { rev: 5 })],
  })
  const { result } = await run(sim, { 'rule:stale': () => ({ rulings: [STALE_B] }), 'plan:': written(row('b').spec_path) }, {}, { workflow: probes([probeReturn()]) })
  assert.deepEqual(result.escalations.map((e) => [e.id, e.reason]), [['b', 'replan_not_converging']])
  assert.ok(!sim.opens.includes('b'))
})

test('an affected ruling whose replan a plugin fault ended is left unanswered, so the next invocation rules again', async () => {
  const sim = simulate([composite('.'), row('b'), row('c')], { preflight: () => ({ stale: staleOf([row('b')]) }) })
  const { result } = await run(sim, { 'rule:stale': () => ({ rulings: [STALE_B] }), 'plan:': () => { throw new Error('planner died') } })
  assert.deepEqual(result.faults.map((x) => x.id), ['b'])
  assert.deepEqual(result.parked, [])
  const [ruled] = recordsOf(sim, 'stale-ruled')
  assert.ok(!sim.events.some((e) => e.node === 'b' && ['parked', 'escalated', 'replanned'].includes(e.kind) && e.seq > ruled.seq),
    'nothing answers the ruling on disk, and an unanswered affected ruling is no anchor (test/boundary-execution.test.mjs)')
  assert.ok(sim.opens.includes('c') && !sim.opens.includes('b'))
})

test('a leaf with work already standing on its plan is never replanned under it: it parks with the ruler\'s question', async () => {
  const sim = simulate([composite('.'), row('b'), row('c')], { preflight: () => ({ stale: staleOf([{ ...row('b'), under_way: true }]) }) })
  const { result, prompts } = await run(sim, { 'rule:stale': () => ({ rulings: [STALE_B] }) })
  assert.deepEqual(result.parked.map((p) => [p.id, p.return, sim.files.get(p.said)]), [['b', 'premise_mismatch', STALE_B.question]])
  assert.ok(!labels(prompts).some((l) => l.startsWith('plan:')))
  assert.deepEqual(recordsOf(sim, 'stale-ruled').map((r) => [r.node, r.ruling]), [['b', 'affected']], 'the park is its answer on disk')
})

test('a drift replan a plugin fault ended parks the consumer: the drift would not be found again', async () => {
  const sim = driftSim()
  const { result } = await run(sim, { 'rule:drift:.': ruling('affected', 'does b still read one?'), 'plan:': () => { throw new Error('planner died') } })
  assert.deepEqual(result.parked.map((p) => [p.id, p.return, sim.files.get(p.said)]), [['b', 'contract_drift', 'does b still read one?']])
  assert.ok(!sim.opens.includes('b'))
})

test('contract drift no analyst could rule, twice, parks the consumer for the user', async () => {
  const sim = driftSim()
  const { result, prompts } = await run(sim, { 'rule:drift:': () => { throw new Error('analyst died') } })
  assert.deepEqual(labels(prompts).filter((l) => l.startsWith('rule:')), ['rule:drift:.', 'rule:drift:.#2'])
  assert.deepEqual(result.parked.map((p) => [p.id, p.return]), [['b', 'contract_drift']])
  assert.match(recordsOf(sim, 'parked')[0].question, /no ruler could rule/)
})

test('a leaf whose files another leaf holds is reported blocked, never re-dispatched to wait', async () => {
  const sim = simulate([composite('.'), row('a'), row('b')], { open: { b: ['held'] } })
  const { result } = await run(sim)
  assert.equal(sim.opens.filter((o) => o === 'b').length, 1)
  assert.deepEqual(result.blocked, [{ blocked_by: 'x', leaves_n: 1 }])
  assert.equal(result.coverage.complete, false)
})

test('a prior blocker the next round never rules on stays open', async () => {
  const sim = simulate([composite('.'), row('a', { own_review: true })])
  const crit = { id: 'F1', severity: 'critical', claim: 'wrong', evidence: 'x:1', failure_scenario: 'y' }
  const { result } = await run(sim, {
    'review:a#1': () => ({ findings: [crit], fix_verdicts: [], notes: '' }),
    'review:': () => ({ findings: [], fix_verdicts: [], notes: '' }),
  })
  assert.deepEqual(result.escalations.map((e) => e.reason), ['review_not_converging'])
})

test('a merge-batch that cannot run escalates its target once, never re-batches it', async () => {
  const sim = simulate([composite('.'), row('a')], {
    merge: () => ({ ok: false, error: { kind: 'integration', message: 'refresh conflicted' } }),
  })
  const { result } = await run(sim)
  assert.equal(sim.batches.length, 1)
  assert.deepEqual(result.escalations.map((e) => [e.id, e.reason]), [['.', 'merge_batch_failed']])
  assert.equal(result.coverage.complete, false)
})

test('a composite or a cycle failing on the merged head escalates, never enters a leaf chain', async () => {
  const sim = simulate([composite('.'), composite('c'), row('c/x'), row('r', { rigor: 'tdd-pair', role: 'red', own_review: true }),
    row('g', { rigor: 'tdd-pair', role: 'green', deps: ['r'], own_review: true })], {
    merge: (args) => {
      if (args.target !== '.') return {}
      const failed = []
      if (args.children.some((c) => c.id === 'c')) failed.push({ id: 'c', ids: ['c'], failures: [{ check: 'suite', claim: 'c breaks it', evidence: '' }] })
      if (args.children.some((c) => c.id === 'g')) failed.push({ id: 'g', ids: ['r', 'g'], failures: [{ check: 'suite', claim: 'the pair breaks it', evidence: '' }] })
      return { merged: args.children.filter((c) => !failed.some((f) => f.ids.includes(c.id))).map((c) => ({ id: c.id, merged_sha: 'm' })), failed_alone: failed }
    },
  })
  const { result } = await run(sim)
  assert.deepEqual(result.escalations.map((e) => [e.id, e.reason]).sort(), [['c', 'fails_on_integration'], ['g', 'fails_on_integration'], ['r', 'fails_on_integration']])
  assert.ok(!sim.calls.some((c) => c.name === 'leaf-open' && c.args.node === 'c'))
})

test('a finished composite passes the suite gate before its review, and a failing gate escalates it unreviewed', async () => {
  const passing = simulate([composite('.'), composite('c'), row('c/x'), row('y')], {})
  await run(passing)
  assert.deepEqual([...passing.gates].sort(), ['.', 'c'])
  const gateAt = (sim, id) => sim.calls.findIndex((c) => c.name === 'suite-gate' && c.args.target === id)
  const failing = simulate([composite('.'), composite('c'), row('c/x')], {
    suiteGate: (args) => (args.target === 'c'
      ? { ran: true, passed: false, failures: [{ check: 'suite', claim: 'the suite fails on the integration head' }], record: '/gates/c.json' }
      : {}),
  })
  const { result, prompts } = await run(failing)
  assert.ok(gateAt(failing, 'c') >= 0)
  assert.deepEqual(result.escalations.map((e) => [e.id, e.reason]), [['c', 'fails_full_suite']])
  assert.ok(!prompts.some((p) => p.opts.label === 'review:integration:c'))
  assert.ok(!failing.batches.some((b) => b.target === '.' && b.children.some((ch) => ch.id === 'c')))
})

test('a resumed leaf is closed at its own round, reviewed over its own base and brief', async () => {
  const sim = simulate([composite('.'), row('a', { own_review: true })], {
    facts: { a: { id: 'a', next_action: 'verify', note: '', branch: 'agentics/e--a', worktree: '/wt/a', head_sha: 'h1', base_sha: 'b1', approved_head: '', commits: ['h1'], dirty: [], rounds: 1, brief_path: '/briefs/a-r1.md' } },
  })
  const { result, prompts } = await run(sim)
  const close = sim.calls.find((c) => c.name === 'leaf-close')
  assert.equal(close.args.round, 1)
  assert.equal(close.args.base_sha, 'b1')
  const review = prompts.find((p) => p.opts.label === 'review:a#1')
  assert.match(review.prompt, /Span under review: b1\.\.h-a-1/)
  assert.match(review.prompt, /read \/briefs\/a-r1\.md/)
  assert.equal(result.implemented[0].salvaged, true)
})

test('a resumed approval merges the approved head, not the branch tip', async () => {
  const sim = simulate([composite('.'), row('a', { status: 'approved', approved_head: 'approved' })], {
    facts: { a: { id: 'a', next_action: 'merge', note: '', head_sha: 'tip', base_sha: 'b', approved_head: 'approved', commits: [], dirty: [], rounds: 1, brief_path: '' } },
  })
  await run(sim)
  assert.deepEqual(sim.batches[0].children, [{ id: 'a', head_sha: 'approved' }])
})

const finding = { next: 'finding', reason: '', failures: [{ check: 'suite', claim: 'the premise is false', evidence: 'x:1' }] }

test('a verify finding under a folder you authored parks that folder for a re-spec', async () => {
  const sim = simulate([composite('.'), row('v', { rigor: 'verify' })], { close: { v: [finding] } })
  const { result, prompts } = await run(sim)
  assert.deepEqual(result.escalations.map((e) => [e.id, e.reason]), [['v', 'verify_finding']])
  assert.deepEqual(result.parked.map((p) => [p.id, p.return]), [['.', 'needs_respec']])
  assert.ok(recordsOf(sim, 'parked')[0].question.includes(composite('.').spec_path), 'the question names the spec to edit')
  assert.ok(!labels(prompts).some((l) => l.startsWith('plan:')))
})

test('a folder the planner authored is replanned in its own spec and reviewed again', async () => {
  const sim = simulate([composite('.'), composite('c', { author: 'planner' }), row('c/v', { rigor: 'verify' })],
    { close: { 'c/v': [finding] } })
  const probe = probes([probeReturn()])
  await run(sim, { 'plan:': written(composite('c').spec_path) }, {}, { workflow: probe })
  assert.equal(probe.calls.length, 1)
  assert.equal(probe.calls[0].args.artifact, composite('c').spec_path)
  assert.deepEqual(sim.prepared.map((p) => p.node), ['c'])
})

const plannerDesign = () => simulate([composite('.'), row('p', { kind: 'design', author: 'planner' })], {
  compiled: () => [composite('.'), composite('p', { author: 'planner' }), row('p/x')],
})

test('a planner spec ratifiable at its first review is prepared, compiled, and built', async () => {
  const sim = plannerDesign()
  // No finding: the probe recorded an empty return, and that return is the review that passed.
  const first = probeReturn({ snapshot: 'snapshot:first', review: '20260926-120000-probe' })
  const probe = probes([first])
  const { result, prompts } = await run(sim, { 'plan:': written(row('p').spec_path) }, {}, { workflow: probe })
  const checked = sim.calls.find((c) => c.name === 'spec-check')
  assert.ok(checked, 'the spec is checked before it is reviewed')
  assert.equal(probe.calls.length, 1)
  assert.equal(probe.calls[0].args.artifact, row('p').spec_path)
  assert.equal(probe.calls[0].args.since, undefined, 'a first review is never narrowed')
  assert.deepEqual(sim.prepared.map((p) => [p.node, p.review]), [['p', first.review]], 'the preparation names the return that passed')
  assert.ok(!labels(prompts).some((l) => l.startsWith('settle:')), 'nothing to settle')
  assert.deepEqual(sim.reviewed.map((r) => [r.node, r.complete, r.remaining]), [['p', true, []]])
  const order = sim.calls.map((c) => c.name)
  assert.ok(order.indexOf('spec-check') < order.indexOf('spec-reviewed'))
  assert.ok(order.indexOf('spec-reviewed') < order.indexOf('spec-prepare'))
  assert.ok(sim.opens.includes('p/x'))
  assert.equal(result.coverage.complete, true, JSON.stringify(result.coverage.unreached))
})

test('an incomplete review is recorded as partial, naming the axes it left, and escalates', async () => {
  const sim = plannerDesign()
  const partial = { ...COVERED, complete: false, unreached: ['axis growth: its analyst returned nothing'], resumable: { runId: 'r', remaining: ['growth'] } }
  const probe = probes([probeReturn({ coverage: partial })])
  const { result } = await run(sim, { 'plan:': written(row('p').spec_path) }, {}, { workflow: probe })
  assert.deepEqual(sim.reviewed.map((r) => [r.node, r.complete, r.remaining]), [['p', false, ['growth']]])
  assert.deepEqual(result.escalations.map((e) => [e.id, e.reason]), [['p', 'review_incomplete']])
  assert.deepEqual(sim.prepared, [])
})

test('a spec_changed park on a folder the planner wrote is re-derived by the planner; one you wrote waits for you', async () => {
  const sim = simulate([composite('.'),
    composite('u', { status: 'parked', reason: 'spec_changed', rev: 1 }),
    composite('p', { author: 'planner', status: 'parked', reason: 'spec_changed', rev: 1 })], {
    compiled: () => [composite('.'), composite('u', { status: 'parked', reason: 'spec_changed', rev: 1 }), composite('p', { author: 'planner', rev: 2 }), row('p/x', { rev: 2 })],
  })
  const probe = probes([probeReturn()])
  const { result, prompts } = await run(sim, { 'plan:': written(composite('p').spec_path) }, {}, { workflow: probe })
  const plan = prompts.find((p) => p.opts.label === 'plan:p')
  assert.ok(plan && plan.prompt.includes('spec_changed'), 'the planner re-derives its own folder')
  assert.ok(!labels(prompts).includes('plan:u'), 'a folder you wrote is never handed to the planner')
  assert.deepEqual(sim.prepared.map((p) => p.node), ['p'])
  assert.ok(sim.opens.includes('p/x'))
  assert.deepEqual(result.parked.map((p) => [p.id, p.return]), [['u', 'spec_changed']])
})

test('an ambiguity the planner discards is refused, and a second discard escalates; a sibling still runs', async () => {
  const sim = simulate([composite('.'), row('a'), row('p', { kind: 'design', author: 'planner' })])
  const probe = probes([probeReturn({ findings: [probeFinding('P1', 'ambiguity', 'the queue is read two ways')] })])
  const { result, prompts } = await run(sim, {
    'plan:': written(row('p').spec_path),
    'settle:': settled('discarded'),
  }, {}, { workflow: probe })
  assert.deepEqual(result.escalations.map((e) => [e.id, e.reason]), [['p', 'review_not_converging']])
  assert.deepEqual(sim.dispositions, [], 'a refused discard is never recorded')
  assert.deepEqual(sim.prepared, [])
  const again = prompts.find((p) => p.opts.label === 'settle:p#2')
  assert.ok(again && again.prompt.includes('P1'), 'the refusal went back to the planner, naming the finding')
  assert.ok(result.implemented.some((i) => i.id === 'a'), 'an escalation in the review stops only that sub-effort')
})

test('a discard refused once and then incorporated is reviewed again and prepared', async () => {
  const sim = plannerDesign()
  const probe = probes([
    probeReturn({ findings: [probeFinding('P1', 'gap', 'no retry is designed')], snapshot: 'snapshot:a', review: 'ra-probe' }),
    probeReturn({ snapshot: 'snapshot:b', review: 'rb-probe' }),
  ])
  await run(sim, {
    'plan:': written(row('p').spec_path),
    'settle:p#1': settled('discarded'),
    'settle:p#2': settled('incorporated'),
  }, {}, { workflow: probe })
  assert.deepEqual(sim.dispositions, [{ node: 'p', finding: 'item-no-retry-is-designed', outcome: 'incorporated' }])
  assert.equal(probe.calls.length, 2)
  assert.deepEqual(sim.prepared.map((p) => p.review), ['rb-probe'])
})

test('a finding back unchanged after it was incorporated escalates as not converging', async () => {
  const sim = plannerDesign()
  const probe = probes([
    probeReturn({ findings: [probeFinding('P1', 'gap', 'Missing a retry policy')], snapshot: 'snapshot:a' }),
    probeReturn({ findings: [probeFinding('P4', 'gap', '  missing a   retry policy ')], snapshot: 'snapshot:b' }),
  ])
  const { result } = await run(sim, { 'plan:': written(row('p').spec_path), 'settle:': settled('incorporated') }, {}, { workflow: probe })
  assert.deepEqual(result.escalations.map((e) => [e.id, e.reason]), [['p', 'review_not_converging']])
  assert.deepEqual(sim.prepared, [])
})

test('a round that incorporates nothing while the gate stays shut escalates as not converging', async () => {
  const sim = plannerDesign()
  const probe = probes([probeReturn({
    findings: [probeFinding('P1', 'ambiguity', 'the queue is read two ways'), probeFinding('P2', 'note', 'name the queue after its owner')],
  })])
  const { result } = await run(sim, {
    'plan:': written(row('p').spec_path),
    // The planner settles only the note and leaves the ambiguity untouched: no edit, gate still shut.
    'settle:': () => ({ status: 'settled', question: '', detail: '', dispositions: [{ finding: 'P2', outcome: 'discarded' }] }),
  }, {}, { workflow: probe })
  assert.deepEqual(result.escalations.map((e) => [e.id, e.reason]), [['p', 'review_not_converging']])
  assert.equal(probe.calls.length, 1, 'an unedited spec is not reviewed again')
  assert.deepEqual(sim.prepared, [])
})

test('a planner edit that adds a Decisions row parks the folder for the user', async () => {
  const sim = simulate([composite('.'), row('p', { kind: 'design', author: 'planner' })], {
    specCheck: (args, n) => (n === 1
      ? { decisions_n: 1, problems: [{ file: row('p').spec_path, line: 9, problem: 'a planner-written spec states no decisions' }] }
      : {}),
  })
  const probe = probes([probeReturn({ findings: [probeFinding('P1', 'gap', 'which store holds the queue')] })])
  const { result } = await run(sim, { 'plan:': written(row('p').spec_path), 'settle:': settled('incorporated') }, {}, { workflow: probe })
  assert.deepEqual(result.parked.map((p) => [p.id, p.return]), [['p', 'needs_decision']])
  assert.equal(probe.calls.length, 1, 'a spec that states a decision is not reviewed again')
  assert.deepEqual(sim.prepared, [])
})

test('the re-review after an edit is narrowed to the last reviewed snapshot', async () => {
  const sim = plannerDesign()
  const probe = probes([
    probeReturn({ findings: [probeFinding('P1', 'ambiguity', 'two meanings of tick')], snapshot: 'snapshot:aaa', review: 'raaa-probe' }),
    probeReturn({ snapshot: 'snapshot:bbb', review: 'rbbb-probe' }),
  ])
  await run(sim, { 'plan:': written(row('p').spec_path), 'settle:': settled('incorporated') }, {}, { workflow: probe })
  assert.equal(probe.calls[0].args.since, undefined)
  assert.equal(probe.calls[1].args.since, 'snapshot:aaa', 'narrowed by the snapshot, not by the return\'s name')
  assert.equal(sim.reviewed.length, probe.calls.length, 'every round is recorded')
  assert.deepEqual(sim.dispositions, [{ node: 'p', finding: 'item-two-meanings-of-tick', outcome: 'incorporated' }])
  assert.deepEqual(sim.prepared.map((p) => p.review), ['rbbb-probe'])
})

// A clean round records an empty return (T24b), so only a probe whose record failed (`review: ''`),
// or whose scope failed too (`snapshot: ''`), leaves the preparation to name what it read.
test('a passing review whose probe recorded no return is prepared against its snapshot, or the spec hash', async () => {
  const snapshotOnly = plannerDesign()
  await run(snapshotOnly, { 'plan:': written(row('p').spec_path) }, {},
    { workflow: probes([probeReturn({ review: '', snapshot: 'snapshot:first' })]) })
  assert.deepEqual(snapshotOnly.prepared.map((p) => p.review), ['snapshot:first'])

  // The simulator's first spec-check answers hash 'h0'.
  const neither = plannerDesign()
  await run(neither, { 'plan:': written(row('p').spec_path) }, {},
    { workflow: probes([probeReturn({ review: '', snapshot: '' })]) })
  assert.deepEqual(neither.prepared.map((p) => p.review), ['h0'])
})

test('a finding with no item is disposed as h0#P1', async () => {
  const sim = plannerDesign()
  const probe = probes([
    probeReturn({ findings: [probeFinding('P1', 'ambiguity', 'two meanings of tick', { item: '' })] }),
    probeReturn(),
  ])
  await run(sim, { 'plan:': written(row('p').spec_path), 'settle:': settled('incorporated') }, {}, { workflow: probe })
  // '<spec hash>#<P-id>': the simulator's first spec-check answers hash 'h0'.
  assert.deepEqual(sim.dispositions, [{ node: 'p', finding: 'h0#P1', outcome: 'incorporated' }])
  assert.deepEqual(sim.reviewed[0].ambiguities, ['h0#P1'])
})

test('a finding carried from a round that settled it is not settled again, and does not hold the gate shut', async () => {
  const sim = plannerDesign()
  const tick = probeFinding('P1', 'ambiguity', 'two meanings of tick')
  const note = probeFinding('P2', 'note', 'name the queue after its owner')
  const probe = probes([
    probeReturn({ findings: [tick, note], snapshot: 'snapshot:aaa' }),
    probeReturn({ findings: [{ ...tick, carried: true }, { ...note, carried: true }], snapshot: 'snapshot:bbb', review: 'rbbb-probe' }),
  ])
  const { result, prompts } = await run(sim, {
    'plan:': written(row('p').spec_path),
    'settle:': (prompt) => ({
      status: 'settled', question: '', detail: '',
      dispositions: [{ finding: 'P1', outcome: 'incorporated' }, { finding: 'P2', outcome: 'discarded' }],
    }),
  }, {}, { workflow: probe })
  assert.equal(labels(prompts).filter((l) => l.startsWith('settle:')).length, 1, 'carried findings are already settled')
  assert.deepEqual(sim.dispositions.map((d) => [d.finding, d.outcome]),
    [[tick.item, 'incorporated'], [note.item, 'discarded']])
  assert.deepEqual(sim.prepared.map((p) => p.review), ['rbbb-probe'], 'a settled carried ambiguity is not an open one')
  assert.deepEqual(result.escalations, [])
})

test('a gate still shut after a round that incorporated nothing escalates as not converging', async () => {
  // The ledger holds an ambiguity this invocation never saw settled (a reviewed line another
  // session wrote): the gate stays shut, and a round that edited nothing cannot open it.
  const shutGate = () => ({ ratifiable: false, open: ['Iabandoned'], coverage_complete: true })
  const note = probeFinding('P1', 'note', 'name the queue after its owner')
  for (const findings of [[note], []]) {
    const sim = simulate([composite('.'), row('p', { kind: 'design', author: 'planner' })], { gate: shutGate })
    const probe = probes([probeReturn({ findings })])
    const { result } = await run(sim, { 'plan:': written(row('p').spec_path), 'settle:': settled('discarded') }, {}, { workflow: probe })
    const label = findings.length ? 'a discarded note' : 'no finding'
    assert.deepEqual(result.escalations.map((e) => [e.id, e.reason]), [['p', 'review_not_converging']], label)
    assert.ok(recordsOf(sim, 'escalated')[0].detail.includes('Iabandoned'), label + ': the open ambiguity is named')
    assert.ok(sim.calls.some((c) => c.name === 'spec-gate'), label + ': the gate was asked')
    assert.equal(probe.calls.length, 1, label + ': an unedited spec is not reviewed again')
    assert.deepEqual(sim.prepared, [], label)
    assert.deepEqual(sim.dispositions.map((d) => [d.finding, d.outcome]), findings.map((f) => [f.item, 'discarded']), label)
  }
})

test('a compile refusal at preparation escalates, and nothing below the folder runs', async () => {
  const sim = simulate([composite('.'), row('p', { kind: 'design', author: 'planner' })], {
    prepare: () => ({ compile: { ok: false, problems: [{ file: 'DESIGN.md', line: 3, problem: 'x realises D9, which no spec defines' }], written: [], retired: [], parked: [], flagged: [], skipped: [] } }),
  })
  const { result } = await run(sim, { 'plan:': written(row('p').spec_path) }, {}, { workflow: probes([probeReturn()]) })
  assert.deepEqual(result.escalations.map((e) => [e.id, e.reason]), [['p', 'compile_refused']])
  assert.ok(recordsOf(sim, 'escalated')[0].detail.includes('D9'))
})

test('spec-check problems escalate spec_refused before any review', async () => {
  const sim = simulate([composite('.'), row('p', { kind: 'design', author: 'planner' })], {
    specCheck: () => ({ problems: [{ file: row('p').spec_path, line: 14, problem: 'task x has no criterion' }] }),
  })
  const probe = probes([])
  const { result } = await run(sim, { 'plan:': written(row('p').spec_path) }, {}, { workflow: probe })
  assert.deepEqual(result.escalations.map((e) => [e.id, e.reason]), [['p', 'spec_refused']])
  assert.ok(recordsOf(sim, 'escalated')[0].detail.includes('task x has no criterion'))
  assert.equal(probe.calls.length, 0)
  assert.deepEqual(sim.prepared, [])
})

test('a review that throws is a plugin fault on the folder, never a question, and names its channel', async () => {
  const sim = plannerDesign()
  const probe = probes([])   // its first call is unscripted, so it throws
  const { result } = await run(sim, { 'plan:': written(row('p').spec_path) }, {}, { workflow: probe })
  assert.deepEqual(result.escalations, [])
  assert.deepEqual(result.faults.map((f) => [f.id, f.channel]), [['p', 'dispatch']])
  assert.ok(result.coverage.failed_channels.includes('autonomous-review'))
  assert.deepEqual(sim.reviewed, [])
  assert.deepEqual(sim.prepared, [])
})

test('a preparation the boundary refuses escalates prepare_refused', async () => {
  const sim = simulate([composite('.'), row('p', { kind: 'design', author: 'planner' })], {
    prepare: () => ({ status: 'refused', problems: [{ file: row('p').spec_path, line: 1, problem: 'the parent spec gives p to the user' }] }),
  })
  const { result } = await run(sim, { 'plan:': written(row('p').spec_path) }, {}, { workflow: probes([probeReturn()]) })
  assert.deepEqual(result.escalations.map((e) => [e.id, e.reason]), [['p', 'prepare_refused']])
  assert.ok(recordsOf(sim, 'escalated')[0].detail.includes('gives p to the user'))
})

test('a prepared folder that compiles with no children escalates planner_wrote_nothing', async () => {
  const sim = simulate([composite('.'), row('p', { kind: 'design', author: 'planner' })], {
    compiled: () => [composite('.'), composite('p', { author: 'planner' })],
  })
  const { result } = await run(sim, { 'plan:': written(row('p').spec_path) }, {}, { workflow: probes([probeReturn()]) })
  assert.deepEqual(sim.prepared.map((p) => p.node), ['p'])
  assert.deepEqual(result.escalations.map((e) => [e.id, e.reason]), [['p', 'planner_wrote_nothing']])
})

test('a settle dispatch that returns nothing is a plugin fault on the folder, never a question', async () => {
  const sim = plannerDesign()
  const probe = probes([probeReturn({ findings: [probeFinding('P1', 'gap', 'no retry is designed')] })])
  const { result } = await run(sim, { 'plan:': written(row('p').spec_path), 'settle:': () => null }, {}, { workflow: probe })
  assert.deepEqual(result.escalations, [])
  assert.deepEqual(result.faults.map((f) => [f.id, f.channel]), [['p', 'dispatch']])
  assert.deepEqual(sim.dispositions, [])
  assert.deepEqual(sim.prepared, [])
})

test('a settle that needs a decision parks the folder with the planner\'s question', async () => {
  const sim = plannerDesign()
  const probe = probes([probeReturn({ findings: [probeFinding('P1', 'gap', 'which store holds the queue')] })])
  const question = 'Keep the queue in memory or on disk?'
  const { result } = await run(sim, {
    'plan:': written(row('p').spec_path),
    'settle:': () => ({ status: 'needs_decision', dispositions: [], question, detail: '' }),
  }, {}, { workflow: probe })
  assert.deepEqual(result.parked.map((p) => [p.id, p.return, sim.files.get(p.said)]), [['p', 'needs_decision', question]])
  assert.deepEqual(sim.dispositions, [])
  assert.deepEqual(sim.prepared, [])
})

test('a planner folder still parked spec_changed after its re-derivation is handed to the planner once', async () => {
  const parkedP = () => composite('p', { author: 'planner', status: 'parked', reason: 'spec_changed', rev: 1 })
  // The compiled tree still shows the park, so only the once-per-park rule keeps a second plan:p away.
  const sim = simulate([composite('.'), parkedP()], {
    compiled: () => [composite('.'), parkedP(), row('p/x')],
  })
  const probe = probes([probeReturn()])
  const { prompts } = await run(sim, { 'plan:': written(composite('p').spec_path) }, {}, { workflow: probe })
  assert.deepEqual(labels(prompts).filter((l) => l.startsWith('plan:')), ['plan:p'])
  assert.equal(probe.calls.length, 1)
})

test("develop's planner is pointed at the nested survey's context file, and handed none of its items", async () => {
  const sim = simulate([composite('.'), row('p', { kind: 'design', author: 'planner', ground_known: false })])
  const survey = {
    question: 'q', topics: ['a'], ground: ['src'], reused: [], unrecorded: [], history: null, docs: null,
    items: [{
      id: 'I12345678', topic: 'a', kind: 'behaviour', claim: 'the loader reads config.json',
      spans: [{ path: 'src/load.js', start: 3, end: 9, at: 'a'.repeat(40) }], queries: [], sources: [], rests_on: [],
    }],
    risks: [{ topic: 'a', text: 'tests were not searched' }],
    coverage: { complete: true, dropped: [], incomplete: [], failed_channels: [], unreached: [], resumable: { runId: 'r', remaining: [] } },
  }
  const { result, prompts } = await run(sim, { 'plan:': written(row('p').spec_path) }, {}, {
    workflow: (ref) => {
      const scriptPath = ref && ref.scriptPath
      if (/attack-document-with-independent-reviewers\.workflow\.js$/.test(scriptPath)) return probeReturn()
      if (!/gather-evidence-without-concluding\.workflow\.js$/.test(scriptPath)) throw new Error('no nested ' + scriptPath + ' in this scenario')
      return survey
    },
  })
  const plan = prompts.find((p) => p.opts.label === 'plan:p').prompt
  const context = /a survey of this folder's ground is in (\S+)\./.exec(plan)[1]
  assert.deepEqual(sim.files.get(context).map((i) => i.claim), ['the loader reads config.json'], 'the file holds the items in full')
  assert.doesNotMatch(plan, /the loader reads config\.json|src\/load\.js|tests were not searched/, 'the prompt holds none of them')
  const card = /Its card, (\S+), holds/.exec(plan)[1]
  assert.equal(sim.files.get(card).id, 'p', 'the title and intent are on the card the prompt names')
  assert.ok(!result.escalations.some((e) => e.reason === 'review_failed'), 'the nested probe answered')
})

test('a failed integration review makes the result incomplete', async () => {
  const sim = simulate([composite('.'), row('a'), row('b')])
  const { result } = await run(sim, { 'review:integration:.': () => { throw new Error('dispatch died') } })
  assert.ok(result.coverage.failed_channels.includes('integration-review'))
  assert.equal(result.coverage.complete, false)
  assert.deepEqual(recordsOf(sim, 'claims'), [], 'a review that never returned has no verdicts to record')
})

const claim = (verdict, text = 'every request is validated') => ({ claim: text, verdict, evidence: 'src/a.js:3' })
const integration = (claims, findings = []) => ({ 'review:integration:.': () => ({ findings, fix_verdicts: [], claims, notes: '' }) })

test('the integration review takes the folder\'s spec as its yardstick', async () => {
  const sim = simulate([composite('.'), row('a'), row('b')])
  const { prompts } = await run(sim)
  const review = prompts.find((p) => p.opts.label === 'review:integration:.')
  const card = /Its card, (\S+), names/.exec(review.prompt)[1]
  assert.equal(sim.files.get(card).spec_path, composite('.').spec_path, 'the card the prompt names holds the yardstick')
  assert.deepEqual(sim.files.get(card).children.sort(), ['a', 'b'])
})

test('under, over and deviates each go the integration-critical way', async () => {
  // No single producer owns a composite's merged work, so drift there parks for the user rather
  // than going to a fix round.
  for (const verdict of ['under', 'over', 'deviates']) {
    const sim = simulate([composite('.'), row('a'), row('b')])
    const drift = claim(verdict)
    const { result } = await run(sim, integration([claim('met', 'it builds'), drift]))
    assert.deepEqual(result.parked.map((p) => [p.id, p.return]), [['.', 'integration_critical']], verdict)
    assert.ok(recordsOf(sim, 'parked')[0].question.includes('[' + drift.verdict + '] ' + drift.claim + ' — ' + drift.evidence), verdict)
    assert.ok(!recordsOf(sim, 'parked')[0].question.includes('it builds'), 'a met claim is not a question')
  }
})

test('a spec_defect parks the folder on its spec', async () => {
  const sim = simulate([composite('.'), row('a'), row('b')])
  const { result } = await run(sim, integration([claim('spec_defect', 'the queue is both bounded and unbounded')]))
  assert.deepEqual(result.parked.map((p) => [p.id, p.return]), [['.', 'spec_defect']])
  assert.ok(recordsOf(sim, 'parked')[0].question.includes('the queue is both bounded and unbounded'))
  assert.ok(recordsOf(sim, 'parked')[0].question.includes(composite('.').spec_path))
  assert.deepEqual(recordsOf(sim, 'claims').map((e) => e.node), ['.'], 'a parked review still records its verdicts')
})

test('a critical finding with a cant_tell claim parks integration_critical; a critical finding with a spec_defect claim parks spec_defect', async () => {
  const critical = { id: 'F1', severity: 'critical', claim: 'the lock is never released', evidence: 'src/l.js:4', failure_scenario: 'two writers' }
  const withCantTell = await run(simulate([composite('.'), row('a'), row('b')]), integration([claim('cant_tell')], [critical]))
  assert.deepEqual(withCantTell.result.parked.map((p) => [p.id, p.return]), [['.', 'integration_critical']])
  const withDefect = await run(simulate([composite('.'), row('a'), row('b')]), integration([claim('spec_defect')], [critical]))
  assert.deepEqual(withDefect.result.parked.map((p) => [p.id, p.return]), [['.', 'spec_defect']])
})

test('cant_tell goes to the user and never counts as a pass', async () => {
  const sim = simulate([composite('.'), row('a'), row('b')])
  const { result } = await run(sim, integration([claim('cant_tell')]))
  assert.deepEqual(result.parked.map((p) => [p.id, p.return]), [['.', 'cant_tell']])
  assert.equal(result.coverage.complete, false)
})

test('several classes park once, the spec defect first, every claim in the question', async () => {
  const sim = simulate([composite('.'), row('a'), row('b')])
  const { result } = await run(sim, integration([
    claim('cant_tell', 'latency stays flat'), claim('under', 'retries are bounded'), claim('spec_defect', 'ids are unique and reused'),
  ]))
  assert.deepEqual(result.parked.map((p) => [p.id, p.return]), [['.', 'spec_defect']])
  for (const text of ['latency stays flat', 'retries are bounded', 'ids are unique and reused']) {
    assert.ok(recordsOf(sim, 'parked')[0].question.includes(text), text)
  }
})

test('claims all met: nothing parks, and the verdicts are recorded for the landing view', async () => {
  const sim = simulate([composite('.'), row('a'), row('b')])
  const claims = [claim('met', 'it builds'), claim('met')]
  const { result } = await run(sim, integration(claims))
  assert.deepEqual(result.parked, [])
  assert.equal(result.coverage.complete, true, JSON.stringify(result.coverage.unreached))
  const recorded = recordsOf(sim, 'claims')
  assert.deepEqual(recorded.map((e) => [e.node, e.claims]), [['.', claims.map(({ claim, verdict }) => ({ claim, verdict }))]],
    'the verdicts ride the record; the evidence stays in the reviewer\'s own file')
  assert.match(recorded[0].said, /^\/said\/\d+-\d+-review-integration-\.\.md$/)
  assert.ok(recorded[0].head_sha, 'the verdicts name the head they judged')
  const review = result.integration.reviews.find((r) => r.target === '.')
  assert.equal(review.reviewed, true)
  assert.deepEqual(sim.files.get(review.review_file).claims, claims, 'the session is pointed at the review its author wrote')
})

test('the root\'s integration review is always earned once work merged; a sub-folder\'s by the old rule', async () => {
  const one = simulate([composite('.'), row('a', { own_review: true })])
  const alone = await run(one)
  assert.ok(labels(alone.prompts).includes('review:integration:.'), 'the landing view needs the root\'s verdicts')

  const sub = simulate([composite('.'), composite('c'), row('c/x', { own_review: true }), row('b', { own_review: true })])
  const deep = await run(sub)
  assert.ok(!labels(deep.prompts).includes('review:integration:c'), 'one reviewed child earns no review below the root')
})

test('a consumer parked for drift while in flight is not merged', async () => {
  // b is still in its review loop when a merges; the real merge-batch never flags a node it landed.
  const sim = simulate([composite('.'), row('a'), row('b', { own_review: true, consumes: [{ name: 'api', paths: ['src/api.js'] }] })], {
    merge: (args) => (args.children.some((c) => c.id === 'a') && !args.children.some((c) => c.id === 'b')
      ? { drift: [{ node: 'b', contract: 'api', files: ['src/api.js'] }] } : {}),
  })
  const { result } = await run(sim, {
    'review:b#1': () => ({ findings: [{ id: 'F', severity: 'critical', claim: 'x', evidence: 'y', failure_scenario: 'z' }], fix_verdicts: [], notes: '' }),
    'review:b#2': () => ({ findings: [], fix_verdicts: [{ id: 'F', status: 'fixed', evidence: 'ok' }], notes: '' }),
  })
  assert.ok(sim.batches.some((bt) => bt.children.some((c) => c.id === 'a')), 'a merged while b was in flight')
  assert.ok(!sim.batches.some((bt) => bt.children.some((c) => c.id === 'b')))
  assert.deepEqual(result.parked.map((p) => p.id), ['b'])
})

test('a dependency declared on a composite binds every leaf beneath it', async () => {
  const sim = simulate([composite('.'), row('b'), composite('a', { deps: ['b'] }), row('a/x')])
  await run(sim)
  const order = sim.calls.map((c) => c.name + ':' + (c.args.node || c.args.target || ''))
  assert.ok(order.indexOf('leaf-open:a/x') > order.findIndex((o) => o === 'merge-batch:.'), order.join(' '))
})

test('escalations carried from an earlier invocation lead the result', async () => {
  const sim = simulate([composite('.'), row('a', { status: 'escalated', reason: 'blocked' }), row('b')])
  const { result } = await run(sim)
  assert.deepEqual(result.escalations.map((e) => [e.id, e.carried === true]), [['a', true]])
  assert.match(result.coverage.unreached[0], /a: escalated earlier — blocked/)
})

/** Resolve once `pred` holds, checking on every turn of the event loop. */
const until = (pred) => new Promise((resolve) => {
  const check = () => (pred() ? resolve() : setTimeout(check, 1))
  check()
})

test('a stop the user answers while the run goes on is relaunched by the same run', async () => {
  const sim = simulate([composite('.'), row('a'), row('b')])
  let asked = 0
  const { result } = await run(sim, {
    'implementer:a#1': () => (asked++ === 0
      ? { status: 'blocked', detail: 'needs a key', concerns: [], commits: [] }
      : { status: 'done', detail: '', concerns: [], commits: [{ sha: 'c2', subject: 'do a' }] }),
    'implementer:b#1': async () => {
      await until(() => sim.statusOf('a') === 'escalated')
      // The session asked, the user answered, and the session recorded the retry.
      sim.event({ kind: 'replanned', node: 'a', reason: 'retry_escalated', by: 'session' })
      return { status: 'done', detail: '', concerns: [], commits: [{ sha: 'c1', subject: 'do b' }] }
    },
  })
  assert.equal(sim.opens.filter((o) => o === 'a').length, 2, 'a ran again in the same invocation')
  assert.deepEqual(result.escalations, [], 'an answered stop is no longer reported')
  assert.equal(sim.statusOf('a'), 'merged')
  assert.equal(result.coverage.complete, true)
})

test('a launch whose node a merge parked while the tick was in flight is dropped, never started', async () => {
  const api = [{ name: 'api', paths: ['src/api.js'] }]
  const sim = simulate([composite('.'), row('a', { provides: api }), row('c', { deps: ['a'], consumes: api }), row('b')], {
    merge: (args, n) => (n === 0 ? { drift: [{ node: 'c', contract: 'api', files: ['src/api.js'] }] } : {}),
  })
  // b ends only once the merge of a is under way, so the tick b wakes is built with a merged on
  // disk and c ready; the merge's answer, which parks c, arrives while that tick is still out.
  let mergeCalled = false
  let mergeDelivered = false
  const carried = (out) => ({ ...out, task_tools: 'skipped' })
  const { result } = await run(sim, {
    'implementer:b#1': async () => {
      await until(() => mergeCalled)
      return { status: 'done', detail: '', concerns: [], commits: [{ sha: 'c1', subject: 'do b' }] }
    },
    courier: async (prompt, opts) => {
      const out = sim.courier(prompt)
      if (opts.label === 'merge:.' && !mergeCalled) {
        mergeCalled = true
        const calls = sim.calls.length
        await until(() => sim.calls.slice(calls).some((c) => c.name === 'schedule'))
        mergeDelivered = true
        return carried(out)
      }
      if (opts.label.startsWith('schedule#')) await until(() => !mergeCalled || mergeDelivered)
      await new Promise((resolve) => setTimeout(resolve, 0))
      return carried(out)
    },
  })
  assert.ok(mergeDelivered, 'the merge answered while a tick was out')
  assert.ok(!sim.opens.includes('c'), 'the tick launched c from a view that had not seen the park')
  assert.deepEqual(result.parked.map((p) => [p.id, p.return]), [['c', 'contract_drift']])
})
