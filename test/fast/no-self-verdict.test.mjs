// test/fast/no-self-verdict.test.mjs — pins the ban on self-reported verdict booleans in workflow
// schemas (IRON LAW §2, extended to review).
//
// The line this rule draws is verdict names vs. fact names: `approved`/`passed`/`ok`/... are
// judgments a schema must never let a model set for itself, while `build_ok`/`suite_pass`/...
// describe an observed command exit status and stay legal. The clean case below is the real
// VERIFY schema, verbatim — if this rule ever flagged that schema, every workflow carrying it
// would trip the lint on day one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { id, applies, check } from '../../tools/rules/no-self-verdict.mjs'

const FILE = 'workflows/agentics-develop.workflow.js'

test('it applies to workflow scripts and the return schemas, and nothing else', () => {
  assert.ok(applies.test('workflows/agentics-develop.workflow.js'))
  assert.ok(!applies.test('agents/reviewer.md'))
  assert.ok(!applies.test('tools/lint.mjs'))
  assert.ok(applies.test('lib/schemas.mjs'))
  assert.ok(!applies.test('lib/runner.mjs'))
})

test('flags approved declared as a boolean schema property', () => {
  const src = [
    'const FINDINGS = {',
    '  type: "object",',
    "  properties: { approved: { type: 'boolean' } },",
    '}',
  ].join('\n')

  const found = check(src, FILE)
  assert.equal(found.length, 1)
  assert.equal(found[0].line, 3)
  assert.match(found[0].message, /approved/)
})

test('flags complete declared as a boolean schema property', () => {
  // The coverage block's `complete` is DERIVED in JS and never appears in a schema — a
  // schema declaring it is exactly the laundering IRON LAW §2 forbids.
  const src = "properties: { complete: { type: 'boolean' } }"

  const found = check(src, FILE)
  assert.equal(found.length, 1)
  assert.equal(found[0].line, 1)
  assert.match(found[0].message, /complete/)
})

test('flags two banned keys in one file as two findings', () => {
  const src = [
    'const SCHEMA = {',
    '  properties: {',
    "    passed: { type: 'boolean' },",
    "    lgtm: { type: 'boolean' },",
    '  },',
    '}',
  ].join('\n')

  const found = check(src, FILE)
  assert.equal(found.length, 2)
  assert.deepEqual(found.map((v) => v.line), [3, 4])
  assert.match(found[0].message, /passed/)
  assert.match(found[1].message, /lgtm/)
})

test('flags every key in the banned list', () => {
  // Mirrors test/fast/no-schema-bounds.test.mjs's "flags all four banned keys": a literal copy
  // of the rule's BANNED_KEYS, kept here rather than exported, since the rule module's
  // contract is exactly `id`, `applies`, `check` and this is not reason enough to widen it.
  // If a key is ever typo'd or dropped from the rule, this loop is what catches it — the
  // four keys covered by name above are not the whole list.
  const bannedKeys = [
    'approved', 'approve', 'passed', 'ok', 'accepted', 'lgtm', 'complete', 'success', 'valid',
  ]

  for (const key of bannedKeys) {
    const found = check(`${key}: { type: 'boolean' }`, FILE)
    assert.equal(found.length, 1, `${key} should be flagged`)
    assert.match(found[0].message, new RegExp(key))
  }
})

test('flags two banned keys declared on the same line', () => {
  const src = "{ ok: { type: 'boolean' }, valid: { type: 'boolean' } }"

  const found = check(src, FILE)
  assert.equal(found.length, 2)
  assert.deepEqual(found.map((v) => v.line), [1, 1])
  assert.match(found[0].message, /ok/)
  assert.match(found[1].message, /valid/)
})

test('flags a key and its type on separate lines, on the key line', () => {
  // Pins the claim in the rule's header comment: [^}]* deliberately spans newlines so a
  // schema written one property per line — how every real schema in this codebase is
  // written — still matches. Asserting the line is the KEY's line, not the type's line,
  // is what would catch a future "tightening" of [^}]* to [^}\n]*: that change only ever
  // produces fewer findings, so only a positive case here can catch it.
  const src = [
    'properties: {',
    '  accepted: {',
    "    type: 'boolean',",
    '  },',
    '}',
  ].join('\n')

  const found = check(src, FILE)
  assert.equal(found.length, 1)
  assert.equal(found[0].line, 2)
})

test('does not flag fact-named booleans build_ok or suite_pass', () => {
  const src = [
    "build_ok: { type: 'boolean' },",
    "suite_pass: { type: 'boolean' },",
  ].join('\n')

  assert.deepEqual(check(src, FILE), [])
})

test('does not flag a key that merely contains a banned key as a substring', () => {
  const src = "passed_tests: { type: 'boolean' }"
  assert.deepEqual(check(src, FILE), [])
})

test('does not flag an exact-match key whose type is not boolean', () => {
  const src = "passed: { type: 'array', items: { type: 'string' } }"
  assert.deepEqual(check(src, FILE), [])
})

test('does not flag banned words in prose or prompt strings', () => {
  const src = [
    'const PROMPT = `',
    '  Report clearly say whether it passed the suite and whether the fix is complete.',
    '`',
  ].join('\n')

  assert.deepEqual(check(src, FILE), [])
})

test('the real VERIFY schema is clean', () => {
  const src = `
const VERIFY = {
  type: 'object', additionalProperties: false,
  required: ['stop_reason', 'build', 'suite', 'suite_output_tail',
             'discriminator', 'series_findings', 'notes'],
  properties: {
    stop_reason: { type: 'string', enum: ['completed', 'environment_broken'] },
    build: { type: 'string', enum: ['passed', 'failed', 'absent'] },  // observed — a fact, not a judgment
    suite: { type: 'string', enum: ['passed', 'failed', 'absent'] },
    suite_output_tail: { type: 'string' },  // last ~40 lines of real output, verbatim
    discriminator: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['test_id', 'failed_on_base', 'passes_now'],
      properties: {
        test_id: { type: 'string' },
        failed_on_base: { type: 'boolean' },   // observed at base_sha in THIS worktree
        passes_now: { type: 'boolean' },
      } } },
    series_findings: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['sha', 'check', 'message', 'blocking'],
      properties: { sha: { type: 'string' }, check: { type: 'string' },
                    message: { type: 'string' }, blocking: { type: 'boolean' } } } },
    notes: { type: 'string' },
  },
}
`

  assert.deepEqual(check(src, FILE), [])
})
