// test/harness/review-world.mjs — what the program-review-snapshot and program-review-exit tests share:
// the review rig over a repository with a change, the scripted reviewer's rulings and findings, and
// the readers of the user's tree. Nothing here runs at import.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { posix } from '../../lib/store.mjs'
import { programRig } from './program-rig.mjs'

export const sh = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })

export const GUIDE = 'GUIDE-7f3a: loaders never throw on a missing key'
const A_COMMITTED = 'export const a = 1\n'
export const A_EDITED = 'export const a = 2 // edited in the working tree\n'
export const X_COMMITTED = 'agentics notes, committed\n'
const CRITERIA_LINES = [
  '- [ ] the loader returns a plain object',
  '- keys are case-insensitive',
  '',
  'HUMAN: the page reads well',
  '- [ ] HUMAN: the message is kind',
  'unknown keys are an error',
]
const CRITERIA = CRITERIA_LINES.join('\n')
export const CRITERION_TEXT = ['the loader returns a plain object', 'keys are case-insensitive', 'unknown keys are an error']

export const CHANGED = ['a.js', 'b.js', 'c.js', 'd.js']
const CRITERION_UNITS = CRITERION_TEXT.map((_, i) => 'criterion:' + (i + 1))
const FILE_UNITS = CHANGED.map((f) => 'file:' + f)
export const UNITS = [...CRITERION_UNITS, ...FILE_UNITS]

export const write = (root, path, text) => {
  const full = join(root, ...path.split('/'))
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, text)
}

/**
 * The user's checkout: a base commit, a commit after it, a stash entry, an edit, a staged file, an
 * untracked file, an ignored file, an edited `.agentics/` file and a file under `.claude/`.
 */
export function reviewRig(t, script = {}) {
  const rig = programRig({
    files: {
      'CLAUDE.md': '# Guidance\n\n' + GUIDE + '\n',
      'a.js': A_COMMITTED,
      'keep.js': 'export const keep = 1\n',
      '.gitignore': 'ignored.txt\n',
      '.agentics/x.md': X_COMMITTED,
    },
    script,
  })
  t.after(() => rig.cleanup())
  const base = sh(rig.repo, 'rev-parse', 'HEAD').trim()
  write(rig.repo, 'b.js', 'export const b = 1\n')
  sh(rig.repo, 'add', 'b.js')
  sh(rig.repo, 'commit', '-q', '-m', 'b')
  write(rig.repo, 'keep.js', 'export const keep = 2 // stashed\n')
  sh(rig.repo, 'stash', 'push', '-q')
  write(rig.repo, 'a.js', A_EDITED)
  write(rig.repo, 'd.js', 'export const d = 1\n')
  sh(rig.repo, 'add', 'd.js')
  write(rig.repo, 'c.js', 'export const c = 1\n')
  write(rig.repo, 'ignored.txt', 'ignored\n')
  write(rig.repo, '.agentics/x.md', 'agentics notes, edited\n')
  write(rig.repo, '.claude/worktrees/other/x.txt', 'another worktree\n')
  const dir = mkdtempSync(join(tmpdir(), 'agentics-review-criteria-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const criteriaFile = join(dir, 'criteria.md')
  writeFileSync(criteriaFile, CRITERIA + '\n')
  const args = (over = {}) => ({ base, criteria_file: criteriaFile, criteria: CRITERIA, prior: '', ...over })
  return { rig, base, args }
}

export const ruled = (unit, ruling = 'clean', ids = []) => ({ unit, ruling, ids, why: 'looked at ' + unit })
export const returnOf = ({ units = UNITS.map((u) => ruled(u)), findings = [], fix_rulings = [] } = {}) =>
  ({ units, findings, fix_rulings, claims: [], notes: '' })
export const scriptOf = (output) => ({ 'reviewer||reviewer': [{ output }] })

export const norm = (p) => {
  const out = posix(resolve(p))
  return process.platform === 'win32' ? out.toLowerCase() : out
}
export const worktreeOf = (rig) => join(rig.repo, '.claude', 'worktrees', 'review-' + rig.run)
export const listed = (repo, path) => sh(repo, 'worktree', 'list', '--porcelain').split('\n')
  .filter((l) => l.startsWith('worktree ')).some((l) => norm(l.slice('worktree '.length).trim()) === norm(path))

export const briefOf = (rig) => {
  assert.equal(rig.calls.length, 1)
  return rig.calls[0].brief
}
