// test/evidence-anchors-worktree.test.mjs — anchors read from a linked worktree, and the CLI.
// The family's header is in test/evidence-anchors.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { itemsFor, liveItems, recordItems, recordJudgement, reviewScope } from '../lib/evidence.mjs'
import { fnv1a } from '../lib/plan-digest.mjs'
import { hashSpec } from '../lib/spec.mjs'
import { evidenceItemsPath } from '../lib/store.mjs'
import {
  cli, commit, gitRepo, itemOf, lines, linkedWorktree, logOf, record, RETURN, span, spanFixture, stateOf,
  returnFile, text, withLine, write,
} from './harness/evidence-fixture.mjs'

// ------------------------------------------------------------------ worktrees

test('a span recorded from a linked worktree is read from the worktree and stored in the main checkout', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(30)) })
  const wt = linkedWorktree(repo)
  write(wt, 'src/a.js', text([...lines(30), ...lines(10, 'more')]))
  const head = commit(wt)
  const item = span('src/a.js', 35, 38)
  assert.equal(recordItems(repo, RETURN, [itemOf(item)]).ok, false, 'by default the main checkout is read, and it has no line 35')

  const id = record(repo, item, { root: wt })
  assert.deepEqual(liveItems(repo).get(id).spans, [{ path: 'src/a.js', start: 35, end: 38, at: head }])
  assert.ok(existsSync(evidenceItemsPath(repo)))
  assert.equal(existsSync(join(wt, '.agentics')), false, 'nothing is written in the worktree')
})

test('checkAnchors given a worktree root reads the worktree: an edit only in the worktree makes the item suspect', () => {
  const { repo, id } = spanFixture()
  const wt = linkedWorktree(repo)
  const edited = withLine(lines(30), 12, 'line twelve')
  write(wt, 'src/a.js', text(edited))
  assert.equal(stateOf(wt, id).state, 'standing', 'without a root the main checkout is read, and it is untouched')

  const st = stateOf(repo, id, { root: wt })
  assert.equal(st.state, 'suspect', 'the worktree is the checkout the run is in')
  assert.equal(st.changed[0].now, edited.slice(9, 14).join('\n'), 'its text is the worktree\'s')

  const listed = record(repo, {
    kind: 'enumeration', claim: 'src has one line 7', queries: [{ pattern: '^line 7$', scope: ['src'] }],
  })
  write(wt, 'src/new.js', text(['line 7']))
  assert.equal(stateOf(wt, listed).state, 'standing', 'the main checkout has no src/new.js')
  const q = stateOf(repo, listed, { root: wt })
  assert.equal(q.state, 'suspect', 'a query is re-run in the worktree, untracked files included')
  assert.match(q.changed[0].now, /src\/new\.js/)

  commit(wt)
  assert.equal(stateOf(wt, id, { root: wt }).state, 'suspect', 'a commit on the worktree\'s branch is read there too')
  assert.equal(stateOf(repo, id).state, 'standing')

  const judged = recordJudgement(repo, listed, 'holds', { root: wt })
  assert.deepEqual([judged.ok, judged.state], [true, 'standing'], JSON.stringify(judged))
  assert.deepEqual(liveItems(repo).get(listed).queries[0].result.map((r) => r.path), ['src/a.js', 'src/new.js'],
    'a holds re-runs the query in the worktree')
  assert.equal(existsSync(join(wt, '.agentics')), false, 'nothing is written in the worktree')
})

test('itemsFor and holds read the root they are given: a holds judged in a worktree re-anchors at the worktree\'s HEAD', () => {
  const { repo, id } = spanFixture()
  const wt = linkedWorktree(repo)
  const edited = ['top', ...withLine(lines(30), 12, 'line twelve')]
  write(wt, 'src/a.js', text(edited))
  const head = commit(wt)

  assert.deepEqual(itemsFor(repo, { ground: ['src'] }).map((i) => [i.id, i.state]), [[id, 'standing']])
  assert.deepEqual(itemsFor(repo, { ground: ['src'], root: wt }).map((i) => [i.id, i.state]), [[id, 'suspect']])

  const out = recordJudgement(repo, id, 'holds', { root: wt })
  assert.deepEqual([out.ok, out.state], [true, 'standing'], JSON.stringify(out))
  assert.deepEqual(liveItems(repo).get(id).spans, [{
    path: 'src/a.js', start: edited.indexOf('line 10') + 1, end: edited.indexOf('line 14') + 1, at: head,
  }], 'the lines and the HEAD the judge read')
  assert.equal(logOf(repo, 'judged').at(-1).at, head)
  assert.equal(existsSync(join(wt, '.agentics')), false, 'the store stays in the main checkout')
})

test('reviewScope reads the root it is given, and maps a worktree path to the same repository-relative path', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)) })
  const wt = linkedWorktree(repo)
  const spec = '.agentics/e1/DESIGN.md'
  write(repo, '.agentics/.gitignore', '*\n')
  write(repo, spec, text(lines(12, 'spec')))
  write(wt, spec, text(lines(20, 'spec')))
  for (const file of [join(wt, '.agentics', 'e1', 'DESIGN.md'), spec]) {
    const main = reviewScope(wt, file)
    assert.equal(main.ok, true, JSON.stringify(main))
    assert.deepEqual([main.path, main.lines], [spec, 12], 'without a root, the main checkout: ' + file)
    const here = reviewScope(wt, file, '', { root: wt })
    assert.equal(here.ok, true, JSON.stringify(here))
    assert.deepEqual([here.path, here.lines], [spec, 20], 'with the worktree as root, the worktree: ' + file)
  }

  const s = reviewScope(repo, spec).snapshot
  const finding = record(repo, {
    question: spec, topic: 'challenge:yagni', ground: [spec], kind: 'behaviour',
    claim: 'a yagni finding at 5', spans: [{ path: spec, start: 5, end: 7, at: s }],
    detail: { axis: 'yagni', severity: 'note', section: '§1', evidence: 'e' },
  })
  write(wt, spec, text(withLine(lines(20, 'spec'), 6, 'spec 6, edited')))
  assert.deepEqual(reviewScope(repo, spec, s).carried.map((i) => i.id), [finding], 'the main checkout never saw the edit')
  assert.deepEqual(reviewScope(repo, spec, s, { root: wt }).carried, [], 'its lines changed in the worktree, so it is not carried there')
})

// ------------------------------------------------------------------ the CLI

test('the items verb lists handles by ground, standing and suspect by default, and writes what they say to a file', () => {
  const { repo, id } = spanFixture()
  write(repo, 'src/a.js', text(withLine(lines(30), 12, 'line twelve')))
  const run = cli(repo)
  const listed = run('items', '--ground', 'src')
  assert.deepEqual(listed.items.map((i) => [i.id, i.state, i.topic, i.ground]), [[id, 'suspect', 't', ['src']]])
  const said = readFileSync(listed.context, 'utf8')
  assert.match(said, /SUSPECT[\s\S]*src\/a\.js:10-14 says what it says[\s\S]*is now:\nline 10\nline 11\nline twelve/)
  assert.deepEqual(run('items', '--ground', 'src', '--states', 'standing'), { items: [], context: '' })
  assert.deepEqual(run('items', '--ground', 'src', '--states', 'standing,suspect').items.map((i) => i.id), [id])
  assert.deepEqual(run('items', '--ground', 'src', '--return-kind', 'probe').items, [], 'only the kind of return asked for')
})

test("the judge verb records the analyst's verdict for each id it is handed as that id's ruling", () => {
  const { repo, id } = spanFixture()
  write(repo, 'src/a.js', text(withLine(lines(30), 12, 'line twelve')))
  const from = returnFile(repo, { judgements: [{ id, verdict: 'holds', why: 'a comment' }, { id: 'I00000001', verdict: 'fails' }] })
  const judged = cli(repo)('judge', '--from', from, '--id', id, '--id', 'I00000000')
  assert.deepEqual(judged, { read: true, recorded_n: 1, standing_n: 1, failed_n: 1 }, 'an id it was not handed is not recorded; an unknown one fails')
  assert.equal(stateOf(repo, id).state, 'standing')
  const recorded = logOf(repo, 'judged')
  assert.deepEqual(recorded.map((j) => [j.id, j.ruling]), [[id, 'holds']])
  assert.equal(Object.hasOwn(recorded[0], 'verdict'), false, 'the analyst file says verdict; the store says ruling')
})

test('the judge verb records unsure for every id when the analyst wrote no file', () => {
  const { repo, id } = spanFixture()
  const judged = cli(repo)('judge', '--from', join(repo, 'nobody-wrote-this.json'), '--id', id)
  assert.deepEqual([judged.read, judged.recorded_n], [false, 1])
  assert.deepEqual(logOf(repo, 'judged').map((j) => j.ruling), ['unsure'])
  assert.equal(stateOf(repo, id).state, 'stale')
})

test('the review-scope verb prints the scope as handles', () => {
  const { repo } = spanFixture()
  const run = cli(repo)
  const scope = run('review-scope', '--file', 'src/a.js')
  assert.deepEqual([scope.ok, scope.path, scope.full, scope.lines, scope.carried, scope.context], [true, 'src/a.js', true, 30, [], ''])
  assert.equal(run('review-scope', '--file', 'src/a.js', '--since', 'snapshot:deadbeef').since, 'snapshot:deadbeef')
})

test('the record verb reads the checkout to record from out of --root', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(30)) })
  const wt = linkedWorktree(repo)
  write(wt, 'src/a.js', text([...lines(30), ...lines(10, 'more')]))
  const head = commit(wt)
  const plan = returnFile(repo, { question: 'q' })
  const judge = returnFile(repo, { items: [{ ...span('src/a.js', 35, 38), topic: 't' }], risks: [] })
  const out = cli(repo)('record', '--kind', 'survey', '--root', wt, '--plan', plan, '--question-digest', fnv1a('q'),
    '--topic', 't', '--subtree', 'src', '--from', judge)
  assert.equal(out.ok, true, JSON.stringify(out))
  const [item] = [...liveItems(repo).values()]
  assert.deepEqual([item.from_return, item.spans[0].at], [out.return, head])
})

test('the items, judge and review-scope verbs read the checkout out of --root', () => {
  const { repo, id } = spanFixture()
  const wt = linkedWorktree(repo)
  const edited = withLine(lines(30), 12, 'line twelve')
  write(wt, 'src/a.js', text(edited))
  const run = cli(repo)

  assert.deepEqual(run('items', '--ground', 'src').items.map((i) => i.state), ['standing'])
  assert.deepEqual(run('items', '--ground', 'src', '--root', wt).items.map((i) => i.state), ['suspect'])

  const judged = run('judge', '--root', wt, '--from', returnFile(repo, { judgements: [{ id, verdict: 'holds' }] }), '--id', id)
  assert.deepEqual([judged.recorded_n, judged.standing_n], [1, 1])
  assert.equal(liveItems(repo).get(id).spans[0].at, 'snapshot:' + hashSpec(text(edited)),
    'an uncommitted worktree edit re-anchors at a snapshot of the worktree\'s text')

  write(wt, 'src/a.js', text(lines(40)))
  assert.equal(run('review-scope', '--file', 'src/a.js').lines, 30)
  assert.equal(run('review-scope', '--file', 'src/a.js', '--root', wt).lines, 40)
})
