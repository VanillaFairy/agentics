// test/migrate-to-1.test.mjs — tools/migrate-to-1.mjs from the command line: a dry run writes
// nothing, `--yes` rewrites what version 1 no longer reads and stamps the store, a second run writes
// nothing, and a store stamped past 1 is refused.
//
// Design: docs/DESIGN.md#migrations.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { storeStampPath, storeVersion } from '../lib/store.mjs'

const TOOL = fileURLToPath(new URL('../tools/migrate-to-1.mjs', import.meta.url))
const run = (repo, ...flags) => spawnSync(process.execPath, [TOOL, '--repo', repo, ...flags], { encoding: 'utf8' })

/** A store as one that predates the stamp left it: a withdrawn message and a return with a line of text in unread. */
function oldStore(t) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-migrate-to-1-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const state = join(repo, '.agentics', 'e1', '.state')
  mkdirSync(join(state, 'executions', '20261001-120000', 'returns'), { recursive: true })
  const events = [
    { seq: 1, kind: 'message', msg: 'continue_search', thread: 'x', node: 'a', execution: '20261001-120000' },
    { seq: 2, kind: 'withdrawn', node: 'a', execution: '20261001-120000', messages: [1] },
    { seq: 3, kind: 'merged', node: 'a', execution: '20261001-120000' },
  ]
  writeFileSync(join(state, 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''))
  writeFileSync(join(state, 'executions', '20261001-120000', 'returns', 'a-r1.json'), JSON.stringify({ status: 'done', unread: ['docs/api.md'] }))
  return { repo, events: join(state, 'events.jsonl'), ret: join(state, 'executions', '20261001-120000', 'returns', 'a-r1.json'), merged: JSON.stringify(events[2]) + '\n' }
}

test('a dry run lists the rewrites and writes nothing; --yes writes them and the stamp; a second run writes nothing', (t) => {
  const s = oldStore(t)
  const before = [readFileSync(s.events, 'utf8'), readFileSync(s.ret, 'utf8')]
  const dry = run(s.repo)
  assert.equal(dry.status, 0, dry.stderr)
  const listed = JSON.parse(dry.stdout)
  assert.deepEqual(listed.events, [{ effort: 'e1', withdrawn: 1, messages: [{ seq: 1, msg: 'continue_search' }] }])
  assert.equal(listed.returns.length, 1)
  assert.deepEqual([readFileSync(s.events, 'utf8'), readFileSync(s.ret, 'utf8')], before)
  assert.equal(storeVersion(s.repo), 0)

  assert.equal(run(s.repo, '--yes').status, 0)
  assert.equal(readFileSync(s.events, 'utf8'), s.merged)
  assert.deepEqual(JSON.parse(readFileSync(s.ret, 'utf8')).unread, [{ kind: 'doc', path: 'docs/api.md', what: '' }])
  assert.equal(storeVersion(s.repo), 1)

  const again = JSON.parse(run(s.repo, '--yes').stdout)
  assert.deepEqual([again.events, again.returns], [[], []])
  assert.equal(readFileSync(s.events, 'utf8'), s.merged)
})

test('a store stamped past 1 is refused and left as it is', (t) => {
  const s = oldStore(t)
  mkdirSync(join(s.repo, '.agentics', '.state'), { recursive: true })
  writeFileSync(storeStampPath(s.repo), JSON.stringify({ version: 2 }))
  const before = readFileSync(s.events, 'utf8')
  const out = run(s.repo, '--yes')
  assert.equal(out.status, 1)
  assert.equal(readFileSync(s.events, 'utf8'), before)
  assert.equal(storeVersion(s.repo), 2)
})
