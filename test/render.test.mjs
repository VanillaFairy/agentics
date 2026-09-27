// test/render.test.mjs — the landing view, rendered from a real spec and real events on disk.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { append } from '../lib/ledger.mjs'
import { renderLanding } from '../lib/render.mjs'
import { specPath } from '../lib/store.mjs'

const STAMP = '20260926-100000'
const CRITERIA = ['Starting design never needs an id or a flag.', 'Every command ends with a Next line.']

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-render-'))
  execFileSync('git', ['init', '-q', dir])
  return dir
}

const rootSpec = (intent) => [
  '# The change', '', '## Intent', '', ...intent, '',
  '## Decisions', '', '| id | decision | why |', '|---|---|---|', '| D1 | do it | asked for |', '',
  '## Design', '', 'As planned.', '', '## Plan', '',
  '- **x** — task · realises: D1 · rigor: tdd · locus: src/x.mjs', '  Add x.', '  - [ ] x works — check: `node --test`', '',
  '## Open questions', '', '## Evidence', '', 'None gathered.', '',
].join('\n')

const WITH_CRITERIA = ['For the maintainer.', '', '**Success criteria.**', '', ...CRITERIA.map((c, i) => (i + 1) + '. ' + c), '', 'Out of scope: the viewer.']

function writeRoot(r, text) {
  const path = specPath(r, 'e1', '.')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const claims = (r, list, head = 'h1') =>
  assert.equal(append(r, 'e1', 'events', { kind: 'claims', node: '.', execution: STAMP, head_sha: head, claims: list }).ok, true)

const criteriaLines = (view) => view.split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, ''))
const rowOf = (view, text) => view.split('\n').findIndex((l) => l.startsWith('|') && l.includes(text))

// Loss first, as the spec orders the verdicts: what did not hold leads, what could not be decided
// follows it, and `met` comes last.
const LOSS_FIRST = ['under', 'over', 'deviates', 'spec_defect', 'cant_tell', 'met']

test('the success criteria stand beside the verdicts, loss first', () => {
  const r = repo()
  writeRoot(r, rootSpec(WITH_CRITERIA))
  const list = [
    { claim: 'it builds', verdict: 'met', evidence: 'ci' },
    { claim: 'latency stays flat', verdict: 'cant_tell', evidence: 'no benchmark' },
    { claim: 'the api matches the spec', verdict: 'deviates', evidence: 'src/api.js:4' },
    { claim: 'the spec asks for two things at once', verdict: 'spec_defect', evidence: 'DESIGN.md:12' },
    { claim: 'memory stays bounded', verdict: 'cant_tell', evidence: 'no load test' },
    { claim: 'logging is scoped', verdict: 'over', evidence: 'src/log.js:2' },
    { claim: 'retries are bounded', verdict: 'under', evidence: 'src/r.js:9' },
  ]
  claims(r, list)
  const view = renderLanding(r, 'e1')
  assert.deepEqual(criteriaLines(view), CRITERIA)

  const rows = view.split('\n').filter((l) => /^\| (?!verdict \|)\w/.test(l))
  assert.equal(rows.length, list.length, 'every claim has its row')
  const rank = (v) => LOSS_FIRST.indexOf(v)
  assert.deepEqual(rows.map((l) => l.split('|')[1].trim()), list.map((c) => c.verdict).sort((a, b) => rank(a) - rank(b)))

  const count = (pass) => list.filter((c) => pass(c.verdict)).length
  const met = count((v) => v === 'met')
  const undecided = count((v) => v === 'cant_tell')
  const notMet = count((v) => v !== 'met' && v !== 'cant_tell')
  assert.ok(view.includes(list.length + ' claim(s): ' + met + ' met, ' + notMet + ' not met, ' + undecided + ' it could not decide.'),
    'a cant_tell is counted as neither met nor not met')
})

test('no recorded verdicts: the criteria stand alone, with no table', () => {
  const r = repo()
  writeRoot(r, rootSpec(WITH_CRITERIA))
  const view = renderLanding(r, 'e1')
  assert.deepEqual(criteriaLines(view), CRITERIA)
  assert.equal(view.split('\n').filter((l) => l.startsWith('|')).length, 0)
})

test('the latest claims event on the root is the one rendered', () => {
  const r = repo()
  writeRoot(r, rootSpec(WITH_CRITERIA))
  claims(r, [{ claim: 'an old claim', verdict: 'under', evidence: 'x' }], 'h1')
  claims(r, [{ claim: 'the new claim', verdict: 'met', evidence: 'y' }], 'h2')
  const view = renderLanding(r, 'e1')
  assert.ok(rowOf(view, 'the new claim') !== -1)
  assert.equal(rowOf(view, 'an old claim'), -1)
})

test('a claim holding a pipe still renders three columns', () => {
  const r = repo()
  writeRoot(r, rootSpec(WITH_CRITERIA))
  claims(r, [{ claim: 'a | b stays one claim', verdict: 'deviates', evidence: 'src/a.js:1' }])
  const view = renderLanding(r, 'e1')
  const row = view.split('\n')[rowOf(view, 'stays one claim')]
  assert.equal(row.split(/(?<!\\)\|/).length, 5, row)
})

test('CRLF and LF specs list the same criteria', () => {
  const lf = repo()
  const crlf = repo()
  writeRoot(lf, rootSpec(WITH_CRITERIA))
  writeRoot(crlf, rootSpec(WITH_CRITERIA).replace(/\n/g, '\r\n'))
  assert.deepEqual(criteriaLines(renderLanding(crlf, 'e1')), criteriaLines(renderLanding(lf, 'e1')))
})

test('an Intent with no success-criteria list is rendered whole', () => {
  const r = repo()
  writeRoot(r, rootSpec(['Make the queue durable across restarts.']))
  assert.ok(renderLanding(r, 'e1').includes('Make the queue durable across restarts.'))
})
