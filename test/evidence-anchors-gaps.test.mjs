// test/evidence-anchors-gaps.test.mjs — the gaps an audit of the anchors found.
// The family's header is in test/evidence-anchors.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  checkAnchors, itemId, liveItems, recordItems, recordJudgement, recordRaw, reviewScope,
} from '../lib/evidence.mjs'
import { appendProject } from '../lib/ledger.mjs'
import { evidenceItemsPath, evidenceReturnsDir, evidenceSnapshotsDir } from '../lib/store.mjs'
import {
  CLI, commit, gitRepo, itemOf, lines, logOf, record, RETURN, span, spanFixture, stateOf, text, withLine,
  write,
} from './harness/evidence-fixture.mjs'

// ------------------------------------------------------------------ T22d: the audit's gaps

test('G1: a file committed with CRLF bytes stands through a line-ending change and moved lines; an edit inside reads as LF text', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(30), '\r\n') })
  const id = record(repo, span('src/a.js', 10, 14))
  assert.equal(stateOf(repo, id).state, 'standing')

  write(repo, 'src/a.js', text(lines(30)))
  assert.equal(stateOf(repo, id).state, 'standing', 'the working copy turned LF: only line endings moved')

  write(repo, 'src/a.js', text(['above', ...lines(30)], '\r\n'))
  assert.equal(stateOf(repo, id).state, 'standing', 'a line added above the span')

  const edited = withLine(lines(30), 12, 'line twelve')
  write(repo, 'src/a.js', text(edited, '\r\n'))
  const st = stateOf(repo, id)
  assert.equal(st.state, 'suspect')
  assert.equal(st.changed[0].old, lines(30).slice(9, 14).join('\n'), 'the old text is read from a CRLF blob, and has no CR')
  assert.equal(st.changed[0].now, edited.slice(9, 14).join('\n'))
})

test('G2: a derived cycle is stale, never a stack overflow', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)) })
  const a = itemOf({ kind: 'derived', claim: 'A holds because B does' })
  const b = itemOf({ kind: 'derived', claim: 'B holds because A does' })
  const c = itemOf({ kind: 'derived', claim: 'C holds because C does' })
  const [idA, idB, idC] = [a, b, c].map(itemId)
  const out = recordItems(repo, RETURN, [{ ...a, rests_on: [idB] }, { ...b, rests_on: [idA] }, { ...c, rests_on: [idC] }])
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual(checkAnchors(repo, [idA, idB, idC]).map((s) => s.state), ['stale', 'stale', 'stale'])
})

test('G2: a derived lattice derives each base once per call: thirty rungs of two, each resting on both below', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)) })
  let below = [record(repo, {
    kind: 'external', claim: 'the floor', ground: [], sources: [{ url: 'https://example.com', version: '', retrieved: '' }],
  })]
  for (let k = 1; k <= 30; k++) {
    const out = recordItems(repo, RETURN, [0, 1].map((n) => itemOf({ kind: 'derived', claim: 'rung ' + k + '.' + n, rests_on: below })))
    assert.equal(out.ok, true, JSON.stringify(out))
    below = out.ids
  }
  // Deriving each base once is 61 derivations; deriving it per path is 2^30. A child process
  // is killed at the timeout, where a runaway in this one would hang the suite.
  const script = 'import(' + JSON.stringify(pathToFileURL(CLI).href) + ').then((m) => console.log(m.checkAnchors(' +
    JSON.stringify(repo) + ', [' + JSON.stringify(below[0]) + '])[0].state))'
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 })
  assert.equal(r.signal, null, 'the check ran away: a base is derived more than once')
  assert.equal(r.stdout.trim(), 'standing', r.stderr)
})

test('G3: the revision a holds appends carries no seq inside its item', () => {
  const { repo, id } = spanFixture()
  write(repo, 'src/a.js', text(withLine(lines(30), 12, 'line twelve')))
  commit(repo)
  assert.equal(recordJudgement(repo, id, 'holds').state, 'standing')
  const last = logOf(repo, 'item').at(-1)
  assert.equal(last.item.id, id)
  assert.equal(Object.hasOwn(last.item, 'seq'), false, 'seq belongs to the log line, never to the item')
})

test('G4: the latest judgement is the one with the highest seq, whatever the line order', () => {
  const { repo, id } = spanFixture()
  const [item] = logOf(repo, 'item')
  writeFileSync(evidenceItemsPath(repo), [
    item,
    { kind: 'judged', id, ruling: 'fails', at: '', seq: item.seq + 2 },
    { kind: 'judged', id, ruling: 'holds', at: '', seq: item.seq + 1 },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n')
  assert.equal(stateOf(repo, id).state, 'stale', 'the fails line has the higher seq, though the holds line comes later')
})

test('G5: reviewScope marks line 1 for a deleted first line, the new last line for a deleted last line, and merges touching ranges', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)), '.agentics/.gitignore': '*\n' })
  const path = '.agentics/e1/DESIGN.md'
  const v1 = lines(40, 'spec')
  write(repo, path, text(v1))
  const since = reviewScope(repo, path).snapshot
  const changedAfter = (ls) => {
    write(repo, path, text(ls))
    return reviewScope(repo, path, since).changed
  }

  assert.deepEqual(changedAfter(v1.slice(1)), [{ start: 1, end: 1 }], 'the line that followed the deleted first line')
  const shorter = v1.slice(0, -1)
  assert.deepEqual(changedAfter(shorter), [{ start: shorter.length, end: shorter.length }], 'no line follows a deleted last line')
  // Old line 9 goes, so new lines 8 and 9 flank where it was; old line 11, edited, is new line 10.
  const both = v1.filter((_, i) => i !== 8).map((l) => (l === 'spec 11' ? 'spec 11, edited' : l))
  const eleven = both.indexOf('spec 11, edited') + 1
  assert.deepEqual(changedAfter(both), [{ start: v1.indexOf('spec 9'), end: eleven }], 'touching ranges are one range')
})

test('G6: a query git cannot run is refused at record, and stale in the store', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)) })
  const raw = itemOf({ kind: 'absence', claim: 'nothing matches a pattern git refuses', queries: [{ pattern: 'a(b', scope: ['src'] }] })
  const refused = recordItems(repo, RETURN, [raw])
  assert.deepEqual([refused.ok, refused.refused && refused.refused[0].index], [false, 0], JSON.stringify(refused))

  const item = { ...raw, queries: [{ pattern: 'a(b', scope: ['src'], result: [] }], from_return: RETURN }
  const id = itemId(item)
  assert.equal(appendProject(repo, 'items', [{ kind: 'item', item: { ...item, id } }]).ok, true)
  assert.equal(stateOf(repo, id).state, 'stale')
})

test('G7: a query whose pattern or scope holds a NUL is refused at record, never thrown, and leaves no raw return', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)) })
  for (const q of [{ pattern: 'a\u0000b', scope: ['src'] }, { pattern: 'line', scope: ['sr\u0000c'] }]) {
    const out = recordItems(repo, RETURN, [itemOf({ kind: 'enumeration', claim: 'nul in ' + JSON.stringify(q), queries: [q] })])
    assert.deepEqual([out.ok, out.refused && out.refused[0].index], [false, 0], JSON.stringify(q))
    const raw = recordRaw(repo, 'survey', { items: [itemOf({ kind: 'enumeration', claim: 'raw nul in ' + JSON.stringify(q), queries: [q] })] })
    assert.equal(raw.ok, false, JSON.stringify(q))
  }
  assert.equal(existsSync(evidenceItemsPath(repo)), false, 'nothing entered the pool')
  const returns = evidenceReturnsDir(repo)
  assert.deepEqual(existsSync(returns) ? readdirSync(returns) : [], [], 'a refused return is deleted again')
})

test('G7: a stored query pattern holding a NUL is stale, never thrown', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)) })
  const item = itemOf({
    kind: 'absence', claim: 'a stored pattern holding a NUL', queries: [{ pattern: 'a\u0000b', scope: ['src'], result: [] }], from_return: RETURN,
  })
  const id = itemId(item)
  assert.equal(appendProject(repo, 'items', [{ kind: 'item', item: { ...item, id } }]).ok, true)
  assert.equal(stateOf(repo, id).state, 'stale')
})

test('G8: a query never matches inside .agentics/, even with the store\'s ignore file gone', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)) })
  const id = record(repo, {
    kind: 'absence', claim: 'nothing in the repository says zqxj', ground: ['.'], queries: [{ pattern: 'zqxj', scope: ['.'] }],
  })
  rmSync(join(repo, '.agentics', '.gitignore'))
  assert.equal(stateOf(repo, id).state, 'standing', 'the store holds the pattern, and the store is never searched')

  const listed = record(repo, {
    kind: 'enumeration', claim: 'where zqxj is said', ground: ['.'], queries: [{ pattern: 'zqxj', scope: ['.'] }],
  })
  assert.deepEqual(liveItems(repo).get(listed).queries[0].result, [], 'the recorder searches the tree, never the store')
})

test('G9: reviewScope given a since snapshot that does not hash to its name gives a full review', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)), '.agentics/.gitignore': '*\n' })
  const path = '.agentics/e1/DESIGN.md'
  const v1 = lines(40, 'spec')
  write(repo, path, text(v1))
  const since = reviewScope(repo, path).snapshot
  writeFileSync(join(evidenceSnapshotsDir(repo), since.slice('snapshot:'.length) + '.txt'), text(v1).slice(0, 20))
  write(repo, path, text(withLine(v1, 31, 'spec 31, edited')))
  const next = reviewScope(repo, path, since)
  assert.equal(next.full, true, 'a torn snapshot is not the old text')
  assert.deepEqual(next.changed, [{ start: 1, end: v1.length }])
})
