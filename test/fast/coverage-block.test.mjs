// test/fast/coverage-block.test.mjs — pins IL2 at the workflow boundary: a partial
// result must never be indistinguishable from a whole one. An agentics-* workflow that returns
// nothing, or returns a result with no coverage block, hands its caller an answer that
// looks exactly like a complete one.
//
// The subtle half of this rule is not "find the word coverage". It is finding it in a real
// returned object literal and NOT in the enormous prompt strings that make up most of a
// workflow script — strings which contain braces, the word return, and ${} interpolations,
// plus the comments that quote all three. Most of the tests below are those cases, because
// the naive scan passes the easy ones and then fails on the very first real workflow.
//
// Where more than one honest reading exists (an inline `if (x) return`, a
// `return` followed by an object on the NEXT line, `return { ...base, coverage }`), this
// file deliberately asserts nothing. Those are open questions, not test gaps.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { id, applies, check } from '../../tools/rules/coverage-block.mjs'

const WF = 'workflows/agentics-survey.workflow.js'

/** 1-indexed line number of an exact fixture line, so no test has to count by hand. */
function lineOf(lines, exact) {
  const i = lines.indexOf(exact)
  assert.ok(i >= 0, `fixture has no line ${JSON.stringify(exact)}`)
  return i + 1
}

const clean = [
  "export const meta = { name: 'agentics-survey', description: 'x', phases: [] }",
  'const verdicts = []',
  'return {',
  '  question,',
  '  verdicts,',
  '  coverage: { complete: true, dropped: [], incomplete: [] },',
  '}',
].join('\n')

// --- the module contract ----------------------------------------------------------------

test('the rule applies to workflow scripts', () => {
  assert.equal(applies.test(WF), true)
})

test('the rule does not apply to anything that is not a workflow script', () => {
  assert.equal(applies.test('agents/scout.md'), false)
  assert.equal(applies.test('skills/investigate/SKILL.md'), false)
  assert.equal(applies.test('tools/lint.mjs'), false)
})

test('applies is stateless — the orchestrator reuses one regex across every file', () => {
  // A /g flag makes RegExp.test() carry lastIndex between calls, so the same path matches,
  // then does not, then does. tools/lint.mjs tests this one object against every file in
  // the tree, so a stateful regex silently lints half the workflows.
  assert.equal(applies.test(WF), true)
  assert.equal(applies.test(WF), true)
  assert.equal(applies.test('agents/scout.md'), false)
  assert.equal(applies.test(WF), true)
})

// --- the clean case ---------------------------------------------------------------------

test('a workflow that returns a coverage block is clean', () => {
  assert.deepEqual(check(clean, WF), [])
})

// --- V1: nothing is returned at all -----------------------------------------------------

const noReturn = [
  "export const meta = { name: 'agentics-survey', description: 'x', phases: [] }",
  'const verdicts = []',
  "phase('Plan')",
].join('\n')

test('a workflow that never returns is flagged once, at file level', () => {
  // undefined reaching the caller is indistinguishable from a crash. IL2.
  const found = check(noReturn, WF)

  assert.equal(found.length, 1)
  assert.equal(found[0].line, 0)
  assert.match(found[0].message, /return/i)
})

// --- V2: a result object with no coverage key -------------------------------------------

const noCoverage = [
  'const verdicts = []',
  'return {',
  '  question,',
  '  verdicts,',
  '}',
].join('\n')

test('a result object with no coverage key is flagged once, at file level', () => {
  const found = check(noCoverage, WF)

  assert.equal(found.length, 1)
  assert.equal(found[0].line, 0)
  assert.match(found[0].message, /coverage/i)
})

test('a key that merely ends in the word coverage does not satisfy the rule', () => {
  // `has_coverage:` satisfies a lazy /coverage\s*:/ scan and is not the coverage block.
  const found = check('return { question, has_coverage: true }', WF)

  assert.equal(found.length, 1)
  assert.equal(found[0].line, 0)
  assert.match(found[0].message, /coverage/i)
})

test('several returns, none carrying coverage, are one file-level finding', () => {
  const src = [
    'function summarize(v) {',
    '  return { text: v.length }',
    '}',
    'return { question, verdicts: [] }',
  ].join('\n')

  const found = check(src, WF)

  assert.equal(found.length, 1)
  assert.equal(found[0].line, 0)
})

// --- V3: a bare return ------------------------------------------------------------------

const bareReturn = [
  'const verdicts = []',
  'if (!question) {',
  '  return',
  '}',
  'return { question, coverage: { complete: true } }',
]

test('a bare return is flagged on its own line', () => {
  // Indented on purpose: an anchored /^return$/m scan misses every real one.
  const found = check(bareReturn.join('\n'), WF)

  assert.equal(found.length, 1)
  assert.equal(found[0].line, lineOf(bareReturn, '  return'))
  assert.match(found[0].message, /return/i)
})

const bareReturnSemicolon = [
  'const verdicts = []',
  'if (verdicts.length === 0) {',
  '  return;',
  '}',
  'return { question, coverage: { complete: true } }',
]

test('a bare return written with a semicolon is flagged the same way', () => {
  const found = check(bareReturnSemicolon.join('\n'), WF)

  assert.equal(found.length, 1)
  assert.equal(found[0].line, lineOf(bareReturnSemicolon, '  return;'))
})

const twoBareReturns = [
  'if (!question) {',
  '  return',
  '}',
  'if (!roots) {',
  '  return;',
  '}',
  'return { question, coverage: { complete: true } }',
]

test('every bare return is reported, not just the first', () => {
  const found = check(twoBareReturns.join('\n'), WF)

  assert.deepEqual(
    found.map((v) => v.line).sort((a, b) => a - b),
    [lineOf(twoBareReturns, '  return'), lineOf(twoBareReturns, '  return;')],
  )
})

const bareReturnAfterPrompt = [
  'const prompt = `Search until the search is exhausted.',
  '',
  'Do not stop early. Report the surface you did not reach.',
  '',
  'Reply as JSON.`',
  'if (!prompt) {',
  '  return',
  '}',
  'return { question, coverage: { complete: true } }',
]

test('a bare return after a multi-line prompt is reported on the right line', () => {
  // Whatever the implementation does to strings, it must not collapse them: losing the
  // newlines inside a prompt shifts the reported line of everything below it.
  const found = check(bareReturnAfterPrompt.join('\n'), WF)

  assert.equal(found.length, 1)
  assert.equal(found[0].line, lineOf(bareReturnAfterPrompt, '  return'))
})

// --- prompt strings are not source ------------------------------------------------------

test('a coverage key that exists only inside a template literal does not satisfy the rule', () => {
  const src = [
    'const p = `Report the coverage: { complete: true }`',
    'return { question }',
  ].join('\n')

  const found = check(src, WF)

  assert.equal(found.length, 1)
  assert.equal(found[0].line, 0)
  assert.match(found[0].message, /coverage/i)
})

test('a coverage key that exists only inside a quoted string does not satisfy the rule', () => {
  const src = [
    "const a = 'return { coverage: { complete: true } }'",
    'const b = "coverage: { complete: true }"',
    'return { question }',
  ].join('\n')

  const found = check(src, WF)

  assert.equal(found.length, 1)
  assert.equal(found[0].line, 0)
  assert.match(found[0].message, /coverage/i)
})

test('a return that exists only inside a prompt is not the workflow returning', () => {
  // Count deliberately unpinned here — whether a file with no real return draws one
  // finding or two is a single decision, pinned once in the V1 test above.
  const src = [
    'const p = `Then return { coverage: { complete: true } } to the caller.`',
    'const verdicts = []',
  ].join('\n')

  const found = check(src, WF)

  assert.ok(found.length >= 1)
  assert.deepEqual([...new Set(found.map((v) => v.line))], [0])
})

test('the word return alone on a line inside a prompt is not a bare return', () => {
  const src = [
    'const prompt = `When you are done:',
    'return',
    'the coverage line, then stop.`',
    'return { question, coverage: { complete: true } }',
  ].join('\n')

  assert.deepEqual(check(src, WF), [])
})

test('an interpolated template before the return does not break brace matching', () => {
  const src = [
    'const prompt = `Context: ${JSON.stringify({ a: 1 })} - answer the question.`',
    'return { question, coverage: { complete: true, dropped: [] } }',
  ].join('\n')

  assert.deepEqual(check(src, WF), [])
})

test('an unbalanced brace inside a prompt does not truncate the returned object', () => {
  // Real prompt text shows the model what to emit, closing braces and all. A brace
  // counter that reads those braces as code closes the object early and never sees
  // the coverage key that is sitting right there.
  const src = [
    'return {',
    '  question,',
    '  prompt: `Reply with { "hits": [] }. Write nothing after the closing }.`,',
    '  coverage: { complete: true },',
    '}',
  ].join('\n')

  assert.deepEqual(check(src, WF), [])
})

test('an apostrophe inside a prompt does not swallow the rest of the file', () => {
  // Scanning for quotes without tracking which delimiter opened the literal turns the
  // apostrophe in "Don't" into the start of a string that runs to end of file, taking
  // the real return with it.
  const src = [
    "const prompt = `Don't stop until the search is exhausted.`",
    'return { question, coverage: { complete: true } }',
  ].join('\n')

  assert.deepEqual(check(src, WF), [])
})

// --- comments are not source ------------------------------------------------------------

test('a coverage key inside a line comment does not satisfy the rule', () => {
  const src = [
    '// return { coverage: { complete: true, dropped: [] } }',
    'return { question }',
  ].join('\n')

  const found = check(src, WF)

  assert.equal(found.length, 1)
  assert.equal(found[0].line, 0)
  assert.match(found[0].message, /coverage/i)
})

test('a coverage key inside a block comment does not satisfy the rule', () => {
  const src = [
    '/*',
    ' * The old shape was:',
    ' *   return { question, coverage: { complete: true } }',
    ' */',
    'return { question }',
  ].join('\n')

  const found = check(src, WF)

  assert.equal(found.length, 1)
  assert.equal(found[0].line, 0)
  assert.match(found[0].message, /coverage/i)
})

test('a commented-out bare return is not a bare return', () => {
  const src = [
    'const verdicts = []',
    '// return',
    '/* return */',
    'return { question, coverage: { complete: true } }',
  ].join('\n')

  assert.deepEqual(check(src, WF), [])
})

// --- the accepted limitation ------------------------------------------------------------
//
// The rule asks that AT LEAST ONE returned object carries coverage, not that every
// result-path return does. Telling a script-level return from a helper's return needs a
// real parser and this repo has no dependencies; early-error paths are left to human
// review. Both tests below pin the weaker rule so it does not get over-implemented,
// and between them they rule out "just check the first return" and "just check the last".

test('a helper returning a plain object is fine when the script return carries coverage', () => {
  const src = [
    'async function scoutUntilComplete(t) {',
    '  return { hits: [], searched: [], complete: false }',
    '}',
    'return { question, coverage: { complete: false } }',
  ].join('\n')

  assert.deepEqual(check(src, WF), [])
})

test('a hoisted helper below the script return is fine too', () => {
  const src = [
    'const verdicts = []',
    'return { question, summary: summarize(verdicts), coverage: { complete: true } }',
    '',
    'function summarize(v) {',
    '  return { text: v.length }',
    '}',
  ].join('\n')

  assert.deepEqual(check(src, WF), [])
})

// --- invariants of the finding itself ---------------------------------------------------

test('every violation carries an integer line and a non-empty message', () => {
  const found = [...check(noCoverage, WF), ...check(bareReturn.join('\n'), WF)]

  assert.ok(found.length >= 2)
  for (const v of found) {
    assert.ok(Number.isInteger(v.line), `line was ${JSON.stringify(v.line)}`)
    assert.ok(v.line >= 0)
    assert.equal(typeof v.message, 'string')
    assert.ok(v.message.trim().length > 0)
  }
})

test('check is pure — the same source gives the same answer whatever ran before it', () => {
  const first = check(noCoverage, WF)
  check(clean, WF)
  check(bareReturn.join('\n'), WF)

  assert.deepEqual(check(noCoverage, WF), first)
})
