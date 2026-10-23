// test/fast/briefs-execute.test.mjs — pins the prompts the execute program builds: each carries what its
// agent rules or writes from inline, and the same input gives the same text.
//
// Design: docs/DESIGN.md#briefs-and-returns.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  driftBrief, integrationBrief, integrationRerule, investigatorBrief, plannerBrief, reviewerBrief, staleBrief,
} from '../../lib/briefs/execute.mjs'
import { normalizeNode } from '../../lib/tree.mjs'

const leaf = (extra = {}) => normalizeNode({
  id: 'api/parse', kind: 'leaf', title: 'Parse keys', rigor: 'tdd', expects: ['src/api/parse.js'],
  acceptance: [{ text: 'Key lookup ignores case', check: 'node --test test/parse.test.mjs', decisions: ['D1'] }], ...extra,
})

const review = (extra = {}) => ({
  leaf: leaf(),
  brief: '## Task\n\napi/parse — Parse keys\n',
  span: { base: 'b0b0b0b', head: 'c1c1c1c' },
  producer: { status: 'done_with_concerns', concerns: ['the tokenizer may drop unicode keys'], text: 'Parsed keys through the tokenizer.' },
  units: ['criterion:1', 'file:src/api/parse.js'],
  prior: [],
  ...extra,
})

const blocker = { id: 'F1', severity: 'critical', claim: 'upper-case keys are dropped', evidence: 'src/api/parse.js:30', failure_scenario: 'a key "A" reads as missing', remedy: 'code' }

const rerule = (extra = {}) => ({
  folder: { id: 'api', title: 'The api layer', worktree: '/wt/api' },
  spec: '# The api layer\n\n## Intent\n\nConfigs load from disk, case blind.\n',
  diff: '@@ -3,3 +3,3 @@\n-Configs load from disk.\n+Configs load from disk, case blind.',
  prior: [
    { claim: 'configs load', ruling: 'met' }, { claim: 'keys are cased', ruling: 'under' },
    { claim: 'parse is named read', ruling: 'equivalent' }, { claim: 'errors are typed', ruling: 'cant_tell' },
    { claim: 'the key is shorter', ruling: 'accepted' },
  ],
  span: { base: 'a0a0a0a', head: 'd4d4d4d' },
  guidance: '',
  ...extra,
})

const integration = (extra = {}) => ({
  folder: { id: 'api', title: 'The api layer', worktree: '/wt/api' },
  spec: '# The api layer\n\n## Intent\n\nConfigs load from disk.\n',
  units: ['file:src/api/parse.js', 'file:src/api/types.js'],
  span: { base: 'a0a0a0a', head: 'd4d4d4d' },
  caveat: '',
  guidance: '',
  ...extra,
})

const consumer = normalizeNode({
  id: 'api/load', kind: 'leaf', title: 'Load configs', intent: 'configs load through the parser', rigor: 'tdd',
  expects: ['src/api/load.js'], reads: ['src/api/parse.js'], consumes: [{ name: 'Parser', paths: ['src/api/parse.js'] }],
  acceptance: [{ text: 'A config file loads', check: 'node --test test/load.test.mjs', decisions: [] }], context: 'Call parse once per file.',
})
const other = normalizeNode({ id: 'ui/show', kind: 'leaf', title: 'Show configs', rigor: 'trivial', expects: ['src/ui/show.js'] })

const drift = (extra = {}) => ({
  target: 'agentics/e1/api',
  records: [
    { node: 'api/load', contract: 'Parser', files: ['src/api/parse.js'], entry: consumer },
    { node: 'api/load', contract: 'Types', files: ['src/api/types.js'], entry: consumer },
    { node: 'ui/show', contract: 'Types', files: ['src/api/types.js'], entry: other },
  ],
  diffs: { 'api/load': '--- a/src/api/parse.js\n+++ b/src/api/parse.js\n-old parse\n+new parse\n', 'ui/show': '-old types\n+new types\n' },
  ...extra,
})

const stale = (extra = {}) => ({
  nodes: [
    { node: 'api/load', anchor: '1111111', writes: ['src/api/load.js'], reads: [], entry: consumer },
    { node: 'ui/show', anchor: '2222222', writes: [], reads: ['src/api/types.js'], entry: other },
  ],
  base_now: '9999999',
  diffs: { 'api/load': '-load before\n+load after\n', 'ui/show': '-types before\n+types after\n' },
  ...extra,
})

const planner = (extra = {}) => ({
  folder: { id: 'api', title: 'The api layer', intent: 'the api reads configs', spec_path: '/repo/.agentics/e1/api/DESIGN.md', why: 'a fresh sub-effort' },
  mode: 'write',
  spec: '',
  decisions: [{ id: 'D1', text: 'Keys are case-insensitive.' }, { id: 'D2', text: 'Unknown keys are an error.' }],
  findings: [],
  request: null,
  guidance: '',
  ...extra,
})

const probeFinding = (id, severity, section, claim) => ({ id, axis: 'completeness', severity, section, claim, evidence: '@12 "the loader"', start: 12, end: 12 })

const known = (extra = {}) => ({
  build: 'npm run build', typecheck: '', suite: '', suite_fast: '', test_one: '',
  absent: { build: false, typecheck: true, suite: false, suite_fast: false }, ...extra,
})

// ------------------------------------------------------------------ reviewerBrief

test("the reviewer brief carries the leaf's brief and the span to read", () => {
  const text = reviewerBrief(review())
  assert.ok(text.includes('## Task\n\napi/parse — Parse keys'), 'the leaf brief, inline')
  assert.ok(text.includes('git log --reverse -p b0b0b0b..c1c1c1c'))
  assert.ok(text.includes('git diff b0b0b0b c1c1c1c'))
})

test("the producer's concerns come before the rest of its return", () => {
  const text = reviewerBrief(review())
  const concern = text.indexOf('the tokenizer may drop unicode keys')
  assert.ok(concern >= 0)
  assert.ok(text.includes('done_with_concerns'))
  assert.ok(concern < text.indexOf('Parsed keys through the tokenizer.'), 'concerns first')
})

test('a producer with no concerns says so', () => {
  const text = reviewerBrief(review({ producer: { status: 'done', concerns: [], text: 'Done.' } }))
  assert.ok(text.includes('Concerns: (none)'))
  assert.ok(text.includes('Done.'))
})

test('every unit the reviewer rules is listed under its name', () => {
  const units = ['criterion:1', 'criterion:2', 'file:src/api/parse.js', 'approved-case:test/parse.test.mjs#keys ignore case']
  const text = reviewerBrief(review({ units }))
  for (const u of units) assert.ok(text.includes('\n- ' + u + '\n') || text.endsWith('\n- ' + u), u)
})

test("each of the prior round's open blockers is listed by its id, to rule in fix_rulings", () => {
  const second = { ...blocker, id: 'F2', severity: 'major', claim: 'the error names no key' }
  const text = reviewerBrief(review({ prior: [blocker, second] }))
  assert.ok(text.includes('fix_rulings'))
  for (const f of [blocker, second]) assert.ok(text.includes('[' + f.id + '] (' + f.severity + ') ' + f.claim), f.id)
  assert.ok(text.includes('goes wrong when: a key "A" reads as missing'))
})

test('a first round has no prior blockers to rule', () => {
  const text = reviewerBrief(review())
  assert.ok(!text.includes('## Prior blockers'))
  assert.ok(!text.includes('fix_rulings'))
})

test("a yardstick leaf's majors block like criticals", () => {
  assert.ok(reviewerBrief(review({ leaf: leaf({ rigor: 'tdd-pair', role: 'red' }) })).includes('YARDSTICK'))
  assert.ok(reviewerBrief(review({ leaf: leaf({ provides: [{ name: 'Parser', paths: ['src/api/parse.js'] }] }) })).includes('YARDSTICK'))
  assert.ok(!reviewerBrief(review()).includes('YARDSTICK'))
})

test('a leaf review returns no claim rulings', () => {
  assert.ok(reviewerBrief(review()).includes('`claims` is []'))
})

// ------------------------------------------------------------------ integrationBrief

test("the integration brief carries the folder's spec as its yardstick, the merged span and its units", () => {
  const text = integrationBrief(integration())
  assert.ok(text.includes('# The api layer\n\n## Intent\n\nConfigs load from disk.'), 'the spec, inline')
  assert.ok(text.includes('git diff a0a0a0a d4d4d4d'))
  assert.ok(text.includes('/wt/api'))
  for (const u of integration().units) assert.ok(text.includes('- ' + u), u)
  for (const r of ['met', 'equivalent', 'under', 'over', 'deviates', 'spec_defect', 'cant_tell']) assert.ok(text.includes(r), r)
})

test('the caveat is in the integration brief only when given', () => {
  const caveat = 'Planned children that did not land: api/cache.'
  assert.ok(integrationBrief(integration({ caveat })).includes(caveat))
  assert.ok(!integrationBrief(integration()).includes('## Caveat'))
})

test("the repository's guidance closes a brief when given", () => {
  const guidance = '## Repository guidance\n\n### CLAUDE.md\n\nroot rules'
  for (const [name, text] of [
    ['integration', integrationBrief(integration({ guidance }))],
    ['drift', driftBrief({ ...drift(), guidance })],
    ['stale', staleBrief({ ...stale(), guidance })],
    ['planner', plannerBrief(planner({ guidance }))],
    ['investigator', investigatorBrief({ worktree: '/wt/x', known: known(), guidance })],
  ]) assert.ok(text.trimEnd().endsWith(guidance), name)
})

test('the re-rule brief carries the edit, the last rulings numbered, a unit for each claim not passed and the spec whole', () => {
  const input = rerule()
  const text = integrationRerule(input)
  assert.ok(text.includes(input.diff), 'the edit')
  assert.ok(text.includes(input.spec.trim()), 'the spec as it now reads')
  assert.ok(text.includes('git diff a0a0a0a d4d4d4d'), 'the span the last review judged')
  input.prior.forEach((c, i) => assert.ok(text.includes('claim:' + (i + 1) + ' [' + c.ruling + '] ' + c.claim), 'ruling ' + (i + 1)))
  const units = text.split('## The units you rule')[1].split('## Claims')[0].split('\n').filter((l) => l.startsWith('- '))
  assert.deepEqual(units, ['- claim:2', '- claim:4', '- change'], 'a unit for each claim not met, equivalent or accepted, then the change')
  assert.equal(text.includes('decision:'), false, "the whole review's units are not here")
})

// ------------------------------------------------------------------ driftBrief, staleBrief

test("the drift brief carries each ruled node's entry and its diff", () => {
  const text = driftBrief(drift())
  assert.ok(text.includes('agentics/e1/api'))
  assert.ok(text.includes('ruler_premises'))
  assert.ok(text.includes('-old parse\n+new parse'), "api/load's diff")
  assert.ok(text.includes('-old types\n+new types'), "ui/show's diff")
  for (const s of ['configs load through the parser', 'Call parse once per file.', 'A config file loads — check: `node --test test/load.test.mjs`',
    '- src/api/load.js', '- src/api/parse.js', 'Parser: src/api/parse.js']) assert.ok(text.includes(s), s)
})

test('the drift brief lists each node once, with every contract that drifted under it', () => {
  const text = driftBrief(drift())
  assert.equal(text.split('# api/load — Load configs').length - 1, 1)
  const block = text.slice(text.indexOf('# api/load — Load configs'), text.indexOf('# ui/show — Show configs'))
  assert.ok(block.includes('contract Parser (src/api/parse.js)'))
  assert.ok(block.includes('contract Types (src/api/types.js)'))
  for (const id of ['api/load', 'ui/show']) assert.ok(text.includes('\n- ' + id + '\n'), 'unit ' + id)
})

test("the stale brief carries each ruled node's entry, its move and its diff", () => {
  const text = staleBrief(stale())
  assert.ok(text.includes('ruler_premises'))
  assert.ok(text.includes('from 1111111 to 9999999'))
  assert.ok(text.includes('from 2222222 to 9999999'))
  assert.ok(text.includes('Moved files it writes: src/api/load.js.'))
  assert.ok(text.includes('Moved files it reads: src/api/types.js.'))
  assert.ok(text.includes('-load before\n+load after'))
  assert.ok(text.includes('-types before\n+types after'))
  for (const id of ['api/load', 'ui/show']) assert.ok(text.includes('\n- ' + id + '\n'), 'unit ' + id)
})

// ------------------------------------------------------------------ plannerBrief

test('a planner writing a spec is told the folder, the path, why, and every decision to realise', () => {
  const text = plannerBrief(planner())
  for (const s of ['api', 'The api layer', 'the api reads configs', '/repo/.agentics/e1/api/DESIGN.md', 'a fresh sub-effort',
    'D1: Keys are case-insensitive.', 'D2: Unknown keys are an error.', 'planner_write', 'Decisions row']) assert.ok(text.includes(s), s)
  assert.ok(!text.includes('## The spec as it stands'), 'a new spec has no text yet')
})

test('a planner rewriting a spec is handed its current text', () => {
  const spec = '# The api layer\n\n## Plan\n\n- **parse** — task\n'
  assert.ok(plannerBrief(planner({ spec })).includes(spec.trim()))
})

test('a planner settling a review is handed the spec and every finding by its id', () => {
  const spec = '# The api layer\n\n## Design\n\nThe loader reads files.\n'
  const findings = [probeFinding('P1', 'ambiguity', 'Design', 'the loader\'s encoding is unstated'), probeFinding('P2', 'gap', 'Plan', 'no retry is planned')]
  const text = plannerBrief(planner({ mode: 'settle', spec, findings }))
  assert.ok(text.includes('planner_settle'))
  assert.ok(text.includes(spec.trim()))
  assert.ok(text.includes('[P1] (ambiguity, Design) the loader\'s encoding is unstated'))
  assert.ok(text.includes('[P2] (gap, Plan) no retry is planned'))
  assert.ok(text.includes('incorporated'))
})

test("a planner answering a producer is handed the spec and the producer's request", () => {
  const spec = '# The api layer\n'
  const request = { node: 'api/parse', status: 'needs_context', text: 'Which encoding do config files use?' }
  const text = plannerBrief(planner({ mode: 'answer', spec, request }))
  assert.ok(text.includes('planner_write'))
  for (const s of ['api/parse', 'needs_context', 'Which encoding do config files use?', spec.trim()]) assert.ok(text.includes(s), s)
})

test('an unknown planner mode is refused', () => {
  assert.throws(() => plannerBrief(planner({ mode: 'review' })), /mode/)
})

// ------------------------------------------------------------------ investigatorBrief

test('the investigator is told the worktree and the commands still to establish', () => {
  const text = investigatorBrief({ worktree: '/wt/investigate', known: known() })
  assert.ok(text.includes('/wt/investigate'))
  assert.ok(text.includes('- build: `npm run build`'), 'an established command')
  assert.ok(text.includes('- typecheck: established absent'), 'an established absence')
  const todo = text.slice(text.indexOf('## To establish'))
  for (const n of ['suite', 'suite_fast', 'test_one']) assert.ok(todo.includes('- ' + n + '\n') || todo.includes('- ' + n), n)
  assert.ok(!todo.includes('- build'), 'an established command is not asked for again')
})

test('with nothing known the investigator establishes every command', () => {
  const text = investigatorBrief({ worktree: '/wt/investigate', known: {} })
  const todo = text.slice(text.indexOf('## To establish'))
  for (const n of ['build', 'typecheck', 'suite', 'suite_fast', 'test_one']) assert.ok(todo.includes('- ' + n), n)
})

// ------------------------------------------------------------------ every brief

test('the same input gives the same text, and the input is left as it was', () => {
  const calls = [
    [reviewerBrief, review({ prior: [blocker] })],
    [integrationBrief, integration({ caveat: 'c' })],
    [integrationRerule, rerule()],
    [driftBrief, drift()],
    [staleBrief, stale()],
    [plannerBrief, planner({ mode: 'settle', spec: 's', findings: [probeFinding('P1', 'gap', 'Plan', 'x')] })],
    [investigatorBrief, { worktree: '/wt/x', known: known() }],
  ]
  for (const [fn, input] of calls) {
    const before = structuredClone(input)
    const first = fn(input)
    assert.equal(typeof first, 'string', fn.name)
    assert.equal(fn(input), first, fn.name)
    assert.deepEqual(input, before, fn.name + ' left its input as it was')
  }
})

test('the convergence brief names the ruling and its schema, and carries each review round with what it left open', async () => {
  const { convergenceBrief } = await import('../../lib/briefs/execute.mjs')
  assert.equal(typeof convergenceBrief, 'function')
  const second = { ...blocker, id: 'F2', claim: 'lower-case keys are doubled' }
  const reviews = [
    { review_round: 1, round: 1, open: [blocker], unfixed: [] },
    { review_round: 2, round: 2, open: [second], unfixed: ['F1'] },
  ]
  const text = convergenceBrief({ leaf: leaf(), reviews })
  for (const s of ['api/parse', 'ruler_convergence', 'F1', blocker.claim, 'F2', second.claim]) assert.ok(text.includes(s), s)
  assert.ok(text.indexOf(blocker.claim) < text.indexOf(second.claim), 'the oldest round first')
  assert.equal(convergenceBrief({ leaf: leaf(), reviews }), text, 'the same input gives the same text')
})

test('an integration brief names the work agentics did not produce, with its shas', () => {
  const text = integrationBrief({
    folder: { id: 'c', title: 'c' }, spec: '# c', units: ['criterion:c/a#1'], span: { base: 'b0', head: 'h0' },
    outside: { leaves: [{ id: 'c/a', commits: ['a1a1a1a1a1', 'a2a2a2a2a2'] }], commits: ['s1s1s1s1s1'] },
  })
  assert.ok(text.includes('## Work agentics did not produce'))
  for (const s of ['c/a', 'a1a1a1a1a1', 'a2a2a2a2a2', 's1s1s1s1s1']) assert.ok(text.includes(s), s)
})

test('an integration brief with no outside work has no such section', () => {
  const text = integrationBrief({ folder: { id: 'c', title: 'c' }, spec: '# c', units: [], span: { base: 'b0', head: 'h0' } })
  assert.equal(text.includes('Work agentics did not produce'), false)
})

test('an existing test a change rewrote outside what it expected is named to its reviewer as a unit to rule closely', () => {
  for (const text of [reviewerBrief(review({ rewritten: ['test/old.test.mjs'] })), integrationBrief(integration({ rewritten: ['test/old.test.mjs'] }))]) {
    const section = text.slice(text.indexOf('## Existing tests rewritten'))
    assert.ok(text.includes('## Existing tests rewritten'), text)
    assert.ok(section.includes('- file:test/old.test.mjs'), section)
  }
  assert.ok(!reviewerBrief(review()).includes('## Existing tests rewritten'), 'no section when nothing was rewritten')
})
