import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  commandsOf, deleteGotcha, extractReportBlocks, gotchaId, gotchaProblem, gotchasFor, knowledgeDir,
  listGotchas, parseGotcha, readKnowledge, writeGotcha,
} from '../lib/gotchas.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'

const CLI = fileURLToPath(new URL('../lib/gotchas.mjs', import.meta.url))
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

test('extractReportBlocks parses every block and reports malformed ones instead of throwing', () => {
  const report = [
    '# Report', '',
    '```agentics-gotchas', JSON.stringify([pitfall(), pitfall({ roles: [] })]), '```', '',
    '```agentics-gotchas-stale', '["g-0000abcd", "../../x"]', '```', '',
    '```agentics-mutations', JSON.stringify([{ file: 'src/a.js', find: '<', replace: '<=', expect_failing: ['a bound'] }, { file: 'src/a.js', find: '', replace: 'x', expect_failing: [] }]), '```', '',
    '```agentics-commit', 'test(a): pin the bound', '```', '',
    '```agentics-gotchas', '{not json', '```', '',
    '```agentics-mutations', '{"file": "x"}', '```', '',
    '```js', 'const x = 1', '```',
  ].join('\r\n')
  const out = extractReportBlocks(report)
  assert.equal(out.gotchas.length, 1)
  assert.deepEqual(out.stale, ['g-0000abcd'])
  assert.deepEqual(out.mutations, [{ file: 'src/a.js', find: '<', replace: '<=', expect_failing: ['a bound'] }])
  assert.equal(out.commit, 'test(a): pin the bound')
  assert.equal(out.problems.length, 5, out.problems.join('\n'))
  assert.ok(out.problems.some((p) => /agentics-gotchas\[1\]: roles/.test(p)))
  assert.ok(out.problems.some((p) => /agentics-gotchas: not JSON/.test(p)))
  assert.ok(out.problems.some((p) => /agentics-mutations: expected a JSON array/.test(p)))
  assert.ok(out.problems.some((p) => /not a gotcha id/.test(p)))

  assert.deepEqual(extractReportBlocks('no blocks at all'), { gotchas: [], stale: [], mutations: [], commit: null, problems: [] })
  const twoLines = extractReportBlocks('```agentics-commit\nfirst\nsecond\n```\n')
  assert.equal(twoLines.commit, null)
  assert.match(twoLines.problems[0], /one subject line/)
  assert.doesNotThrow(() => extractReportBlocks(undefined))
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

test('gotchasFor filters by role and by locus overlap; unscoped gotchas reach every locus', () => {
  const r = repo()
  writeGotcha(r, E, pitfall({ trigger: 'anywhere' }), {})
  writeGotcha(r, E, pitfall({ trigger: 'in src', paths: ['src/'] }), {})
  writeGotcha(r, E, pitfall({ trigger: 'in docs', paths: ['docs/guide.md'] }), {})
  writeGotcha(r, E, pitfall({ trigger: 'for tests', roles: ['test-author'] }), {})

  const trig = (gs) => gs.map((g) => g.body.split(',')[0]).sort()
  assert.deepEqual(trig(gotchasFor(r, E, { role: 'implementer', locus: ['src/a/b.js'] })), ['When anywhere', 'When in src'])
  assert.deepEqual(trig(gotchasFor(r, E, { role: 'implementer', locus: ['docs/guide.md'] })), ['When anywhere', 'When in docs'])
  assert.deepEqual(trig(gotchasFor(r, E, { role: 'implementer', locus: ['src'] })), ['When anywhere', 'When in src'])
  assert.deepEqual(trig(gotchasFor(r, E, { role: 'implementer', locus: [] })), ['When anywhere'])
  assert.deepEqual(trig(gotchasFor(r, E, { role: 'test-author', locus: ['src/x.js'] })), ['When for tests'])
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

test('CLI add is all or nothing and prints the envelope; list filters', () => {
  const r = repo()
  spawnSync('git', ['init', '-q', r])
  const file = (v) => {
    const path = join(mkdtempSync(join(tmpdir(), 'agentics-gotchas-file-')), 'gotchas.json')
    writeFileSync(path, JSON.stringify(v))
    return path
  }
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })

  const bad = run('add', '--repo', r, '--effort', E, '--file', file([command('suite', 'npm test'), pitfall({ roles: [] })]))
  assert.equal(bad.status, 0)
  const badOut = JSON.parse(bad.stdout)
  assert.equal(badOut.payload.ok, false)
  assert.equal(badOut.payload_digest, fnv1a(canonical(badOut.payload)))
  assert.equal(existsSync(knowledgeDir(r, E)), false)

  const good = JSON.parse(run('add', '--repo', r, '--effort', E, '--file', file([command('suite', 'npm test')])).stdout)
  assert.equal(good.payload.ok, true)
  assert.deepEqual(good.payload.written.map((w) => w.id), ['command-suite'])
  assert.equal(commandsOf(r, E).suite, 'npm test')

  const listed = JSON.parse(run('list', '--repo', r, '--effort', E, '--role', 'reviewer', '--locus', 'src/a.js').stdout)
  assert.deepEqual(listed.payload.gotchas.map((g) => g.id), ['command-suite'])
  const none = JSON.parse(run('list', '--repo', r, '--effort', E, '--role', 'auditor').stdout)
  assert.deepEqual(none.payload.gotchas, [])

  const unknown = run('frobnicate')
  assert.equal(unknown.status, 1)
  assert.ok(JSON.parse(unknown.stdout).error)
})
