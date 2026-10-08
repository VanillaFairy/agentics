import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

import { applies, check, id } from '../../tools/rules/size-budget.mjs'

const budgets = JSON.parse(readFileSync(new URL('../../tools/budgets.json', import.meta.url), 'utf8')).files

test('the rule id matches its file and it applies to agents, roles and skills only', () => {
  assert.equal(id, 'size-budget')
  assert.ok(applies.test('agents/courier.md'))
  assert.ok(applies.test('roles/scout.md'))
  assert.ok(applies.test('skills/develop/landing.md'))
  assert.ok(!applies.test('docs/DESIGN.md'))
  assert.ok(!applies.test('lib/tree.mjs'))
})

test('a file within its budget passes; one over it is named with both numbers', () => {
  assert.deepEqual(check('a\nb\n', 'agents/courier.md'), [])
  const over = check('x\n'.repeat(budgets['agents/courier.md'] + 1), 'agents/courier.md')
  assert.equal(over.length, 1)
  assert.match(over[0].message, new RegExp(String(budgets['agents/courier.md'] + 1) + ' lines against a budget of ' + budgets['agents/courier.md']))
})

test('a definition with no budget is a finding', () => {
  assert.match(check('x\n', 'agents/newcomer.md')[0].message, /no size budget/)
})

test('every shipped agent and skill file has a budget, and no budget names a file that is gone', () => {
  const shipped = [
    ...readdirSync(new URL('../../agents/', import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => 'agents/' + f),
    ...readdirSync(new URL('../../roles/', import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => 'roles/' + f),
    ...readdirSync(new URL('../../skills/', import.meta.url)).flatMap((d) =>
      readdirSync(new URL('../../skills/' + d + '/', import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => 'skills/' + d + '/' + f)),
  ].sort()
  assert.deepEqual(Object.keys(budgets).sort(), shipped)
})
