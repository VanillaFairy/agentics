// test/fast/coverage-grammar.test.mjs — a coverage line a skill quotes as an example is a line
// `coverageLines` writes. The test folds ledgers whose asks end every way the skills talk about (a
// research ask ruled absent, one ended no_progress, one stopped), takes the lines the code writes,
// turns each into a shape (its variable parts — names, ask keys, whys, patterns, paths, counts —
// become placeholders) and checks every quoted example against those shapes.
//
// Design: docs/DESIGN.md#searches.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { coverageLines, foldLedger } from '../../lib/search/ledger.mjs'

const ROOT = new URL('../../', import.meta.url)
const skill = (name) => readFileSync(new URL('skills/' + name + '/SKILL.md', ROOT), 'utf8').replace(/\r\n/g, '\n')

// ------------------------------------------------------------------ the ledgers

const NAME = 'probe:find'
const PATTERN = 'pattern-of-the-grep'
const PATH = 'dir-of-the-grep'
const OPEN_SEED = 'seed-never-opened'
const WHY_ABSENT = 'why-it-was-ruled-absent'
const WHY_OPEN = 'why-it-was-ruled-open'
const STOP = 'why-the-navigator-stopped'

const ask = (key, extra = {}) => ({ key, find: 'what ' + key + ' asks', scope: ['.'], domain: 'repo', seeds: [{ key: 'MATERIAL.md', as: 'closed', reason: 'the material' }], ...extra })
const grep = (asks, lines, pattern, paths = [PATH]) => ({
  tool: 'grep', args: { pattern, fixed: false, ignore_case: false, paths, page: 1 }, asks: [].concat(asks), ok: true,
  total: lines.length, page: 1, pages: 1, observed: lines.map(([key, line]) => ({ key, line })), keys: [...new Set(lines.map(([key]) => key))],
})
const unit = (u, ruling, why) => ({ unit: u, ruling, why })
const ruled = (turn, ...units) => ({ turn, asks: units.map((u) => u.unit), units })
function script(specs) {
  const calls = []
  const turns = specs.map((s, i) => {
    for (const c of s.calls ?? []) calls.push({ ...c, seq: calls.length + 1 })
    const head = { turn: i + 1, calls_through: calls.length }
    if (s.stop) return { ...head, stop: s.stop }
    return { ...head, output: { hits: [], dismissed: [], leads: [], asks: [] } }
  })
  return { calls, turns }
}
const fold = (asks, x, rulings) => foldLedger({ asks, ground: { rows: [], seeds: [] }, calls: x.calls, turns: x.turns, rulings })

/** Each ledger with the asks it holds and the values that vary from one search to the next. */
function ledgers() {
  // a research ask the ruler ruled absent after one zero-hit grep
  const absent = fold([ask('absent-ask')], script([{ calls: [grep('absent-ask', [], PATTERN)] }]), [ruled(1, unit('absent-ask', 'absent', WHY_ABSENT))])
  // one the ruler ruled open, back in that state at the next turn: no_progress
  const stalled = fold([ask('stalled-ask')], script([{ calls: [grep('stalled-ask', [['moved/one.js', 1]], PATTERN)] }, {}]), [ruled(1, unit('stalled-ask', 'open', WHY_OPEN))])
  // one the navigator's stop stopped, with a seed it never opened
  const stopped = fold(
    [ask('stopped-ask', { seeds: [{ key: OPEN_SEED, as: 'open', reason: 'a seed the frame gave' }] })],
    script([{ calls: [grep('stopped-ask', [['moved/two.js', 1]], PATTERN)] }, { stop: STOP }]),
    [],
  )
  // one no call ever ran under
  const idle = fold([ask('idle-ask')], script([{}]), [])
  return [absent, stalled, stopped, idle]
}

/** The values that vary per search, longest first so a value inside another is not cut first. */
function variables(ls) {
  const vars = new Set([NAME, PATTERN, PATH, OPEN_SEED, STOP, 'moved/one.js', 'moved/two.js'])
  for (const l of ls) {
    for (const a of Object.values(l.asks)) {
      vars.add(a.key)
      if (a.end?.why) vars.add(a.end.why)
      for (const f of a.agenda) {
        vars.add(f.key)
        if (f.detail) vars.add(f.detail)
      }
    }
  }
  return [...vars].filter(Boolean).sort((x, y) => y.length - x.length)
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const HOLE = '\u0000'

/** A written line → the regex of its shape: each variable part and each count a placeholder. */
function shapeOf(line, vars) {
  let t = line
  for (const v of vars) t = t.split(v).join(HOLE)
  t = t.replace(/\d+/g, HOLE)
  return new RegExp('^' + t.split(HOLE).map(escape).join('.+?') + '$')
}

function shapes() {
  const ls = ledgers()
  const vars = variables(ls)
  const written = []
  for (const l of ls) {
    const c = coverageLines(l, NAME)
    for (const list of ['declared', 'incomplete', 'unreached']) for (const line of c[list]) written.push({ list, line })
  }
  return { written, regexes: written.map(({ list, line }) => ({ list, line, re: shapeOf(line, vars) })) }
}

/** The examples a skill quotes that read as coverage lines: `<name>:<ask>: …` in an italic quote or a code span. */
function quotedLines(text) {
  const out = []
  for (const m of text.matchAll(/\*"([^"]+)"\*/g)) out.push(m[1].replace(/\s+/g, ' '))
  for (const m of text.matchAll(/`([^`\n]+)`/g)) if (/^[^\s:`]+(:[^\s:`]+)+: \S/.test(m[1])) out.push(m[1])
  return out
}

const unmatched = (quotes, regexes) => quotes.filter((q) => !regexes.some(({ re }) => re.test(q)))

// ------------------------------------------------------------------ the fixture covers what the skills talk about

test('the folded ledgers write a line for each end the skills quote', () => {
  const { written } = shapes()
  const lines = written.map((w) => w.list + ' ' + w.line)
  assert.ok(lines.some((l) => l.startsWith('declared ' + NAME + ':absent-ask: ruled absent: ')), 'a ruled absent writes a declared line\n' + lines.join('\n'))
  assert.ok(lines.some((l) => l.startsWith('incomplete ' + NAME + ':stalled-ask: no_progress, ')), 'a no_progress end writes an incomplete line\n' + lines.join('\n'))
  assert.ok(lines.some((l) => l.startsWith('incomplete ' + NAME + ':stopped-ask: stopped, ')), 'a stop writes an incomplete line\n' + lines.join('\n'))
  assert.ok(lines.some((l) => l.startsWith('unreached ' + NAME + ':stopped-ask: ') && l.includes(OPEN_SEED)), 'an unopened seed writes an unreached line\n' + lines.join('\n'))
})

test('a shape tells a written line from a stale one', () => {
  const { regexes, written } = shapes()
  for (const { line } of written) assert.equal(unmatched([line], regexes).length, 0, 'a written line matches its own shape: ' + line)
  for (const stale of ['find:crates: exhausted; found nothing: no such parser', 'find:crates stopped (…) and never reached crates.io']) {
    assert.deepEqual(unmatched([stale], regexes), [stale], 'the old grammar matches no shape: ' + stale)
  }
})

// ------------------------------------------------------------------ the skills

test('the skill quotes lines the code writes', () => {
  const quotes = quotedLines(skill('search-for-existing-solutions-before-building'))
  assert.ok(quotes.length > 0, 'the solutions skill quotes at least one coverage line as an example')
  const { regexes } = shapes()
  assert.deepEqual(unmatched(quotes, regexes), [], 'every quoted coverage line has the shape of one coverageLines writes:\n' + regexes.map((r) => r.line).join('\n'))
})

test('investigate quotes lines the code writes', () => {
  const quotes = quotedLines(skill('investigate'))
  const { regexes } = shapes()
  assert.deepEqual(unmatched(quotes, regexes), [], 'every quoted coverage line has the shape of one coverageLines writes:\n' + regexes.map((r) => r.line).join('\n'))
})
