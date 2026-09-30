// test/usage.test.mjs — what an execution's agents spent, read from the host's transcripts.
//
// What is pinned here:
//
//   transcript  one count per API message (the host writes a message once per content block, and
//               only the last copy carries its output), split by the model that answered
//   price       dollars from the four usage kinds at the model's rates; no price is null, never 0
//   collect     the runs of one execution are found by their preflight command, every agent in
//               them is recorded under its label, and a second collect appends only what changed
//
// Design: docs/DESIGN.md#self-checks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readLog } from '../lib/ledger.mjs'
import { PRICES, collectUsage, tokensOf, usageOfTranscript, usdOf } from '../lib/usage.mjs'

const fresh = (name) => mkdtempSync(join(tmpdir(), 'agentics-usage-' + name + '-')).split('\\').join('/')

const E = 'eff'
const X = '20200101-000000'

const user = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
const assistant = (id, model, usage) => JSON.stringify({ type: 'assistant', message: { id, model, usage } })
const usage = (input, write5m, write1h, read, output) => ({
  input_tokens: input,
  cache_creation_input_tokens: write5m + write1h,
  cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h },
  cache_read_input_tokens: read,
  output_tokens: output,
})
const counts = (input, cache_write_5m, cache_write_1h, cache_read, output) => ({ input, cache_write_5m, cache_write_1h, cache_read, output })

test('a message written once per content block is counted once, at its last copy', () => {
  const text = [
    user('go'),
    assistant('m1', 'claude-sonnet-5', usage(10, 100, 0, 0, 1)),
    assistant('m1', 'claude-sonnet-5', usage(10, 100, 0, 0, 40)),
    'not json',
    assistant('m2', 'claude-sonnet-5', usage(5, 0, 20, 300, 7)),
    assistant('m3', 'claude-haiku-4-5-20251001', usage(1, 0, 0, 0, 2)),
  ].join('\n')

  assert.deepEqual(usageOfTranscript(text), {
    'claude-sonnet-5': counts(15, 100, 20, 300, 47),
    'claude-haiku-4-5': counts(1, 0, 0, 0, 2),
  })
})

test('a message that spent nothing names no model', () => {
  assert.deepEqual(usageOfTranscript(assistant('m1', '<synthetic>', usage(0, 0, 0, 0, 0))), {})
})

test('dollars come from the model\'s own rates, and an unknown model has no price', () => {
  const c = counts(1e6, 1e6, 1e6, 1e6, 1e6)
  for (const [model, p] of Object.entries(PRICES)) {
    assert.equal(usdOf(model, c), p.input + p.input * 1.25 + p.input * 2 + p.cache_read + p.output, model)
  }
  assert.equal(usdOf('claude-next', c), null)
  assert.equal(tokensOf(c), 5e6)
})

/** One workflow run's folder under a fake transcripts root, holding the agents given. */
function runDir(root, name, agents) {
  const dir = join(root, 'proj', 'session', 'subagents', 'workflows', name)
  mkdirSync(dir, { recursive: true })
  for (const [id, label, lines] of agents) {
    writeFileSync(join(dir, 'agent-' + id + '.meta.json'), JSON.stringify({ description: label }))
    writeFileSync(join(dir, 'agent-' + id + '.jsonl'), lines.join('\n') + '\n')
  }
  return dir
}

const preflight = (effort, execution) =>
  user('run node "/p/lib/boundary.mjs" preflight --repo "." --effort "' + effort + '" --execution "' + execution + '" --digest 0 --b64 e30=')

test('collect records every agent of the execution\'s runs, and only what changed since', () => {
  const repo = fresh('repo')
  const root = fresh('root')
  const dir = runDir(root, 'wf_1', [
    ['a1', 'preflight', [preflight(E, X), assistant('m1', 'claude-haiku-4-5-20251001', usage(1, 2, 0, 3, 4))]],
    ['a2', 'implementer:x#1', [user('build x'), assistant('m2', 'claude-sonnet-5', usage(10, 0, 0, 0, 5))]],
  ])
  runDir(root, 'wf_other', [
    ['b1', 'preflight', [preflight(E, '20200101-000001'), assistant('m3', 'claude-sonnet-5', usage(9, 9, 9, 9, 9))]],
  ])
  runDir(root, 'wf_retry', [
    ['c1', 'preflight', [user('go')]],
    ['c2', 'preflight#2', [user('the request the host relays first'), preflight(E, X), assistant('m4', 'claude-haiku-4-5-20251001', usage(1, 0, 0, 0, 1))]],
  ])

  assert.deepEqual(collectUsage(repo, E, X, { root }), { runs: 2, agents: 4, appended: 3 })
  const lines = () => readLog(repo, E, 'state:' + X).entries.filter((e) => e.kind === 'usage')
  assert.deepEqual(lines().map((l) => [l.agent, l.label, l.models]).sort(), [
    ['a1', 'preflight', { 'claude-haiku-4-5': counts(1, 2, 0, 3, 4) }],
    ['a2', 'implementer:x#1', { 'claude-sonnet-5': counts(10, 0, 0, 0, 5) }],
    ['c2', 'preflight#2', { 'claude-haiku-4-5': counts(1, 0, 0, 0, 1) }],
  ])

  assert.equal(collectUsage(repo, E, X, { root }).appended, 0, 'nothing moved, nothing written')

  writeFileSync(join(dir, 'agent-a2.jsonl'),
    [user('build x'), assistant('m2', 'claude-sonnet-5', usage(10, 0, 0, 0, 5)), assistant('m5', 'claude-sonnet-5', usage(1, 0, 0, 15, 2))].join('\n'))
  assert.equal(collectUsage(repo, E, X, { root }).appended, 1)
  assert.deepEqual(lines().filter((l) => l.agent === 'a2').pop().models, { 'claude-sonnet-5': counts(11, 0, 0, 15, 7) })
})

test('no transcripts is nothing collected, not an error', () => {
  assert.deepEqual(collectUsage(fresh('repo'), E, X, { root: join(fresh('root'), 'absent') }), { runs: 0, agents: 0, appended: 0 })
})
