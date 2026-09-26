import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, plan } from '../tools/migrate-legacy.mjs'

test('the migration moves pre-tree state out of the live paths and evidence into evidence/', () => {
  const r = mkdtempSync(join(tmpdir(), 'agentics-migrate-'))
  const a = join(r, '.claude', 'agentics')
  mkdirSync(join(a, 'runs', '20260901-100000'), { recursive: true })
  mkdirSync(join(a, 'kb'), { recursive: true })
  mkdirSync(join(a, 'efforts', 'e1', 'surveys'), { recursive: true })
  mkdirSync(join(a, 'efforts', 'e1', 'probes'), { recursive: true })
  writeFileSync(join(a, 'efforts', 'e1', 'effort.json'), JSON.stringify({ about: 'x', roots: ['.'], opened_at: 'now' }))
  writeFileSync(join(a, 'efforts', 'e1', 'surveys', '20260901-100000.json'), '{"coverage":{"complete":true}}')
  writeFileSync(join(a, 'efforts', 'e1', 'surveys', '20260901-100000.anchor'), '{"observed_at":"","ground":["."]}')
  writeFileSync(join(a, 'efforts', 'e1', 'probes', '20260902-100000.json'), '{}')
  writeFileSync(join(a, 'efforts', 'e1', 'links.jsonl'), '{"kind":"run","value":"20260901-100000"}\n')

  const p = plan(r, '20260925-000000')
  assert.equal(existsSync(join(a, 'runs')), true, 'planning moves nothing')
  apply(p.moves)
  assert.equal(existsSync(join(a, 'runs')), false)
  assert.equal(existsSync(join(a, 'legacy', '20260925-000000', 'runs', '20260901-100000')), true)
  assert.equal(existsSync(join(a, 'legacy', '20260925-000000', 'kb')), true)
  assert.equal(existsSync(join(a, 'legacy', '20260925-000000', 'links', 'e1.jsonl')), true)
  assert.match(p.notes.join(' '), /1 run\(s\) move to legacy/)
})
