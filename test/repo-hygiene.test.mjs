// test/repo-hygiene.test.mjs — `.gitignore` excludes `docs/superpowers/` as vf-superpowers'
// planning scratch, and CLAUDE.md calls it a workspace file, never committed. A commit that force-
// adds it anyway ships a process log, with local paths, inside the plugin the marketplace
// submodule carries (I5).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))

test('nothing under the gitignored docs/superpowers/ is tracked', () => {
  const tracked = execFileSync('git', ['-C', REPO, 'ls-files', 'docs/superpowers'], { encoding: 'utf8' })
    .split('\n').filter(Boolean)
  assert.deepEqual(tracked, [], 'tracked despite .gitignore: ' + tracked.join(', '))
})
