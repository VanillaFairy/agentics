import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assembleBrief, measuresFor } from '../lib/brief.mjs'
import { writeGotcha } from '../lib/gotchas.mjs'
import { fnv1a } from '../lib/plan-digest.mjs'
import { briefPath, effortDir, reportPath } from '../lib/store.mjs'
import { addNodes, normalizeNode } from '../lib/tree.mjs'

const CLI = fileURLToPath(new URL('../lib/brief.mjs', import.meta.url))
const E = 'e1'
const X = '20260925-120000'

const criterion = (text, decisions = ['D1']) => ({ text, check: 'node --test test/parse.test.mjs', decisions })

function effort() {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-brief-'))
  const added = addNodes(repo, E, [
    { id: '.', kind: 'composite', title: 'Parse configs', intent: 'configs load from disk',
      defines: [{ id: 'D1', text: 'Keys are case-insensitive.' }, { id: 'D2', text: 'Unknown keys are an error.' }] },
    { id: 'api', kind: 'composite', title: 'The api layer', intent: 'the api reads configs', ground: ['src/api'] },
    { id: 'api/types', kind: 'leaf', title: 'Declare the config type', rigor: 'trivial', locus: ['src/api/types.js'],
      provides: [{ name: 'ConfigType', paths: ['src/api/types.js'] }], decisions: ['D2'],
      acceptance: [{ text: 'HUMAN: the type reads well', decisions: ['D2'] }] },
    { id: 'api/parse', kind: 'leaf', title: 'Parse keys', intent: 'keys parse case-insensitively', rigor: 'tdd',
      locus: ['src/api/parse.js', 'test/parse.test.mjs'], reads: ['src/api/types.js'], deps: ['api/types'],
      decisions: ['D1'], acceptance: [criterion('Key lookup ignores case')], context: 'Use the existing tokenizer.' },
  ], { by: 'session' })
  assert.equal(added.ok, true, JSON.stringify(added.problems))
  return repo
}

const pitfall = (trigger, roles, paths = []) => ({
  kind: 'pitfall', roles, paths, trigger, action: 'pass the flag',
  evidence: { command: 'node --test', output: 'boom' },
})

test('the brief carries decisions, criteria, contracts, context and ancestor intents, in order', () => {
  const repo = effort()
  const b = assembleBrief(repo, E, X, 'api/parse', {})
  assert.equal(b.path, briefPath(repo, E, X, 'api/parse', 'implementer', 1))
  assert.equal(readFileSync(b.path, 'utf8'), b.text)
  assert.equal(b.digest, fnv1a(b.text))
  assert.equal(b.bytes, Buffer.byteLength(b.text))

  const t = b.text
  assert.match(t, /^# Brief — api\/parse: Parse keys/)
  assert.match(t, /- role: implementer\n- round: 1\n- rigor: tdd/)
  assert.match(t, /each new test fails at the base and passes now/)
  assert.match(t, /review at integration/)
  assert.match(t, /- D1 \(defined at \.\): Keys are case-insensitive\./)
  assert.doesNotMatch(t, /Unknown keys are an error/)
  assert.match(t, /- Key lookup ignores case — check: `node --test test\/parse\.test\.mjs` \[D1\]/)
  assert.match(t, /- ConfigType \(from api\/types\): src\/api\/types\.js/)
  assert.match(t, /Use the existing tokenizer\./)
  assert.match(t, /- api — The api layer: the api reads configs\n- \. — Parse configs: configs load from disk/)
  assert.match(t, new RegExp('Report path: ' + reportPath(repo, E, X, 'api/parse', 'implementer', 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  for (const s of ['done', 'done_with_concerns', 'blocked', 'needs_context', 'decompose', 'unsplittable',
    'premise_mismatch', 'needs_decision', 'contract_changed']) assert.ok(t.includes('- `' + s + '`'), s)
  assert.match(t, /```agentics-gotchas```/)
  assert.doesNotMatch(t, /agentics-mutations/, 'an implementer declares no mutations')
  assert.doesNotMatch(t, /## Fix round/)

  const order = ['## Intent', '## Decisions realised', '## Acceptance criteria', '## Locus', '## Reads',
    '## Contracts', '## Context', '## Ancestor intents', '## Standing evidence', '## Gotchas', '## Report']
  const at = order.map((h) => t.indexOf(h))
  assert.ok(at.every((i, k) => i > 0 && (k === 0 || i > at[k - 1])), JSON.stringify(at))

  const types = assembleBrief(repo, E, X, 'api/types', {}).text
  assert.match(types, /HUMAN: the type reads well — routed to the user/)
  assert.match(types, /Provided:\n- ConfigType: src\/api\/types\.js/)
  assert.match(types, /a review loop of its own/)
})

test('gotchas reach the brief for its role and locus only', () => {
  const repo = effort()
  writeGotcha(repo, E, pitfall('for implementers in api', ['implementer'], ['src/api/']), {})
  writeGotcha(repo, E, pitfall('for implementers in docs', ['implementer'], ['docs/']), {})
  writeGotcha(repo, E, pitfall('for test authors', ['test-author']), {})
  writeGotcha(repo, E, pitfall('for everyone who implements', ['implementer', 'test-author']), {})

  const impl = assembleBrief(repo, E, X, 'api/parse', { role: 'implementer' }).text
  assert.match(impl, /When for implementers in api, do pass the flag\./)
  assert.match(impl, /When for everyone who implements/)
  assert.doesNotMatch(impl, /for implementers in docs/)
  assert.doesNotMatch(impl, /for test authors/)

  const tests = assembleBrief(repo, E, X, 'api/parse', { role: 'test-author' })
  assert.equal(tests.path, briefPath(repo, E, X, 'api/parse', 'test-author', 1))
  assert.match(tests.text, /When for test authors/)
  assert.doesNotMatch(tests.text, /for implementers in api/)
  assert.match(tests.text, /```agentics-mutations```/)
  assert.match(tests.text, /```agentics-commit```/)
})

test('a fix round lists the failures and open findings it must clear', () => {
  const repo = effort()
  const fix = [
    { source: 'verify', claim: 'suite failed', evidence: 'test/parse.test.mjs:12\nexpected 1' },
    { source: 'review', claim: 'F1: upper-case keys are dropped', evidence: 'src/api/parse.js:30' },
  ]
  const b = assembleBrief(repo, E, X, 'api/parse', { round: 2, fix })
  assert.equal(b.path, briefPath(repo, E, X, 'api/parse', 'implementer', 2))
  assert.match(b.text, /- round: 2/)
  assert.match(b.text, /## Fix round 2/)
  assert.match(b.text, /- \[verify\] suite failed\n {2}evidence: test\/parse\.test\.mjs:12 \/ expected 1/)
  assert.match(b.text, /- \[review\] F1: upper-case keys are dropped/)
  assert.ok(b.text.indexOf('## Fix round') < b.text.indexOf('## Report'))
})

test('survey verdicts whose topic ground meets the node ground or locus are excerpted, conclusions only', () => {
  const repo = effort()
  const dir = join(effortDir(repo, E), 'evidence')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '20260901-000000-survey.json'), JSON.stringify({
    question: 'q', ground: ['src'],
    topics: [{ key: 'parsing', find: 'x', kb_path: 'src/api' }, { key: 'ui', find: 'y', kb_path: 'src/ui' }],
    verdicts: [
      { topic: 'parsing', conclusion: 'The tokenizer already lower-cases.', evidence: [{ path: 'SECRET-EVIDENCE' }], risks: ['tabs are not trimmed'] },
      { topic: 'ui', conclusion: 'The UI never reads configs.', evidence: [], risks: [] },
    ],
    coverage: { complete: true },
  }))
  const t = assembleBrief(repo, E, X, 'api/parse', {}).text
  assert.match(t, /\[survey 20260901-000000, parsing\] The tokenizer already lower-cases\.\n {2}risks: tabs are not trimmed/)
  assert.doesNotMatch(t, /UI never reads configs/)
  assert.doesNotMatch(t, /SECRET-EVIDENCE/)
})

test('measuresFor names the yardstick per rigor and role', () => {
  const m = (extra) => measuresFor(normalizeNode({ kind: 'leaf', ...extra })).join(' | ')
  assert.match(m({ rigor: 'verify' }), /nothing is written/)
  assert.match(m({ rigor: 'tdd-pair', role: 'red' }), /fail now and fail at the base/)
  assert.match(m({ rigor: 'tdd-pair', role: 'green' }), /red leaf's tests pass now/)
  assert.match(m({ rigor: 'tdd-triad', role: 'audit' }), /no new tests are expected/)
  assert.match(m({ rigor: 'tests-only' }), /at least one declaration is required/)
})

test('an unknown node is refused', () => {
  const repo = effort()
  assert.throws(() => assembleBrief(repo, E, X, 'nope', {}), /no live node/)
})

test('fetch prints the brief only when the digest matches', () => {
  const repo = effort()
  const b = assembleBrief(repo, E, X, 'api/parse', {})
  const run = (...args) => spawnSync(process.execPath, [CLI, 'fetch', ...args], { encoding: 'utf8' })

  const ok = run('--path', b.path, '--digest', b.digest)
  assert.equal(ok.status, 0)
  assert.equal(ok.stdout, b.text)

  const wrong = run('--path', b.path, '--digest', '0badc0de')
  assert.equal(wrong.status, 1)
  assert.match(wrong.stdout, /^REFUSED: .* digests to [0-9a-f]{8}, not "0badc0de"/)
  assert.doesNotMatch(wrong.stdout, /## Intent/)

  assert.equal(run('--path', b.path).status, 1)
  const missing = run('--path', b.path + '.gone', '--digest', b.digest)
  assert.equal(missing.status, 1)
  assert.match(missing.stdout, /^REFUSED: .* could not be read/)
})
