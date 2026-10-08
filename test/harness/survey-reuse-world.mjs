// test/harness/survey-reuse-world.mjs — what the program-survey-reuse-* tests share: a repository with
// an evidence pool, the scripted answers of the survey's planner, scouts and judges, and the survey
// run over them. Nothing here runs at import.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { itemsFor, recordItems } from '../../lib/evidence.mjs'
import { readProjectLog } from '../../lib/ledger.mjs'

// --- the world --------------------------------------------------------------------------------

const Q = 'How does the loader resolve a module path?'
const OLD_Q = 'An earlier question about the loader?'
export const GUIDE = 'GUIDE-7f3a: name every loader path you cite.'
export const A = 'src/a.js'
export const lines = (word, n) => Array.from({ length: n }, (_, i) => `${word} line ${i + 1}`).join('\n') + '\n'
export const FILES = {
  'CLAUDE.md': '# Project\n\n' + GUIDE + '\n',
  [A]: lines('alpha', 40),
  'lib/b.js': lines('beta', 20),
}
export const EDIT = 'EDITED-9f1 line 11'

const SEED = '20250101-000000-survey'

export const seedItem = ({ topic, claim, ground = ['src'], start = 10, end = 12 }) =>
  ({ question: OLD_Q, topic, ground, kind: 'behaviour', claim, spans: [{ path: A, start, end }], queries: [], sources: [], rests_on: [] })
export function seed(repo, items, name = SEED) {
  const out = recordItems(repo, name, items)
  assert.equal(out.ok, true, JSON.stringify(out))
  return out.ids
}
/** Edit one line of src/a.js in a working tree, uncommitted. */
export const editLine = (base, n, text) => writeFileSync(join(base, 'src', 'a.js'), FILES[A].replace(new RegExp(`^alpha line ${n}$`, 'm'), text))

export const stateOf = (repo, id) => (itemsFor(repo, { ground: ['src'], states: ['standing', 'suspect', 'stale'] }).find((it) => it.id === id) || {}).state

// --- scripts ----------------------------------------------------------------------------------

export const LOADER = { key: 'loader', find: 'FIND-loader where a module path resolves', subtree: 'src' }
const plan = (topics = [LOADER]) => ({ topics, common_ground: '', history_question: '', docs_question: '' })
const scoutOut = (line) => ({ hits: [{ path: A, line, note: 'seen at ' + A + ':' + line }], searched: ['src'], no_match: '', not_reached: '', stop_reason: 'exhausted' })
export const newClaim = (key) => 'NEW-' + key + ' claim from this run'
const newItem = (key, line) => ({ topic: key, kind: 'behaviour', claim: newClaim(key), spans: [{ path: A, start: line, end: line }], queries: [], sources: [], rests_on: [] })
const anchoredUnit = (key) => ({ unit: key, ruling: 'anchored', ids: [], why: 'every claim is anchored' })
export const rule = (id, ruling) => ({ id, ruling, why: 'WHY-' + ruling })
export const rulings = (list) => [{ output: { rulings: list } }]

/**
 * The plan returns `planned`; `searched` lists every topic key expected to be scouted (planned or
 * forced), each scouted at its own line and given one item by the one judge.
 */
export function script({ planned = [LOADER], searched = planned.map((t) => t.key), extra = {} } = {}) {
  const s = { 'analyst||plan': [{ output: plan(planned) }], ...extra }
  searched.forEach((key, i) => { s['scout||scout:' + key] = [{ output: scoutOut(3 + i) }] })
  if (searched.length > 0) {
    s['analyst||judge:1'] = [{
      output: { items: searched.map((key, i) => newItem(key, 3 + i)), risks: [], units: searched.map(anchoredUnit) },
    }]
  }
  return s
}

export const ARGS = (over = {}) => ({
  question: Q, roots: ['src'], notes: '', prior: '', max_topics: 8, intelligence: 'normal', pace: 'balanced', ground: ['src'], ...over,
})

export const on = (rig, thread) => rig.calls.filter((c) => c.thread.key === thread)

export const judgedLines = (repo, id) => readProjectLog(repo, 'items').entries.filter((e) => e.kind === 'judged' && (id === undefined || e.id === id))

export const topicTriples = (result) => result.topics.map(({ key, subtree, forced }) => ({ key, subtree, forced }))
export const cov = (result) => result.coverage

export const SUSPECT = 'SUSPECT-a77 the loader reads line eleven'
