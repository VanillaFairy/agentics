// test/evidence-anchors-worktree.test.mjs — anchors read from a linked worktree, and the CLI.
// The family's header is in test/evidence-anchors.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { itemsFor, liveItems, recordItems, recordJudgement, reviewScope } from '../lib/evidence.mjs'
import { hashSpec } from '../lib/spec.mjs'
import { evidenceItemsPath } from '../lib/store.mjs'
import {
  cli, commit, gitRepo, itemOf, lines, linkedWorktree, logOf, record, RETURN, span, spanFixture, stateOf,
  text, token, withLine, write,
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

test('the items verb lists by ground, standing and suspect by default, and --states filters', () => {
  const { repo, id } = spanFixture()
  write(repo, 'src/a.js', text(withLine(lines(30), 12, 'line twelve')))
  const run = cli(repo)
  const listed = run('items', '--ground', 'src')
  assert.deepEqual(listed.ground, ['src'])
  assert.deepEqual(listed.items.map((i) => [i.id, i.state]), [[id, 'suspect']])
  assert.deepEqual(run('items', '--ground', 'src', '--states', 'standing').items, [])
  assert.deepEqual(run('items', '--ground', 'src', '--states', 'standing,suspect').items.map((i) => i.id), [id])
})

test('the judge verb records each judgement, an unknown id as ok: false inside its payload', () => {
  const { repo, id } = spanFixture()
  write(repo, 'src/a.js', text(withLine(lines(30), 12, 'line twelve')))
  const judged = cli(repo)('judge', ...token({ judgements: [{ id, verdict: 'holds' }, { id: 'I00000000', verdict: 'holds' }] }))
  assert.deepEqual(judged.recorded.map((r) => [r.id, r.verdict, r.ok]), [[id, 'holds', true], ['I00000000', 'holds', false]])
  assert.equal(judged.recorded[0].state, 'standing')
  assert.equal(stateOf(repo, id).state, 'standing')
})

test('the judge verb refuses a token whose digest does not match, and records nothing', () => {
  const { repo, id } = spanFixture()
  const [, , b64flag, b64] = token({ judgements: [{ id, verdict: 'fails' }] })
  const damaged = cli(repo)('judge', '--digest', 'deadbeef', b64flag, b64)
  assert.equal(damaged.error.kind, 'digest_mismatch')
  assert.deepEqual(logOf(repo, 'judged'), [])
  assert.equal(stateOf(repo, id).state, 'standing')
})

test('the review-scope verb prints the reviewScope payload', () => {
  const { repo } = spanFixture()
  const run = cli(repo)
  const scope = run('review-scope', '--file', 'src/a.js')
  assert.deepEqual([scope.ok, scope.path, scope.full, scope.lines], [true, 'src/a.js', true, 30])
  assert.equal(run('review-scope', '--file', 'src/a.js', '--since', 'snapshot:deadbeef').since, 'snapshot:deadbeef')
})

test('the record verb reads the checkout to record from out of --root', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(30)) })
  const wt = linkedWorktree(repo)
  write(wt, 'src/a.js', text([...lines(30), ...lines(10, 'more')]))
  const head = commit(wt)
  const out = cli(repo)('record', '--kind', 'survey', '--root', wt, ...token({ items: [itemOf(span('src/a.js', 35, 38))] }))
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(liveItems(repo).get(out.ids[0]).spans[0].at, head)
})

test('the items, judge and review-scope verbs read the checkout out of --root', () => {
  const { repo, id } = spanFixture()
  const wt = linkedWorktree(repo)
  const edited = withLine(lines(30), 12, 'line twelve')
  write(wt, 'src/a.js', text(edited))
  const run = cli(repo)

  assert.deepEqual(run('items', '--ground', 'src').items.map((i) => i.state), ['standing'])
  assert.deepEqual(run('items', '--ground', 'src', '--root', wt).items.map((i) => i.state), ['suspect'])

  const judged = run('judge', '--root', wt, ...token({ judgements: [{ id, verdict: 'holds' }] }))
  assert.deepEqual(judged.recorded.map((r) => [r.id, r.ok, r.state]), [[id, true, 'standing']])
  assert.equal(liveItems(repo).get(id).spans[0].at, 'snapshot:' + hashSpec(text(edited)),
    'an uncommitted worktree edit re-anchors at a snapshot of the worktree\'s text')

  write(wt, 'src/a.js', text(lines(40)))
  assert.equal(run('review-scope', '--file', 'src/a.js').lines, 30)
  assert.equal(run('review-scope', '--file', 'src/a.js', '--root', wt).lines, 40)
})
