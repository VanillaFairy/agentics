// test/fast/git-command.test.mjs — pins what every git the plugin runs is held to, so a run never
// waits on a prompt, an editor, a lazy fetch or an automatic gc nobody started.
//
// Design: docs/DESIGN.md#the-process-model.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { gitCommand } from '../../lib/store.mjs'

test('a git command can wait on nothing nobody will answer', () => {
  const { argv, env } = gitCommand('/repo', ['merge', '--no-edit', 'b'])
  assert.equal(env.GIT_TERMINAL_PROMPT, '0', 'no credential prompt')
  assert.equal(env.GIT_EDITOR, 'true', 'no editor')
  assert.equal(env.GIT_NO_LAZY_FETCH, '1', "no fetch of a partial clone's missing object")
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0', "no optional index lock beside a producer's own git")
  const config = argv.slice(0, argv.indexOf('-C'))
  assert.ok(config.includes('gc.auto=0') && config.includes('maintenance.auto=false'), 'no automatic gc or maintenance')
  assert.deepEqual(argv.slice(argv.indexOf('-C')), ['-C', '/repo', 'merge', '--no-edit', 'b'])
})

test("a caller's env goes over the held env and the process's own", () => {
  const { env } = gitCommand('/repo', ['status'], { GIT_INDEX_FILE: '/tmp/i', GIT_EDITOR: 'vi' })
  assert.equal(env.GIT_INDEX_FILE, '/tmp/i')
  assert.equal(env.GIT_EDITOR, 'vi')
  assert.equal(env.PATH ?? env.Path, process.env.PATH ?? process.env.Path)
})
