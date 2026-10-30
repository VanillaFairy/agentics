// A plan too big for one reader is refused when it is checked, not when a brief is built after the
// work merged.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { append } from '../lib/ledger.mjs'
import { BRIEF_BYTES, PART_BYTES } from '../lib/roles.mjs'
import { checkFolder } from '../lib/spec.mjs'
import { specPath } from '../lib/store.mjs'

const E = 'e'
const body = (title, plan, design = '') => ['# ' + title, '', '## Intent', '', 'Why.', '', '## Decisions', '', '## Design', '', design, '',
  '## Plan', '', plan, '', '## Open questions', '', '## Evidence', ''].join('\n')
const sub = (name) => '- **' + name + '** — sub-effort\n  Do ' + name + '.'

function world(t, specs, files = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-spec-size-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const write = (path, text) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  for (const [id, text] of Object.entries(specs)) write(specPath(repo, E, id), text)
  for (const [rel, text] of Object.entries(files)) write(join(dirname(specPath(repo, E, '.')), rel), text)
  return repo
}

const sizeProblems = (repo, folder) => checkFolder(repo, E, folder).problems.map((p) => p.problem).filter((p) => p.includes('too big'))

test('a spec past what one part of a brief holds is refused, naming the split', (t) => {
  const repo = world(t, { '.': body('Root', '', 'x'.repeat(PART_BYTES + 1)) })
  const [problem, ...rest] = sizeProblems(repo, '.')
  assert.match(problem, /split it into sub-efforts/)
  assert.deepEqual(rest, [])
})

test('text a spec links to in the store still counts as the spec', (t) => {
  const repo = world(t, { '.': body('Root', '', 'See [the rest](design/rest.md).') }, { 'design/rest.md': 'x'.repeat(PART_BYTES + 1) })
  assert.match(sizeProblems(repo, '.')[0], /split it into sub-efforts/)
})

test('an effort past one brief is refused at every spec, naming separate efforts, though no spec alone is over', (t) => {
  const each = Math.floor(BRIEF_BYTES / 3) + 1
  const names = ['a', 'b', 'c']
  assert.ok(each < PART_BYTES, 'the fixture: each spec fits alone')
  const specs = Object.fromEntries(names.map((n) => [n, body(n, '', 'x'.repeat(each))]))
  const repo = world(t, { '.': body('Root', names.map(sub).join('\n')), ...specs })
  for (const folder of ['.', 'a']) assert.match(sizeProblems(repo, folder).join(), /separate efforts that land in turn/)
})

test('once work has merged the plan is past splitting, so its size refuses nothing', (t) => {
  const repo = world(t, { '.': body('Root', '', 'x'.repeat(PART_BYTES + 1)) })
  assert.equal(append(repo, E, 'events', [{ kind: 'merged', node: 'a', into: 'b', merged_sha: 's', head_sha: 's' }]).ok, true)
  assert.deepEqual(sizeProblems(repo, '.'), [])
})

test('a spec the plan no longer names is not counted', (t) => {
  const repo = world(t, { '.': body('Root', sub('a')), a: body('a', ''), gone: body('gone', '', 'x'.repeat(BRIEF_BYTES + 1)) })
  assert.deepEqual(sizeProblems(repo, '.'), [])
})

test('an effort within both bounds has no size problem', (t) => {
  const repo = world(t, { '.': body('Root', sub('a')), a: body('a', '', 'x'.repeat(PART_BYTES - 1000)) })
  assert.deepEqual(sizeProblems(repo, '.'), [])
})
