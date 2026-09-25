import { test } from 'node:test'
import assert from 'node:assert/strict'

import { runWorkflow } from './harness/workflow-host.mjs'
import { agents, composite, recordsOf, row, simulate } from './harness/develop-sim.mjs'

const WF = new URL('../workflows/agentics-develop.workflow.js', import.meta.url).pathname
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
  const two = await run(contract, { 'review:a#1': major('breaks consumer'), 'review:a#2': () => ({ findings: [], fix_verdicts: [], notes: '' }) })
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

test('decompose: the planner splits the leaf, the tree reloads, the children run', async () => {
  const sim = simulate([composite('.'), row('a')], {
    preflight: (args, s, n) => (args.reload ? { nodes: [composite('.'), composite('a'), row('a/x'), row('a/y')] } : {}),
  })
  const { result, prompts } = await run(sim, {
    'implementer:a#1': () => ({ status: 'decompose', detail: 'two concerns', concerns: [], commits: [] }),
    planner: () => ({ status: 'written', written: ['a/x', 'a/y'], accepted_warnings: [], uncovered: [], question: '', detail: '' }),
  })
  assert.ok(labels(prompts).includes('plan:a'))
  assert.ok(sim.opens.includes('a/x') && sim.opens.includes('a/y'))
  const intoA = sim.batches.find((b) => b.target === 'a')
  assert.deepEqual(intoA.children.map((c) => c.id).sort(), ['a/x', 'a/y'])
  assert.ok(sim.batches.some((b) => b.target === '.' && b.children.some((c) => c.id === 'a')), 'the composite merged up')
  assert.equal(result.coverage.complete, true, JSON.stringify(result.coverage.unreached))
})

test('an unplanned root is planned first; a design node is parked for the user', async () => {
  const sim = simulate([composite('.')], {
    preflight: (args) => (args.reload ? { nodes: [composite('.'), row('a'), row('d', { kind: 'design', level: 'component' })] } : {}),
  })
  const { result } = await run(sim, {
    planner: () => ({ status: 'written', written: ['a', 'd'], accepted_warnings: [], uncovered: [], question: '', detail: '' }),
  })
  assert.deepEqual(result.parked.map((p) => [p.id, p.return]), [['d', 'needs_design']])
  assert.ok(result.implemented.some((i) => i.id === 'a'))
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
