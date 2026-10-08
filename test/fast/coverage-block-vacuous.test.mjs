// test/coverage-block-vacuous.test.mjs — pins the self-audit deepening of the
// `coverage-block` rule: a coverage KEY whose value is decidably empty no longer
// satisfies IL2. The rule's message demands six named fields; before this,
// `coverage: {}` and `coverage: null` both linted clean — a partial result wearing the
// label of a whole one, waved through by the very rule built to stop that.
//
// The boundary is deliberate and narrow: only a literal `{}` and a literal `null` are
// decidable by regex. An identifier (`coverage: coverageBlock`) or ES shorthand may hold
// anything; judging THOSE belongs to the scenario harness, which executes the workflow
// and reads the real block. This file pins both sides of that line, so the rule can
// neither regress into keyword-matching nor creep into pretending it can read variables.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check } from '../../tools/rules/coverage-block.mjs'

const WF = 'workflows/agentics-survey.workflow.js'

function assertVacuous(found) {
  assert.equal(found.length, 1)
  assert.equal(found[0].line, 0)
  assert.match(found[0].message, /empty object literal or null/)
}

test('coverage: {} is flagged as vacuous', () => {
  assertVacuous(check('return { question, coverage: {} }', WF))
})

test('coverage: {} with only whitespace and newlines inside is still vacuous', () => {
  assertVacuous(check('return { question, coverage: {\n\n  } }', WF))
})

test('coverage: null is flagged as vacuous', () => {
  assertVacuous(check('return { question, coverage: null }', WF))
})

test('a substantive literal is not vacuous', () => {
  assert.deepEqual(check('return { question, coverage: { complete: false } }', WF), [])
})

test('an identifier value is left to the harness, not guessed at', () => {
  const src = ['const c = buildCoverage()', 'return { question, coverage: c }'].join('\n')
  assert.deepEqual(check(src, WF), [])
})

test('ES shorthand stays accepted', () => {
  const src = ['const coverage = buildCoverage()', 'return { question, coverage }'].join('\n')
  assert.deepEqual(check(src, WF), [])
})

test('one vacuous return does not poison a file whose real return is substantive', () => {
  // The error-path return is sloppy; the success path is real. At-least-one semantics is
  // the rule's documented scope, so this lints clean — the sloppy path is the harness's
  // catch, not this rule's.
  const src = [
    'if (!question) return { question, coverage: null }',
    'return { question, coverage: { complete: true, dropped: [] } }',
  ].join('\n')

  assert.deepEqual(check(src, WF), [])
})

test('a value that is null-ish prose in a string does not count either way', () => {
  // `coverage` here is only a word inside a template; the object carries no key at all,
  // so the finding is the MISSING-key message, not the vacuous one.
  const src = 'return { question, note: `coverage: null happens when nothing ran` }'

  const found = check(src, WF)
  assert.equal(found.length, 1)
  assert.match(found[0].message, /No returned object carries/)
})
