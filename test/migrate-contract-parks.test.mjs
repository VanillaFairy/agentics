// test/migrate-contract-parks.test.mjs — tools/migrate-contract-parks.mjs: an open `contract_changed`
// park an earlier version raised on an edit that never touched the contract is cleared without a
// replan; one whose contract did change, or whose texts are not kept, is listed and left.
//
// Design: docs/DESIGN.md#a-changed-spec.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { recordApproval } from '../lib/approval.mjs'
import { compileEffort } from '../lib/compile.mjs'
import { append } from '../lib/ledger.mjs'
import { specPath } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { plan } from '../tools/migrate-contract-parks.mjs'

const FIXTURES = fileURLToPath(new URL('./fixtures/compile/', import.meta.url))
const read = (name) => readFileSync(join(FIXTURES, name), 'utf8').replace(/\r\n/g, '\n')
const E = 'e1'
const ROOT = read('root.md')
const API = read('api.md')

/** An effort whose api spec, providing config-type to `cli`, was re-approved with `edited` and compiled, then parked `cli` as 6.14.2 did. */
function parkedAfter(t, edited, base = API) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-migrate-parks-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const write = (id, text) => {
    mkdirSync(dirname(specPath(repo, E, id)), { recursive: true })
    writeFileSync(specPath(repo, E, id), text)
  }
  write('.', ROOT)
  write('api', base)
  for (const id of ['.', 'api']) assert.equal(recordApproval(repo, E, id).ok, true)
  assert.equal(compileEffort(repo, E).ok, true)
  write('api', edited)
  assert.equal(recordApproval(repo, E, 'api').ok, true)
  assert.equal(compileEffort(repo, E).ok, true)
  const question = 'the spec .agentics/' + E + '/api/DESIGN.md that provides config-type changed — re-spec this node against it, approve it again and recompile'
  assert.equal(append(repo, E, 'events', [{ kind: 'parked', node: 'cli', execution: '', return: 'contract_changed', question }]).ok, true)
  assert.equal(readTree(repo, E).status.get('cli').status, 'parked')
  return repo
}

test('a park raised on a plan-only edit of the provider is cleared; one on an edit of its Design is left', (t) => {
  const planOnly = parkedAfter(t, API.replace('Use the existing tokenizer.', 'Use the existing tokenizer, kept pure.'))
  assert.deepEqual(plan(planOnly, E), { cleared: [{ node: 'cli', contract: 'config-type', provider: '.agentics/e1/api/DESIGN.md' }], left: [] })

  const design = parkedAfter(t, API.replace('`load(path)`, then `parse(text)`.', '`load(path)` returns a frozen object.'))
  assert.deepEqual(plan(design, E).cleared, [])
  assert.deepEqual(plan(design, E).left, [{ node: 'cli', why: 'config-type changed in .agentics/e1/api/DESIGN.md' }])
})

test('the migration keeps the reader of the time: an edit beside the paragraph naming the contract is cleared', (t) => {
  const base = API.replace('`load(path)`, then `parse(text)`.', '`load(path)`, then `parse(text)`.\n\nconfig-type is a plain object.')
  const beside = parkedAfter(t, base.replace('`load(path)`, then `parse(text)`.', '`load(path)` reads; `parse(text)` maps.'), base)
  assert.deepEqual(plan(beside, E).cleared, [{ node: 'cli', contract: 'config-type', provider: '.agentics/e1/api/DESIGN.md' }])
})
