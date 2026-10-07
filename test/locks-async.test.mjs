// test/locks-async.test.mjs — the lock and slot waits that keep the event loop running.
//
// What is pinned here:
//
//   withLockAsync        withLock's lock and holder, waited for with an awaited sleep: timers fire
//                        while it waits; it and withLock exclude each other; the same timeout error;
//                        a dead holder broken; the lock held until an async fn settles
//   acquireAsync         acquire's result, its slot wait awaited; a held locus answered at once
//   withBranchLockAsync  one branch held across an awaited fn, other branches free
//
// Design: docs/DESIGN.md#slots-and-locks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { append } from '../lib/ledger.mjs'
import { acquire, acquireAsync, withBranchLock, withBranchLockAsync } from '../lib/locks.mjs'
import { configPath, mkdirState, withLock, withLockAsync } from '../lib/store.mjs'
import { seedTree } from './harness/seed-tree.mjs'

const E = 'e1'
const X = '20260925-120000'

const fresh = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-locks-async-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const deadPid = () => spawnSync(process.execPath, ['-e', ''], { env: { ...process.env, NODE_TEST_CONTEXT: '' } }).pid

/** Put the holder file of a holder that is gone into the lock directory at `path`. */
const goneHolder = (path) =>
  writeFileSync(join(path, 'gone'), JSON.stringify({ pid: deadPid(), host: hostname(), at: new Date().toISOString() }))

/** withLock's answer: 'taken', or the message it threw. */
const syncAttempt = (path, waitMs) => {
  try {
    return withLock(path, () => 'taken', { waitMs })
  } catch (err) {
    return err.message
  }
}

/** A promise the test resolves by hand. */
const gate = () => {
  let open
  const opened = new Promise((resolve) => { open = resolve })
  return { open, opened }
}

const leaf = (id) => ({
  id, kind: 'leaf', title: 'do ' + id, rigor: 'trivial', locus: ['src/' + id + '.js', 'src/shared.js'],
  decisions: ['D1'], acceptance: [{ text: id + ' works', check: 'node --test', decisions: ['D1'] }],
})

/** A repo with one effort whose leaves are dispatched (status `active`), and a pool of `max`. */
function effortRepo(t, ids, max) {
  const repo = fresh(t)
  const out = seedTree(repo, E, [
    { id: '.', kind: 'composite', title: 'the change', defines: [{ id: 'D1', text: 'do it' }] },
    ...ids.map(leaf),
  ])
  assert.ok(out.ok, JSON.stringify(out.problems))
  for (const id of ids) {
    const r = append(repo, E, 'events', { kind: 'dispatched', node: id, execution: X, role: 'implementer', round: 1, model: 'sonnet', effort: 'medium' })
    assert.ok(r.ok, r.error)
  }
  mkdirState(dirname(configPath(repo)))
  writeFileSync(configPath(repo), JSON.stringify({ max_parallel: max }))
  return repo
}

// ------------------------------------------------------------------ withLockAsync

test('a timer fires while withLockAsync waits', { timeout: 10_000 }, async (t) => {
  const path = join(fresh(t), 'held')
  const release = gate()
  const holding = withLockAsync(path, () => release.opened)
  let fired = false
  setTimeout(() => { fired = true; release.open() }, 50)
  const seen = await withLockAsync(path, () => fired, { waitMs: 5000 })
  await holding
  assert.equal(seen, true, 'only the timer releases the holder, so the wait let it fire')
  assert.equal(existsSync(path), false, 'released afterwards')
})

test('withLockAsync waits while withLock holds the lock', { timeout: 10_000 }, async (t) => {
  const path = join(fresh(t), 'held')
  let sleeps = 0
  let released = false
  let waiting
  withLock(path, () => {
    waiting = withLockAsync(path, () => ({ released, held: existsSync(path) }), { sleep: async () => { sleeps++ } })
  })
  released = true
  assert.deepEqual(await waiting, { released: true, held: true }, 'it ran, holding the lock, only after withLock released')
  assert.ok(sleeps >= 1, 'it waited')
  assert.equal(existsSync(path), false, 'released afterwards')
})

test('withLock waits while withLockAsync holds the lock', { timeout: 10_000 }, async (t) => {
  const path = join(fresh(t), 'held')
  const outcome = await withLockAsync(path, async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    return syncAttempt(path, 100)
  })
  assert.match(outcome, /could not take the lock/)
  assert.equal(syncAttempt(path, 100), 'taken', 'free once withLockAsync released')
})

test('withLockAsync gives up with the error withLock gives', { timeout: 10_000 }, async (t) => {
  const dir = fresh(t)
  const path = join(dir, 'held')
  await withLockAsync(path, async () => {
    const mine = readdirSync(path)
    const expected = syncAttempt(path, 50)
    const actual = await withLockAsync(path, () => 'taken', { waitMs: 50 }).catch((err) => err.message)
    assert.match(expected, /could not take the lock/)
    assert.equal(actual, expected)
    assert.deepEqual(readdirSync(path), mine, 'the holder is untouched')
    assert.deepEqual(readdirSync(dir), ['held'], 'a waiter that gave up leaves nothing beside the lock')
  })
})

test('withLockAsync breaks a dead holder and takes the lock', { timeout: 10_000 }, async (t) => {
  const path = join(fresh(t), 'held')
  mkdirSync(path, { recursive: true })
  goneHolder(path)
  assert.equal(await withLockAsync(path, () => 'taken', { waitMs: 5000 }), 'taken')
  assert.equal(existsSync(path), false, 'released afterwards')
})

test('withLockAsync holds the lock until an async fn settles, and releases it when fn rejects', { timeout: 10_000 }, async (t) => {
  const path = join(fresh(t), 'held')
  const boom = new Error('boom')
  let heldWhileAwaiting = false
  await assert.rejects(withLockAsync(path, async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    heldWhileAwaiting = existsSync(path)
    throw boom
  }), boom)
  assert.equal(heldWhileAwaiting, true)
  assert.equal(existsSync(path), false, 'released after the rejection')
  assert.equal(await withLockAsync(path, async () => 'resolved'), 'resolved', 'the resolved value is returned')
})

// ------------------------------------------------------------------ acquireAsync

test('acquireAsync returns what acquire returns once a slot frees', { timeout: 10_000 }, async (t) => {
  const repo = effortRepo(t, ['a', 'b'], 1)
  assert.equal(acquire(repo, { effort: E, execution: X, node: 'a', waitMs: 0 }).ok, true)
  let freed = false
  const pauses = []
  const spec = { effort: E, execution: X, node: 'b', holderActive: () => !freed, waitMs: 60_000, pollMs: 5 }
  const result = await acquireAsync(repo, spec, {
    sleep: async (ms) => { pauses.push(ms); if (pauses.length === 2) freed = true },
  })
  assert.equal(pauses.length, 2, 'it waited until the slot freed, and no longer')
  assert.ok(pauses.every((ms) => ms >= 1 && ms <= spec.pollMs), 'each pause is at most pollMs: ' + pauses)
  assert.equal(result.ok, true)
  assert.deepEqual(result, acquire(repo, { ...spec, waitMs: 0 }), 'the result acquire gives for the slot b now holds')
})

test('acquireAsync answers locus_held at once, as acquire does', { timeout: 10_000 }, async (t) => {
  const repo = effortRepo(t, ['a', 'b'], 4)
  assert.equal(acquire(repo, { effort: E, execution: X, node: 'a', locus: ['src/shared.js'], waitMs: 0 }).ok, true)
  let sleeps = 0
  const spec = { effort: E, execution: X, node: 'b', locus: ['src/b.js', 'src/shared.js'], waitMs: 60_000 }
  const result = await acquireAsync(repo, spec, { sleep: async () => { sleeps++ } })
  assert.equal(result.reason, 'locus_held')
  assert.equal(sleeps, 0, 'a held locus is never waited for')
  assert.deepEqual(result, acquire(repo, { ...spec, waitMs: 0 }))
})

test('acquireAsync answers no_slot once waitMs has passed, as acquire does', { timeout: 10_000 }, async (t) => {
  const repo = effortRepo(t, ['a', 'b'], 1)
  assert.equal(acquire(repo, { effort: E, execution: X, node: 'a', waitMs: 0 }).ok, true)
  let sleeps = 0
  const spec = { effort: E, execution: X, node: 'b', waitMs: 0 }
  const result = await acquireAsync(repo, spec, { sleep: async () => { sleeps++ } })
  assert.equal(result.reason, 'no_slot')
  assert.equal(sleeps, 0)
  assert.deepEqual(result, acquire(repo, spec))
})

test('the event loop runs while acquireAsync waits for a slot', { timeout: 10_000 }, async (t) => {
  const repo = effortRepo(t, ['a', 'b'], 1)
  assert.equal(acquire(repo, { effort: E, execution: X, node: 'a', waitMs: 0 }).ok, true)
  let freed = false
  setTimeout(() => { freed = true }, 50)
  const result = await acquireAsync(repo, { effort: E, execution: X, node: 'b', holderActive: () => !freed, waitMs: 5000, pollMs: 10 })
  assert.deepEqual([result.ok, result.slot], [true, 1], 'only the timer frees the slot, so the wait let it fire')
})

test('acquireAsync refuses what acquire refuses', async (t) => {
  const repo = fresh(t)
  for (const spec of [{ effort: 'Not An Effort', node: 'a' }, { effort: E, node: '' }, { effort: E, node: 'a', locus: ['../out.js'] }]) {
    const result = await acquireAsync(repo, spec)
    assert.equal(result.reason, 'invalid', JSON.stringify(spec))
    assert.deepEqual(result, acquire(repo, spec))
  }
})

// ------------------------------------------------------------------ withBranchLockAsync

test('withBranchLockAsync holds its branch across an awaited fn, and only that branch', { timeout: 10_000 }, async (t) => {
  const repo = fresh(t)
  const seen = await withBranchLockAsync(repo, E, 'agentics/e1--a', async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    let same
    try {
      same = withBranchLock(repo, E, 'agentics/e1--a', () => 'taken', { waitMs: 50 })
    } catch (err) {
      same = err.message
    }
    return { same, other: withBranchLock(repo, E, 'agentics/e1--b', () => 'taken', { waitMs: 50 }) }
  })
  assert.match(seen.same, /could not take the lock/)
  assert.equal(seen.other, 'taken')
  assert.equal(withBranchLock(repo, E, 'agentics/e1--a', () => 'taken', { waitMs: 50 }), 'taken', 'released afterwards')
})

test('withBranchLockAsync rejects a name that is not an effort', async (t) => {
  await assert.rejects(withBranchLockAsync(fresh(t), 'Not An Effort', 'agentics/x', async () => 'never'), /not an effort name/)
})
