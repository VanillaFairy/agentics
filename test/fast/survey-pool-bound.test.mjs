// test/fast/survey-pool-bound.test.mjs — pins that what a survey's briefs hold of the evidence pool is
// sized by the code that builds it: a pool past the bound is held to it, the items nearest the
// question in full and the rest by topic, and stale candidates past theirs keep their keys.
//
// Design: docs/DESIGN.md#survey, docs/DESIGN.md#the-agent-runner.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { JUDGE_KNOWN_BYTES, PLAN_KNOWN_BYTES, judgeBrief, planBrief, topicFind } from '../../lib/briefs/survey.mjs'
import { knownText, poolText } from '../../lib/evidence.mjs'
import { briefFits } from '../../lib/programs/common.mjs'
import { PART_BYTES } from '../../lib/roles.mjs'

const bytes = (text) => Buffer.byteLength(text, 'utf8')
const QUESTION = 'How does the portrait row place its widgets?'
const BASE = { question: QUESTION, roots: ['.'], maxTopics: 8 }
const FILLER = 'the cache keeps what the resolver walked, and nothing here reads it twice. '.repeat(3)
const item = (n, over = {}) => ({
  id: 'I' + String(n).padStart(7, '0'), seq: n, topic: 'topic-' + (n % 40), kind: 'behaviour', state: 'standing',
  claim: 'CLAIM-' + n + ' ' + FILLER, spans: [{ path: 'src/f' + n + '.mjs', start: n, end: n + 2 }], ...over,
})
/** A pool whose text alone is past what one part of a brief may hold. */
const bigPool = () => {
  const items = Array.from({ length: 600 }, (_, i) => item(i + 1))
  assert.ok(bytes(poolText(items)) > PART_BYTES, 'the pool alone overflows a part')
  return items
}
const TOPIC = { key: 'loader', subtree: 'src', find: 'FIND-loader', search: { status: 'done', why: '' }, held: 0, of: 0, excerpts: '' }

test("a pool past a part's budget still yields a plan brief and a judge brief an analyst may be sent", () => {
  const items = bigPool()
  assert.equal(briefFits('analyst', planBrief({ ...BASE, known: poolText(items) })), false, 'unbounded, the planner is refused')
  const plan = knownText(items, QUESTION, PLAN_KNOWN_BYTES)
  const judge = knownText(items, QUESTION, JUDGE_KNOWN_BYTES)
  assert.ok(bytes(plan.text) <= PLAN_KNOWN_BYTES && bytes(judge.text) <= JUDGE_KNOWN_BYTES)
  assert.equal(briefFits('analyst', planBrief({ ...BASE, known: plan.text })), true)
  assert.equal(briefFits('analyst', judgeBrief({ question: QUESTION, topics: [TOPIC], known: judge.text })), true)
})

test('a bounded pool shows whole items and accounts for every item it leaves out, by topic', () => {
  const items = bigPool()
  const { text, shown } = knownText(items, QUESTION, PLAN_KNOWN_BYTES)
  const full = text.split('\n').filter((l) => l.startsWith('- [I'))
  assert.equal(full.length, shown)
  assert.ok(shown > 0 && shown < items.length)
  for (const line of full) assert.ok(line.includes(FILLER.trim()) && /\.mjs:\d+-\d+$/.test(line), 'no item is cut: ' + line)
  const counted = [...text.split('NOT SHOWN')[1].matchAll(/^- topic-\d+: (\d+)$/gm)].reduce((n, m) => n + Number(m[1]), 0)
  assert.equal(shown + counted, items.length)
})

test("the items kept in full are the ones nearest the question's words, wherever the pool holds them", () => {
  const near = item(9001, { seq: 0, claim: 'NEAR-1 the portrait widgets are placed by the row layout' })
  const { text } = knownText([...bigPool(), near], QUESTION, JUDGE_KNOWN_BYTES)
  assert.ok(text.split('NOT SHOWN')[0].includes('NEAR-1'), 'the oldest item, last in the pool, is shown for its words')
})

test('a pool within the bound is handed over whole, as the pool reads', () => {
  const items = [item(1), item(2)]
  assert.deepEqual(knownText(items, QUESTION, PLAN_KNOWN_BYTES), { text: poolText(items), shown: 2 })
  assert.deepEqual(knownText([], QUESTION, PLAN_KNOWN_BYTES), { text: '', shown: 0 })
})

test('stale candidates past their bound keep every key the planner may adopt, and the brief still fits', () => {
  const used = Array.from({ length: 12 }, (_, i) => item(i + 1))
  const stale = Array.from({ length: 80 }, (_, i) => ({ key: 'stale-' + (i + 1), subtree: 'src', used }))
  const brief = planBrief({ ...BASE, stale, known: knownText(bigPool(), QUESTION, PLAN_KNOWN_BYTES).text })
  assert.equal(briefFits('analyst', brief), true)
  for (const c of stale) assert.ok(brief.includes(c.key), c.key)
  assert.match(brief, /left out to fit this brief, what \d+ more candidates claimed; their keys: /)
})

test("a topic searched again carries its old claims within a bound, the rest counted", () => {
  const used = Array.from({ length: 200 }, (_, i) => item(i + 1))
  const find = topicFind({ key: 'cache', find: 'FIND-cache', subtree: 'src', again: true, used })
  assert.ok(bytes(find) < PART_BYTES / 8, String(bytes(find)))
  const shown = find.split('\n').filter((l) => l.startsWith('- CLAIM-')).length
  assert.ok(find.includes('- (' + (used.length - shown) + ' more claims of it, not shown)'), find.slice(-200))
})
