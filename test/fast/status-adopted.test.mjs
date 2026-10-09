// test/fast/status-adopted.test.mjs — how adopted work reads in the todo list, a node's card and a
// checkpoint, spawn-free.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renderCheckpoint, renderNode, todoFor } from '../../lib/status.mjs'
import { deriveStatus, liveNodes } from '../../lib/tree.mjs'

const NODES = [{ id: '.', kind: 'composite', title: 'root' }, { id: 'a', kind: 'leaf', title: 'a', rigor: 'tdd' }, { id: 'b', kind: 'leaf', title: 'b', rigor: 'tdd' }]
function tree(events) {
  const nodes = liveNodes(NODES.map((node, i) => ({ kind: 'node', node, seq: i + 1 })))
  const ev = events.map((e, i) => ({ execution: '', ...e, seq: NODES.length + i + 1 }))
  return { nodes, events: ev, status: deriveStatus(nodes, ev) }
}

test('an adopted leaf is completed, merged (adopted); one agentics merged is merged', () => {
  const t = tree([{ kind: 'merged', node: 'a', head_sha: 'h', by: 'user', commits: ['c1'] }, { kind: 'merged', node: 'b', head_sha: 'h' }])
  const a = todoFor(t.nodes, t.status, t.events, 'a')
  assert.equal(a.status, 'completed')
  assert.equal(a.activeForm, 'merged (adopted)')
  assert.equal(todoFor(t.nodes, t.status, t.events, 'b').activeForm, 'merged')
})

test("a node's card reads who adopted it and which commits", () => {
  const text = renderNode({
    id: 'a', title: 'a', status: 'merged', stage: null, live: null,
    event: { kind: 'merged', seq: 9, by: 'user', commits: ['c1c1c1c1c1c1', 'c2c2c2c2c2c2'], into: 'agentics/e1', merged_sha: 'm' },
    card: { next: null, behind: null, report: null, checkout_changed: null, notes: [], relaunch: null },
    files: { spec: { path: '', line: null } }, branch: 'agentics/e1--a',
  })
  assert.ok(text.includes('adopted by user'), text)
  assert.ok(text.includes('c1c1c1c1') && text.includes('c2c2c2c2'), text)
})

test('an outside_work checkpoint lists each branch with its commits', () => {
  const text = renderCheckpoint({ reason: 'outside_work', detail: 'd', branches: [{ branch: 'agentics/e1--c', commits: ['s1s1s1s1s1', 's2s2s2s2s2'] }] })
  assert.ok(text.includes('agentics/e1--c'))
  assert.ok(text.includes('s1s1s1s1s1') && text.includes('s2s2s2s2s2'))
})
