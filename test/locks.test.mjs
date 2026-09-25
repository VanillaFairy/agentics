// test/locks.test.mjs — the slot pool and the lock files (lib/locks.mjs).
//
// Temp repositories without git: the pool reads only lock files and each holder's effort tree,
// which is built with the real ledger so the default "does the holder still occupy its slot"
// predicate is exercised against real derived status.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { append } from '../lib/ledger.mjs'
import {
  acquire, heldBy, locusFileOf, maxParallel, poolConfig, releaseLocus, releaseSlots, withBranchLock,
} from '../lib/locks.mjs'
import { effortDir, slotsDir } from '../lib/store.mjs'
import { addNodes } from '../lib/tree.mjs'

const LOCKS = fileURLToPath(new URL('../lib/locks.mjs', import.meta.url))
const LEDGER_URL = pathToFileURL(fileURLToPath(new URL('../lib/ledger.mjs', import.meta.url))).href
const LOCKS_URL = pathToFileURL(LOCKS).href

const E = 'e1'
const X = '20260925-120000'

const newRepo = () => mkdtempSync(join(tmpdir(), 'agentics-locks-'))

const setMax = (repo, value) => {
  mkdirSync(slotsDir(repo), { recursive: true })
  writeFileSync(join(slotsDir(repo), 'config.json'), typeof value === 'string' ? value : JSON.stringify({ max_parallel: value }))
}

const leaf = (id) => ({
  id, kind: 'leaf', title: 'do ' + id, rigor: 'trivial', locus: ['src/' + id + '.js'],
  decisions: ['D1'], acceptance: [{ text: id + ' works', check: 'node --test', decisions: ['D1'] }],
})

/** A repo with one effort whose leaves are dispatched (status `active`). */
function effortRepo(ids, { max } = {}) {
  const repo = newRepo()
  const out = addNodes(repo, E, [
    { id: '.', kind: 'composite', title: 'the change', defines: [{ id: 'D1', text: 'do it' }] },
    ...ids.map(leaf),
  ], { by: 'session' })
  assert.ok(out.ok, JSON.stringify(out.problems))
  for (const id of ids) event(repo, 'dispatched', id, { role: 'implementer', round: 1, model: 'sonnet', effort: 'medium' })
  if (max !== undefined) setMax(repo, max)
  return repo
}

const event = (repo, kind, node, extra = {}) => {
  const r = append(repo, E, 'events', { kind, node, execution: X, ...extra })
  assert.ok(r.ok, r.error)
}

const take = (repo, node, extra = {}) => acquire(repo, { effort: E, execution: X, node, waitMs: 0, ...extra })

const slotFiles = (repo) => (existsSync(slotsDir(repo)) ? readdirSync(slotsDir(repo)).filter((f) => /^\d+\.lock$/.test(f)).sort() : [])
const locusLockExists = (repo, path) => existsSync(join(effortDir(repo, E), 'locks', 'locus', locusFileOf(path)))

test('max_parallel: default 4, read from config on every call, malformed → default with a note', () => {
  const repo = newRepo()
  assert.equal(maxParallel(repo), 4)
  assert.deepEqual(poolConfig(repo), { max_parallel: 4, note: '' })
  setMax(repo, 7)
  assert.equal(maxParallel(repo), 7)
  setMax(repo, 2)
  assert.equal(maxParallel(repo), 2, 'an edit takes effect at the next read')
  for (const bad of ['{nope', JSON.stringify({ max_parallel: 0 }), JSON.stringify({ max_parallel: 2.5 }), JSON.stringify({})]) {
    setMax(repo, bad)
    const c = poolConfig(repo)
    assert.equal(c.max_parallel, 4)
    assert.match(c.note, /default/)
  }
  assert.match(heldBy(repo).notes[0], /default/)
})

test('the pool limit is respected: the leaf past max_parallel gets no_slot and nothing is written for it', () => {
  const repo = effortRepo(['a', 'b', 'c'], { max: 2 })
  const a = take(repo, 'a', { locus: ['src/a.js'] })
  const b = take(repo, 'b', { locus: ['src/b.js'] })
  assert.deepEqual([a.ok, a.slot, b.ok, b.slot], [true, 1, true, 2])
  assert.deepEqual(a.locks, ['src/a.js'])

  const c = take(repo, 'c', { locus: ['src/c.js'] })
  assert.equal(c.ok, false)
  assert.equal(c.reason, 'no_slot')
  assert.deepEqual(c.held_by.map((h) => [h.n, h.node]), [[1, 'a'], [2, 'b']])
  assert.equal(locusLockExists(repo, 'src/c.js'), false, 'all or nothing: no locus lock without a slot')
  assert.deepEqual(slotFiles(repo), ['1.lock', '2.lock'])
})

test('a planned holder (slot taken, dispatched not yet appended) still occupies its slot', () => {
  const repo = newRepo()
  addNodes(repo, E, [{ id: '.', kind: 'composite', title: 't', defines: [{ id: 'D1', text: 'x' }] }, leaf('a'), leaf('b')], { by: 'session' })
  setMax(repo, 1)
  assert.equal(take(repo, 'a').ok, true)
  assert.equal(take(repo, 'b').reason, 'no_slot')
})

for (const [kind, extra] of [
  ['approved', { head_sha: 'abc', review_rounds: 0, at_integration: false }],
  ['merged', { into: 'agentics/e1', merged_sha: 'def', head_sha: 'abc' }],
  ['escalated', { reason: 'stuck', detail: '' }],
  ['parked', { return: 'needs_design', question: 'which?' }],
]) {
  test(`a slot frees without a write when its holder becomes ${kind}`, () => {
    const repo = effortRepo(['a', 'b'], { max: 1 })
    assert.equal(take(repo, 'a').slot, 1)
    assert.equal(take(repo, 'b').reason, 'no_slot')
    assert.equal(heldBy(repo).slots[0].active, true)

    event(repo, kind, 'a', extra)
    assert.equal(heldBy(repo).slots[0].active, false)
    const b = take(repo, 'b')
    assert.deepEqual([b.ok, b.slot], [true, 1])
    assert.equal(heldBy(repo).slots[0].node, 'b')
  })
}

test('all or nothing: one held locus path refuses the whole acquire, leaving no slot and no other lock', () => {
  const repo = effortRepo(['a', 'b'], { max: 4 })
  assert.equal(take(repo, 'a', { locus: ['src/shared.js'] }).ok, true)

  const b = take(repo, 'b', { locus: ['src/b.js', 'src/shared.js'] })
  assert.equal(b.ok, false)
  assert.equal(b.reason, 'locus_held')
  assert.deepEqual(b.held_by, [{ effort: E, path: 'src/shared.js', node: 'a', execution: X }])
  assert.equal(locusLockExists(repo, 'src/b.js'), false)
  assert.deepEqual(slotFiles(repo), ['1.lock'], 'b left no slot behind')

  // approved is not enough for a locus lock: the file is free only once a's work has merged
  event(repo, 'approved', 'a', { head_sha: 'abc', review_rounds: 0, at_integration: false })
  assert.equal(take(repo, 'b', { locus: ['src/b.js', 'src/shared.js'] }).reason, 'locus_held')
  event(repo, 'merged', 'a', { into: 'agentics/e1', merged_sha: 'def', head_sha: 'abc' })
  const again = take(repo, 'b', { locus: ['src/b.js', 'src/shared.js'] })
  assert.equal(again.ok, true)
  assert.deepEqual(heldBy(repo).locus.map((l) => [l.path, l.node]), [['src/b.js', 'b'], ['src/shared.js', 'b']])
})

test('a locus lock whose holder was retired by a replan is free', () => {
  const repo = effortRepo(['a', 'b'], { max: 4 })
  assert.equal(take(repo, 'a', { locus: ['src/x.js'] }).ok, true)
  assert.equal(take(repo, 'b', { locus: ['src/x.js'] }).reason, 'locus_held')
  const r = addNodes(repo, E, [{ ...leaf('a'), retired: true }], { by: 'session', reason: 'retired' })
  assert.ok(r.ok, JSON.stringify(r.problems))
  assert.equal(take(repo, 'b', { locus: ['src/x.js'] }).ok, true)
})

test('re-acquiring what the same node holds is a no-op success on the same slot', () => {
  const repo = effortRepo(['a', 'b'], { max: 2 })
  const first = take(repo, 'a', { locus: ['src/a.js'] })
  assert.equal(take(repo, 'b').slot, 2)
  const second = take(repo, 'a', { locus: ['src/a.js'], execution: '20260925-130000' })
  assert.deepEqual([second.ok, second.slot, second.locks], [true, first.slot, ['src/a.js']])
  assert.deepEqual(slotFiles(repo), ['1.lock', '2.lock'])
  assert.equal(heldBy(repo).slots[0].execution, '20260925-130000', 'the slot now names the re-acquiring execution')
})

test('shrinking max_parallel: slots above the limit never count and are never handed out', () => {
  const repo = effortRepo(['a', 'b', 'c', 'd', 'e'], { max: 4 })
  for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) assert.equal(take(repo, id).slot, i + 1)
  setMax(repo, 2)

  const e = take(repo, 'e')
  assert.equal(e.reason, 'no_slot')
  assert.deepEqual(e.held_by.map((h) => h.n), [1, 2], 'only indices 1..max are in play')

  event(repo, 'approved', 'c', { head_sha: 'x', review_rounds: 0, at_integration: false })
  assert.equal(take(repo, 'e').reason, 'no_slot', 'slot 3 freeing does not help above the limit')
  assert.equal(take(repo, 'd').reason, 'no_slot', 'd holds slot 4, above the limit: its next leaf-open waits too')
  assert.deepEqual(slotFiles(repo), ['1.lock', '2.lock', '3.lock', '4.lock'], 'a holder above the limit keeps its file')

  event(repo, 'approved', 'a', { head_sha: 'x', review_rounds: 0, at_integration: false })
  assert.equal(take(repo, 'e').slot, 1)
  event(repo, 'approved', 'b', { head_sha: 'x', review_rounds: 0, at_integration: false })
  const d = take(repo, 'd')
  assert.equal(d.slot, 2)
  assert.deepEqual(slotFiles(repo), ['1.lock', '2.lock', '3.lock'], 'd moved into range and dropped slot 4')
})

test('waits, polling, until an injected holder predicate frees a slot', () => {
  const repo = newRepo()
  setMax(repo, 1)
  assert.equal(acquire(repo, { effort: E, execution: X, node: 'a', holderActive: () => true, waitMs: 0 }).ok, true)
  let polls = 0
  const started = Date.now()
  const b = acquire(repo, {
    effort: E, execution: X, node: 'b', waitMs: 5000, pollMs: 20,
    holderActive: () => ++polls < 4,
  })
  assert.deepEqual([b.ok, b.slot], [true, 1])
  assert.ok(polls >= 4)
  assert.ok(Date.now() - started >= 40, 'it slept between attempts')
})

test('waits until another process frees the slot by appending the holder\'s approval', async () => {
  const repo = effortRepo(['a', 'b'], { max: 1 })
  assert.equal(take(repo, 'a').slot, 1)
  const script = `
    import { append } from ${JSON.stringify(LEDGER_URL)}
    setTimeout(() => {
      const r = append(${JSON.stringify(repo)}, ${JSON.stringify(E)}, 'events',
        { kind: 'approved', node: 'a', execution: ${JSON.stringify(X)}, head_sha: 'x', review_rounds: 0, at_integration: false })
      process.exit(r.ok ? 0 : 1)
    }, 300)`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' })
  const exited = new Promise((resolve) => child.on('exit', resolve))

  const started = Date.now()
  const b = acquire(repo, { effort: E, execution: X, node: 'b', waitMs: 10000, pollMs: 50 })
  assert.deepEqual([b.ok, b.slot], [true, 1])
  assert.ok(Date.now() - started >= 200, 'it waited for the other process')
  assert.equal(await exited, 0)
})

test('no_slot after waitMs when nothing frees', () => {
  const repo = effortRepo(['a', 'b'], { max: 1 })
  assert.equal(take(repo, 'a').ok, true)
  const started = Date.now()
  const b = acquire(repo, { effort: E, execution: X, node: 'b', waitMs: 200, pollMs: 50 })
  const took = Date.now() - started
  assert.equal(b.ok, false)
  assert.equal(b.reason, 'no_slot')
  assert.deepEqual(b.held_by, [{ n: 1, effort: E, execution: X, node: 'a' }])
  assert.ok(took >= 200 && took < 3000, 'waited about waitMs, took ' + took)
})

test('two processes racing for the last slot: exactly one wins', async () => {
  for (let round = 0; round < 3; round++) {
    const repo = newRepo()
    setMax(repo, 2)
    assert.equal(acquire(repo, { effort: E, execution: X, node: 'held', holderActive: () => true, waitMs: 0 }).slot, 1)
    const startAt = Date.now() + 300
    const script = (node) => `
      import { acquire } from ${JSON.stringify(LOCKS_URL)}
      while (Date.now() < ${startAt}) {}
      const r = acquire(${JSON.stringify(repo)}, { effort: ${JSON.stringify(E)}, execution: ${JSON.stringify(X)},
        node: ${JSON.stringify(node)}, locus: ['src/${node}.js'], holderActive: () => true, waitMs: 0 })
      console.log(JSON.stringify(r))`
    const run = (node) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script(node)], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { err += d })
      child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))))
    })
    const results = await Promise.all([run('p'), run('q')])
    assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results))
    const loser = results.find((r) => !r.ok)
    assert.equal(loser.reason, 'no_slot')
    const winner = results.find((r) => r.ok)
    assert.equal(winner.slot, 2)
    assert.deepEqual(slotFiles(repo), ['1.lock', '2.lock'])
    const loserNode = results[0].ok ? 'q' : 'p'
    assert.equal(locusLockExists(repo, `src/${loserNode}.js`), false, 'the loser wrote no locus lock')
  }
})

test('releaseSlots frees one execution\'s slots; releaseLocus frees named nodes\' locks', () => {
  const repo = newRepo()
  const on = () => true
  acquire(repo, { effort: E, execution: X, node: 'a', locus: ['src/a.js'], holderActive: on, waitMs: 0 })
  acquire(repo, { effort: E, execution: X, node: 'b', locus: ['src/b.js'], holderActive: on, waitMs: 0 })
  acquire(repo, { effort: E, execution: 'other', node: 'c', locus: ['src/c.js'], holderActive: on, waitMs: 0 })
  assert.deepEqual(releaseSlots(repo, { effort: E, execution: X, node: 'b' }).released, [2])
  assert.deepEqual(releaseSlots(repo, { effort: E, execution: X }).released, [1])
  assert.deepEqual(slotFiles(repo), ['3.lock'])

  assert.deepEqual(releaseLocus(repo, E, ['a', 'c']).released.sort(), ['src/a.js', 'src/c.js'])
  assert.deepEqual(heldBy(repo).locus.map((l) => l.path), ['src/b.js'])
})

test('withBranchLock serializes per branch and releases afterwards', () => {
  const repo = newRepo()
  const inner = withBranchLock(repo, E, 'agentics/e1', () => {
    // the same branch is held: a second taker gives up after its wait
    assert.throws(() => withBranchLock(repo, E, 'agentics/e1', () => 0, { waitMs: 50 }), /could not take the lock/)
    // another branch is independent
    return withBranchLock(repo, E, 'agentics/e1--a', () => 'nested ok', { waitMs: 50 })
  })
  assert.equal(inner, 'nested ok')
  assert.equal(withBranchLock(repo, E, 'agentics/e1', () => 'free again', { waitMs: 50 }), 'free again')
})

test('invalid input is refused without touching the pool', () => {
  const repo = newRepo()
  assert.equal(acquire(repo, { effort: 'Bad--slug', execution: X, node: 'a', waitMs: 0 }).reason, 'invalid')
  assert.equal(acquire(repo, { effort: E, execution: X, node: 'a', locus: ['../etc/passwd'], waitMs: 0 }).reason, 'invalid')
  assert.deepEqual(slotFiles(repo), [])
})

test('CLI: held prints the pool', () => {
  const repo = effortRepo(['a'], { max: 3 })
  take(repo, 'a', { locus: ['src/a.js'] })
  const r = spawnSync(process.execPath, [LOCKS, 'held', '--repo', repo], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), {
    max_parallel: 3,
    slots: [{ n: 1, effort: E, execution: X, node: 'a', active: true }],
    locus: [{ effort: E, path: 'src/a.js', node: 'a', execution: X }],
    notes: [],
  })
})
