// test/courier-handles.test.mjs — GP6: no command a model is handed carries data.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applies, check } from '../tools/rules/courier-handles.mjs'

test('it applies to workflows, agents and skills, and to nothing else', () => {
  assert.ok(applies.test('service-workflows/x.workflow.js'))
  assert.ok(applies.test('agents/courier.md'))
  assert.ok(applies.test('skills/develop/SKILL.md'))
  assert.ok(!applies.test('lib/boundary.mjs'))
  assert.ok(!applies.test('docs/DESIGN.md'))
})

test('every way of putting data into a command is flagged on its line', () => {
  for (const line of [
    "cli + ' --digest ' + d + ' --b64 ' + base64(json)",
    'node lib/evidence.mjs record --json-file "x.json"',
    'node lib/gotchas.mjs add --stdin',
    "printf '%s' '{\"a\":1}' > token.json",
    "node lib/ledger.mjs append <<'AGENTICS_EOF'",
    'cat x.json | node lib/ledger.mjs append',
  ]) {
    const found = check('const a = 1\n' + line)
    assert.equal(found.length, 1, line)
    assert.equal(found[0].line, 2)
    assert.match(found[0].message, /GP6/)
  }
})

test('a command of handles passes', () => {
  const src = [
    'node "$R/lib/boundary.mjs" retry --repo "C:/r" --effort e1 --node a/b --node c',
    'node "$R/lib/evidence.mjs" record --kind survey --from "C:/r/.agentics/.state/evidence/inbox/judge.json"',
    'const shifted = a << 2',
  ].join('\n')
  assert.deepEqual(check(src), [])
})
