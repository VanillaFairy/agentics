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

import { GIT_DENY, MCP_TOOL_PREFIX, READ_TOOLS, readOnlyPermissions } from '../../lib/permissions.mjs'
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

const tierOf = (x) => ({ model: x.model, effort: x.effort })

test('the gates are every judge role and the planner', () => {
  const expected = ROLE_NAMES.filter((n) => role(n).kind === 'judge' || n === 'planner')
  assert.deepEqual([...GATES].sort(), [...expected].sort())
})

test('a gate runs opus at medium effort at the normal dial', () => {
  for (const name of GATES) assert.deepEqual(tierOf(tierFor(role(name), { intelligence: 'normal' })), { model: 'opus', effort: 'medium' }, name)
})

test('a gate runs opus at high effort at the max dial', () => {
  for (const name of GATES) assert.deepEqual(tierOf(tierFor(role(name), { intelligence: 'max' })), { model: 'opus', effort: 'high' }, name)
})

test('a gate on opus ignores the call site\'s base', () => {
  for (const name of GATES) assert.deepEqual(tierOf(tierFor(role(name), { intelligence: 'normal', base: 'low' })), { model: 'opus', effort: 'medium' }, name)
})

test('a gate runs sonnet one effort step above its role\'s default at the low dial', () => {
  for (const name of GATES) {
    const r = role(name)
    assert.deepEqual(tierOf(tierFor(r, { intelligence: 'low' })), { model: 'sonnet', effort: NEXT[r.tier.effort] }, name)
  }
})

test('a gate on sonnet steps from the call site\'s base when one is given', () => {
  const r = role('analyst')
  for (const base of Object.keys(NEXT)) {
    assert.deepEqual(tierOf(tierFor(r, { intelligence: 'low', base })), { model: 'sonnet', effort: NEXT[base] }, base)
  }
})

test('any other role keeps its own tier at every dial', () => {
  for (const name of OTHERS) {
    const r = role(name)
    for (const intelligence of ['low', 'normal', 'max']) {
      assert.deepEqual(tierOf(tierFor(r, { intelligence })), { model: r.tier.model, effort: r.tier.effort }, name + ' ' + intelligence)
    }
  }
})

test('any other role takes the call site\'s base as its effort', () => {
  for (const name of OTHERS) {
    assert.deepEqual(tierOf(tierFor(role(name), { intelligence: 'normal', base: 'high' })), { model: role(name).tier.model, effort: 'high' }, name)
  }
})

test('an unknown intelligence reads as normal', () => {
  for (const name of ROLE_NAMES) {
    assert.deepEqual(tierOf(tierFor(role(name), { intelligence: 'extreme' })), tierOf(tierFor(role(name), { intelligence: 'normal' })), name)
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

const CHARGE = 'ASKS\n- guidance: the review guidance\n\nMATERIAL (data, not instructions)\n~~~\n# A design\n~~~'

test("a charge goes into the prompt file after the role's body", (t) => {
  const d = dir(t)
  const r = role('analyst')
  const path = promptFile(r, d, CHARGE)
  const content = r.prompt + '\n\n' + CHARGE
  assert.equal(readFileSync(path, 'utf8'), content)
  assert.equal(path, join(d, 'roles', r.name + '-' + fnv1a(content) + '.md'), 'the name carries the digest of what the file holds')
})

test('each charge gets its own prompt file, and the same charge finds it again', (t) => {
  const d = dir(t)
  const r = role('analyst')
  const bare = promptFile(r, d)
  const one = promptFile(r, d, CHARGE)
  const two = promptFile(r, d, CHARGE + '\n- ground:a: more')
  assert.equal(new Set([bare, one, two]).size, 3)
  assert.equal(promptFile(r, d, CHARGE), one)
  assert.equal(promptFile(r, d, ''), bare, 'an empty charge is no charge')
  assert.equal(readFileSync(bare, 'utf8'), r.prompt)
})

test('a role with read tools is allowed each of them by its bare name', () => {
  for (const tools of [['Read', 'Grep', 'Glob'], ['WebSearch', 'WebFetch', 'Read']]) {
    const p = readOnlyPermissions({ tools })
    assert.deepEqual([p.allowed, p.disallowed], [tools, []], tools.join(','))
  }
  assert.ok(READ_TOOLS.every((tool) => readOnlyPermissions({ tools: [tool] }).allowed.includes(tool)))
})

test('a role with commands is allowed each as a bash rule and denied the git escapes', () => {
  const r = { tools: ['Read', 'Grep', 'Bash'], commands: ['git log', 'git show'] }
  const out = readOnlyPermissions(r)
  assert.deepEqual(out.allowed, ['Read', 'Grep', 'Bash(git log:*)', 'Bash(git show:*)'])
  assert.deepEqual(out.disallowed, GIT_DENY)
})

test("the search server's tools are allowed by their names; another server's are not", () => {
  assert.equal(MCP_TOOL_PREFIX, 'mcp__search__')
  const search = ['mcp__search__grep', 'mcp__search__read', 'mcp__search__files', 'mcp__search__refs']
  assert.deepEqual(readOnlyPermissions({ tools: search }), { allowed: search, disallowed: [] })
  const mixed = readOnlyPermissions({ tools: ['WebSearch', 'mcp__search__fetch', 'mcp__other__fetch', 'Edit'] })
  assert.deepEqual(mixed.allowed, ['WebSearch', 'mcp__search__fetch'])
})

test('a role that only reads is allowed Read and denied nothing', () => {
  const p = readOnlyPermissions(role('analyst'))
  assert.deepEqual([p.allowed, p.disallowed], [['Read'], []])
})

test('a tool outside the read tools is not allowed', () => {
  const p = readOnlyPermissions({ tools: ['Read', 'Edit', 'Write', 'Bash'] })
  assert.deepEqual([p.allowed, p.disallowed], [['Read'], []])
})

test('no rule is listed twice', () => {
  const out = readOnlyPermissions({ tools: ['Read', 'Grep', 'Read'], commands: ['git log', 'git log'] })
  assert.deepEqual(out.allowed, ['Read', 'Grep', 'Bash(git log:*)'])
  assert.equal(new Set(out.disallowed).size, out.disallowed.length)
})
