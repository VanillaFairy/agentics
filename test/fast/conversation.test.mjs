// test/fast/conversation.test.mjs — where a message goes, what its rendering carries, and that a
// message is delivered exactly once.
//
// What is pinned here:
//
//   routing     every (msg, from, remedy) the table names goes to its `to`; every other pair is
//               refused `no_route`; there is no `dispute`, and nothing goes to a reviewer
//   rendering   a rendered message contains what its payload carries, never a template's wording
//   delivery    a message is pending until a `dispatched` carries it, and never again after; an
//               unreturned carrier is resumed rather than sent again
//
// Design: docs/DESIGN.md#conversations.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ROUTES, deliveryPlan, pendingMessages, renderMessage, routeOf,
} from '../../lib/conversation.mjs'

// The task's routing table: the spec these routes are checked against.
const TABLE = [
  { msg: 'findings', from: 'reviewer', remedy: 'code', to: 'producer' },
  { msg: 'findings', from: 'reviewer', remedy: 'tests', to: 'cycle_test' },
  { msg: 'surviving_mutations', from: 'code', to: 'cycle_test' },
  { msg: 'needs_tests', from: 'implementer', to: 'cycle_test' },
  { msg: 'consolidate', from: 'code', to: 'cycle_test' },
  { msg: 'tests_ready', from: 'code', to: 'green_implementer' },
  { msg: 'declined', from: 'test-author', to: 'requester' },
  { msg: 'needs_context', from: 'implementer', to: 'planner_or_park' },
  { msg: 'needs_context', from: 'test-author', to: 'planner_or_park' },
  { msg: 'brief_changed', from: 'code', to: 'thread' },
  { msg: 'findings', from: 'probe', to: 'planner' },
  { msg: 'problems', from: 'code', to: 'planner' },
  { msg: 'refusals', from: 'code', to: 'thread' },
  { msg: 'cut_off', from: 'code', to: 'thread' },
  { msg: 'failures', from: 'code', to: 'producer' },
  { msg: 'rebase', from: 'code', to: 'producer' },
  { msg: 'retried', from: 'code', to: 'thread' },
  { msg: 'notes', from: 'code', to: 'thread' },
]

const SENDERS = ['reviewer', 'code', 'implementer', 'test-author', 'probe', 'producer', 'judge',
  'planner']

function assertNoRoute(result, label) {
  assert.equal(result.error?.kind, 'no_route', `${label}: expected a no_route refusal`)
  assert.equal(typeof result.error.message, 'string', `${label}: the refusal says why`)
  assert.ok(result.error.message.length > 0, `${label}: the refusal says why`)
  assert.equal(result.to, undefined, `${label}: a refusal names no recipient`)
}

// A tiny in-order log: each entry gets the next seq, as the log port would assign it.
function logOf(...specs) {
  let seq = 0
  return specs.map((s) => ({ ...s, seq: ++seq }))
}
const message = (thread, msg, payload, from = 'code') => ({ kind: 'message', thread, from, msg, payload })
const dispatched = (dispatch, thread, carries) => ({ kind: 'dispatched', dispatch, thread, carries })
const returned = (dispatch, status) => ({ kind: 'returned', dispatch, status })

const seqsOf = (entries, pred) => entries.filter(pred).map((e) => e.seq)

// --- routing ---------------------------------------------------------------------------------

test('every route goes where the table says', () => {
  assert.ok(Array.isArray(ROUTES) && ROUTES.length > 0, 'ROUTES is a non-empty array')
  for (const row of ROUTES) {
    const got = routeOf({ msg: row.msg, from: row.from, remedy: row.remedy })
    assert.equal(got.error, undefined, `${row.msg} from ${row.from} (${row.remedy}) has a route`)
    assert.equal(got.to, row.to, `${row.msg} from ${row.from} (${row.remedy ?? ''})`)
  }
  for (const row of TABLE) {
    const args = row.remedy ? { msg: row.msg, from: row.from, remedy: row.remedy } : { msg: row.msg, from: row.from }
    assert.equal(routeOf(args).to, row.to, `${row.msg} from ${row.from} (${row.remedy ?? ''})`)
    assert.ok(
      ROUTES.some((r) => r.msg === row.msg && r.from === row.from && r.to === row.to),
      `ROUTES holds ${row.msg} from ${row.from} to ${row.to}`,
    )
  }
  const routed = new Set(TABLE.map((r) => `${r.msg}\0${r.from}`))
  const kinds = [...new Set([...TABLE.map((r) => r.msg), ...ROUTES.map((r) => r.msg), 'dispute'])]
  for (const msg of kinds) {
    for (const from of SENDERS) {
      if (routed.has(`${msg}\0${from}`)) continue
      assertNoRoute(routeOf({ msg, from }), `${msg} from ${from}`)
    }
  }
  for (const r of ROUTES) {
    assert.ok(routed.has(`${r.msg}\0${r.from}`), `ROUTES adds no pair the table lacks: ${r.msg} from ${r.from}`)
  }
})

test('every route names its message, its ends and its answers', () => {
  for (const row of ROUTES) {
    for (const key of ['msg', 'from', 'to']) {
      assert.equal(typeof row[key], 'string', `${JSON.stringify(row)} names its ${key}`)
      assert.ok(row[key].length > 0, `${JSON.stringify(row)} names its ${key}`)
    }
    assert.ok(Array.isArray(row.answers), `${row.msg} from ${row.from} lists its answers`)
    assert.ok(row.answers.length >= 1, `${row.msg} from ${row.from} has at least one answer`)
    for (const a of row.answers) {
      assert.equal(typeof a, 'string', `${row.msg} from ${row.from}: an answer is a string`)
      assert.ok(a.length > 0, `${row.msg} from ${row.from}: an answer is not empty`)
    }
  }
})

test("findings without a remedy are the code's", () => {
  const code = routeOf({ msg: 'findings', from: 'reviewer', remedy: 'code' })
  assert.equal(routeOf({ msg: 'findings', from: 'reviewer' }).to, 'producer')
  assert.equal(routeOf({ msg: 'findings', from: 'reviewer', remedy: '' }).to, 'producer')
  assert.equal(code.to, 'producer')
  assert.equal(routeOf({ msg: 'findings', from: 'reviewer', remedy: 'tests' }).to, 'cycle_test',
    'the remedy is what tells the two apart')
})

test('a producer cannot dispute a finding', () => {
  assert.ok(!ROUTES.some((r) => r.msg === 'dispute'), 'no row routes a dispute')
  for (const from of ['producer', 'implementer', 'test-author']) {
    let result
    assert.doesNotThrow(() => { result = routeOf({ msg: 'dispute', from }) }, 'a refusal is returned')
    assertNoRoute(result, `dispute from ${from}`)
    assertNoRoute(routeOf({ msg: 'dispute', from, remedy: 'code' }), `dispute from ${from}, remedy code`)
  }
})

test('a producer cannot send findings', () => {
  for (const from of ['implementer', 'producer', 'test-author']) {
    let result
    assert.doesNotThrow(() => { result = routeOf({ msg: 'findings', from }) }, 'a refusal is returned')
    assertNoRoute(result, `findings from ${from}`)
    assertNoRoute(routeOf({ msg: 'findings', from, remedy: 'tests' }), `findings from ${from}, remedy tests`)
  }
})

test('an unknown message has no route', () => {
  const unknown = 'gossip'
  assert.ok(!ROUTES.some((r) => r.msg === unknown))
  for (const from of new Set(ROUTES.map((r) => r.from))) {
    let result
    assert.doesNotThrow(() => { result = routeOf({ msg: unknown, from }) }, 'a refusal is returned')
    assertNoRoute(result, `${unknown} from ${from}`)
  }
})

test('nothing is routed to a reviewer', () => {
  for (const row of ROUTES) {
    assert.doesNotMatch(row.to, /review/i, `${row.msg} from ${row.from} goes to ${row.to}`)
    const got = routeOf({ msg: row.msg, from: row.from, remedy: row.remedy })
    if (got.to !== undefined) assert.doesNotMatch(got.to, /review/i)
  }
})

test('failures go from code to the producer, answered by a fix round', () => {
  assert.deepEqual(routeOf({ msg: 'failures', from: 'code' }), { to: 'producer' })
  const row = ROUTES.find((r) => r.msg === 'failures' && r.from === 'code')
  assert.deepEqual(row.answers, ['fix'])
  for (const from of ['implementer', 'test-author', 'reviewer']) assertNoRoute(routeOf({ msg: 'failures', from }), `failures from ${from}`)
})

test('retried goes from code to the thread its round resumes, answered by a round', () => {
  assert.deepEqual(routeOf({ msg: 'retried', from: 'code' }), { to: 'thread' })
  const row = ROUTES.find((r) => r.msg === 'retried' && r.from === 'code')
  assert.deepEqual(row.answers, ['round'])
  for (const from of ['implementer', 'test-author', 'reviewer']) assertNoRoute(routeOf({ msg: 'retried', from }), `retried from ${from}`)
})

test('tests_declined is not a message', () => {
  assert.ok(!ROUTES.some((r) => r.msg === 'tests_declined'), 'no row routes tests_declined')
  for (const from of SENDERS) assertNoRoute(routeOf({ msg: 'tests_declined', from }), `tests_declined from ${from}`)
  assert.throws(() => renderMessage({ msg: 'tests_declined', payload: { why: 'x' } }))
})

// --- rendering -------------------------------------------------------------------------------

test('findings name what was found', () => {
  const findings = [
    { id: 'F-alpha-17', severity: 'blocker', claim: 'routeOf ignores the remedy of zebra findings' },
    { id: 'F-beta-42', severity: 'minor', claim: 'the header names the wrong anchor quokka' },
  ]
  const text = renderMessage({ msg: 'findings', payload: { findings } })
  assert.equal(typeof text, 'string')
  for (const f of findings) {
    assert.ok(text.includes(f.id), `names ${f.id}`)
    assert.ok(text.includes(f.severity), `names ${f.id}'s severity`)
    assert.ok(text.includes(f.claim), `names ${f.id}'s claim`)
  }
})

test('surviving mutations name what survived', () => {
  const mutations = [
    { file: 'lib/alpha-zebra.mjs', find: 'a.length > 0', replace: 'a.length >= 0', expect_failing: ['alpha keeps its order', 'alpha refuses empty'] },
    { file: 'lib/beta-quokka.mjs', find: 'n + 1', replace: 'n + 2', expect_failing: ['beta counts once'] },
  ]
  const text = renderMessage({ msg: 'surviving_mutations', payload: { mutations } })
  for (const m of mutations) {
    assert.ok(text.includes(m.file), `names ${m.file}`)
    assert.ok(text.includes(m.find), `shows what ${m.file} held`)
    assert.ok(text.includes(m.replace), `shows what ${m.file} was changed to`)
    for (const t of m.expect_failing) assert.ok(text.includes(t), `names the test ${t} for ${m.file}`)
  }
})

test('surviving mutations accept the tests under the name tests', () => {
  const text = renderMessage({ msg: 'surviving_mutations', payload: { mutations: [{ file: 'lib/a.mjs', find: 'x', replace: 'y', tests: ['alpha counts once'] }] } })
  assert.ok(text.includes('alpha counts once'))
})

test('a consolidation request names each test its judges asked to retire and each break the audit holds', () => {
  const retire = [{ claim: 'wombat exists only restates the type', evidence: 'test/w.test.mjs:4' }]
  const held = [{ file: 'lib/w.mjs', find: 'n > 0', replace: 'n >= 0', expect_failing: ['test/w.test.mjs'] }]
  const text = renderMessage({ msg: 'consolidate', payload: { retire, held } })
  for (const part of [retire[0].claim, retire[0].evidence, held[0].file, held[0].find, held[0].replace, held[0].expect_failing[0]]) {
    assert.ok(text.includes(part), 'carries ' + part)
  }
})

test('a test request carries its text and forbids the code', () => {
  const request = 'please pin what happens when the wombat list is empty'
  const text = renderMessage({ msg: 'needs_tests', payload: { text: request } })
  assert.ok(text.includes(request), 'carries the request verbatim')
  assert.match(text, /\b(not|never|n't|don't|do not|must not|without)\b[^.\n]*\bread(ing)?\b/i,
    'says the implementation is not to be read')
})

test('tests ready names the tests', () => {
  const files = ['test/alpha-zebra.test.mjs', 'test/beta-quokka.test.mjs']
  const text = renderMessage({ msg: 'tests_ready', payload: { files } })
  for (const f of files) assert.ok(text.includes(f), `names ${f}`)
})

test('failures carry their source and each failed check, claim and evidence', () => {
  const failures = [
    { check: 'node --test test/wombat.test.mjs', claim: 'the empty wombat list throws', evidence: 'TypeError at lib/wombat.mjs:12' },
    { check: 'tsc --noEmit', claim: 'quokka.ts no longer typechecks', evidence: '' },
  ]
  for (const source of ['verification', 'integration']) {
    const text = renderMessage({ msg: 'failures', payload: { source, failures } })
    assert.ok(text.includes(source), `names its source ${source}`)
    for (const f of failures) {
      assert.ok(text.includes(f.check), `names ${f.check}`)
      assert.ok(text.includes(f.claim), `carries ${f.claim}`)
    }
    assert.ok(text.includes(failures[0].evidence), 'carries the evidence')
  }
})

test('a retried message carries the cleared stop\'s reason and each note', () => {
  const payload = { reason: 'wombat_fixture_missing', notes: ['the wombat fixture now lives in test/zebra', 'quokka runs need the --slow flag'] }
  const text = renderMessage({ msg: 'retried', payload })
  assert.ok(text.includes(payload.reason), 'names the reason')
  for (const n of payload.notes) assert.ok(text.includes(n), `quotes ${n}`)
})

test('a retried message with no notes still names its reason', () => {
  const text = renderMessage({ msg: 'retried', payload: { reason: 'platypus_blocked', notes: [] } })
  assert.equal(typeof text, 'string')
  assert.ok(text.includes('platypus_blocked'), 'names the reason')
  assert.ok(text.length < renderMessage({ msg: 'retried', payload: { reason: 'platypus_blocked', notes: ['a note'] } }).length, 'a note adds to it')
})

test('a decline carries its why', () => {
  const why = 'the wombat case is already pinned by the empty-list test'
  const text = renderMessage({ msg: 'declined', payload: { why } })
  assert.ok(text.includes(why))
})

test('a changed brief carries the change and the brief', () => {
  const changed = 'acceptance line 4 now names the platypus remedy'
  const brief = '# Task T99\n\nDo the platypus thing.\n\n- [ ] platypus line'
  const text = renderMessage({ msg: 'brief_changed', payload: { changed, brief } })
  assert.ok(text.includes(changed), 'carries what changed')
  assert.ok(text.includes(brief), 'carries the new brief whole')
})

test('a cut_off message renders without a payload', () => {
  const text = renderMessage({ msg: 'cut_off' })
  assert.equal(typeof text, 'string')
  assert.ok(text.trim().length > 0, 'says something')
  assert.equal(renderMessage({ msg: 'cut_off', payload: {} }), text)
})

test('refused items, dispositions or rulings each answer a refusals message', () => {
  const row = ROUTES.find((r) => r.msg === 'refusals' && r.from === 'code')
  assert.ok(row, 'the refusals route exists')
  for (const answer of ['items', 'dispositions', 'rulings']) assert.ok(row.answers.includes(answer), answer)
})

test('a refusals message goes back to the thread whose return was refused', () => {
  assert.deepEqual(routeOf({ msg: 'refusals', from: 'code' }), { to: 'thread' })
})

const REFUSED = [
  { claim: 'the loader caches zebra-71', problem: 'no anchor for quokka-3' },
  { id: 'P7', problem: 'discarded, but only a note may be discarded' },
]

test('a refusals message names each refused claim or id with its problem', () => {
  for (const of of ['items', 'dispositions', 'rulings']) {
    const text = renderMessage({ msg: 'refusals', payload: { of, refusals: REFUSED } })
    for (const r of REFUSED) {
      assert.ok(text.includes(r.claim || r.id), of + ': names ' + (r.claim || r.id))
      assert.ok(text.includes(r.problem), of + ': says ' + r.problem)
    }
  }
})

test('a refusals message says what was refused, and names the evidence store for items alone', () => {
  const texts = Object.fromEntries(['items', 'dispositions', 'rulings']
    .map((of) => [of, renderMessage({ msg: 'refusals', payload: { of, refusals: REFUSED } })]))
  assert.equal(new Set(Object.values(texts)).size, 3, 'each `of` reads differently')
  for (const [of, text] of Object.entries(texts)) assert.ok(text.includes(of), of + ' is named')
  assert.ok(!/evidence store/i.test(texts.dispositions), "dispositions are not the evidence store's")
  assert.ok(!/evidence store/i.test(texts.rulings), "rulings are not the evidence store's")
})

test('a refusals message without of still renders its refusals, naming no evidence store', () => {
  const text = renderMessage({ msg: 'refusals', payload: { refusals: REFUSED } })
  for (const r of REFUSED) assert.ok(text.includes(r.problem), r.problem)
  assert.ok(!/evidence store/i.test(text))
})

test('a refusals message with an unknown of renders as one without of', () => {
  const none = renderMessage({ msg: 'refusals', payload: { refusals: REFUSED } })
  for (const of of ['findings', 'constructor', '']) {
    assert.equal(renderMessage({ msg: 'refusals', payload: { of, refusals: REFUSED } }), none, JSON.stringify(of))
  }
})

test('a rendered message is deterministic', () => {
  const inputs = [
    { msg: 'findings', payload: { findings: [{ id: 'F1', severity: 'blocker', claim: 'c1' }] } },
    { msg: 'surviving_mutations', payload: { mutations: [{ file: 'lib/a.mjs', find: 'f', replace: 'r', expect_failing: ['t1'] }] } },
    { msg: 'needs_tests', payload: { text: 'pin the empty case' } },
    { msg: 'tests_ready', payload: { files: ['test/a.test.mjs'] } },
    { msg: 'declined', payload: { why: 'already pinned' } },
    { msg: 'brief_changed', payload: { changed: 'line 2', brief: 'the brief' } },
  ]
  for (const input of inputs) {
    const before = structuredClone(input)
    const first = renderMessage(input)
    const second = renderMessage(structuredClone(input))
    assert.equal(second, first, `${input.msg} renders the same twice`)
    assert.equal(renderMessage(input), first, `${input.msg} renders the same a third time`)
    assert.deepEqual(input, before, `${input.msg}: rendering leaves its input alone`)
  }
})

test('a message with no template is refused', () => {
  assert.throws(() => renderMessage({ msg: 'gossip', payload: { text: 'hello' } }))
  assert.throws(() => renderMessage({ msg: 'dispute', payload: { why: 'I disagree' } }))
})

// --- delivery --------------------------------------------------------------------------------

test('pending messages are the uncarried ones, oldest first', () => {
  const T = 'leaf-a/producer'
  const entries = logOf(
    message(T, 'findings', { findings: [{ id: 'F1', severity: 'blocker', claim: 'one' }] }, 'reviewer'),
    dispatched('d-1', T, []),
    message(T, 'brief_changed', { changed: 'two', brief: 'b2' }),
    dispatched('d-2', T, [1]),
    returned('d-2', 'done'),
    message(T, 'declined', { why: 'three' }, 'test-author'),
    message(T, 'tests_ready', { files: ['test/four.test.mjs'] }),
  )
  const pending = pendingMessages(entries, T)
  const expected = entries.filter((e) => e.kind === 'message' && e.seq !== 1)
  assert.deepEqual(pending.map((p) => p.seq), expected.map((e) => e.seq))
  for (const [i, p] of pending.entries()) {
    assert.equal(p.msg, expected[i].msg)
    assert.deepEqual(p.payload, expected[i].payload)
  }
  const ascending = pending.map((p) => p.seq).every((s, i, a) => i === 0 || a[i - 1] < s)
  assert.ok(ascending, 'oldest first')
  assert.deepEqual(pendingMessages([], T), [])
})

test("another thread's messages are not pending here", () => {
  const A = 'leaf-a/producer'
  const B = 'leaf-b/test'
  const entries = logOf(
    message(B, 'needs_tests', { text: 'b one' }, 'implementer'),
    message(A, 'declined', { why: 'a one' }, 'test-author'),
    message(B, 'tests_ready', { files: ['test/b.test.mjs'] }),
    dispatched('d-b', B, [1]),
    message(A, 'brief_changed', { changed: 'a two', brief: 'brief a' }),
  )
  assert.deepEqual(pendingMessages(entries, A).map((p) => p.seq),
    seqsOf(entries, (e) => e.kind === 'message' && e.thread === A))
  assert.deepEqual(pendingMessages(entries, B).map((p) => p.seq), [3])
  assert.deepEqual(pendingMessages(entries, 'leaf-c/none'), [])
  const plan = deliveryPlan(entries, A)
  assert.equal(plan.action, 'deliver')
  assert.deepEqual(plan.carries, seqsOf(entries, (e) => e.kind === 'message' && e.thread === A))
  assert.ok(!plan.prompt.includes('b one'))
})

test('pending messages are delivered together', () => {
  const T = 'leaf-a/test'
  const entries = logOf(
    message(T, 'needs_tests', { text: 'old request, delivered already' }, 'implementer'),
    dispatched('d-1', T, [1]),
    returned('d-1', 'done'),
    message(T, 'surviving_mutations', { mutations: [{ file: 'lib/kiwi.mjs', find: 'a', replace: 'b', expect_failing: ['kiwi once'] }] }),
    message('elsewhere', 'declined', { why: 'not for this thread' }, 'test-author'),
    message(T, 'findings', { findings: [{ id: 'F-9', severity: 'blocker', claim: 'kiwi twice' }] }, 'reviewer'),
    message(T, 'needs_tests', { text: 'pin the empty kiwi' }, 'implementer'),
  )
  const plan = deliveryPlan(entries, T)
  assert.equal(plan.action, 'deliver')
  const want = entries.filter((e) => e.kind === 'message' && e.thread === T && e.seq !== 1)
  assert.deepEqual(plan.carries, want.map((e) => e.seq), 'carries every pending seq, in order')
  assert.equal(typeof plan.prompt, 'string')
  for (const m of want) {
    assert.ok(plan.prompt.includes(renderMessage({ msg: m.msg, payload: m.payload })),
      `the prompt holds message ${m.seq} as rendered`)
  }
  assert.ok(!plan.prompt.includes('old request, delivered already'), 'a delivered message is not sent again')
  assert.ok(!plan.prompt.includes('not for this thread'))
})

test('an unreturned carrier is resumed, never sent again', () => {
  const T = 'leaf-a/producer'
  const entries = logOf(
    message(T, 'findings', { findings: [{ id: 'F1', severity: 'blocker', claim: 'one' }] }, 'reviewer'),
    message(T, 'brief_changed', { changed: 'two', brief: 'b2' }),
    dispatched('d-7', T, [1, 2]),
    message(T, 'tests_ready', { files: ['test/three.test.mjs'] }),
  )
  const plan = deliveryPlan(entries, T)
  assert.equal(plan.action, 'resume_carrier')
  assert.equal(plan.dispatch, 'd-7')
  assert.ok(plan.carries === undefined || plan.carries.length === 0, 'delivers nothing new')
  assert.equal(plan.prompt, undefined, 'sends no new prompt')
  assert.deepEqual(pendingMessages(entries, T).map((p) => p.seq), [4], 'the newer message waits')

  const quiet = entries.slice(0, 3)
  const quietPlan = deliveryPlan(quiet, T)
  assert.equal(quietPlan.action, 'resume_carrier', 'resumed even with nothing new waiting')
  assert.equal(quietPlan.dispatch, 'd-7')

  const otherThread = logOf(
    message('leaf-b/test', 'needs_tests', { text: 'b' }, 'implementer'),
    dispatched('d-b', 'leaf-b/test', [1]),
    message(T, 'declined', { why: 'a' }, 'test-author'),
  )
  assert.equal(deliveryPlan(otherThread, T).action, 'deliver', "another thread's carrier is not this one's")
})

test('a carrier cut off counts as delivered', () => {
  const T = 'leaf-a/producer'
  const base = logOf(
    message(T, 'findings', { findings: [{ id: 'F1', severity: 'blocker', claim: 'one' }] }, 'reviewer'),
    dispatched('d-1', T, [1]),
    returned('d-1', 'cut_off'),
  )
  assert.deepEqual(pendingMessages(base, T), [])
  assert.equal(deliveryPlan(base, T).action, 'none', 'nothing to resume, nothing to send')

  const later = logOf(...base.map(({ seq, ...rest }) => rest),
    message(T, 'declined', { why: 'two' }, 'test-author'))
  const plan = deliveryPlan(later, T)
  assert.equal(plan.action, 'deliver')
  assert.deepEqual(plan.carries, [4])
  assert.ok(!plan.prompt.includes('F1'), 'the cut-off carrier\'s message is not sent again')
})

test('nothing pending is nothing to do', () => {
  const T = 'leaf-a/producer'
  assert.equal(deliveryPlan([], T).action, 'none')
  const delivered = logOf(
    message(T, 'declined', { why: 'one' }, 'test-author'),
    dispatched('d-1', T, [1]),
    returned('d-1', 'done'),
    message('leaf-b/test', 'needs_tests', { text: 'b' }, 'implementer'),
  )
  assert.equal(deliveryPlan(delivered, T).action, 'none')
  assert.equal(deliveryPlan(delivered, 'leaf-c/idle').action, 'none')
})

test('a carried message is never pending again, whatever happened to its carrier', () => {
  const T = 'leaf-a/producer'
  const fates = [[], [returned('d-1', 'done')], [returned('d-1', 'blocked')],
    [returned('d-1', 'cut_off')], [returned('d-1', 'failed')], [returned('d-1', 'error')]]
  for (const fate of fates) {
    const label = fate.length ? fate[0].status : 'unreturned'
    const entries = logOf(
      message(T, 'needs_tests', { text: 'carried once' }, 'implementer'),
      dispatched('d-1', T, [1]),
      ...fate,
      message(T, 'declined', { why: 'later one' }, 'test-author'),
    )
    const pending = pendingMessages(entries, T).map((p) => p.seq)
    assert.ok(!pending.includes(1), `${label}: the carried message is not pending`)
    assert.deepEqual(pending, [entries.at(-1).seq], `${label}: the uncarried one is`)
    const plan = deliveryPlan(entries, T)
    assert.ok(!(plan.carries ?? []).includes(1), `${label}: never carried twice`)
    if (plan.prompt !== undefined) assert.ok(!plan.prompt.includes('carried once'), `${label}: not sent again`)
  }
})

test('the notes message hands a fresh session every note, one per line', () => {
  const text = renderMessage({ msg: 'notes', payload: { notes: ['started on hand/b at abc', 'mind the cache'] } })
  assert.ok(text.includes('- started on hand/b at abc'))
  assert.ok(text.includes('- mind the cache'))
  const lines = text.split('\n')
  assert.ok(lines.includes('- started on hand/b at abc') && lines.includes('- mind the cache'), 'each on a line of its own')
})
