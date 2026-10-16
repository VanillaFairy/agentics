// test/repo-hygiene.test.mjs — `.gitignore` excludes `docs/superpowers/` as vf-superpowers'
// planning scratch, and CLAUDE.md calls it a workspace file, never committed. A commit that force-
// adds it anyway ships a process log, with local paths, inside the plugin the marketplace
// submodule carries (I5).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))

test('nothing under the gitignored docs/superpowers/ is tracked', () => {
  const tracked = execFileSync('git', ['-C', REPO, 'ls-files', 'docs/superpowers'], { encoding: 'utf8' })
    .split('\n').filter(Boolean)
  assert.deepEqual(tracked, [], 'tracked despite .gitignore: ' + tracked.join(', '))
})

// The rule that protects docs/superpowers/ names it; that one rule is the only mention allowed.
const RULES = {
  'CLAUDE.md': '- `docs/superpowers/` is gitignored scratch for the vf-superpowers planning skills; nothing in',
  'docs/DESIGN.md': '- `docs/superpowers/` is gitignored local scratch for planning sessions. Nothing in the repository',
}

test('CLAUDE.md and DESIGN.md name docs/superpowers/ only in the rule that protects it', () => {
  for (const [file, rule] of Object.entries(RULES)) {
    const lines = readFileSync(join(REPO, file), 'utf8').split(/\r?\n/)
    assert.ok(lines.includes(rule), file + ' keeps the rule naming docs/superpowers/')
    assert.deepEqual(lines.filter((l) => l.includes('superpowers') && l !== rule), [], file + ' points into docs/superpowers/')
  }
})
