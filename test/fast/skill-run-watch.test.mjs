// test/fast/skill-run-watch.test.mjs — pins where every skill following a detached run starts its watch,
// and that it says what to do when the run ends failed or never launched. A program run's log is
// its own, so its watch starts at the log's start, `--since 0` (docs/DESIGN.md#detached-runs). An
// execution's log spans every run of it, so the skill that starts `execute` watches from the
// effort's `seq` it read from `lib/status.mjs list` before the start (docs/DESIGN.md#progress).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WATCH = 'status.mjs" watch --repo . --run'
const EXECUTE = 'lib/run.mjs" execute'
const SKILLS = fileURLToPath(new URL('../../skills/', import.meta.url))
const skillFiles = readdirSync(SKILLS, { recursive: true })
  .filter((p) => p.endsWith('.md'))
  .map((p) => ({ path: 'skills/' + p.split('\\').join('/'), text: readFileSync(join(SKILLS, p), 'utf8') }))
const watching = skillFiles.filter((f) => f.text.includes(WATCH))

test('some skill follows a detached run', () => {
  assert.ok(watching.length > 0)
})

for (const { path, text } of watching) {
  const lines = text.split('\n')
  const watches = lines.filter((l) => l.includes(WATCH))
  if (text.includes(EXECUTE)) {
    test(path + ' watches its execution from the seq it read before the start', () => {
      const start = lines.findIndex((l) => l.includes(EXECUTE))
      const read = lines.findIndex((l) => l.includes('status.mjs" list --repo .') && l.includes('seq'))
      assert.ok(read >= 0 && read < start, 'reads the effort seq from lib/status.mjs list before the start')
      for (const line of watches) assert.match(line, /--run <run> --since <seq>/, line)
    })
  } else {
    test(path + ' watches each run from the start of its log', () => {
      for (const line of watches) assert.match(line, /--run <run> --since 0/, line)
    })
  }

  test(path + ' says what to do when a run ends failed or never launches', () => {
    assert.ok(text.includes('`ended failed`'), 'names ended failed')
    assert.ok(text.includes('`launch_failed`'), 'names launch_failed')
  })
}
