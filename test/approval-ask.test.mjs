// test/approval-ask.test.mjs — before the user is asked to approve a spec, the spec is compiled in
// preview: a text compile would refuse gets no token and names its problems, and approving it is
// refused without asking anyone.
//
// Design: docs/DESIGN.md#the-users-word.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { actToken, approvalState, approveAct, askState, recordApproval } from '../lib/approval.mjs'
import { compileEffort } from '../lib/compile.mjs'
import { readLog } from '../lib/ledger.mjs'
import { specPath } from '../lib/store.mjs'

const FIXTURES = fileURLToPath(new URL('./fixtures/compile/', import.meta.url))
const read = (name) => readFileSync(join(FIXTURES, name), 'utf8').replace(/\r\n/g, '\n')
const ROOT = read('root.md')
const API = read('api.md')
// The api folder's task restating the contract its entry promises, at a path outside the promise:
// compile refuses the second provider, and so does the spec check before it.
const SECOND_PROVIDER = API.replace('reads: src/api/types.js', 'reads: src/api/types.js · provides: config-api (src/reload.js)')
const E = 'e1'

function effort(t, api) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-approval-ask-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  for (const [id, text] of [['.', ROOT], ['api', api]]) {
    mkdirSync(dirname(specPath(repo, E, id)), { recursive: true })
    writeFileSync(specPath(repo, E, id), text)
  }
  assert.equal(recordApproval(repo, E, '.').ok, true)
  assert.equal(compileEffort(repo, E).ok, true)
  return repo
}
const neverAsk = () => { throw new Error('nobody is asked about a spec compile refuses') }

test('a spec that compiles is asked about with its token', (t) => {
  const repo = effort(t, API)
  const st = askState(repo, E, 'api')
  assert.deepEqual([st.state, st.problems], ['none', []])
  assert.equal(st.token, actToken({ act: 'approve', folder: 'api', hash: approvalState(repo, E, 'api').hash }))
})

test('a spec compile would refuse gets no token, and names what compile refuses', (t) => {
  const repo = effort(t, SECOND_PROVIDER)
  const preview = compileEffort(repo, E, { folder: 'api', preview: 'api' })
  assert.equal(preview.ok, false)
  const st = askState(repo, E, 'api')
  assert.equal(st.token, '')
  for (const p of preview.problems) assert.ok(st.problems.some((q) => q.problem.includes(p.problem)), JSON.stringify(st.problems))
})

test('approving a spec compile would refuse is refused before anyone is asked, and records nothing', async (t) => {
  const repo = effort(t, SECOND_PROVIDER)
  const out = await approveAct(repo, E, 'api', { env: {}, stdinIsTTY: true, ask: neverAsk })
  assert.equal(out.ok, false)
  assert.match(JSON.stringify(out.error), /config-api/)
  assert.deepEqual(readLog(repo, E, 'ledger').entries.filter((l) => l.kind === 'approved' && l.folder === 'api'), [])
})
