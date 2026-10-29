// test/fast/store-stamp.test.mjs — the store version stamp: a store is stamped as it is born and
// never after, and tools/migrate-to-1.mjs's rewrites of what version 1 no longer reads.
//
// Design: docs/DESIGN.md#storage, docs/DESIGN.md#migrations.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { STORE_VERSION, mkdirState } from '../../lib/store.mjs'
import { eventsRewrite, returnRewrite } from '../../tools/migrate-to-1.mjs'

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-stamp-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const stampOf = (dir) => join(dir, '.agentics', '.state', 'store.json')

test('the directory that gives a store its first state stamps it at this version', (t) => {
  const dir = scratch(t)
  mkdirState(join(dir, '.agentics', 'e1', '.state'))
  assert.deepEqual(JSON.parse(readFileSync(stampOf(dir), 'utf8')), { version: STORE_VERSION })
})

test('a store that already holds state is never stamped by a later directory', (t) => {
  for (const held of [['.state'], ['e1', '.state']]) {
    const dir = scratch(t)
    mkdirSync(join(dir, '.agentics', ...held), { recursive: true })
    mkdirState(join(dir, '.agentics', 'e2', '.state'))
    assert.equal(existsSync(stampOf(dir)), false, held.join('/'))
  }
})

test('a withdrawn event, every message it names and every message of a kind version 1 cannot render are rewritten out', () => {
  const lines = [
    { seq: 1, kind: 'message', msg: 'continue_search', thread: 'x' },
    { seq: 2, kind: 'message', msg: 'findings', thread: 'x' },
    { seq: 3, kind: 'message', msg: 'failures', thread: 'x' },
    { seq: 4, kind: 'withdrawn', messages: [3] },
    { seq: 5, kind: 'merged', node: 'a' },
  ].map((r) => JSON.stringify(r))
  const out = eventsRewrite([...lines, 'not json', ''].join('\n'))
  assert.equal(out.text, [lines[1], lines[4], 'not json', ''].join('\n'))
  assert.deepEqual(out.dropped, { withdrawn: 1, messages: [{ seq: 1, msg: 'continue_search' }, { seq: 3, msg: 'failures' }] })
  assert.equal(eventsRewrite(out.text).text, out.text, 'a second pass changes nothing')
})

test("a stored return's lines of text in unread are typed: blank dropped, one path a path, any other line what it says", () => {
  const typed = { kind: 'source', path: 'src/a.ts', what: 'its API' }
  const out = returnRewrite({ status: 'done', unread: [' ', ' docs/api.md ', 'the save format — not in the brief', typed] })
  assert.deepEqual(out.unread, [
    { kind: 'doc', path: 'docs/api.md', what: '' },
    { kind: 'doc', path: '', what: 'the save format — not in the brief' },
    typed,
  ])
  assert.equal(out.status, 'done')
  assert.equal(returnRewrite(out), null, 'a typed return is left as it is')
  assert.equal(returnRewrite({ status: 'done' }), null)
})
