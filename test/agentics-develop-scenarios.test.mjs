import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { runWorkflow } from './harness/workflow-host.mjs'
import { agents, composite, recordsOf, row, simulate } from './harness/develop-sim.mjs'

const WF = fileURLToPath(new URL('../workflows/agentics-develop.workflow.js', import.meta.url))
const ARGS = { repo: '/repo', effort: 'e1', execution: '20260925-120000', plugin_root: '/plugin' }

const run = (sim, handlers = {}, args = {}, extra = {}) =>
  runWorkflow(WF, { args: { ...ARGS, ...args }, agent: agents(sim, handlers), ...extra })

const labels = (prompts) => prompts.map((p) => p.opts.label)

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
  const fixOpen = sim.calls.find((c) => c.name === 'leaf-open' && c.args.round === 2)
  assert.match(fixOpen.args.fix[0].claim, /F1/)
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

test('a major blocks only on a contract leaf, and only with a failure scenario', async () => {
  const major = (scenario) => () => ({ findings: [{ id: 'M', severity: 'major', claim: 'c', evidence: 'e', failure_scenario: scenario }], fix_verdicts: [], notes: '' })
  const plain = simulate([composite('.'), row('a', { own_review: true, rigor: 'tdd-pair', role: 'red' })])
  const one = await run(plain, { 'review:a#1': major('breaks consumer') })
  assert.equal(one.result.implemented[0].review_rounds, 1, 'not a contract: the major is advisory')

  const contract = simulate([composite('.'), row('a', { own_review: true, provides: [{ name: 'api', paths: ['src/'] }] })])
  const two = await run(contract, { 'review:a#1': major('breaks consumer'), 'review:a#2': () => ({ findings: [], fix_verdicts: [{ id: 'M', status: 'fixed', evidence: 'ok' }], notes: '' }) })
  assert.equal(two.result.implemented[0].review_rounds, 2)

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
  assert.deepEqual(result.blocked, [{ id: 'b', blocked_by: 'a' }])
  assert.ok(result.implemented.some((i) => i.id === 'c'))
  assert.ok(!sim.opens.includes('b'))
  assert.equal(result.coverage.complete, false)
  assert.ok(result.coverage.unreached.some((u) => /b: blocked — a/.test(u)))
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

const written = (path) => () => ({ status: 'written', written: [path], accepted_warnings: [], uncovered: [], question: '', detail: '' })

test('decompose: the planner promotes the task to a folder of its own, and it waits for its review', async () => {
  const sim = simulate([composite('.'), row('a')])
  const { result, prompts } = await run(sim, {
    'implementer:a#1': () => ({ status: 'decompose', detail: 'two concerns', concerns: [], commits: [] }),
    'plan:': written(row('a').spec_path),
  })
  const plan = prompts.find((p) => p.opts.label === 'plan:a')
  assert.ok(plan, 'the planner was dispatched for the promoted task')
  assert.ok(plan.prompt.includes(row('a').spec_path), 'the planner is told where the promoted spec goes')
  assert.ok(!plan.prompt.includes('tree.mjs" add'), 'the planner no longer writes nodes')
  assert.ok(plan.prompt.includes('lib/spec.mjs" check'), 'the planner checks its spec with the spec checker')
  assert.deepEqual(result.parked.map((p) => [p.id, p.return]), [['a', 'spec_unreviewed']])
  assert.ok(result.parked[0].question.includes(row('a').spec_path), 'the seam names the spec awaiting review')
})

test('a design node you author is parked for design; one the planner authors goes to the planner', async () => {
  const sim = simulate([composite('.'), row('a'),
    row('d', { kind: 'design', author: 'you' }), row('p', { kind: 'design', author: 'planner' })])
  const { result, prompts } = await run(sim, { 'plan:': written(row('p').spec_path) })
  assert.deepEqual(result.parked.map((p) => [p.id, p.return]).sort(), [['d', 'needs_design'], ['p', 'spec_unreviewed']])
  assert.deepEqual(labels(prompts).filter((l) => l.startsWith('plan:')), ['plan:p'])
  assert.ok(prompts.find((p) => p.opts.label === 'plan:p').prompt.includes(row('p').spec_path))
  assert.ok(result.implemented.some((i) => i.id === 'a'), 'the rest keeps running')
})

test('a childless folder you authored is parked, never handed to the planner', async () => {
  const sim = simulate([composite('.')])
  const { result, prompts } = await run(sim)
  assert.deepEqual(result.parked.map((p) => [p.id, p.return]), [['.', 'needs_design']])
  assert.ok(result.parked[0].question.includes(composite('.').spec_path), 'the question names the spec that needs a Plan')
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

test('a leaf failing alone on the merged head gets a fix round on a refreshed branch', async () => {
  const sim = simulate([composite('.'), row('a')], {
    merge: (args, n) => (n === 0 ? { merged: [], failed_alone: [{ id: 'a', failures: [{ check: 'suite', claim: 'breaks x', evidence: 't' }] }] } : {}),
  })
  const { result } = await run(sim)
  const refresh = sim.calls.find((c) => c.name === 'leaf-open' && c.args.refresh === true)
  assert.ok(refresh, 'the fix round asked for a refreshed branch')
  assert.equal(result.coverage.complete, true)
})

test('pause stops starting new leaves after the first merge-batch', async () => {
  const sim = simulate([composite('.'), row('a'), row('b', { deps: ['a'] })])
  const { result } = await run(sim, {}, { pause: true })
  assert.ok(!sim.opens.includes('b'))
  assert.equal(result.stopped, 'pause')
  assert.equal(result.coverage.complete, false)
  const post = sim.calls.find((c) => c.name === 'postflight')
  assert.equal(post.args.status, 'paused')
})

test('an integration critical parks the composite for the user', async () => {
  const sim = simulate([composite('.'), row('a'), row('b')])
  const { result } = await run(sim, {
    'review:integration:.': () => ({ findings: [{ id: 'I1', severity: 'critical', claim: 'a and b disagree', evidence: 'x', failure_scenario: 'y' }], fix_verdicts: [], notes: '' }),
  })
  assert.deepEqual(result.parked.map((p) => [p.id, p.return]), [['.', 'integration_critical']])
  assert.equal(result.coverage.complete, false)
})

test('the cost report counts every dispatch, and the records carry a dispatch line for each', async () => {
  const sim = simulate([composite('.'), row('a')])
  const { result, prompts } = await run(sim)
  assert.equal(result.cost.dispatches, prompts.length)
  assert.ok(recordsOf(sim, 'dispatch').length >= prompts.length - 1)
})

test('bad input returns a coverage block, never undefined', async () => {
  const { result } = await runWorkflow(WF, { args: { repo: '/r' }, agent: () => { throw new Error('none') } })
  assert.equal(result.checkpoint.reason, 'bad_input')
  assert.equal(result.coverage.complete, false)
})

test('contract drift parks the consumer until the user rules, and the rest keeps running', async () => {
  const sim = simulate([composite('.'), row('a'), row('b', { deps: ['a'], consumes: [{ name: 'api', paths: ['src/api.js'] }] }), row('c')], {
    merge: (args) => (args.children.some((ch) => ch.id === 'a') ? { drift: [{ node: 'b', contract: 'api', files: ['src/api.js'] }] } : {}),
  })
  const { result } = await run(sim)
  assert.deepEqual(result.parked.map((p) => [p.id, p.return]), [['b', 'contract_drift']])
  assert.ok(!sim.opens.includes('b'))
  assert.ok(result.implemented.some((i) => i.id === 'c'))
  assert.deepEqual(result.drift, [{ node: 'b', contract: 'api', files: ['src/api.js'] }])
})

test('a leaf whose files are held by a stopped leaf is reported blocked, never re-dispatched in a loop', async () => {
  const sim = simulate([composite('.'), row('a'), row('b')], { open: { b: ['stuck'] } })
  const { result } = await run(sim)
  assert.equal(sim.opens.filter((o) => o === 'b').length, 1)
  assert.deepEqual(result.blocked, [{ id: 'b', blocked_by: 'x' }])
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

test('a resumed leaf is closed at its own round, reviewed over its own base and brief', async () => {
  const sim = simulate([composite('.'), row('a', { own_review: true })], {
    preflight: () => ({ leaves: [{ id: 'a', next_action: 'verify', note: '', branch: 'agentics/e--a', worktree: '/wt/a', head_sha: 'h1', base_sha: 'b1', approved_head: '', commits: ['h1'], dirty: [], rounds: 1, brief_path: '/briefs/a-r1.md' }] }),
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
  const sim = simulate([composite('.'), row('a', { status: 'approved' })], {
    preflight: () => ({ leaves: [{ id: 'a', next_action: 'merge', note: '', head_sha: 'tip', base_sha: 'b', approved_head: 'approved', commits: [], dirty: [], rounds: 1, brief_path: '' }] }),
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
  assert.ok(result.parked[0].question.includes(composite('.').spec_path), 'the question names the spec to edit')
  assert.ok(!labels(prompts).some((l) => l.startsWith('plan:')))
})

test('a folder the planner authored is replanned by the planner, in its own spec', async () => {
  const sim = simulate([composite('.'), composite('c', { author: 'planner' }), row('c/v', { rigor: 'verify' })],
    { close: { 'c/v': [finding] } })
  const { result, prompts } = await run(sim, { 'plan:': written(composite('c').spec_path) })
  const plan = prompts.find((p) => p.opts.label === 'plan:c')
  assert.ok(plan && plan.prompt.includes(composite('c').spec_path))
  assert.deepEqual(result.parked.map((p) => [p.id, p.return]), [['c', 'spec_unreviewed']])
})

test("develop's planner prompt carries the nested survey's items and risks, not verdicts", async () => {
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
  const { prompts } = await run(sim, { 'plan:': written(row('p').spec_path) }, {}, {
    workflow: (name) => {
      if (name !== 'agentics-survey') throw new Error('no nested ' + name + ' in this scenario')
      return survey
    },
  })
  const plan = prompts.find((p) => p.opts.label === 'plan:p').prompt
  assert.match(plan, /the loader reads config\.json/)
  assert.match(plan, /src\/load\.js/)
  assert.match(plan, /tests were not searched/)
  assert.doesNotMatch(plan, /"verdicts"/)
})

test('a failed integration review makes the result incomplete', async () => {
  const sim = simulate([composite('.'), row('a'), row('b')])
  const { result } = await run(sim, { 'review:integration:.': () => { throw new Error('dispatch died') } })
  assert.ok(result.coverage.failed_channels.includes('integration-review'))
  assert.equal(result.coverage.complete, false)
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
