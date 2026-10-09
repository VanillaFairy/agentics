// test/execute-integrate-outside.test.mjs — the integration review is briefed on the work agentics
// did not produce: an adopted leaf's commits and a folder's outside commits.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { append } from '../lib/ledger.mjs'
import { reviewUnit } from '../lib/programs/execute/integrate.mjs'
import { executionRig } from './harness/program-rig.mjs'

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim()
function commitIn(worktree, files, subject) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(worktree, path)), { recursive: true })
    writeFileSync(join(worktree, path), text)
  }
  git(worktree, 'add', '-A')
  git(worktree, 'commit', '-q', '-m', subject)
  return git(worktree, 'rev-parse', 'HEAD')
}

test("the integration reviewer is told which commits a person made: an adopted leaf's and the folder's outside ones", { timeout: 120_000 }, async (t) => {
  const rig = executionRig(t)
  const wt = rig.worktreeOf('.')
  const leafWork = commitIn(wt, { 'src/a.mjs': 'export const a = () => 1\n' }, 'a, by hand')
  const stray = commitIn(wt, { 'docs/notes.md': 'notes\n' }, 'notes, by hand')
  rig.log.append('merged', { node: 'a', into: rig.branchOf('.'), merged_sha: leafWork, head_sha: leafWork, by: 'user', commits: [leafWork] })
  append(rig.repo, rig.effort, 'events', { kind: 'outside', node: '.', execution: '', commits: [stray], by: 'user' })
  rig.script({ 'reviewer|.|integration:.:1': [{ output: { units: [], findings: [], fix_rulings: [], claims: [], notes: '' } }] })
  const out = await reviewUnit(rig.ctx, rig.xc, { id: '.', where: { base: rig.base_sha, worktree: wt }, unreviewed: ['a'] })
  assert.equal(out.outcome, 'reviewed', JSON.stringify(out))
  const brief = rig.calls[0].brief
  assert.ok(brief.includes('## Work agentics did not produce'))
  assert.ok(brief.includes(leafWork) && brief.includes(stray), 'both shas are named')
  assert.ok(brief.split('\n').includes('- criterion:a#1'), "the adopted leaf's criterion is a unit")
})
