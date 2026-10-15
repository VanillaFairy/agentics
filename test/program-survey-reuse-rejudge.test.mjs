// test/program-survey-reuse-rejudge.test.mjs — pins how the survey reuses the evidence pool: the
// re-judge of suspect items on the cheapest tier, twenty to a call, and what it does with an item
// that holds, one that fails, an id it left unruled and a failed re-judge.
//
// The pool, the scripts and the surveys the parts share are in test/harness/survey-reuse-world.mjs.
//
// Design: docs/DESIGN.md#survey, docs/DESIGN.md#the-drift-ladder.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { survey } from '../lib/programs/survey.mjs'
import { schemaOf } from '../lib/schemas.mjs'
import { programRig } from './harness/program-rig.mjs'
import {
  GUIDE, FILES, EDIT, seedItem, seed, editLine, stateOf, LOADER, rule, rulings, script, ARGS, on,
  judgedLines, topicTriples, cov, SUSPECT,
} from './harness/survey-reuse-world.mjs'

/** A line of a file as a brief shows it, not mistaken for a longer line number. */
const lineRe = (word, n) => new RegExp(`${word} line ${n}(?!\\d)`)

// --- the re-judge -----------------------------------------------------------------------------

/** One suspect item of `topic` over src, edited at line 11, re-judged by `steps`. */
async function rejudged(t, { topic, steps, planned = [], searched = planned.map((x) => x.key), over = {} }) {
  const base = programRig({ files: FILES })
  t.after(() => base.cleanup())
  const [id] = seed(base.repo, [seedItem({ topic, claim: SUSPECT })])
  editLine(base.repo, 11, EDIT)
  assert.equal(stateOf(base.repo, id), 'suspect')
  const rig = base.relaunch({ 'analyst||rejudge:1': steps(id), ...script({ planned, searched }) })
  const result = await survey(rig.ctx, ARGS(over))
  return { rig, result, id }
}

test('a suspect item is re-judged on the cheapest tier whatever the dial, its claim and changed text inline', async (t) => {
  for (const intelligence of ['low', 'normal', 'max']) {
    const { rig, id } = await rejudged(t, { topic: 'old', steps: (id) => rulings([rule(id, 'holds')]), over: { intelligence } })
    const calls = on(rig, 'rejudge:1')
    assert.equal(calls.length, 1, intelligence)
    assert.equal(calls[0].role.name, 'analyst')
    assert.deepEqual(calls[0].schema, schemaOf('rejudge'))
    assert.deepEqual(calls[0].tier, { model: 'haiku', effort: 'low' }, intelligence)
    const brief = calls[0].brief
    assert.ok(brief.includes(id), intelligence + ': the id')
    assert.ok(brief.includes(SUSPECT), intelligence + ': the claim')
    assert.match(brief, lineRe('alpha', 11), intelligence + ': the old text')
    assert.ok(brief.includes(EDIT), intelligence + ': the new text')
    assert.ok(brief.includes(GUIDE), intelligence + ': the guidance')
  }
})

test('suspect items are re-judged twenty to a call', async (t) => {
  const claims = Array.from({ length: 21 }, (_, i) => `SUSPECT-${String(i).padStart(2, '0')} the loader reads line eleven`)
  const base = programRig({ files: FILES })
  t.after(() => base.cleanup())
  const ids = seed(base.repo, claims.map((claim) => seedItem({ topic: 'held', claim })))
  editLine(base.repo, 11, EDIT)
  const sorted = [...ids].sort()
  const first = sorted.slice(0, 20)
  const last = sorted[20]
  const rig = base.relaunch({
    'analyst||rejudge:1': rulings(first.map((id) => rule(id, 'holds'))),
    'analyst||rejudge:2': rulings([rule(last, 'holds')]),
    ...script({ planned: [] }),
  })
  const result = await survey(rig.ctx, ARGS())
  const [one, two] = [on(rig, 'rejudge:1'), on(rig, 'rejudge:2')]
  assert.equal(one.length, 1)
  assert.equal(two.length, 1)
  for (const id of first) {
    assert.ok(one[0].brief.includes(id), 'rejudge:1 holds ' + id)
    assert.ok(!two[0].brief.includes(id), 'rejudge:2 does not hold ' + id)
  }
  assert.ok(two[0].brief.includes(last), 'rejudge:2 holds the 21st')
  assert.ok(!one[0].brief.includes(last), 'rejudge:1 does not hold the 21st')
  assert.deepEqual([...result.reused].sort(), sorted)
})

test('a re-judged item that holds is known ground', async (t) => {
  const { rig, result, id } = await rejudged(t, { topic: 'held', steps: (id) => rulings([rule(id, 'holds')]), planned: [LOADER] })
  assert.ok(result.reused.includes(id))
  const lines = judgedLines(rig.repo, id)
  assert.equal(lines.length, 1, JSON.stringify(lines))
  assert.equal(lines[0].ruling, 'holds')
  assert.equal(on(rig, 'scout:held').length, 0)
})

test('a re-judged item that fails is searched again', async (t) => {
  const { rig, result, id } = await rejudged(t, { topic: 'loader', steps: (id) => rulings([rule(id, 'fails')]), searched: ['loader'] })
  assert.ok(!result.reused.includes(id))
  assert.deepEqual(topicTriples(result), [{ key: 'loader', subtree: 'src', forced: true }])
  assert.equal(on(rig, 'scout:loader').length, 2, 'its turn and the stall the ruler ends it on')
})

test('an id the re-judge left unruled is unsure, and its topic searched again', async (t) => {
  const { rig, result, id } = await rejudged(t, { topic: 'loader', steps: () => rulings([]), searched: ['loader'] })
  const lines = judgedLines(rig.repo, id)
  assert.equal(lines.length, 1, JSON.stringify(lines))
  assert.equal(lines[0].ruling, 'unsure')
  assert.equal(on(rig, 'scout:loader').length, 2, 'its turn and the stall the ruler ends it on')
  assert.ok(!result.reused.includes(id))
})

test("a failed re-judge records nothing, and its items' topics are searched again", async (t) => {
  const { rig, result } = await rejudged(t, { topic: 'loader', steps: () => [{ status: 'failed', cause: 'host_error' }], searched: ['loader'] })
  assert.equal(on(rig, 'rejudge:1').length, 1)
  assert.deepEqual(judgedLines(rig.repo), [])
  assert.equal(on(rig, 'scout:loader').length, 2, 'its turn and the stall the ruler ends it on')
  assert.equal(cov(result).complete, true, JSON.stringify(cov(result)))
})
