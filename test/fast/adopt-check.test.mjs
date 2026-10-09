// test/fast/adopt-check.test.mjs — the adoption mapping read, checked and turned into records,
// over hand-built git facts: every refusal kind, the report, the digest.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { actToken } from '../../lib/approval.mjs'
import { adoptDigest, adoptRecords, checkAdoption, parseMapping } from '../../lib/adopt.mjs'
import { deriveStatus, liveNodes } from '../../lib/tree.mjs'

const NODES = [
  { id: '.', kind: 'composite', title: 'root' },
  { id: 'c', kind: 'composite', title: 'c' },
  { id: 'c/a', kind: 'leaf', title: 'a', rigor: 'tdd', locus: ['src/a.mjs'], acceptance: [{ text: 'a works', check: 'node --test' }, { text: 'HUMAN: a reads well', check: '' }] },
  { id: 'c/b', kind: 'leaf', title: 'b', rigor: 'tdd', locus: ['src/b.mjs'], deps: ['c/a'] },
  { id: 'c/r', kind: 'leaf', title: 'r', rigor: 'tdd-pair', role: 'red', locus: ['test/r.test.mjs'] },
  { id: 'c/g', kind: 'leaf', title: 'g', rigor: 'tdd-pair', role: 'green', locus: ['src/g.mjs'], deps: ['c/r'] },
  { id: 'c/tr', kind: 'leaf', title: 'tr', rigor: 'tdd-triad', role: 'red', locus: ['test/t.test.mjs'] },
  { id: 'c/tg', kind: 'leaf', title: 'tg', rigor: 'tdd-triad', role: 'green', locus: ['src/t.mjs'], deps: ['c/tr'] },
  { id: 'c/ta', kind: 'leaf', title: 'ta', rigor: 'tdd-triad', role: 'audit', locus: ['test/t.test.mjs'], deps: ['c/tg'] },
  { id: 'd', kind: 'composite', title: 'd' },
  { id: 'd/x', kind: 'leaf', title: 'x', rigor: 'tdd', locus: ['src/x.mjs'] },
]
const sha = (n) => String(n).padStart(2, '0').repeat(20)
const [S1, S2, S3, OFF, TIP, OLD] = [1, 2, 3, 4, 5, 6].map(sha)
const HEAD = sha(9)

/** Facts as `adoptFacts` would read them: every sha in `on` is on the folder branch, in that order, touching `files`. */
function factsOf({ events = [], on = [S1, S2, S3, TIP], files = {}, folder = 'c', head = HEAD, ...extra } = {}) {
  const nodes = liveNodes(NODES.map((node, i) => ({ kind: 'node', node, seq: i + 1 })))
  const ev = events.map((e, i) => ({ execution: '', ...e, seq: NODES.length + i + 1 }))
  const known = [...on, OFF]
  return {
    effort: 'e1', folder, folderBranch: 'agentics/e1--' + folder, folderHead: head,
    tree: { nodes, status: deriveStatus(nodes, ev), events: ev }, live: [],
    shas: Object.fromEntries(known.flatMap((s) => [[s, s], [s.slice(0, 8), s]])),
    onFolder: Object.fromEntries(known.map((s) => [s, on.includes(s)])),
    order: Object.fromEntries(on.map((s, i) => [s, i])),
    mergedAt: Object.fromEntries(on.map((s) => [s, s])),
    files: Object.fromEntries(known.map((s) => [s, files[s] || ['src/a.mjs']])),
    doneBranches: {}, handoverBranches: {}, canonical: {},
    ...extra,
  }
}
const parsed = (doc) => {
  const out = parseMapping(JSON.stringify(doc))
  assert.equal(out.ok, true, JSON.stringify(out))
  return out.mapping
}
const check = (doc, facts = factsOf()) => checkAdoption(parsed(doc), facts)
const kinds = (out) => out.refusals.map((r) => [r.entry, r.kind])

// ---------------------------------------------------------------- reading the mapping

test('a mapping that is not JSON, or not an object, refuses bad_mapping', () => {
  for (const text of ['{', '[]', '"done"', 'null']) {
    const out = parseMapping(text)
    assert.equal(out.ok, false, text)
    assert.deepEqual(out.refusals.map((r) => r.kind), ['bad_mapping'], text)
  }
})

test('a section other than done, outside and handover refuses bad_mapping', () => {
  assert.deepEqual(parseMapping(JSON.stringify({ done: [], extra: [] })).refusals.map((r) => r.kind), ['bad_mapping'])
})

test('a done entry with both commits and a branch, or neither, refuses bad_mapping', () => {
  const both = parseMapping(JSON.stringify({ done: [{ node: 'c/a', commits: [S1], branch: 'x' }] }))
  const neither = parseMapping(JSON.stringify({ done: [{ node: 'c/a' }] }))
  assert.deepEqual(both.refusals.map((r) => [r.entry, r.kind]), [['done[0]', 'bad_mapping']])
  assert.deepEqual(neither.refusals.map((r) => [r.entry, r.kind]), [['done[0]', 'bad_mapping']])
})

test('an entry naming no commit refuses empty_entry', () => {
  const out = parseMapping(JSON.stringify({ done: [{ node: 'c/a', commits: [] }], outside: [{ commits: [] }] }))
  assert.deepEqual(out.refusals.map((r) => [r.entry, r.kind]), [['done[0]', 'empty_entry'], ['outside[0]', 'empty_entry']])
})

test('a mapping that adopts nothing refuses empty_mapping', () => {
  for (const doc of [{}, { done: [], outside: [], handover: [] }]) {
    assert.deepEqual(parseMapping(JSON.stringify(doc)).refusals.map((r) => r.kind), ['empty_mapping'])
  }
})

test('a done entry by branch reads as its branch, with no commits', () => {
  assert.deepEqual(parsed({ done: [{ node: 'c/a', branch: 'hand/a' }] }).done, [{ node: 'c/a', commits: null, branch: 'hand/a' }])
})

test('every section is optional', () => {
  assert.deepEqual(parsed({ outside: [{ commits: [S1] }] }), { done: [], outside: [{ commits: [S1] }], handover: [] })
})

// ---------------------------------------------------------------- the folder

test('a folder that is no composite refuses not_a_folder, and nothing else is checked', () => {
  for (const folder of ['c/a', 'nope']) {
    assert.deepEqual(kinds(check({ done: [{ node: 'c/a', commits: [S1] }] }, factsOf({ folder }))), [['', 'not_a_folder']])
  }
})

test('a folder whose integration branch does not exist refuses no_folder_branch', () => {
  assert.deepEqual(kinds(check({ done: [{ node: 'c/a', commits: [S1] }] }, factsOf({ head: '' }))), [['', 'no_folder_branch']])
})

test('a live run over the folder refuses run_live', () => {
  const out = check({ done: [{ node: 'c/a', commits: [S1] }] }, factsOf({ live: [{ stamp: '20261009-120000', root: '.' }] }))
  assert.deepEqual(kinds(out), [['', 'run_live']])
})

// ---------------------------------------------------------------- the node

test('an entry whose node is not a live leaf of the folder refuses by what it is', () => {
  const out = check({ done: [{ node: 'c/zz', commits: [S1] }, { node: 'c', commits: [S2] }, { node: 'd/x', commits: [S3] }] })
  assert.deepEqual(kinds(out), [['done[0]', 'unknown_node'], ['done[1]', 'not_a_leaf'], ['done[2]', 'not_in_folder']])
})

test('a leaf already merged refuses already_merged', () => {
  const out = check({ done: [{ node: 'c/a', commits: [S1] }] }, factsOf({ events: [{ kind: 'merged', node: 'c/a', into: 'agentics/e1--c', merged_sha: OLD, head_sha: OLD }] }))
  assert.deepEqual(kinds(out), [['done[0]', 'already_merged']])
})

test('a node named by two entries refuses claimed_twice', () => {
  const out = check({ done: [{ node: 'c/a', commits: [S1] }], handover: [{ node: 'c/a', branch: 'hand/a' }] },
    factsOf({ handoverBranches: { 'hand/a': { head: TIP, commits: [TIP] } } }))
  assert.deepEqual(kinds(out), [['handover[0]', 'claimed_twice']])
})

// ---------------------------------------------------------------- the commits

test('a sha git does not know refuses unknown_commit', () => {
  assert.deepEqual(kinds(check({ outside: [{ commits: ['deadbeef'] }] })), [['outside[0]', 'unknown_commit']])
})

test('a sha the folder branch does not hold refuses not_on_folder_branch', () => {
  assert.deepEqual(kinds(check({ done: [{ node: 'c/a', commits: [OFF] }] })), [['done[0]', 'not_on_folder_branch']])
})

test('a sha named by two entries, or already by a record, refuses claimed_twice', () => {
  const twice = check({ done: [{ node: 'c/a', commits: [S1] }], outside: [{ commits: [S1] }] })
  assert.deepEqual(kinds(twice), [['outside[0]', 'claimed_twice']])
  const recorded = check({ outside: [{ commits: [S2] }] }, factsOf({ events: [{ kind: 'outside', node: 'c', commits: [S2], by: 'user' }] }))
  assert.deepEqual(kinds(recorded), [['outside[0]', 'claimed_twice']])
})

test('an abbreviated sha counts as the full one it names', () => {
  const out = check({ done: [{ node: 'c/a', commits: [S2.slice(0, 8)] }], outside: [{ commits: [S2] }] })
  assert.deepEqual(kinds(out), [['outside[0]', 'claimed_twice']])
})

// ---------------------------------------------------------------- the branches

test('a done branch git does not know refuses unknown_branch; one not merged into the folder, not_on_folder_branch', () => {
  const facts = factsOf({ doneBranches: { gone: { head: '', mergedAt: '', ff: false, commits: [] }, open: { head: OFF, mergedAt: '', ff: false, commits: [] } } })
  assert.deepEqual(kinds(check({ done: [{ node: 'c/a', branch: 'gone' }, { node: 'c/b', branch: 'open' }] }, facts)),
    [['done[0]', 'unknown_branch'], ['done[1]', 'not_on_folder_branch']])
})

test('a fast-forwarded done branch refuses empty_entry and says to list its commits', () => {
  const facts = factsOf({ doneBranches: { ff: { head: TIP, mergedAt: TIP, ff: true, commits: [] } } })
  const out = check({ done: [{ node: 'c/a', branch: 'ff' }] }, facts)
  assert.deepEqual(kinds(out), [['done[0]', 'empty_entry']])
  assert.match(out.refusals[0].message, /commits/)
})

test('a handover branch that is unknown, holds nothing new, or meets another canonical head refuses', () => {
  const facts = factsOf({
    handoverBranches: { gone: { head: '', commits: [] }, same: { head: S1, commits: [] }, mine: { head: TIP, commits: [TIP] } },
    canonical: { 'c/b': OLD },
  })
  const out = check({ handover: [{ node: 'c/a', branch: 'gone' }, { node: 'c/r', branch: 'same' }, { node: 'c/b', branch: 'mine' }] }, facts)
  assert.deepEqual(kinds(out), [['handover[0]', 'unknown_branch'], ['handover[1]', 'empty_entry'], ['handover[2]', 'branch_exists']])
})

test('a handover whose canonical branch already stands at its head is no refusal', () => {
  const facts = factsOf({ handoverBranches: { mine: { head: TIP, commits: [TIP] } }, canonical: { 'c/b': TIP } })
  assert.deepEqual(kinds(check({ handover: [{ node: 'c/b', branch: 'mine' }] }, facts)), [])
})

// ---------------------------------------------------------------- cycles

test('a green whose red is neither merged nor adopted in the batch refuses cycle_order', () => {
  assert.deepEqual(kinds(check({ done: [{ node: 'c/g', commits: [S2] }] })), [['done[0]', 'cycle_order']])
  assert.deepEqual(kinds(check({ done: [{ node: 'c/r', commits: [S1] }, { node: 'c/g', commits: [S2] }] })), [])
  const redMerged = factsOf({ events: [{ kind: 'merged', node: 'c/r', into: 'agentics/e1--c', merged_sha: OLD, head_sha: OLD }] })
  assert.deepEqual(kinds(check({ done: [{ node: 'c/g', commits: [S2] }] }, redMerged)), [])
})

test('an audit whose green is neither merged nor adopted in the batch refuses cycle_order', () => {
  assert.deepEqual(kinds(check({ done: [{ node: 'c/ta', commits: [S3] }] })), [['done[0]', 'cycle_order']])
  assert.deepEqual(kinds(check({ done: [{ node: 'c/tr', commits: [S1] }, { node: 'c/tg', commits: [S2] }, { node: 'c/ta', commits: [S3] }] })), [])
})

test('a handed-over green whose red is not done refuses cycle_order', () => {
  const facts = factsOf({ handoverBranches: { g: { head: TIP, commits: [TIP] } } })
  assert.deepEqual(kinds(check({ handover: [{ node: 'c/g', branch: 'g' }] }, facts)), [['handover[0]', 'cycle_order']])
})

// ---------------------------------------------------------------- the report

test('the report names files outside the leaf locus, the stops a merge clears, open deps and the criteria to rule', () => {
  const facts = factsOf({
    files: { [S1]: ['src/a.mjs', 'README.md'] },
    events: [{ kind: 'escalated', node: 'c/b', reason: 'stuck' }],
  })
  const out = check({ done: [{ node: 'c/a', commits: [S1] }, { node: 'c/b', commits: [S2] }] }, facts)
  assert.deepEqual(out.refusals, [])
  assert.deepEqual(out.report.outside_locus, [{ node: 'c/a', paths: ['README.md'] }, { node: 'c/b', paths: ['src/a.mjs'] }])
  assert.deepEqual(out.report.clears_stops, [{ node: 'c/b', kind: 'escalated', reason: 'stuck' }])
  assert.deepEqual(out.report.deps_open, [], 'c/b depends on c/a, adopted in the same batch')
  assert.deepEqual(out.report.criteria.find((c) => c.node === 'c/a').criteria, ['a works'], 'a HUMAN: criterion is the user\'s, not the review\'s')
})

test('a dependency neither merged nor adopted is reported open, never refused', () => {
  const out = check({ done: [{ node: 'c/b', commits: [S2] }] })
  assert.deepEqual(out.refusals, [])
  assert.deepEqual(out.report.deps_open, [{ node: 'c/b', deps: ['c/a'] }])
})

// ---------------------------------------------------------------- digest and records

test("the normalized mapping holds full shas in the folder's order", () => {
  const out = check({ done: [{ node: 'c/a', commits: [S3, S1.slice(0, 8)] }] })
  assert.deepEqual(out.normalized.done, [{ node: 'c/a', branch: '', commits: [S1, S3] }])
})

test('the adopt token names the folder and the first eight characters of the digest', () => {
  assert.equal(actToken({ act: 'adopt', folder: 'c/sub', hash: '0123456789abcdef' }), 'adopt c/sub@01234567')
  assert.equal(actToken({ act: 'adopt', folder: '.', hash: 'fedcba98' }), 'adopt .@fedcba98')
  assert.throws(() => actToken({ act: 'adopted', folder: 'c', hash: '0123' }), /no token form/)
})

test('the digest moves with the folder head and with the mapping, and stands still otherwise', () => {
  const a = check({ done: [{ node: 'c/a', commits: [S1] }] }).normalized
  const b = check({ done: [{ node: 'c/a', commits: [S1] }], outside: [{ commits: [S2] }] }).normalized
  assert.equal(adoptDigest(a, HEAD), adoptDigest(check({ done: [{ node: 'c/a', commits: [S1.slice(0, 8)] }] }).normalized, HEAD))
  assert.notEqual(adoptDigest(a, HEAD), adoptDigest(a, sha(8)))
  assert.notEqual(adoptDigest(a, HEAD), adoptDigest(b, HEAD))
  assert.match(actToken({ act: 'adopt', folder: 'c', hash: adoptDigest(a, HEAD) }), /^adopt c@[0-9a-f]{8}$/)
})

test("a done entry records merged into the folder branch, its last commit as head, where that merged, by and every commit", () => {
  const facts = factsOf({ mergedAt: { [S1]: S1, [S2]: S3, [S3]: S3, [TIP]: TIP } })
  const { normalized } = check({ done: [{ node: 'c/a', commits: [S2, S1] }] }, facts)
  const { events, branches } = adoptRecords(normalized, facts, 'terminal')
  assert.deepEqual(branches, [])
  assert.equal(events.length, 1)
  const m = events[0]
  assert.equal(m.kind, 'merged')
  assert.equal(m.node, 'c/a')
  assert.equal(m.execution, '')
  assert.equal(m.into, facts.folderBranch)
  assert.equal(m.head_sha, S2)
  assert.equal(m.merged_sha, S3)
  assert.equal(m.by, 'terminal')
  assert.deepEqual(m.commits, [S1, S2])
})

test('an outside entry records outside on the folder; a handover a note naming its branch and head, and the canonical branch', () => {
  const facts = factsOf({ handoverBranches: { 'hand/b': { head: TIP, commits: [TIP] } } })
  const { normalized } = check({ outside: [{ commits: [S1] }], handover: [{ node: 'c/b', branch: 'hand/b' }] }, facts)
  const { events, branches } = adoptRecords(normalized, facts, 'user')
  const outside = events.find((e) => e.kind === 'outside')
  assert.equal(outside.node, 'c')
  assert.equal(outside.execution, '')
  assert.equal(outside.by, 'user')
  assert.deepEqual(outside.commits, [S1])
  const noted = events.find((e) => e.kind === 'noted')
  assert.equal(noted.node, 'c/b')
  assert.equal(noted.by, 'user')
  assert.ok(noted.text.includes('hand/b') && noted.text.includes(TIP), noted.text)
  assert.deepEqual(branches, [{ node: 'c/b', branch: 'agentics/e1--c.b', head: TIP }])
})
