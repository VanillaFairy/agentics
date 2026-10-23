// test/locks.test.mjs — the slot pool and the lock files (lib/locks.mjs).
//
// Temp repositories without git: the pool reads only lock files and each holder's effort tree,
// which is built with the real ledger so the default "does the holder still occupy its slot"
// predicate is exercised against real derived status.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { append } from '../lib/ledger.mjs'
import {
  acquireAsync, heldBy, maxParallel, poolConfig, releaseSlots,
} from '../lib/locks.mjs'
import { configPath, mkdirState, slotsDir } from '../lib/store.mjs'
import { seedTree } from './harness/seed-tree.mjs'

const LOCKS = fileURLToPath(new URL('../lib/locks.mjs', import.meta.url))
const LEDGER_URL = pathToFileURL(fileURLToPath(new URL('../lib/ledger.mjs', import.meta.url))).href
const LOCKS_URL = pathToFileURL(LOCKS).href

const E = 'e1'
const X = '20260925-120000'

const newRepo = () => mkdtempSync(join(tmpdir(), 'agentics-locks-'))

const setMax = (repo, value) => {
  mkdirState(dirname(configPath(repo)))
  writeFileSync(configPath(repo), typeof value === 'string' ? value : JSON.stringify({ max_parallel: value }))
}

// Every leaf declares the shared file too: a lock is held only on a path its holder still claims.
const leaf = (id) => ({
  id, kind: 'leaf', title: 'do ' + id, rigor: 'trivial', expects: ['src/' + id + '.js', 'src/shared.js'],
  decisions: ['D1'], acceptance: [{ text: id + ' works', check: 'node --test', decisions: ['D1'] }],
})

/** A repo with one effort whose leaves are dispatched (status `active`). */
function effortRepo(ids, { max } = {}) {
  const repo = newRepo()
  const out = seedTree(repo, E, [
    { id: '.', kind: 'composite', title: 'the change', defines: [{ id: 'D1', text: 'do it' }] },
    ...ids.map(leaf),
  ])
  assert.ok(out.ok, JSON.stringify(out.problems))
  for (const id of ids) event(repo, 'dispatched', id, { role: 'implementer', round: 1, model: 'sonnet', effort: 'medium' })
  if (max !== undefined) setMax(repo, max)
  return repo
}

const event = (repo, kind, node, extra = {}) => {
  const r = append(repo, E, 'events', { kind, node, execution: X, ...extra })
  assert.ok(r.ok, r.error)
}

const take = (repo, node, extra = {}) => acquireAsync(repo, { effort: E, execution: X, node, waitMs: 0, ...extra })

const slotFiles = (repo) => (existsSync(slotsDir(repo)) ? readdirSync(slotsDir(repo)).filter((f) => /^\d+\.lock$/.test(f)).sort() : [])

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

test('the slot cap lives in the project settings, and a config left in slots/ is not read', () => {
  const repo = newRepo()
  mkdirSync(slotsDir(repo), { recursive: true })
  writeFileSync(join(slotsDir(repo), 'config.json'), JSON.stringify({ max_parallel: 9 }))
  assert.equal(maxParallel(repo), 4, 'the old place is nobody\'s settings any more')

  setMax(repo, 6)
  assert.equal(maxParallel(repo), 6)

  setMax(repo, '{nope')
  const c = poolConfig(repo)
  assert.equal(c.max_parallel, 4)
  assert.match(c.note, /config\.json/)
})

test('the pool limit is respected: the leaf past max_parallel gets no_slot and nothing is written for it', async () => {
  const repo = effortRepo(['a', 'b', 'c'], { max: 2 })
  const a = await take(repo, 'a')
  const b = await take(repo, 'b')
  assert.deepEqual([a.ok, a.slot, b.ok, b.slot], [true, 1, true, 2])

  const c = await take(repo, 'c')
  assert.equal(c.ok, false)
  assert.equal(c.reason, 'no_slot')
  assert.deepEqual(c.held_by.map((h) => [h.n, h.node]), [[1, 'a'], [2, 'b']])
  assert.deepEqual(slotFiles(repo), ['1.lock', '2.lock'])
})

test('a planned holder (slot taken, dispatched not yet appended) still occupies its slot', async () => {
  const repo = newRepo()
  seedTree(repo, E, [{ id: '.', kind: 'composite', title: 't', defines: [{ id: 'D1', text: 'x' }] }, leaf('a'), leaf('b')])
  setMax(repo, 1)
  assert.equal((await take(repo, 'a')).ok, true)
  assert.equal((await take(repo, 'b')).reason, 'no_slot')
})

for (const [kind, extra] of [
  ['approved', { head_sha: 'abc', review_rounds: 0, at_integration: false }],
  ['merged', { into: 'agentics/e1', merged_sha: 'def', head_sha: 'abc' }],
  ['escalated', { reason: 'stuck', detail: '' }],
  ['parked', { return: 'needs_design', question: 'which?' }],
]) {
  test(`a slot frees without a write when its holder becomes ${kind}`, async () => {
    const repo = effortRepo(['a', 'b'], { max: 1 })
    assert.equal((await take(repo, 'a')).slot, 1)
    assert.equal((await take(repo, 'b')).reason, 'no_slot')
    assert.equal(heldBy(repo).slots[0].active, true)

    event(repo, kind, 'a', extra)
    assert.equal(heldBy(repo).slots[0].active, false)
    const b = await take(repo, 'b')
    assert.deepEqual([b.ok, b.slot], [true, 1])
    assert.equal(heldBy(repo).slots[0].node, 'b')
  })
}

test('re-acquiring what the same node holds is a no-op success on the same slot', async () => {
  const repo = effortRepo(['a', 'b'], { max: 2 })
  const first = await take(repo, 'a')
  assert.equal((await take(repo, 'b')).slot, 2)
  const second = await take(repo, 'a', { execution: '20260925-130000' })
  assert.deepEqual([second.ok, second.slot], [true, first.slot])
  assert.deepEqual(slotFiles(repo), ['1.lock', '2.lock'])
  assert.equal(heldBy(repo).slots[0].execution, '20260925-130000', 'the slot now names the re-acquiring execution')
})

test('shrinking max_parallel: slots above the limit never count and are never handed out', async () => {
  const repo = effortRepo(['a', 'b', 'c', 'd', 'e'], { max: 4 })
  for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) assert.equal((await take(repo, id)).slot, i + 1)
  setMax(repo, 2)

  const e = await take(repo, 'e')
  assert.equal(e.reason, 'no_slot')
  assert.deepEqual(e.held_by.map((h) => h.n), [1, 2], 'only indices 1..max are in play')

  event(repo, 'approved', 'c', { head_sha: 'x', review_rounds: 0, at_integration: false })
  assert.equal((await take(repo, 'e')).reason, 'no_slot', 'slot 3 freeing does not help above the limit')
  assert.equal((await take(repo, 'd')).reason, 'no_slot', 'd holds slot 4, above the limit: its next leaf-open waits too')
  assert.deepEqual(slotFiles(repo), ['1.lock', '2.lock', '3.lock', '4.lock'], 'a holder above the limit keeps its file')

  event(repo, 'approved', 'a', { head_sha: 'x', review_rounds: 0, at_integration: false })
  assert.equal((await take(repo, 'e')).slot, 1)
  event(repo, 'approved', 'b', { head_sha: 'x', review_rounds: 0, at_integration: false })
  const d = await take(repo, 'd')
  assert.equal(d.slot, 2)
  assert.deepEqual(slotFiles(repo), ['1.lock', '2.lock', '3.lock'], 'd moved into range and dropped slot 4')
})

test('waits, polling, until an injected holder predicate frees a slot', async () => {
  const repo = newRepo()
  setMax(repo, 1)
  assert.equal((await acquireAsync(repo, { effort: E, execution: X, node: 'a', holderActive: () => true, waitMs: 0 })).ok, true)
  let polls = 0
  const started = Date.now()
  const b = await acquireAsync(repo, {
    effort: E, execution: X, node: 'b', waitMs: 5000, pollMs: 20,
    holderActive: () => ++polls < 4,
  })
  assert.deepEqual([b.ok, b.slot], [true, 1])
  assert.ok(polls >= 4)
  assert.ok(Date.now() - started >= 40, 'it slept between attempts')
})

test('waits until another process frees the slot by appending the holder\'s approval', async () => {
  const repo = effortRepo(['a', 'b'], { max: 1 })
  assert.equal((await take(repo, 'a')).slot, 1)
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
  const b = await acquireAsync(repo, { effort: E, execution: X, node: 'b', waitMs: 10000, pollMs: 50 })
  assert.deepEqual([b.ok, b.slot], [true, 1])
  assert.ok(Date.now() - started >= 200, 'it waited for the other process')
  assert.equal(await exited, 0)
})

test('no_slot after waitMs when nothing frees', async () => {
  const repo = effortRepo(['a', 'b'], { max: 1 })
  assert.equal((await take(repo, 'a')).ok, true)
  const started = Date.now()
  const b = await acquireAsync(repo, { effort: E, execution: X, node: 'b', waitMs: 200, pollMs: 50 })
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
    assert.equal((await acquireAsync(repo, { effort: E, execution: X, node: 'held', holderActive: () => true, waitMs: 0 })).slot, 1)
    const startAt = Date.now() + 300
    const script = (node) => `
      import { acquireAsync } from ${JSON.stringify(LOCKS_URL)}
      while (Date.now() < ${startAt}) {}
      const r = await acquireAsync(${JSON.stringify(repo)}, { effort: ${JSON.stringify(E)}, execution: ${JSON.stringify(X)},
        node: ${JSON.stringify(node)}, holderActive: () => true, waitMs: 0 })
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
  }
})

test('releaseSlots frees one execution\'s slots, or one node\'s', async () => {
  const repo = newRepo()
  const on = () => true
  await acquireAsync(repo, { effort: E, execution: X, node: 'a', holderActive: on, waitMs: 0 })
  await acquireAsync(repo, { effort: E, execution: X, node: 'b', holderActive: on, waitMs: 0 })
  await acquireAsync(repo, { effort: E, execution: 'other', node: 'c', holderActive: on, waitMs: 0 })
  assert.deepEqual(releaseSlots(repo, { effort: E, execution: X, node: 'b' }).released, [2])
  assert.deepEqual(releaseSlots(repo, { effort: E, execution: X }).released, [1])
  assert.deepEqual(slotFiles(repo), ['3.lock'])
})

test('invalid input is refused without touching the pool', async () => {
  const repo = newRepo()
  assert.equal((await acquireAsync(repo, { effort: 'Bad--slug', execution: X, node: 'a', waitMs: 0 })).reason, 'invalid')
  assert.equal((await acquireAsync(repo, { effort: E, execution: X, node: '', waitMs: 0 })).reason, 'invalid')
  assert.deepEqual(slotFiles(repo), [])
})

test('heldBy reports every slot', async () => {
  const repo = effortRepo(['a'], { max: 3 })
  await take(repo, 'a')
  assert.deepEqual(heldBy(repo), {
    max_parallel: 3,
    slots: [{ n: 1, effort: E, execution: X, node: 'a', active: true }],
    notes: [],
  })
})
