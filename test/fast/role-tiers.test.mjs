// test/fast/role-tiers.test.mjs — pins the tier of a leaf's producer and reviewer, a raise, the refusal
// of an unknown effort, and the commands a role may run once the repository's commands are known.
//
// Design: docs/DESIGN.md#model-tier and docs/DESIGN.md#roles.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { EFFORTS, MODELS, loadRole, producerTier, raiseTier, reviewerTier, roleCommands, tierFor } from '../../lib/roles.mjs'
import { rolePermissions } from '../../lib/permissions.mjs'
import { leafOf, parseSpec } from '../../lib/spec.mjs'
import { isYardstick, normalizeNode } from '../../lib/tree.mjs'

const role = (name) => loadRole(name).role
const IMPLEMENTER = role('implementer')
const REVIEWER = role('reviewer')
const leaf = (over = {}) => normalizeNode({ id: 'a/b', kind: 'leaf', title: 't', rigor: 'tdd', role: 'green', ...over })
const deeper = (effort) => EFFORTS[Math.min(EFFORTS.indexOf(effort) + 1, EFFORTS.length - 1)]
const DIALS = ['low', 'normal', 'max']
const COMMANDS = {
  build: 'npm run build', typecheck: 'npx tsc --noEmit', suite: 'npm test', suite_fast: 'npm run test:fast',
  test_one: 'npx vitest run {file}',
}

// ------------------------------------------------------------------ the names a tier may use

test('the models and efforts a tier may name are listed weakest first', () => {
  assert.deepEqual(MODELS, ['haiku', 'sonnet', 'opus', 'fable'])
  assert.deepEqual(EFFORTS, ['low', 'medium', 'high', 'xhigh'])
})

// ------------------------------------------------------------------ producerTier

test("producerTier takes the author's producer dispatch", () => {
  const given = { model: 'haiku', effort: 'low' }
  assert.deepEqual(producerTier(leaf({ dispatch: { producer: given } }), IMPLEMENTER, { intelligence: 'normal' }), given)
})

test("producerTier runs a yardstick leaf's producer on opus at the role's effort", () => {
  const yardsticks = [leaf({ role: 'red' }), leaf({ role: 'audit' }), leaf({ provides: [{ name: 'store-paths', paths: ['lib/store.mjs'] }] })]
  for (const l of yardsticks) {
    assert.equal(isYardstick(l), true)
    assert.deepEqual(producerTier(l, IMPLEMENTER, { intelligence: 'normal' }), { model: 'opus', effort: IMPLEMENTER.tier.effort }, l.role)
  }
})

test("producerTier runs any other leaf's producer at the role's own tier", () => {
  assert.equal(isYardstick(leaf()), false)
  assert.deepEqual(producerTier(leaf(), IMPLEMENTER, { intelligence: 'normal' }), IMPLEMENTER.tier)
})

test("the low dial caps a producer's model at sonnet", () => {
  const low = { intelligence: 'low' }
  assert.deepEqual(producerTier(leaf({ role: 'red' }), IMPLEMENTER, low), { model: 'sonnet', effort: IMPLEMENTER.tier.effort })
  assert.deepEqual(producerTier(leaf({ dispatch: { producer: { model: 'fable', effort: 'high' } } }), IMPLEMENTER, low), { model: 'sonnet', effort: 'high' })
  assert.deepEqual(producerTier(leaf({ dispatch: { producer: { model: 'haiku', effort: 'low' } } }), IMPLEMENTER, low), { model: 'haiku', effort: 'low' })
  assert.deepEqual(producerTier(leaf(), IMPLEMENTER, low), IMPLEMENTER.tier)
})

test('the max dial takes a producer one effort step deeper', () => {
  const max = { intelligence: 'max' }
  assert.deepEqual(producerTier(leaf(), IMPLEMENTER, max), { model: IMPLEMENTER.tier.model, effort: deeper(IMPLEMENTER.tier.effort) })
  assert.deepEqual(producerTier(leaf({ role: 'red' }), IMPLEMENTER, max), { model: 'opus', effort: deeper(IMPLEMENTER.tier.effort) })
  assert.deepEqual(producerTier(leaf({ dispatch: { producer: { model: 'opus', effort: 'high' } } }), IMPLEMENTER, max), { model: 'opus', effort: 'xhigh' })
})

test('the max dial leaves a producer already at xhigh at xhigh', () => {
  const given = { model: 'opus', effort: 'xhigh' }
  assert.deepEqual(producerTier(leaf({ dispatch: { producer: given } }), IMPLEMENTER, { intelligence: 'max' }), given)
})

// ------------------------------------------------------------------ reviewerTier

test("reviewerTier takes the author's reviewer dispatch at every dial", () => {
  const given = { model: 'sonnet', effort: 'high' }
  for (const intelligence of DIALS) {
    assert.deepEqual(reviewerTier(leaf({ dispatch: { reviewer: given } }), REVIEWER, { intelligence }), given, intelligence)
  }
})

test('reviewerTier without a reviewer dispatch is the role tier under the dial', () => {
  const producerOnly = leaf({ dispatch: { producer: { model: 'haiku', effort: 'low' } } })
  for (const intelligence of DIALS) {
    assert.deepEqual(reviewerTier(leaf(), REVIEWER, { intelligence }), tierFor(REVIEWER, { intelligence }), intelligence)
    assert.deepEqual(reviewerTier(producerOnly, REVIEWER, { intelligence }), tierFor(REVIEWER, { intelligence }), intelligence)
  }
  assert.deepEqual(reviewerTier(leaf(), REVIEWER, { intelligence: 'normal' }), tierFor(REVIEWER, { intelligence: 'normal' }))
})

// ------------------------------------------------------------------ raiseTier

test('raiseTier takes haiku to sonnet at the same effort', () => {
  for (const effort of EFFORTS) assert.deepEqual(raiseTier({ model: 'haiku', effort }), { model: 'sonnet', effort }, effort)
})

test('raiseTier takes sonnet to opus at medium', () => {
  for (const effort of EFFORTS) assert.deepEqual(raiseTier({ model: 'sonnet', effort }), { model: 'opus', effort: 'medium' }, effort)
})

test('raiseTier takes a stronger model one effort step deeper', () => {
  for (const model of MODELS.slice(MODELS.indexOf('opus'))) {
    for (const effort of EFFORTS.slice(0, -1)) assert.deepEqual(raiseTier({ model, effort }), { model, effort: deeper(effort) }, model + ' ' + effort)
  }
})

test('raiseTier keeps xhigh at xhigh', () => {
  for (const model of MODELS.slice(MODELS.indexOf('opus'))) assert.deepEqual(raiseTier({ model, effort: 'xhigh' }), { model, effort: 'xhigh' }, model)
})

test("a raise passes the low dial's ceiling", () => {
  const capped = producerTier(leaf({ role: 'red' }), IMPLEMENTER, { intelligence: 'low' })
  assert.equal(capped.model, 'sonnet')
  assert.deepEqual(raiseTier(capped), { model: 'opus', effort: 'medium' })
})

// ------------------------------------------------------------------ tierFor's refusal

test('tierFor throws on a base effort outside EFFORTS', () => {
  for (const r of [IMPLEMENTER, REVIEWER]) {
    for (const intelligence of DIALS) assert.throws(() => tierFor(r, { intelligence, base: 'ultra' }), /ultra/, r.name + ' ' + intelligence)
  }
})

test("tierFor throws on a role's effort outside EFFORTS", () => {
  for (const r of [IMPLEMENTER, REVIEWER]) {
    assert.throws(() => tierFor({ ...r, tier: { model: r.tier.model, effort: 'max' } }, { intelligence: 'normal' }), /max/, r.name)
  }
})

test('tierFor takes every effort in EFFORTS as a base', () => {
  for (const effort of EFFORTS) assert.equal(tierFor(IMPLEMENTER, { intelligence: 'normal', base: effort }).effort, effort)
})

// ------------------------------------------------------------------ roleCommands

const commandsOf = (...commands) => ({ name: 'implementer', commands })

test('<build> becomes the build command', () => {
  assert.deepEqual(roleCommands(commandsOf('<build>', 'git add'), COMMANDS), [COMMANDS.build, 'git add'])
})

test('<typecheck> becomes the typecheck command', () => {
  assert.deepEqual(roleCommands(commandsOf('<typecheck>'), COMMANDS), [COMMANDS.typecheck])
})

test('<test> becomes the suite, the fast suite and test_one cut before {file}', () => {
  const cut = COMMANDS.test_one.slice(0, COMMANDS.test_one.indexOf('{file}')).trim()
  assert.deepEqual(roleCommands(commandsOf('<test>'), COMMANDS), [COMMANDS.suite, COMMANDS.suite_fast, cut])
})

test('an empty or absent command is dropped', () => {
  const some = { build: '', suite: 'npm test', suite_fast: '   ', test_one: '{file}' }
  assert.deepEqual(roleCommands(commandsOf('<build>', '<typecheck>', '<test>', 'git add'), some), ['npm test', 'git add'])
  assert.deepEqual(roleCommands(commandsOf('<build>', '<typecheck>', '<test>'), {}), [])
})

test('an implementer gains each criterion check that is a command', () => {
  const l = leaf({
    acceptance: [
      { text: 'the parser reads a header', check: 'node --test test/parse.test.mjs' },
      { text: 'HUMAN: the page reads well', check: '' },
      { text: 'the build passes', check: 'npm run build:docs' },
    ],
  })
  assert.deepEqual(roleCommands(commandsOf('git add'), COMMANDS, l), ['git add', 'node --test test/parse.test.mjs', 'npm run build:docs'])
})

test("an implementer may run the project commands its leaf's entry runs; a test-author may not", () => {
  const spec = parseSpec([
    '# t', '## Intent', '## Decisions', '## Design', '## Plan',
    '- **rename** — task · rigor: trivial · runs: `npm run asset:rename`',
    '  Rename the art',
    '  - [ ] no old id remains — check: `npm run build`',
    '## Open questions', '## Evidence',
  ].join('\n'))
  const l = normalizeNode(leafOf('rename', spec.entries[0]))
  const { allowed } = rolePermissions({ commands: roleCommands(IMPLEMENTER, COMMANDS, l) })
  assert.ok(allowed.includes('Bash(npm run asset:rename:*)'), JSON.stringify(allowed))
  assert.equal(roleCommands(role('test-author'), COMMANDS, l).includes('npm run asset:rename'), false)
})

test('an implementer without a leaf gains no criterion check', () => {
  assert.deepEqual(roleCommands(commandsOf('git add'), COMMANDS), ['git add'])
})

test('a role other than the implementer gains no criterion check', () => {
  const l = leaf({ acceptance: [{ text: 'it parses', check: 'node --test test/parse.test.mjs' }] })
  assert.deepEqual(roleCommands({ name: 'test-author', commands: ['git add'] }, COMMANDS, l), ['git add'])
  assert.deepEqual(roleCommands(REVIEWER, COMMANDS, l), REVIEWER.commands)
})

test("the implementer's role file gets the repository's commands for its placeholders", () => {
  const l = leaf({ acceptance: [{ text: 'it parses', check: 'node --test test/parse.test.mjs' }] })
  const out = roleCommands(IMPLEMENTER, COMMANDS, l)
  assert.ok(IMPLEMENTER.commands.some((c) => c.startsWith('<')), 'the role file holds placeholders')
  assert.equal(out.some((c) => c.includes('<') || c.includes('{file}')), false, JSON.stringify(out))
  for (const c of IMPLEMENTER.commands.filter((x) => !x.startsWith('<'))) assert.ok(out.includes(c), c)
  for (const c of [COMMANDS.build, COMMANDS.typecheck, COMMANDS.suite, COMMANDS.suite_fast, 'npx vitest run', 'node --test test/parse.test.mjs']) {
    assert.ok(out.includes(c), c)
  }
})

// ------------------------------------------------------------------ the dial has no default below program entry

test('a tier without the dial is refused, never read as normal', () => {
  assert.throws(() => tierFor(IMPLEMENTER), /intelligence/, 'tierFor')
  assert.throws(() => tierFor(IMPLEMENTER, { base: 'high' }), /intelligence/, 'tierFor with a base')
  assert.throws(() => producerTier(leaf(), IMPLEMENTER), /intelligence/, 'producerTier')
  assert.throws(() => reviewerTier(leaf(), REVIEWER), /intelligence/, 'reviewerTier')
  assert.throws(() => reviewerTier(leaf({ dispatch: { reviewer: { model: 'opus', effort: 'high' } } }), REVIEWER), /intelligence/, 'reviewerTier with a given tier')
})
