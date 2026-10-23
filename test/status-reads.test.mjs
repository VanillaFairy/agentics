// test/status-reads.test.mjs — one status read asks each execution once: a snapshot, or one node's
// entry, reads each execution's records once and asks once whether its run is live, so its cost and
// its nodes' live activity read the same answer.
//
// Design: docs/DESIGN.md#snapshot, docs/DESIGN.md#live-activity.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { append, fileFor, seqMax } from '../lib/ledger.mjs'
import { nodeOf, snapshotOf } from '../lib/status.mjs'
import { executionDir, executionRunId, posix, runJsonPath, writeJson } from '../lib/store.mjs'

const E = 'eff'
const X = '20260904-100000'

/** An effort whose merged leaf `x` made one call in execution X, with a journal line there. */
function effort(t) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-status-reads-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const ok = (out) => assert.equal(out.ok, true, out.error)
  ok(append(repo, E, 'nodes', [
    { kind: 'node', node: { id: '.', title: 'make .', kind: 'composite' } },
    { kind: 'node', node: { id: 'x', title: 'do x', kind: 'leaf', rigor: 'trivial', expects: ['src/x.js'], acceptance: [{ text: 't', check: 'c' }] } },
  ]))
  mkdirSync(executionDir(repo, E, X), { recursive: true })
  writeFileSync(join(executionDir(repo, E, X), 'execution.json'), JSON.stringify({ root: '.' }))
  const dispatch = 'x.implementer.producer-x.r1'
  ok(append(repo, E, 'events', { kind: 'dispatched', node: 'x', execution: X, dispatch, role: 'implementer', round: 1, model: 'sonnet', effort: 'medium' }))
  ok(append(repo, E, 'state:' + X, {
    kind: 'returned', dispatch, session: 's', status: 'returned', cause: '', usage: { input_tokens: 1, output_tokens: 1 }, cost_total: 0.5, cost_usd: 0.5, denials: [],
  }))
  ok(append(repo, E, 'journal:' + X, { kind: 'authored', node: 'x' }))
  ok(append(repo, E, 'events', { kind: 'merged', node: 'x', execution: X, into: 'agentics/' + E, merged_sha: 'm', head_sha: 'h' }))
  return repo
}

/** How many times `fn` reads `path` through fs.readFileSync, the reader every log and JSON file goes through. */
function readsOf(path, fn) {
  const real = fs.readFileSync
  const want = posix(path)
  let n = 0
  fs.readFileSync = function (p, ...rest) {
    if (typeof p === 'string' && posix(p) === want) n += 1
    return real.call(this, p, ...rest)
  }
  syncBuiltinESMExports()
  try {
    fn()
  } finally {
    fs.readFileSync = real
    syncBuiltinESMExports()
  }
  return n
}

const journalOf = (repo) => fileFor(repo, E, 'journal:' + X).path

test("a snapshot reads each execution's records once", (t) => {
  const repo = effort(t)
  // A snapshot also asks `seqMax`, which rebuilds its counter from every log on disk: not a read of the records.
  const forSeq = readsOf(journalOf(repo), () => seqMax(repo, E))
  assert.equal(readsOf(journalOf(repo), () => snapshotOf(repo, E)) - forSeq, 1)
})

test("one node's entry reads each execution's records once", (t) => {
  const repo = effort(t)
  assert.equal(readsOf(journalOf(repo), () => nodeOf(repo, E, 'x')), 1)
})

test("a snapshot asks once whether each execution's run is live, so its cost and its nodes read one answer", (t) => {
  const repo = effort(t)
  const run = executionRunId(E, X)
  writeJson(runJsonPath(repo, run), { run, pid: process.pid, heartbeat_at: new Date().toISOString() })
  assert.equal(readsOf(runJsonPath(repo, run), () => snapshotOf(repo, E)), 1)
})
