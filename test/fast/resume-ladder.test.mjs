// test/fast/resume-ladder.test.mjs — lib/resume.mjs's ladder (`nextActionFor`) over the facts it is
// handed: which single action a leaf resumes at. test/resume.test.mjs reads those facts from real git.
//
// Design: docs/DESIGN.md#resume-and-checkpoints.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ACTIONS, nextActionFor } from '../../lib/resume.mjs'
import { normalizeNode } from '../../lib/tree.mjs'

const leaf = (id, over = {}) => normalizeNode({ id, kind: 'leaf', rigor: 'tdd', expects: ['src/' + id + '.mjs'], ...over })

test('nextActionFor answers from the facts it is handed, and only ever names a known action', () => {
  const a = leaf('a')
  const g = { branch: 'agentics/e1--a', head_sha: 'h2', base_sha: 'h0', commits: [{ sha: 'h2', subject: 's' }], checkpoint_head: false, merged_into_parent: false }
  const cases = [
    [{}, 'code'],
    [{ git: { ...g, commits: [] } }, 'code'],
    [{ git: g }, 'continue-series'],
    [{ git: { ...g, measure_first: [] } }, 'continue-series'],
    [{ git: { ...g, measure_first: ['h2'] } }, 'verify'],
    [{ git: { ...g, measure_first: ['h2'], checkpoint_head: true } }, 'verify'],
    [{ git: g, journal: [{ kind: 'series-done', node: 'a', head_sha: 'h2' }] }, 'verify'],
    [{ git: g, journal: [{ kind: 'series-done', node: 'OTHER', head_sha: 'h2' }] }, 'continue-series'],
    [{ git: { ...g, checkpoint_head: true }, journal: [{ kind: 'series-done', node: 'a', head_sha: 'h2' }] }, 'continue-series'],
    [{ git: g, events: [{ kind: 'approved', node: 'a', head_sha: 'h2', seq: 5 }] }, 'merge'],
    [{ git: g, events: [{ kind: 'approved', node: 'a', head_sha: 'h2', seq: 5 }, { kind: 'dispatched', node: 'a', seq: 6 }] }, 'continue-series'],
    [{ git: { ...g, merged_into_parent: true } }, 'continue-series'],
    [{ git: { ...g, merged_into_parent: true }, events: [{ kind: 'approved', node: 'a', head_sha: 'h2', seq: 1 }] }, 'none'],
    [{ events: [{ kind: 'merged', node: 'a', seq: 3 }] }, 'none'],
  ]
  for (const [facts, want] of cases) {
    const got = nextActionFor(a, facts)
    assert.equal(got.next_action, want, JSON.stringify(facts))
    assert.ok(ACTIONS.includes(got.next_action))
    assert.ok(got.note.length > 0)
  }
})
