// test/folder-flag.test.mjs — pins how every session CLI that takes `--folder` reads it: the root by
// each of its names, and a name with no spec refused before anything is written.
//
// Design: docs/DESIGN.md#data-contracts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { openEffort } from '../lib/effort.mjs'
import { readLog } from '../lib/ledger.mjs'
import { effortDir, posix, specPath } from '../lib/store.mjs'
import { seededRepo } from './harness/seeded-repo.mjs'

const E = 'console-commands'
const SPEC = ['# Add a console', '', '## Intent', '', 'A console.', '', '## Decisions', '', '| id | decision | why |', '|---|---|---|',
  '| D1 | It has a console. | Asked. |', '', '## Design', '', 'One module.', '', '## Plan', '', '## Open questions', '', '## Evidence', '', 'None yet.', ''].join('\n')

/** A repository with the effort `console-commands` open and its root spec written. */
function world(t) {
  const repo = seededRepo('agentics-folder-flag-', { message: 'init', files: { 'a.txt': 'x\n' }, autocrlf: false })
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  assert.equal(openEffort(repo, { slug: E, about: 'a dev console', roots: '.' }).ok, true)
  writeFileSync(specPath(repo, E, '.'), SPEC)
  return repo
}

/** One call of a lib CLI: what it printed, parsed, and its exit code. */
function call(repo, script, ...args) {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../lib/' + script, import.meta.url)), ...args, '--repo', repo, '--effort', E], { encoding: 'utf8' })
  return { out: JSON.parse(r.stdout), code: r.status }
}

/** Each CLI that takes `--folder`, with what its answer says of the folder it acted on. */
const CALLS = [
  ['spec.mjs check', ['spec.mjs', 'check'], (o) => o.payload.folder],
  ['approval.mjs state', ['approval.mjs', 'state'], (o) => o.payload.token.split('@')[0]],
  ['compile.mjs', ['compile.mjs'], (o) => o.payload.problems[0].file],
  ['evidence.mjs cite', ['evidence.mjs', 'cite', '--gap', 'a gap'], (o, repo) => readLog(repo, E, 'cites').entries.at(-1).folder + ' ' + o.payload.ok],
  ['render.mjs evidence', ['render.mjs', 'evidence'], (o) => o.payload.path],
]

test('every CLI reads no --folder, `.` and the effort\'s own name as the root', (t) => {
  const repo = world(t)
  for (const [name, args, folderIn] of CALLS) {
    const [none, dot, named] = [[], ['--folder', '.'], ['--folder', E]].map((flag) => folderIn(call(repo, ...args, ...flag).out, repo))
    assert.equal(none, dot, name + ' with no --folder')
    assert.equal(named, dot, name + ' with the effort\'s name')
  }
  assert.equal(call(repo, 'spec.mjs', 'check', '--folder', E).out.payload.folder, '.')
  assert.equal(call(repo, 'render.mjs', 'evidence', '--folder', E).out.payload.path, posix(join(effortDir(repo, E), 'evidence.md')))
})

test('every CLI refuses a folder with no spec, naming it and how folders are named, and writes nothing', (t) => {
  const repo = world(t)
  const before = [readdirSync(effortDir(repo, E)).sort(), readLog(repo, E, 'cites').entries.length, readLog(repo, E, 'ledger').entries.length]
  const more = [['approval.mjs dispose', ['approval.mjs', 'dispose', '--finding', 'F1', '--outcome', 'discarded', '--by', 'user']]]
  for (const [name, args] of [...CALLS, ...more]) {
    const { out } = call(repo, ...args, '--folder', 'bogus')
    assert.equal(out.kind || out.payload.error.kind, 'unknown_folder', name + ': ' + JSON.stringify(out))
    if (out.error) for (const part of ['"bogus"', '.agentics/' + E + '/bogus/DESIGN.md', '"."', '"' + E + '"']) assert.ok(out.error.includes(part), name + ' says ' + part)
  }
  assert.deepEqual([readdirSync(effortDir(repo, E)).sort(), readLog(repo, E, 'cites').entries.length, readLog(repo, E, 'ledger').entries.length], before)
  assert.equal(call(repo, 'render.mjs', 'evidence').code, 0)
  const stray = spawnSync(process.execPath, [fileURLToPath(new URL('../lib/render.mjs', import.meta.url)), 'evidence', '--repo', repo, '--effort', 'nope'], { encoding: 'utf8' })
  assert.equal(JSON.parse(stray.stdout).kind, 'unknown_effort')
  assert.equal(existsSync(effortDir(repo, 'nope')), false, 'no effort is made by naming one')
})
