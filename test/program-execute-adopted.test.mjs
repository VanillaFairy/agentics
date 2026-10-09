// test/program-execute-adopted.test.mjs — the execute program rules drift from adopted work
// before any leaf runs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { append } from '../lib/ledger.mjs'
import { E, IMPL, T, claim, done, leafEntry, rootReview, ruling, rulings, specText, work, world } from './harness/execute-program-world.mjs'

test('drift from adopted work is ruled first, on its own ruler thread, before any leaf runs', T, async (t) => {
  const w = world(t, {
    spec: specText([
      leafEntry('p', { provides: 'api (src/api.txt)', locus: ['src/api.txt', 'src/p.txt'] }),
      leafEntry('a', { locus: ['src/api.txt', 'src/a.txt'] }),
      leafEntry('b', { consumes: 'api' }),
    ]),
  })
  const side = join(w.rig.repo, '.claude', 'worktrees', 'side')
  w.rig.git('worktree', 'add', '-q', '-b', 'side', side, 'HEAD')
  const sha = work(side, { 'src/api.txt': 'moved\n' }, 'a, by hand')
  const seq = append(w.rig.repo, E, 'events', { kind: 'merged', node: 'a', execution: '', into: 'agentics/e1', merged_sha: sha, head_sha: sha, by: 'user', commits: [sha] }).seqs[0]
  w.script(
    { ['ruler|.|ruler:adopted:' + seq]: [rulings(ruling('b', 'unaffected', 'b reads api as before'))] },
    { [IMPL('p')]: [done()], [IMPL('b')]: [done()] },
    rootReview(1, claim('D1 holds')),
  )
  await w.start(['--effort', E])
  assert.equal(w.calls[0].role.name, 'ruler')
  assert.equal(w.calls[0].thread.key, 'ruler:adopted:' + seq)
})
