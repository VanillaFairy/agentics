// test/fast/survey-shared-ground.test.mjs — what a survey hands its readers so they read less: the
// common ground's lines read once by code, the context's digest, and the plan's brief on what the
// asking session already read and the stale topics it may adopt.
//
// Design: docs/DESIGN.md#survey.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planBrief, topicFind } from '../../lib/briefs/survey.mjs'
import { rangeExcerpts } from '../../lib/citations.mjs'
import { DIGEST_BYTES, digestOf } from '../../lib/evidence.mjs'

const lines = (word, n) => Array.from({ length: n }, (_, i) => `${word} line ${i + 1}`).join('\n') + '\n'

function tree(t) {
  const root = mkdtempSync(join(tmpdir(), 'agentics-ground-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'a.mjs'), lines('alpha', 30))
  writeFileSync(join(root, 'src', 'b.mjs'), lines('beta', 4))
  return root
}

// ------------------------------------------------------------------ the common ground

test('a named range is read once, numbered, under its path and length', (t) => {
  const text = rangeExcerpts(tree(t), [{ path: 'src/a.mjs', start: 3, end: 5 }])
  assert.ok(text.startsWith('### src/a.mjs:3-5 (of '), text)
  for (const n of [3, 4, 5]) assert.match(text, new RegExp(`\\b${n}\\talpha line ${n}$`, 'm'))
  for (const n of [2, 6]) assert.doesNotMatch(text, new RegExp(`alpha line ${n}$`, 'm'))
})

test('overlapping ranges of one file merge, and a path alone is the whole file', (t) => {
  const text = rangeExcerpts(tree(t), [{ path: 'src/a.mjs', start: 3, end: 6 }, { path: 'src/a.mjs', start: 5, end: 8 }, { path: 'src/b.mjs' }])
  assert.equal(text.match(/^### src\/a\.mjs/gm).length, 1, text)
  assert.ok(text.includes('### src/a.mjs:3-8'), text)
  for (const n of [1, 4]) assert.match(text, new RegExp(`beta line ${n}$`, 'm'))
})

test('what cannot be read is named, never dropped', (t) => {
  const text = rangeExcerpts(tree(t), [{ path: 'src/gone.mjs' }, { path: 'src/b.mjs', start: 40, end: 41 }, { path: '../outside.mjs' }])
  for (const part of ['src/gone.mjs is not a file', 'so no line 40', '"../outside.mjs" is not a path inside']) assert.ok(text.includes(part), part)
})

// ------------------------------------------------------------------ the digest

const item = (topic, claim, state = 'standing') => ({ topic, claim, state, spans: [{ path: 'src/' + topic + '.mjs', start: 4, end: 4 }] })

test('the digest holds every topic in the plan order, then any other, each with its counts', () => {
  const items = [item('cache', 'the cache keeps results'), item('loader', 'the loader resolves', 'suspect'), item('old', 'an earlier claim')]
  const text = digestOf(items, [{ topic: 'loader', text: 'may race' }], ['loader', 'cache'])
  const at = (s) => text.indexOf(s)
  assert.ok(at('## loader') < at('## cache') && at('## cache') < at('## old'), text)
  assert.ok(text.includes('## loader — 1 item, 1 not standing, 1 risk'), text)
  assert.ok(text.includes('- the cache keeps results [src/cache.mjs:4]'), text)
})

test('a digest of more claims than it holds stays within its bytes, every topic in it and every omission counted', () => {
  const topics = ['one', 'two', 'three']
  const items = topics.flatMap((t) => Array.from({ length: 200 }, (_, i) => item(t, `${t} claim ${i} — ${'é'.repeat(40)}`)))
  const text = digestOf(items, [], topics)
  assert.ok(Buffer.byteLength(text) <= DIGEST_BYTES, String(Buffer.byteLength(text)))
  for (const t of topics) {
    const shown = text.split('\n').filter((l) => l.startsWith(`- ${t} claim`)).length
    assert.ok(text.includes(`- … ${200 - shown} more under [${t}] below`), t)
  }
})

test('no items and no risks give no digest', () => {
  assert.equal(digestOf([], [], ['loader']), '')
})

// ------------------------------------------------------------------ the plan's brief

const BASE = { question: 'How does the loader resolve?', roots: ['.'], maxTopics: 8 }

test('what the asking session already read reaches the planner as ground to plan around', () => {
  const brief = planBrief({ ...BASE, read: 'READ-5e1 src/loader.mjs: resolve() walks the roots' })
  assert.ok(brief.includes('ALREADY READ'), brief)
  assert.ok(brief.includes('READ-5e1 src/loader.mjs: resolve() walks the roots'), brief)
  assert.ok(!planBrief(BASE).includes('ALREADY READ'))
})

test('a stale topic is a candidate the planner adopts by its key, with what it claimed', () => {
  const used = [{ claim: 'STALE-9 the cache never expires', spans: [{ path: 'src/cache.mjs', start: 3, end: 5 }] }]
  const brief = planBrief({ ...BASE, stale: [{ key: 'cache', subtree: 'src/cache', used }] })
  for (const part of ['STALE CANDIDATES', 'under its exact key', '- cache (src/cache):', 'STALE-9 the cache never expires (src/cache.mjs:3-5)']) assert.ok(brief.includes(part), part)
  assert.ok(!planBrief(BASE).includes('STALE CANDIDATES'))
})

test("an adopted stale topic's find is the plan's, then what it used to claim", () => {
  const used = [{ claim: 'STALE-9 the cache never expires', spans: [] }]
  const find = topicFind({ key: 'cache', find: 'FIND-what the cache keeps', subtree: 'src/cache', again: true, used })
  assert.ok(find.startsWith('FIND-what the cache keeps'), find)
  assert.ok(find.includes('STALE-9 the cache never expires'), find)
  assert.equal(topicFind({ key: 'cache', find: 'FIND-plain', subtree: '', again: false }), 'FIND-plain')
})
