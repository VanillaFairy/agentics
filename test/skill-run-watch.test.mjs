// test/skill-run-watch.test.mjs — pins that every skill following a detached run watches it from
// the log's start and says what to do when the run ends failed or never launched.
//
// Design: docs/DESIGN.md#detached-runs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILLS = fileURLToPath(new URL('../skills/', import.meta.url))
const skillFiles = readdirSync(SKILLS, { recursive: true })
  .filter((p) => p.endsWith('.md'))
  .map((p) => ({ path: 'skills/' + p.split('\\').join('/'), text: readFileSync(join(SKILLS, p), 'utf8') }))
const watching = skillFiles.filter((f) => f.text.includes('status.mjs" watch --repo . --run'))

test('some skill follows a detached run', () => {
  assert.ok(watching.length > 0)
})

for (const { path, text } of watching) {
  test(path + ' watches each run from the start of its log', () => {
    const lines = text.split('\n').filter((l) => l.includes('status.mjs" watch --repo . --run'))
    for (const line of lines) assert.match(line, /--run <run> --since 0/, line)
  })

  test(path + ' says what to do when a run ends failed or never launches', () => {
    assert.ok(text.includes('`ended failed`'), 'names ended failed')
    assert.ok(text.includes('`launch_failed`'), 'names launch_failed')
  })
}
