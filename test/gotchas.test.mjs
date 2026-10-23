import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  commandsOf, deleteGotcha, gotchaId, gotchaProblem, gotchasFor, knowledgeDir,
  listGotchas, parseGotcha, readKnowledge, writeGotcha,
} from '../lib/gotchas.mjs'
import { ROLE_NAMES } from '../lib/roles.mjs'
import { fnv1a } from '../lib/plan-digest.mjs'

const repo = () => mkdtempSync(join(tmpdir(), 'agentics-gotchas-'))
const E = 'e1'

const pitfall = (extra = {}) => ({
  kind: 'pitfall', roles: ['implementer'], paths: [], trigger: 'running the suite on Windows',
  action: 'pass --test-concurrency=1', evidence: { command: 'node --test', output: 'EBUSY: resource busy' }, ...extra,
})
const command = (name, value, extra = {}) => ({
  kind: 'command', roles: ['implementer', 'reviewer'], trigger: 'building', action: 'run ' + value,
  evidence: { command: value || 'ls tsconfig.json', output: value ? 'ok' : 'No such file' }, command: { name, value, absent: false }, ...extra,
})

test('a pitfall id is stable across whitespace and case in its trigger; a command id is its name', () => {
  const a = gotchaId(pitfall({ trigger: 'Running the suite  on\tWindows ' }))
  const b = gotchaId(pitfall({ trigger: 'running the SUITE on windows' }))
  assert.equal(a, b)
  assert.match(a, /^g-[0-9a-f]{8}$/)
  assert.equal(a, 'g-' + fnv1a('running the suite on windows'))
  assert.notEqual(a, gotchaId(pitfall({ trigger: 'running the build on windows' })))
  assert.equal(gotchaId(command('suite', 'npm test')), 'command-suite')
})

test('gotchaProblem enforces the checkable qualification rules', () => {
  assert.equal(gotchaProblem(pitfall()), null)
  assert.equal(gotchaProblem(command('build', 'npm run build')), null)
  assert.match(gotchaProblem(pitfall({ kind: 'opinion' })), /kind/)
  assert.match(gotchaProblem(pitfall({ roles: [] })), /roles/)
  assert.match(gotchaProblem(pitfall({ roles: ['coder'] })), /not an agent/)
  assert.match(gotchaProblem(pitfall({ trigger: '  ' })), /trigger/)
  assert.match(gotchaProblem(pitfall({ action: '' })), /action/)
  assert.match(gotchaProblem(pitfall({ evidence: { command: 'x', output: '' } })), /evidence/)
  assert.match(gotchaProblem(pitfall({ evidence: undefined })), /evidence/)
  assert.match(gotchaProblem(pitfall({ paths: ['../etc'] })), /repo-relative/)
  assert.match(gotchaProblem(pitfall({ paths: ['/abs'] })), /repo-relative/)
  assert.match(gotchaProblem(command('lint', 'x')), /names its command/)
  assert.match(gotchaProblem(command('build', '')), /no value/)
  assert.equal(gotchaProblem(command('typecheck', '', { command: { name: 'typecheck', absent: true } })), null)
  assert.match(gotchaProblem('nope'), /object/)
})

test('a gotcha may be addressed to every role lib/roles.mjs defines, a ruler included, and a courier is refused', () => {
  assert.equal(gotchaProblem(pitfall({ roles: ['ruler'] })), null)
  for (const role of ROLE_NAMES) assert.equal(gotchaProblem(pitfall({ roles: [role] })), null, role)
  assert.match(gotchaProblem(pitfall({ roles: ['courier'] })), /not an agent/)
})

test('writeGotcha is idempotent on the id and round-trips through the file format', () => {
  const r = repo()
  const first = writeGotcha(r, E, pitfall(), { observed_at: 'abc', source: { node: 'a/b', role: 'implementer' } })
  assert.equal(first.ok, true)
  const again = writeGotcha(r, E, pitfall({ trigger: 'RUNNING the suite on windows', action: 'pass --test-concurrency=1 always' }),
    { observed_at: 'def', source: { node: 'a/c', role: 'implementer' } })
  assert.equal(again.id, first.id)
  const all = listGotchas(r, E)
  assert.equal(all.length, 1)
  assert.equal(all[0].observed_at, 'def')
  assert.match(all[0].body, /^When RUNNING the suite on windows, do pass --test-concurrency=1 always\./)
  assert.match(all[0].body, /Evidence:\n {4}\$ node --test\n {4}EBUSY/)

  const text = readFileSync(join(knowledgeDir(r, E), first.id + '.md'), 'utf8')
  const front = JSON.parse(text.split('\n')[1])
  assert.deepEqual(front.source, { node: 'a/c', role: 'implementer' })
  assert.equal(parseGotcha(text).id, first.id)

  assert.equal(writeGotcha(r, E, pitfall({ roles: [] })).ok, false)
  assert.deepEqual(deleteGotcha(r, E, first.id), { ok: true, deleted: true })
  assert.deepEqual(deleteGotcha(r, E, first.id), { ok: true, deleted: false })
  assert.equal(deleteGotcha(r, E, '../effort').ok, false)
  assert.equal(listGotchas(r, E).length, 0)
})

test('a damaged gotcha file is reported as malformed, not silently dropped', () => {
  const r = repo()
  mkdirSync(knowledgeDir(r, E), { recursive: true })
  writeFileSync(join(knowledgeDir(r, E), 'g-12345678.md'), 'no frontmatter here\n')
  writeGotcha(r, E, pitfall(), {})
  const { gotchas, malformed } = readKnowledge(r, E)
  assert.equal(gotchas.length, 1)
  assert.equal(malformed.length, 1)
})

test('gotchasFor filters by role and by overlap with the expected files; unscoped gotchas reach every brief', () => {
  const r = repo()
  writeGotcha(r, E, pitfall({ trigger: 'anywhere' }), {})
  writeGotcha(r, E, pitfall({ trigger: 'in src', paths: ['src/'] }), {})
  writeGotcha(r, E, pitfall({ trigger: 'in docs', paths: ['docs/guide.md'] }), {})
  writeGotcha(r, E, pitfall({ trigger: 'for tests', roles: ['test-author'] }), {})

  const trig = (gs) => gs.map((g) => g.body.split(',')[0]).sort()
  assert.deepEqual(trig(gotchasFor(r, E, { role: 'implementer', paths: ['src/a/b.js'] })), ['When anywhere', 'When in src'])
  assert.deepEqual(trig(gotchasFor(r, E, { role: 'implementer', paths: ['docs/guide.md'] })), ['When anywhere', 'When in docs'])
  assert.deepEqual(trig(gotchasFor(r, E, { role: 'implementer', paths: ['src'] })), ['When anywhere', 'When in src'])
  assert.deepEqual(trig(gotchasFor(r, E, { role: 'implementer', paths: [] })), ['When anywhere'])
  assert.deepEqual(trig(gotchasFor(r, E, { role: 'test-author', paths: ['src/x.js'] })), ['When for tests'])
  assert.equal(gotchasFor(r, E, { role: 'implementer' }).length, 3)
  assert.equal(gotchasFor(r, E, {}).length, 4)
})

test('commandsOf reads only command gotchas an investigator or the session wrote', () => {
  const r = repo()
  writeGotcha(r, E, command('suite', 'npm test'), { source: { node: 'a', role: 'implementer' } })
  writeGotcha(r, E, command('build', 'npm run build'), { source: { node: '', role: 'investigator' } })
  writeGotcha(r, E, command('typecheck', '', { command: { name: 'typecheck', absent: true } }), { source: { role: 'investigator' } })
  writeGotcha(r, E, command('test_one', 'npm test -- {file}'), { source: { role: 'session' } })
  writeGotcha(r, E, pitfall(), { source: { role: 'investigator' } })
  assert.deepEqual(commandsOf(r, E), {
    build: 'npm run build', typecheck: '', suite: '', suite_fast: '', test_one: 'npm test -- {file}',
    absent: { build: false, typecheck: true, suite: false, suite_fast: false },
  })
})
