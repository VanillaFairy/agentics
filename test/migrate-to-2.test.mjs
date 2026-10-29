// test/migrate-to-2.test.mjs — tools/migrate-to-2.mjs from the command line over a real repository:
// a dry run names each net and entry it would key to no blob and writes nothing, `--yes` keys each
// net and discriminator entry by its file's blob at the head it names, and an entry by its file's
// blob at its base too, and stamps the store, a second run writes nothing, and a store at another
// version than 1 is refused.
//
// Design: docs/DESIGN.md#migrations.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { storeStampPath, storeVersion } from '../lib/store.mjs'

const TOOL = fileURLToPath(new URL('../tools/migrate-to-2.mjs', import.meta.url))
const run = (repo, ...flags) => spawnSync(process.execPath, [TOOL, '--repo', repo, ...flags], { encoding: 'utf8' })
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { encoding: 'utf8' }).trim()
const lines = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

/** A version 1 store over a repository whose test file has a commit: a net ruled there, and a measurement there and at a commit git does not hold. */
function v1Store(t) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-migrate-to-2-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  git(repo, 'init', '-q', '-b', 'main')
  mkdirSync(join(repo, 'test'))
  writeFileSync(join(repo, 'test', 'x.test.mjs'), "test('x', () => {})\n")
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'x')
  const base = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'test', 'x.test.mjs'), "test('x', () => {})\ntest('x again', () => {})\n")
  writeFileSync(join(repo, 'test', 'y.test.mjs'), "test('y', () => {})\n")
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'y')
  const head = git(repo, 'rev-parse', 'HEAD')
  const gone = 'f'.repeat(40)
  const stamp = '20261001-120000'
  const state = join(repo, '.agentics', 'e1', '.state')
  mkdirSync(join(state, 'executions', stamp), { recursive: true })
  mkdirSync(join(repo, '.agentics', '.state'), { recursive: true })
  writeFileSync(storeStampPath(repo), JSON.stringify({ version: 1 }) + '\n')
  const merged = { seq: 2, kind: 'merged', node: 'a', execution: stamp }
  const events = [
    { seq: 1, kind: 'nets', node: 'a', execution: stamp, head_sha: head, nets: [{ file: 'test/x.test.mjs', why: 'held' }], all: true, by: 'session' },
    merged,
    { seq: 6, kind: 'nets', node: 'b', execution: stamp, head_sha: gone, nets: [{ file: 'test/x.test.mjs', why: 'held' }], by: 'session' },
  ]
  writeFileSync(join(state, 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''))
  const entry = { test_id: 'test/x.test.mjs', adds_test: true, failed_on_base: false, passes_now: true }
  // Measured before the base blob was recorded: it keeps its blob and gains the base's.
  const keyed = { test_id: 'test/y.test.mjs', blob: git(repo, 'rev-parse', head + ':test/y.test.mjs'), adds_test: false, failed_on_base: false, passes_now: true }
  const journal = [
    { seq: 3, kind: 'verify-observed', node: 'a', base_sha: base, head_sha: head, discriminator: [entry, keyed] },
    { seq: 4, kind: 'verify-observed', node: 'a', base_sha: base, head_sha: gone, discriminator: [entry] },
    { seq: 5, kind: 'series-done', node: 'a', head_sha: head },
  ]
  writeFileSync(join(state, 'executions', stamp, 'journal.jsonl'), journal.map((e) => JSON.stringify(e) + '\n').join(''))
  return {
    repo, events: join(state, 'events.jsonl'), journal: join(state, 'executions', stamp, 'journal.jsonl'),
    blob: git(repo, 'rev-parse', head + ':test/x.test.mjs'), baseBlob: git(repo, 'rev-parse', base + ':test/x.test.mjs'), keyed, merged, series: journal[2],
  }
}

test('a dry run lists the logs and writes nothing; --yes keys nets and entries by blob and stamps 2; a second run writes nothing', (t) => {
  const s = v1Store(t)
  const before = [readFileSync(s.events, 'utf8'), readFileSync(s.journal, 'utf8')]
  const dry = run(s.repo)
  assert.equal(dry.status, 0, dry.stdout + dry.stderr)
  const planned = JSON.parse(dry.stdout)
  assert.deepEqual(planned.logs.map((l) => l.lines), [2, 2])
  const voided = (out) => out.voided.map((v) => [v.path.endsWith('journal.jsonl') ? 'journal' : 'events', v.node, v.file])
  assert.deepEqual(voided(planned), [['events', 'b', 'test/x.test.mjs'], ['journal', 'a', 'test/x.test.mjs']],
    'each net and measured file keyed to no blob is shown before the store is stamped')
  assert.deepEqual([readFileSync(s.events, 'utf8'), readFileSync(s.journal, 'utf8')], before)
  assert.equal(storeVersion(s.repo), 1)

  const written = run(s.repo, '--yes')
  assert.equal(written.status, 0)
  assert.deepEqual(voided(JSON.parse(written.stdout)), voided(planned))
  const [nets, merged, gonenet] = lines(s.events)
  assert.deepEqual(nets.nets, [{ file: 'test/x.test.mjs', blob: s.blob, why: 'held' }])
  assert.deepEqual(gonenet.nets, [{ file: 'test/x.test.mjs', blob: '', why: 'held' }])
  assert.equal('all' in nets, false, 'version 2 derives all from the measurement')
  assert.deepEqual(merged, s.merged)
  const [at, gone, series] = lines(s.journal)
  assert.deepEqual(at.discriminator.map((d) => [d.blob, d.base_blob]), [[s.blob, s.baseBlob], [s.keyed.blob, '']],
    'each entry keyed by its file at head and at base, a file the base lacks by none, a blob it had kept')
  assert.deepEqual(gone.discriminator.map((d) => [d.blob, d.base_blob]), [['', s.baseBlob]], 'a commit git does not hold keys the entry to nothing')
  assert.deepEqual(series, s.series)
  assert.equal(storeVersion(s.repo), 2)

  const after = [readFileSync(s.events, 'utf8'), readFileSync(s.journal, 'utf8')]
  const again = JSON.parse(run(s.repo, '--yes').stdout)
  assert.deepEqual(again.logs, [])
  assert.deepEqual([readFileSync(s.events, 'utf8'), readFileSync(s.journal, 'utf8')], after)
})

test('a store at another version than 1 is refused and left as it is', (t) => {
  for (const version of [0, 3]) {
    const s = v1Store(t)
    writeFileSync(storeStampPath(s.repo), JSON.stringify({ version }))
    const before = readFileSync(s.journal, 'utf8')
    const out = run(s.repo, '--yes')
    assert.equal(out.status, 1, out.stdout)
    assert.equal(readFileSync(s.journal, 'utf8'), before)
    assert.equal(storeVersion(s.repo), version)
  }
})
