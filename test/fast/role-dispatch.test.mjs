// test/fast/role-dispatch.test.mjs — pins what a dispatch takes from its role: its tier under the user's
// intelligence dial, its system prompt as a file on disk, and the permission rules of a role that
// writes nothing.
//
// Design: docs/DESIGN.md#model-tier and docs/DESIGN.md#roles.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { GIT_DENY, READ_TOOLS, readOnlyPermissions } from '../../lib/locus.mjs'
import { fnv1a } from '../../lib/plan-digest.mjs'
import { GATES, ROLE_NAMES, loadRole, promptFile, tierFor } from '../../lib/roles.mjs'

const role = (name) => {
  const r = loadRole(name)
  assert.equal(r.ok, true, name)
  return r.role
}
const NEXT = { low: 'medium', medium: 'high', high: 'xhigh', xhigh: 'xhigh' }
const OTHERS = ROLE_NAMES.filter((n) => !GATES.includes(n))

function dir(t) {
  const d = mkdtempSync(join(tmpdir(), 'agentics-role-dispatch-'))
  t.after(() => rmSync(d, { recursive: true, force: true }))
  return d
}

test('the gates are every judge role and the planner', () => {
  const expected = ROLE_NAMES.filter((n) => role(n).kind === 'judge' || n === 'planner')
  assert.deepEqual([...GATES].sort(), [...expected].sort())
})

test('a gate runs opus at medium effort at the normal dial', () => {
  for (const name of GATES) assert.deepEqual(tierFor(role(name)), { model: 'opus', effort: 'medium' }, name)
})

test('a gate runs opus at high effort at the max dial', () => {
  for (const name of GATES) assert.deepEqual(tierFor(role(name), { intelligence: 'max' }), { model: 'opus', effort: 'high' }, name)
})

test('a gate on opus ignores the call site\'s base', () => {
  for (const name of GATES) assert.deepEqual(tierFor(role(name), { base: 'low' }), { model: 'opus', effort: 'medium' }, name)
})

test('a gate runs sonnet one effort step above its role\'s default at the low dial', () => {
  for (const name of GATES) {
    const r = role(name)
    assert.deepEqual(tierFor(r, { intelligence: 'low' }), { model: 'sonnet', effort: NEXT[r.tier.effort] }, name)
  }
})

test('a gate on sonnet steps from the call site\'s base when one is given', () => {
  const r = role('analyst')
  for (const base of Object.keys(NEXT)) {
    assert.deepEqual(tierFor(r, { intelligence: 'low', base }), { model: 'sonnet', effort: NEXT[base] }, base)
  }
})

test('any other role keeps its own tier at every dial', () => {
  for (const name of OTHERS) {
    const r = role(name)
    for (const intelligence of ['low', 'normal', 'max']) {
      assert.deepEqual(tierFor(r, { intelligence }), { model: r.tier.model, effort: r.tier.effort }, name + ' ' + intelligence)
    }
  }
})

test('any other role takes the call site\'s base as its effort', () => {
  for (const name of OTHERS) {
    assert.deepEqual(tierFor(role(name), { base: 'high' }), { model: role(name).tier.model, effort: 'high' }, name)
  }
})

test('an unknown intelligence reads as normal', () => {
  for (const name of ROLE_NAMES) {
    assert.deepEqual(tierFor(role(name), { intelligence: 'extreme' }), tierFor(role(name)), name)
  }
})

test('the prompt file holds the role\'s body and no frontmatter', (t) => {
  const d = dir(t)
  const r = role('scout')
  const path = promptFile(r, d)
  assert.ok(isAbsolute(path))
  assert.equal(path, join(d, 'roles', r.name + '-' + fnv1a(r.prompt) + '.md'))
  assert.equal(readFileSync(path, 'utf8'), r.prompt)
  assert.ok(!readFileSync(path, 'utf8').startsWith('---'))
})

test('the prompt file is written once and found again', (t) => {
  const d = dir(t)
  const r = role('analyst')
  const path = promptFile(r, d)
  writeFileSync(path, 'kept')
  assert.equal(promptFile(r, d), path)
  assert.equal(readFileSync(path, 'utf8'), 'kept')
})

test('a prompt file that is gone is written again', (t) => {
  const d = dir(t)
  const r = role('reviewer')
  rmSync(promptFile(r, d))
  assert.equal(readFileSync(promptFile(r, d), 'utf8'), r.prompt)
})

test('a changed prompt gets a file of its own', (t) => {
  const d = dir(t)
  const r = role('ruler')
  const first = promptFile(r, d)
  const second = promptFile({ ...r, prompt: r.prompt + '\nOne more line.' }, d)
  assert.notEqual(second, first)
  assert.equal(readFileSync(first, 'utf8'), r.prompt)
  assert.equal(readFileSync(second, 'utf8'), r.prompt + '\nOne more line.')
})

test('no temporary file is left beside a prompt file', (t) => {
  const d = dir(t)
  const path = promptFile(role('historian'), d)
  assert.deepEqual(readdirSync(dirname(path)), [basename(path)])
})

test('a searcher with read tools is allowed each of them by its bare name', () => {
  for (const name of ['scout', 'doc-researcher']) {
    const r = role(name)
    assert.deepEqual(readOnlyPermissions(r), { allowed: r.tools, disallowed: [] }, name)
    assert.ok(r.tools.every((tool) => READ_TOOLS.includes(tool)), name)
  }
})

test('a role with commands is allowed each as a bash rule and denied the git escapes', () => {
  const r = role('historian')
  const out = readOnlyPermissions(r)
  const reads = r.tools.filter((tool) => READ_TOOLS.includes(tool))
  assert.deepEqual(out.allowed, [...reads, ...r.commands.map((c) => 'Bash(' + c + ':*)')])
  assert.deepEqual(out.disallowed, GIT_DENY)
})

test('a role that only reads is allowed Read and denied nothing', () => {
  assert.deepEqual(readOnlyPermissions(role('analyst')), { allowed: ['Read'], disallowed: [] })
})

test('a tool outside the read tools is not allowed', () => {
  assert.deepEqual(readOnlyPermissions({ tools: ['Read', 'Edit', 'Write', 'Bash'] }), { allowed: ['Read'], disallowed: [] })
})

test('no rule is listed twice', () => {
  const out = readOnlyPermissions({ tools: ['Read', 'Grep', 'Read'], commands: ['git log', 'git log'] })
  assert.deepEqual(out.allowed, ['Read', 'Grep', 'Bash(git log:*)'])
  assert.equal(new Set(out.disallowed).size, out.disallowed.length)
})
