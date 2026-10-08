// test/fast/coverage-block-gaps.test.mjs — the two defects an adversarial audit found in
// the `coverage-block` rule, pinned. These are gaps, not a rewrite: the main suite in
// test/fast/coverage-block.test.mjs stays exactly as its author left it, and this file sits
// alongside it so the audit trail is readable later.
//
// DEFECT 1 (high) — a `coverage:` sitting inside a string or a comment WITHIN the returned
// object satisfies the rule. The object's span is brace-matched over source that has had its
// strings and comments blanked out, but the span is then read back out of the ORIGINAL text,
// so everything the blanking was supposed to hide is visible again the moment it falls inside
// a returned object. The main suite already covers strings and comments, but its fixtures put
// them OUTSIDE the returned object, where nothing ever reads them — which is why they passed.
// Every fixture below puts them INSIDE. That one word is the whole bug.
//
// The consequence is the worst kind: a workflow with no coverage block at all lints clean.
// The rule that exists to stop a partial result from passing as a whole one (IL2)
// quietly hands out a pass.
//
// DEFECT 2 (medium) — ES shorthand `coverage` is not recognized. This was written down as an
// accepted limitation, then hit by the very first real workflow written against the rule
// (agentics-survey, which had to rename a parameter to `coverageBlock` to get around it).
// Shorthand counts.
//
// Written by an agent who had seen neither the fix nor the original author's reasoning, on
// purpose.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check } from '../../tools/rules/coverage-block.mjs'

const WF = 'workflows/agentics-survey.workflow.js'

/** V2 is a file-level finding: exactly one, line 0, and it talks about coverage. */
function assertMissingCoverageBlock(found) {
  assert.equal(found.length, 1)
  assert.equal(found[0].line, 0)
  assert.match(found[0].message, /coverage/i)
}

// --- DEFECT 1: a string inside the returned object is not a coverage key -----------------

test('a template literal inside the returned object does not supply the coverage key', () => {
  // There is no coverage block here at all. The workflow returns a question and a sentence
  // of prose, and the prose happens to use the word.
  const src = [
    'return {',
    '  question,',
    '  narrator: `Report coverage: what you did not reach.`,',
    '}',
  ].join('\n')

  assertMissingCoverageBlock(check(src, WF))
})

test('a single-quoted string inside the returned object does not supply the coverage key', () => {
  const src = [
    'return {',
    '  question,',
    "  narrator: 'Report coverage: what you did not reach.',",
    '}',
  ].join('\n')

  assertMissingCoverageBlock(check(src, WF))
})

test('a double-quoted string inside the returned object does not supply the coverage key', () => {
  const src = [
    'return {',
    '  question,',
    '  narrator: "Report coverage: what you did not reach.",',
    '}',
  ].join('\n')

  assertMissingCoverageBlock(check(src, WF))
})

test('a prompt inside the returned object that spells out the coverage shape is still prose', () => {
  // The realistic shape: prompt text tells the model what to emit, braces and all. Those
  // braces are also the ones the brace matcher has to ignore, so this fixture exercises the
  // blanking and the span in the same breath.
  const src = [
    'return {',
    '  question,',
    '  prompt: `End with coverage: { complete, dropped, unreached }. Nothing after it.`,',
    '  verdicts,',
    '}',
  ].join('\n')

  assertMissingCoverageBlock(check(src, WF))
})

// --- DEFECT 1: a comment inside the returned object is not a coverage key ----------------

test('a line comment inside the returned object does not supply the coverage key', () => {
  const src = [
    'return {',
    '  question,',
    '  // was: coverage: { complete: true },',
    '  verdicts,',
    '}',
  ].join('\n')

  assertMissingCoverageBlock(check(src, WF))
})

test('a block comment inside the returned object does not supply the coverage key', () => {
  const src = 'return { question, /* was: coverage: { complete: true } */ verdicts }'

  assertMissingCoverageBlock(check(src, WF))
})

// --- DEFECT 2: ES shorthand --------------------------------------------------------------

test('ES shorthand coverage satisfies the rule', () => {
  // The workflow really does return a coverage block; `coverage` and `coverage: coverage`
  // are the same object. Flagging this pushed the first real workflow into renaming a
  // parameter to appease the linter, which is the linter being wrong.
  const src = ['const coverage = {}', 'return { question, coverage }'].join('\n')

  assert.deepEqual(check(src, WF), [])
})

// --- guards against over-correcting -------------------------------------------------------
//
// These three already pass. They are here so the fix cannot be "any mention of coverage in a
// string kills it" or "any token containing coverage saves it" — both of which would close
// one gap by opening another.

test('a genuine coverage key still counts when a prompt in the same object also says coverage', () => {
  const src = [
    'return {',
    '  question,',
    '  prompt: `Report coverage: { complete, dropped } for everything you did not reach.`,',
    '  coverage: { complete: true, dropped: [] },',
    '}',
  ].join('\n')

  assert.deepEqual(check(src, WF), [])
})

test('a genuine coverage key still counts when a comment in the same object mentions it', () => {
  const src = [
    'return {',
    '  question,',
    '  // the coverage: block below is the real one',
    '  coverage: { complete: true },',
    '}',
  ].join('\n')

  assert.deepEqual(check(src, WF), [])
})

test('a shorthand key that merely ends in the word coverage does not satisfy the rule', () => {
  // The colon twin of this is already pinned in the main suite. Recognizing shorthand must
  // not soften it into a substring search: `has_coverage` is a different key.
  const src = ['const has_coverage = true', 'return { question, has_coverage }'].join('\n')

  assertMissingCoverageBlock(check(src, WF))
})
