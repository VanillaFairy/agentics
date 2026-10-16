// test/fast/coverage-grammar.test.mjs — a coverage line a skill quotes as an example is a line
// `coverageLine` writes. The test builds search results that end every way the skills talk about (done
// with and without hits, stalled, budget, failed), takes the lines the code writes, turns each into a
// shape (its variable parts — names, whys, counts — become placeholders) and checks every quoted
// example against those shapes.
//
// Design: docs/DESIGN.md#searches.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { coverageLine } from '../../lib/programs/search/consume.mjs'

const ROOT = new URL('../../', import.meta.url)
const skill = (name) => readFileSync(new URL('skills/' + name + '/SKILL.md', ROOT), 'utf8').replace(/\r\n/g, '\n')

// ------------------------------------------------------------------ the results

const NAME = 'probe:find'
const WHY_STALLED = 'why-the-guard-stalled'
const WHY_BUDGET = 'why-the-budget-ended-it'
const WHY_FAILED = 'why-the-search-failed'
const SKIPPED = 'what-the-scout-says-it-skipped'

const hit = (n) => ({ key: 'src/file-' + n + '.js', line: n })
const result = (status, calls, hits, why = '', rounds = 1, skipped = '') => ({
  name: NAME, status, why, coverage: { rounds, last_added: 0, skipped }, calls: Array.from({ length: calls }, (_, i) => 'call ' + i), hits: Array.from({ length: hits }, (_, i) => hit(i + 1)),
})

/** One result per end the skills talk about, each with its status. */
const results = () => [
  result('done', 3, 2, '', 3, SKIPPED),
  result('done', 1, 0),
  result('stalled', 30, 2, WHY_STALLED, 2, SKIPPED),
  result('budget', 7, 1, WHY_BUDGET),
  result('failed', 0, 0, WHY_FAILED),
]

/** The values that vary per search, longest first so a value inside another is not cut first. */
const VARS = [NAME, WHY_STALLED, WHY_BUDGET, WHY_FAILED, SKIPPED].sort((x, y) => y.length - x.length)

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const HOLE = '\u0000'

/** A written line → the regex of its shape: each variable part and each count a placeholder. */
function shapeOf(line) {
  let t = line
  for (const v of VARS) t = t.split(v).join(HOLE)
  t = t.replace(/\d+/g, HOLE)
  return new RegExp('^' + t.split(HOLE).map(escape).join('.+?') + '$')
}

function shapes() {
  const written = results().map((r) => ({ status: r.status, line: coverageLine(r) }))
  return { written, regexes: written.map(({ line }) => ({ line, re: shapeOf(line) })) }
}

/** The examples a skill quotes that read as coverage lines: `<name>:<part>: …` in an italic quote or a code span. */
function quotedLines(text) {
  const out = []
  for (const m of text.matchAll(/\*"([^"]+)"\*/g)) out.push(m[1].replace(/\s+/g, ' '))
  for (const m of text.matchAll(/`([^`\n]+)`/g)) if (/^[^\s:`]+(:[^\s:`]+)+: \S/.test(m[1])) out.push(m[1])
  return out
}

const unmatched = (quotes, regexes) => quotes.filter((q) => !regexes.some(({ re }) => re.test(q)))

// ------------------------------------------------------------------ the fixture covers what the skills talk about

test('the coverage lines name each end the skills talk about', () => {
  const { written } = shapes()
  const lines = written.map((w) => w.line)
  const has = (prefix, why = '') => lines.some((l) => l.startsWith(NAME + ': ' + prefix) && l.includes(why))
  assert.ok(has('done, 3 calls, 2 hits, 3 rounds', "; the scout's own word: " + SKIPPED), 'a done search with hits writes its counts, rounds and the scout\'s word\n' + lines.join('\n'))
  assert.ok(has('done, 1 call, no hits'), 'a done search without hits says no hits\n' + lines.join('\n'))
  assert.ok(has('stalled, ', ': ' + WHY_STALLED), 'a stalled search writes its why\n' + lines.join('\n'))
  assert.ok(has('budget, 7 calls, 1 hit', ': ' + WHY_BUDGET), 'a budget search writes its why\n' + lines.join('\n'))
  assert.ok(has('failed, 0 calls, no hits', ': ' + WHY_FAILED), 'a failed search writes its why\n' + lines.join('\n'))
})

test('a shape tells a written line from a stale one', () => {
  const { regexes, written } = shapes()
  for (const { line } of written) assert.equal(unmatched([line], regexes).length, 0, 'a written line matches its own shape: ' + line)
  for (const stale of ['find:crates: ruled absent: no crate parses it', 'find:crates: seed crates.io (…)', 'find:crates:parser: no_progress, looked grep parser@crates→0']) {
    assert.deepEqual(unmatched([stale], regexes), [stale], 'the old grammar matches no shape: ' + stale)
  }
})

// ------------------------------------------------------------------ the skills

test('the skill quotes lines the code writes', () => {
  const quotes = quotedLines(skill('search-for-existing-solutions-before-building'))
  assert.ok(quotes.length > 0, 'the solutions skill quotes at least one coverage line as an example')
  const { regexes } = shapes()
  assert.deepEqual(unmatched(quotes, regexes), [], 'every quoted coverage line has the shape of one coverageLine writes:\n' + regexes.map((r) => r.line).join('\n'))
})

test('investigate quotes lines the code writes', () => {
  const quotes = quotedLines(skill('investigate'))
  const { regexes } = shapes()
  assert.deepEqual(unmatched(quotes, regexes), [], 'every quoted coverage line has the shape of one coverageLine writes:\n' + regexes.map((r) => r.line).join('\n'))
})
