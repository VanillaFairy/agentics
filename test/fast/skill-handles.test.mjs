// test/fast/skill-handles.test.mjs — P2: no command a skill runs carries data.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applies, check, id } from '../../tools/rules/skill-handles.mjs'

test("it applies to the skills' files, and to nothing else", () => {
  assert.equal(id, 'skill-handles')
  assert.ok(applies.test('skills/develop/SKILL.md'))
  assert.ok(applies.test('skills/develop/landing.md'))
  assert.ok(!applies.test('service-workflows/x.workflow.js'))
  assert.ok(!applies.test('roles/scout.md'))
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
    assert.match(found[0].message, /^P2:/)
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
