// test/migrate-v5.test.mjs — the one-shot move of a 4.x effort store to 5.0: open executions are
// closed migrated, open stops are stated again with their words as stored returns, standing
// claims and judgements are written again under their 5.0 name, an unapproved folder's complete
// review is marked incomplete, an open review loop's findings become messages, what 5.0 never
// reads is listed, nothing a node's status derives from moves, and a second run changes nothing.
// The sections after the whole move pin what 5.0 then reads of the moved store: a migrated message
// beside a boundary's own, the effort lock judged as the lock does, the gate's open ambiguities,
// the evidence the landing view prints, a fixes file a later round superseded, a migrated green's
// first round, and the edges of each part.
//
// Design: docs/DESIGN.md#migration-from-4x.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { approvalGate } from '../lib/approval.mjs'
import { leafOpen } from '../lib/boundaries/leaf-open.mjs'
import { executionContext, freshRecords, message } from '../lib/boundaries/records.mjs'
import { append, appendProject, executionLog, readLog, readProjectLog } from '../lib/ledger.mjs'
import { renderLanding } from '../lib/render.mjs'
import { hashSpec } from '../lib/spec.mjs'
import { executionSummary } from '../lib/status.mjs'
import { effortStateDir, executionDir, executionsRoot, fixesPath, nodeKey, posix, saidOf, specPath, stalePath } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { apply, plan } from '../tools/migrate-v5.mjs'
import { executionRig } from './harness/program-rig.mjs'
import { seedTree } from './harness/seed-tree.mjs'

const TOOL = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'migrate-v5.mjs')

const E = 'e1'
const CLOSED = '20260801-100000'
const OPEN = '20260901-100000'
const NOENV = '20260902-100000'
const V5 = '20260903-100000'
const LONG = 'a-leaf-whose-name-is-longer-than-forty-characters'
const S1 = 'I0000000a'
const S2 = 'I0000000b'

const childEnv = () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return env
}

// A pid no process holds: the largest int32, which no OS allocates (Windows pids are small and
// recycled, Linux stops at 2^22). The pid of an exited child is not safe here: the OS hands a
// freed pid to the next process started, and under a concurrent suite that process is alive while
// a test plans, so the migration would refuse the whole effort as busy.
const DEAD_PID = 2 ** 31 - 1
assert.throws(() => process.kill(DEAD_PID, 0), { code: 'ESRCH' })

const TEXT = {
  a: 'a is stuck — needs the café decision\n\nsecond paragraph\r\nthird line\n',
  b1: 'b parks on this\n',
  b2: 'b escalates on this\n',
  n: 'n was stopped by a session call\n',
  long: 'the long leaf stops\n',
  root: 'the root parks\n',
}

/** A review entry of a 4.x fixes file, as the leaf's review wrote it. */
const finding = (id, severity, remedy = 'code', extra = {}) =>
  ({ id, severity, claim: id + ' claim', evidence: id + ' evidence', remedy, ...extra })
const reviewEntry = (f) => ({
  source: 'review ' + f.severity + ' ' + f.id, claim: f.claim, evidence: f.evidence, remedy: f.remedy, ...(f.carried ? { carried: true } : {}),
})
const verification = { source: 'verification', claim: 'the suite fails', evidence: '1 failing', remedy: 'code' }

const F = {
  c1: [finding('F0', 'minor')],
  c2: [finding('F1', 'minor'), finding('F2', 'critical', 'tests')],
  c5: [finding('F9', 'major')],
  gr2: [finding('G1', 'major', 'tests', { carried: true }), finding('G2', 'major', 'code')],
  ta2: [finding('A1', 'major', 'tests'), finding('A2', 'major', 'code')],
  d2: [finding('D1', 'major')],
  fx2: [finding('X1', 'major')],
}

const leaf = (id, extra = {}) => ({
  id, kind: 'leaf', title: 'do ' + id, rigor: 'tdd', locus: [id.split('/').join('-') + '.mjs'],
  acceptance: [{ text: id + ' works', check: 'node --test' }], ...extra,
})
const composite = (id) => ({ id, kind: 'composite', title: 'folder ' + id })

function put(path, text = '{}') {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A 4.x store in a fresh directory: effort `e1` with the tree, events, executions, ledger and
 * evidence items the migration reads, in the shapes 4.x wrote them. No git repository.
 */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-migrate-v5-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const seeded = seedTree(dir, E, [
    { id: '.', kind: 'composite', title: 'root' },
    leaf('a'), leaf('b'), leaf('c'), leaf('d'), leaf('n'), leaf(LONG),
    leaf('r', { rigor: 'tdd-pair', role: 'red', locus: ['r.test.mjs'] }),
    leaf('gr', { rigor: 'tdd-pair', role: 'green', deps: ['r'] }),
    leaf('tr', { rigor: 'tdd-triad', role: 'red', locus: ['tr.test.mjs'] }),
    leaf('tg', { rigor: 'tdd-triad', role: 'green', deps: ['tr'] }),
    leaf('ta', { rigor: 'tdd-triad', role: 'audit', deps: ['tg'] }),
    composite('f'), leaf('f/x'), composite('g'), leaf('g/y'),
  ])
  assert.equal(seeded.ok, true, JSON.stringify(seeded.problems))
  assert.ok(nodeKey(LONG).includes('_'), 'the long leaf has a bounded key')

  const openDir = executionDir(dir, E, OPEN)
  const said = (name, text) => {
    const path = posix(join(openDir, 'said', name))
    put(path, text)
    return path
  }
  const ev = (kind, node, fields = {}, execution = OPEN) => {
    const out = append(dir, E, 'events', { kind, node, execution, ...fields })
    assert.equal(out.ok, true, out.error)
    return out.seqs[0]
  }
  const state = (stamp, entry) => {
    const out = append(dir, E, 'state:' + stamp, entry)
    assert.equal(out.ok, true, out.error)
    return out.seqs[0]
  }

  const files = {
    a: said('a-escalation.md', TEXT.a), b1: said('b-park.md', TEXT.b1), b2: said('b-escalation.md', TEXT.b2),
    n: said('n-escalation.md', TEXT.n), long: said('long-escalation.md', TEXT.long), root: said('root-park.md', TEXT.root),
    f: said('f-review.md', 'f was reviewed\n'),
  }
  const seq = {}
  ev('dispatched', 'a', { role: 'implementer', round: 1 })
  seq.aEsc = ev('escalated', 'a', { reason: 'blocked', detail: 'a is blocked', said: files.a })
  seq.bPark = ev('parked', 'b', { return: 'needs_decision', question: 'which b?', said: files.b1 })
  seq.bEsc = ev('escalated', 'b', { reason: 'broken', detail: 'b is broken', said: files.b2 })
  ev('dispatched', 'c', { role: 'implementer', round: 2 })
  ev('dispatched', 'd', { role: 'implementer', round: 1 })
  ev('approved', 'd', { head_sha: 'd'.repeat(40), review_rounds: 1, at_integration: false })
  ev('dispatched', 'r', { role: 'test-author', round: 1 })
  ev('approved', 'r', { head_sha: 'e'.repeat(40), review_rounds: 1, at_integration: false })
  ev('dispatched', 'gr', { role: 'implementer', round: 2 })
  ev('dispatched', 'ta', { role: 'auditor', round: 2 })
  ev('merged', 'f/x', { head_sha: 'f'.repeat(40) })
  seq.fClaims = ev('claims', 'f', {
    head_sha: '1'.repeat(40), review: 'done', said: files.f,
    claims: [{ claim: 'f holds together', verdict: 'met' }, { claim: 'f is fast', verdict: 'under' }],
  })
  seq.gClaims = ev('claims', 'g', { head_sha: '2'.repeat(40), review: 'done', claims: [{ claim: 'g holds', verdict: 'met' }] })
  ev('merged', 'g/y', { head_sha: '3'.repeat(40) })
  seq.nEsc = ev('escalated', 'n', { reason: 'blocked', detail: 'n is blocked', said: files.n }, '')
  seq.longEsc = ev('escalated', LONG, { reason: 'blocked', detail: 'long is blocked', said: files.long })
  seq.rootPark = ev('parked', '.', { return: 'integration_critical', question: 'which root?', said: files.root })

  // executions
  state(CLOSED, { kind: 'invocation', at: 'then' })
  state(CLOSED, { kind: 'closed', status: 'done' })
  put(join(executionDir(dir, E, CLOSED), 'execution.json'), JSON.stringify({ root: '.' }))
  put(fixesPath(dir, E, CLOSED, 'c', 5), JSON.stringify(F.c5.map(reviewEntry)))

  put(join(openDir, 'execution.json'), JSON.stringify({ root: '.' }))
  state(OPEN, { kind: 'invocation', at: 'now' })
  state(OPEN, { kind: 'dispatch', node: 'a', role: 'implementer' })
  state(OPEN, { kind: 'usage', node: 'a', tokens: 10 })
  state(OPEN, { kind: 'checkpoint', why: 'size' })
  state(OPEN, { kind: 'ended' })
  assert.equal(append(dir, E, 'journal:' + OPEN, { kind: 'merge-observed', note: 'x' }).ok, true)
  put(fixesPath(dir, E, OPEN, 'c', 1), JSON.stringify(F.c1.map(reviewEntry)))
  put(fixesPath(dir, E, OPEN, 'c', 2), JSON.stringify([reviewEntry(F.c2[0]), verification, reviewEntry(F.c2[1])]))
  put(fixesPath(dir, E, OPEN, 'gr', 2), JSON.stringify(F.gr2.map(reviewEntry)))
  put(fixesPath(dir, E, OPEN, 'ta', 2), JSON.stringify(F.ta2.map(reviewEntry)))
  put(fixesPath(dir, E, OPEN, 'd', 2), JSON.stringify(F.d2.map(reviewEntry)))
  put(fixesPath(dir, E, OPEN, 'f/x', 2), JSON.stringify(F.fx2.map(reviewEntry)))
  put(join(openDir, 'jobs', 'leaf-close-1.pid'), String(DEAD_PID))
  put(join(openDir, 'jobs', 'leaf-close-1.json'), JSON.stringify({ boundary: 'leaf-close', ok: true }))
  put(join(openDir, 'cards', 'leaf-a-12345678.json'))
  put(join(openDir, 'briefs', 'a-implementer-r1.md'), 'brief\n')
  put(join(openDir, 'closes', 'a-implementer-r1.json'))
  put(join(openDir, 'reviews', 'c-r1.json'))
  put(stalePath(dir, E, OPEN, '0a1b2c3'), 'stale\n')
  put(join(openDir, 'mystery.txt'), 'unknown\n')

  state(NOENV, { kind: 'invocation', at: 'later' })

  const v5Dir = executionDir(dir, E, V5)
  put(join(v5Dir, 'execution.json'), JSON.stringify({ root: '.' }))
  state(V5, { kind: 'run', run: E + '.' + V5 })
  put(join(v5Dir, 'closes', 'a.json'))
  put(join(v5Dir, 'returns', 'a-implementer-1.json'), JSON.stringify({ status: 'returned', text: 'x' }))

  put(join(effortStateDir(dir, E), 'reports', OPEN + '-a-implementer-r1.md'), 'report\n')
  put(join(effortStateDir(dir, E), 'reports', OPEN + '-a-implementer-r1.json'))

  // the ledger
  const spec = (folder, text) => {
    put(specPath(dir, E, folder), text)
    return hashSpec(text)
  }
  const reviewed = (folder, hash, complete = true) => append(dir, E, 'ledger', {
    kind: 'reviewed', folder, hash, complete, remaining: complete ? [] : ['an axis'], ambiguities: [], clean: [], sections: {},
  })
  const hashes = {
    root: spec('.', '# root\n\nthe root spec\n'), f: spec('f', '# f\n\nthe f spec\n'),
    g: spec('g', '# g\n\nthe g spec, first draft\n'), h: spec('h', '# h\n\nthe h spec\n'),
  }
  reviewed('.', hashes.root)
  append(dir, E, 'ledger', { kind: 'approved', folder: '.', hash: hashes.root, decisions: [], by: 'user' })
  reviewed('f', hashes.f)
  reviewed('g', hashes.g)
  put(specPath(dir, E, 'g'), '# g\n\nthe g spec, edited after its review\n')
  reviewed('h', hashes.h)
  append(dir, E, 'ledger', { kind: 'approved', folder: 'h', hash: hashes.h, decisions: [], by: 'user' })
  append(dir, E, 'ledger', { kind: 'prepared', folder: 'h', hash: hashes.h, review: 'r', by: 'planner' })

  // the project's evidence
  const items = (entries) => {
    const out = appendProject(dir, 'items', entries)
    assert.equal(out.ok, true, out.error)
    return out.seqs
  }
  items({ kind: 'item', item: { id: S1, claim: 's1' } })
  const [, j1] = items([{ kind: 'judged', id: S1, verdict: 'holds', at: 'at1' }, { kind: 'judged', id: S1, verdict: 'stale', at: 'at2' }])
  items([{ kind: 'item', item: { id: S2, claim: 's2' } }, { kind: 'judged', id: S2, verdict: 'holds', at: 'at3' }])
  items({ kind: 'item', item: { id: S2, claim: 's2 revised' } })

  return { dir, openDir, files, seq, hashes, judged: { S1: j1 } }
}

// ------------------------------------------------------------------ reading what is on disk

function walk(dir, base, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name)
    const rel = posix(relative(base, path))
    if (e.isDirectory()) {
      out.set(rel + '/', null)
      walk(path, base, out)
    } else {
      out.set(rel, readFileSync(path))
    }
  }
  return out
}

/** Every file (bytes) and directory under `.agentics/`, by path relative to it. */
const snapshot = (dir) => walk(join(dir, '.agentics'), join(dir, '.agentics'), new Map())
const hexed = (snap, prefix = '') => [...snap].filter(([rel]) => rel.startsWith(prefix))
  .map(([rel, bytes]) => [rel, bytes === null ? null : bytes.toString('hex')]).sort(([a], [b]) => (a < b ? -1 : 1))

const jsonlLines = (dir) => {
  const out = new Map()
  for (const [rel, bytes] of snapshot(dir)) {
    if (bytes !== null && rel.endsWith('.jsonl')) out.set(rel, bytes.toString('utf8').split('\n').filter((l) => l.trim() !== '').length)
  }
  return out
}
const totalLines = (dir) => [...jsonlLines(dir).values()].reduce((a, b) => a + b, 0)

const events = (dir, effort = E) => readLog(dir, effort, 'events').entries
const eventsOn = (dir, node, kind) => events(dir).filter((e) => e.node === node && (kind === undefined || e.kind === kind))
const ledgerOn = (dir, folder, kind) => readLog(dir, E, 'ledger').entries.filter((l) => l.folder === folder && l.kind === kind)
const lastOf = (dir, node) => readTree(dir, E).status.get(node).last

/** Every node's `{status, review}`, from the tree as it derives now. */
const statuses = (dir) => {
  const tree = readTree(dir, E)
  return Object.fromEntries([...tree.status].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, s]) => [id, { status: s.status, review: s.review }]))
}

const flat = (p, part) => p.efforts.flatMap((e) => e[part] || [])
const stopOf = (p, node) => flat(p, 'stops').find((s) => s.node === node)
const refusalsOf = (p, node) => p.refused.filter((r) => new RegExp('\\bof ' + escapeRe(node) + '(?![\\w./-])').test(String(r.what)))
const tail = (path) => posix(path).replace(/\/+$/, '')

/** Whether `fresh` is `old` in every field but the ones named. */
function assertSameBut(fresh, old, but) {
  const keys = new Set([...Object.keys(old), ...Object.keys(fresh)].filter((k) => !but.includes(k)))
  for (const k of keys) assert.deepEqual(fresh[k], old[k], 'field ' + k)
}

const storedReturnPath = (fx, dispatch) => join(fx.openDir, 'returns', dispatch + '.json')
const storedBytes = (text) => JSON.stringify({ status: 'migrated', text })

function cli(dir, ...flags) {
  return spawnSync(process.execPath, [TOOL, dir, ...flags], { env: childEnv(), encoding: 'utf8', timeout: 60_000 })
}

// ------------------------------------------------------------------ the dry run and the CLI

test('a dry run writes nothing', (t) => {
  const fx = fixture(t)
  const before = snapshot(fx.dir)
  const p = plan(fx.dir)
  assert.deepEqual(flat(p, 'executions').map((x) => x.stamp), [OPEN])
  assert.ok(flat(p, 'stops').length > 0)
  assert.deepEqual(hexed(snapshot(fx.dir)), hexed(before))
  assert.deepEqual(plan(fx.dir), p, 'a plan is a function of the disk')
})

test('the plan names the repository as given, absolute and forward-slashed', (t) => {
  const fx = fixture(t)
  assert.equal(plan(fx.dir).root, posix(resolve(fx.dir)))
})

test('the CLI dry-runs without --yes, printing applied 0 and the plan', { timeout: 90_000 }, (t) => {
  const fx = fixture(t)
  const before = snapshot(fx.dir)
  const r = cli(fx.dir)
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.applied, 0)
  assert.deepEqual(flat(out, 'executions').map((x) => x.stamp), [OPEN])
  assert.deepEqual(out.efforts, JSON.parse(JSON.stringify(plan(fx.dir).efforts)))
  assert.deepEqual(hexed(snapshot(fx.dir)), hexed(before))
})

test('the CLI applies with --yes and prints how many records it appended', { timeout: 90_000 }, (t) => {
  const fx = fixture(t)
  const before = totalLines(fx.dir)
  const r = cli(fx.dir, '--yes')
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  const added = totalLines(fx.dir) - before
  assert.ok(added > 0)
  assert.equal(out.applied, added)
  assert.equal(executionSummary(fx.dir, E, OPEN).status, 'migrated')
})

// ------------------------------------------------------------------ executions

test('an open 4.x execution is closed migrated and ended', (t) => {
  const fx = fixture(t)
  const p = plan(fx.dir)
  assert.deepEqual(flat(p, 'executions').map((x) => x.stamp), [OPEN])
  assert.equal(executionSummary(fx.dir, E, OPEN).closed, false)
  apply(p)
  const state = readLog(fx.dir, E, 'state:' + OPEN).entries
  const closed = state.filter((e) => e.kind === 'closed')
  assert.equal(closed.length, 1)
  assert.equal(closed[0].status, 'migrated')
  const after = state.slice(state.indexOf(closed[0]) + 1)
  assert.equal(after.length, 1)
  assert.equal(after[0].kind, 'ended')
  assert.deepEqual(after[0].result, { status: 'migrated', file: '', complete: false })
  assert.equal(state.filter((e) => e.kind === 'ended' && e.result).length, 1)
  const summary = executionSummary(fx.dir, E, OPEN)
  assert.equal(summary.closed, true)
  assert.equal(summary.status, 'migrated')
})

test('a closed execution is left as it is', (t) => {
  const fx = fixture(t)
  const prefix = E + '/.state/executions/' + CLOSED
  const before = hexed(snapshot(fx.dir), prefix)
  assert.ok(before.length > 0)
  const p = plan(fx.dir)
  assert.ok(!flat(p, 'executions').some((x) => x.stamp === CLOSED))
  apply(p)
  assert.deepEqual(hexed(snapshot(fx.dir), prefix), before)
})

test('a 4.x execution with no envelope is not closed', (t) => {
  const fx = fixture(t)
  const prefix = E + '/.state/executions/' + NOENV
  const before = hexed(snapshot(fx.dir), prefix)
  const p = plan(fx.dir)
  assert.ok(!flat(p, 'executions').some((x) => x.stamp === NOENV))
  apply(p)
  const state = readLog(fx.dir, E, 'state:' + NOENV).entries
  assert.ok(state.length > 0)
  assert.ok(!state.some((e) => e.kind === 'closed' || e.kind === 'ended'))
  assert.deepEqual(hexed(snapshot(fx.dir), prefix), before)
})

test('a 5.0 execution is neither closed nor listed', (t) => {
  const fx = fixture(t)
  const prefix = E + '/.state/executions/' + V5
  const before = hexed(snapshot(fx.dir), prefix)
  assert.ok(before.length > 0)
  const p = plan(fx.dir)
  assert.ok(!flat(p, 'executions').some((x) => x.stamp === V5))
  assert.ok(!p.left.some((l) => posix(l.path).split('/').includes(V5)))
  apply(p)
  assert.deepEqual(hexed(snapshot(fx.dir), prefix), before)
})

// ------------------------------------------------------------------ stops

test('an open stop whose said names a 4.x file is stated again, said its stored return', (t) => {
  const fx = fixture(t)
  const p = plan(fx.dir)
  const stop = stopOf(p, 'a')
  assert.ok(stop)
  assert.equal(stop.seq, fx.seq.aEsc)
  assert.equal(posix(stop.file), fx.files.a)
  assert.equal(stop.dispatch, 'migrated-a-' + fx.seq.aEsc)

  const old = eventsOn(fx.dir, 'a', 'escalated')
  assert.equal(old.length, 1)
  const topBefore = Math.max(...events(fx.dir).map((e) => e.seq))
  apply(p)
  const all = eventsOn(fx.dir, 'a', 'escalated')
  assert.equal(all.length, 2)
  const fresh = all.find((e) => e.seq !== old[0].seq)
  assert.ok(fresh.seq > topBefore, 'the fresh event comes after every event that existed before apply')
  assertSameBut(fresh, old[0], ['seq', 'said'])
  assert.equal(fresh.said, stop.dispatch)
  assert.equal(readFileSync(storedReturnPath(fx, stop.dispatch), 'utf8'), storedBytes(TEXT.a))
})

test("saidOf reads a re-stated stop's text", (t) => {
  const fx = fixture(t)
  apply(plan(fx.dir))
  const said = saidOf(fx.dir, E, lastOf(fx.dir, 'a'))
  assert.ok(said.includes('a is blocked'), 'the composed detail')
  assert.ok(said.includes(TEXT.a.trim()), "the said file's text")
})

test("the root's re-stated stop is named migrated-root-<seq>", (t) => {
  const fx = fixture(t)
  const p = plan(fx.dir)
  const stop = stopOf(p, '.')
  assert.ok(stop)
  assert.equal(stop.seq, fx.seq.rootPark)
  assert.equal(stop.dispatch, 'migrated-root-' + fx.seq.rootPark)
  apply(p)
  const last = lastOf(fx.dir, '.')
  assert.equal(last.kind, 'parked')
  assert.equal(last.said, stop.dispatch)
  const said = saidOf(fx.dir, E, last)
  assert.ok(said.includes('which root?'))
  assert.ok(said.includes(TEXT.root.trim()))
})

test("a long node's re-stated stop is named by a dispatch key saidOf reads", (t) => {
  const fx = fixture(t)
  const p = plan(fx.dir)
  const stop = stopOf(p, LONG)
  assert.ok(stop)
  assert.equal(stop.seq, fx.seq.longEsc)
  assert.match(stop.dispatch, /^[A-Za-z0-9][A-Za-z0-9.-]*$/)
  assert.equal(stop.dispatch, 'migrated-' + nodeKey(LONG).split('_').join('-') + '-' + fx.seq.longEsc)
  apply(p)
  const last = lastOf(fx.dir, LONG)
  assert.equal(last.said, stop.dispatch)
  assert.ok(saidOf(fx.dir, E, last).includes(TEXT.long.trim()))
})

test('a stop that names no execution is refused and keeps its 4.x said', (t) => {
  const fx = fixture(t)
  const p = plan(fx.dir)
  assert.equal(stopOf(p, 'n'), undefined)
  const refused = refusalsOf(p, 'n')
  assert.ok(refused.length > 0)
  assert.ok(refused.some((r) => String(r.what).includes(String(fx.seq.nEsc))), 'the refusal names the seq')
  const before = eventsOn(fx.dir, 'n')
  apply(p)
  assert.deepEqual(eventsOn(fx.dir, 'n'), before)
  assert.equal(lastOf(fx.dir, 'n').said, fx.files.n)
})

test('a park outranked by a newer stop is not stated again', (t) => {
  const fx = fixture(t)
  const p = plan(fx.dir)
  assert.deepEqual(flat(p, 'stops').filter((s) => s.node === 'b').map((s) => s.seq), [fx.seq.bEsc])
  const before = eventsOn(fx.dir, 'b')
  assert.ok(before.some((e) => e.kind === 'parked'), 'b holds its park')
  assert.ok(before.some((e) => e.kind === 'escalated'), 'b holds the newer stop')
  apply(p)
  const fresh = eventsOn(fx.dir, 'b').filter((e) => !before.some((o) => o.seq === e.seq))
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0].kind, 'escalated')
  assert.equal(readTree(fx.dir, E).status.get('b').status, 'escalated')
})

test('a stop whose said file is gone is refused and keeps its 4.x said', (t) => {
  const fx = fixture(t)
  rmSync(fx.files.a)
  const p = plan(fx.dir)
  assert.equal(stopOf(p, 'a'), undefined)
  const refused = refusalsOf(p, 'a')
  assert.ok(refused.length > 0)
  assert.ok(refused.some((r) => posix(r.why).includes(basename(fx.files.a))), 'the why names the file')
  const before = eventsOn(fx.dir, 'a')
  apply(p)
  assert.deepEqual(eventsOn(fx.dir, 'a'), before)
  assert.equal(lastOf(fx.dir, 'a').said, fx.files.a)
})

test('a stored return already there with the same bytes is done', (t) => {
  const fx = fixture(t)
  const dispatch = 'migrated-a-' + fx.seq.aEsc
  put(storedReturnPath(fx, dispatch), storedBytes(TEXT.a))
  const p = plan(fx.dir)
  const stop = stopOf(p, 'a')
  assert.ok(stop)
  assert.equal(stop.dispatch, dispatch)
  assert.ok(!p.refused.some((r) => posix(r.why).includes(dispatch)), 'nothing refuses that path')
  apply(p)
  assert.equal(readFileSync(storedReturnPath(fx, dispatch), 'utf8'), storedBytes(TEXT.a))
  assert.equal(lastOf(fx.dir, 'a').said, dispatch)
})

test('a stored return already there with other bytes refuses that stop', (t) => {
  const fx = fixture(t)
  const dispatch = 'migrated-a-' + fx.seq.aEsc
  const other = JSON.stringify({ status: 'migrated', text: 'someone else wrote this' })
  put(storedReturnPath(fx, dispatch), other)
  const p = plan(fx.dir)
  assert.equal(stopOf(p, 'a'), undefined)
  assert.ok(p.refused.some((r) => posix(r.why).includes('returns/' + dispatch + '.json')), 'the why names the path')
  const before = eventsOn(fx.dir, 'a')
  apply(p)
  assert.equal(readFileSync(storedReturnPath(fx, dispatch), 'utf8'), other)
  assert.deepEqual(eventsOn(fx.dir, 'a'), before)
  assert.equal(lastOf(fx.dir, 'a').said, fx.files.a)
})

test('a stored return that differs only by a trailing newline refuses that stop', (t) => {
  const fx = fixture(t)
  const dispatch = 'migrated-a-' + fx.seq.aEsc
  put(storedReturnPath(fx, dispatch), storedBytes(TEXT.a) + '\n')
  const p = plan(fx.dir)
  assert.equal(stopOf(p, 'a'), undefined)
  assert.ok(p.refused.some((r) => posix(r.why).includes('returns/' + dispatch + '.json')))
})

// ------------------------------------------------------------------ reviews

test('a standing claims event is appended again with each verdict as its ruling', (t) => {
  const fx = fixture(t)
  const p = plan(fx.dir)
  const claims = flat(p, 'claims')
  assert.equal(claims.length, 1)
  assert.equal(claims[0].node, 'f')
  assert.equal(claims[0].seq, fx.seq.fClaims)
  const old = eventsOn(fx.dir, 'f', 'claims')
  assert.equal(old.length, 1)
  apply(p)
  const all = eventsOn(fx.dir, 'f', 'claims')
  assert.equal(all.length, 2)
  const fresh = all.find((e) => e.seq !== old[0].seq)
  assert.ok(fresh.seq > old[0].seq)
  assert.deepEqual(fresh.claims, old[0].claims.map(({ claim, verdict }) => ({ claim, ruling: verdict })))
  assert.ok(!JSON.stringify(fresh.claims).includes('verdict'))
  assertSameBut(fresh, old[0], ['seq', 'claims', 'said'])
})

test('an outdated claims event is not appended again', (t) => {
  const fx = fixture(t)
  const p = plan(fx.dir)
  assert.ok(!flat(p, 'claims').some((c) => c.node === 'g'))
  apply(p)
  assert.equal(eventsOn(fx.dir, 'g', 'claims').length, 1)
})

test('a claims event outdated by a replan is not appended again', (t) => {
  const fx = fixture(t)
  assert.equal(append(fx.dir, E, 'events', { kind: 'replanned', node: 'f', execution: OPEN, reason: 'revised', by: 'planner' }).ok, true)
  const p = plan(fx.dir)
  assert.ok(!flat(p, 'claims').some((c) => c.node === 'f'))
  apply(p)
  assert.equal(eventsOn(fx.dir, 'f', 'claims').length, 1)
})

test("a claims event older than its node's revision is not appended again", (t) => {
  const fx = fixture(t)
  const { seq: _seq, ...f } = readTree(fx.dir, E).nodes.get('f')
  assert.equal(append(fx.dir, E, 'nodes', { kind: 'node', node: { ...f, title: 'folder f, revised' } }).ok, true)
  const p = plan(fx.dir)
  assert.ok(!flat(p, 'claims').some((c) => c.node === 'f'))
})

test('an older claims event under a ruled newer one is not appended again', (t) => {
  const fx = fixture(t)
  const newer = append(fx.dir, E, 'events', { kind: 'claims', node: 'f', execution: OPEN, review: 'done', claims: [{ claim: 'f holds together', ruling: 'met' }] })
  assert.equal(newer.ok, true)
  const p = plan(fx.dir)
  assert.ok(!flat(p, 'claims').some((c) => c.node === 'f'))
  apply(p)
  assert.equal(eventsOn(fx.dir, 'f', 'claims').length, 2)
})

test('a folder not yet approved whose latest review at its hash is complete gets one incomplete marker', (t) => {
  const fx = fixture(t)
  const p = plan(fx.dir)
  const reviewed = flat(p, 'reviewed')
  assert.equal(reviewed.length, 1)
  assert.equal(reviewed[0].folder, 'f')
  assert.equal(reviewed[0].hash, fx.hashes.f)
  assert.equal(approvalGate(fx.dir, E, 'f').ratifiable, true)
  assert.equal(ledgerOn(fx.dir, 'f', 'reviewed').length, 1)
  apply(p)
  const lines = ledgerOn(fx.dir, 'f', 'reviewed')
  assert.equal(lines.length, 2)
  const marker = lines[1]
  assert.ok(marker.seq > lines[0].seq)
  assert.equal(marker.hash, fx.hashes.f)
  assert.equal(marker.complete, false)
  assert.deepEqual(marker.remaining, ['migrated: a 5.0 review rules units'])
  assert.deepEqual(marker.ambiguities, [])
  assert.deepEqual(marker.clean, [])
  assert.deepEqual(marker.sections, {})
  assert.equal(approvalGate(fx.dir, E, 'f').ratifiable, false)
})

test('a folder whose latest review at its hash is already incomplete gets no marker', (t) => {
  const fx = fixture(t)
  const partial = append(fx.dir, E, 'ledger', {
    kind: 'reviewed', folder: 'f', hash: fx.hashes.f, complete: false, remaining: ['an axis'], ambiguities: [], clean: [], sections: {},
  })
  assert.equal(partial.ok, true)
  const p = plan(fx.dir)
  assert.ok(!flat(p, 'reviewed').some((r) => r.folder === 'f'))
  apply(p)
  assert.equal(ledgerOn(fx.dir, 'f', 'reviewed').length, 2)
})

test('an approved folder gets no marker', (t) => {
  const fx = fixture(t)
  const p = plan(fx.dir)
  assert.ok(!flat(p, 'reviewed').some((r) => r.folder === '.'))
  apply(p)
  assert.equal(ledgerOn(fx.dir, '.', 'reviewed').length, 1)
})

test('a prepared folder gets no marker', (t) => {
  const fx = fixture(t)
  const p = plan(fx.dir)
  assert.ok(!flat(p, 'reviewed').some((r) => r.folder === 'h'))
  apply(p)
  assert.equal(ledgerOn(fx.dir, 'h', 'reviewed').length, 1)
})

test('a folder edited since its review gets no marker', (t) => {
  const fx = fixture(t)
  const p = plan(fx.dir)
  assert.ok(!flat(p, 'reviewed').some((r) => r.folder === 'g'))
  apply(p)
  assert.equal(ledgerOn(fx.dir, 'g', 'reviewed').length, 1)
})

// ------------------------------------------------------------------ findings

const messagesOn = (dir, node) => eventsOn(dir, node, 'message')
const pick = ({ id, severity, claim, evidence, failure_scenario }) => ({ id, severity, claim, evidence, failure_scenario })
const asFindings = (rows) => rows.map(({ id, severity, claim, evidence }) => ({ id, severity, claim, evidence, failure_scenario: '' }))
const planned = (p, node) => flat(p, 'messages').filter((m) => m.node === node)
const byThread = (list) => list.map((m) => [m.thread, m.findings_n]).sort(([a], [b]) => (a < b ? -1 : 1))

test("a leaf's open review findings in its latest fixes file become one findings message of no execution", (t) => {
  const fx = fixture(t)
  const p = plan(fx.dir)
  assert.deepEqual(byThread(planned(p, 'c')), [['producer:c', 2]])
  const entry = planned(p, 'c')[0]
  assert.equal(entry.round, 2)
  assert.ok(tail(entry.file).endsWith('/executions/' + OPEN + '/fixes/c-r2.json'))
  assert.equal(messagesOn(fx.dir, 'c').length, 0)
  apply(p)
  const sent = messagesOn(fx.dir, 'c')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].thread, 'producer:c')
  assert.equal(sent[0].from, 'code')
  assert.equal(sent[0].msg, 'findings')
  assert.equal(sent[0].round, 2)
  assert.equal(sent[0].execution, '')
  assert.deepEqual(sent[0].payload.findings.map(pick), asFindings(F.c2))
})

test("a green's tests findings go to the cycle's test session, its code findings to its producer", (t) => {
  const fx = fixture(t)
  const p = plan(fx.dir)
  assert.deepEqual(byThread(planned(p, 'gr')), [['producer:gr', 1], ['producer:r', 1]])
  apply(p)
  const sent = Object.fromEntries(messagesOn(fx.dir, 'gr').map((m) => [m.thread, m]))
  assert.deepEqual(Object.keys(sent).sort(), ['producer:gr', 'producer:r'])
  assert.deepEqual(sent['producer:r'].payload.findings.map(pick), asFindings([F.gr2[0]]))
  assert.deepEqual(sent['producer:gr'].payload.findings.map(pick), asFindings([F.gr2[1]]))
  for (const m of Object.values(sent)) {
    assert.equal(m.round, 2)
    assert.equal(m.execution, '')
    assert.equal(m.from, 'code')
    assert.equal(m.msg, 'findings')
  }
})

test("an audit's code findings go to its auditor, its tests findings to the cycle's test session", (t) => {
  const fx = fixture(t)
  const p = plan(fx.dir)
  assert.deepEqual(byThread(planned(p, 'ta')), [['auditor:ta', 1], ['producer:tr', 1]])
  apply(p)
  const sent = Object.fromEntries(messagesOn(fx.dir, 'ta').map((m) => [m.thread, m]))
  assert.deepEqual(Object.keys(sent).sort(), ['auditor:ta', 'producer:tr'])
  assert.deepEqual(sent['producer:tr'].payload.findings.map(pick), asFindings([F.ta2[0]]))
  assert.deepEqual(sent['auditor:ta'].payload.findings.map(pick), asFindings([F.ta2[1]]))
})

test("an approved leaf's findings become no message", (t) => {
  const fx = fixture(t)
  const p = plan(fx.dir)
  assert.equal(planned(p, 'd').length, 0)
  apply(p)
  assert.equal(messagesOn(fx.dir, 'd').length, 0)
})

test("a merged leaf's findings become no message", (t) => {
  const fx = fixture(t)
  const p = plan(fx.dir)
  assert.equal(planned(p, 'f/x').length, 0)
  apply(p)
  assert.equal(messagesOn(fx.dir, 'f/x').length, 0)
})

test('no node but the reviewed, unfinished leaves gets a findings message', (t) => {
  const fx = fixture(t)
  apply(plan(fx.dir))
  const nodes = [...new Set(events(fx.dir).filter((e) => e.kind === 'message').map((e) => e.node))].sort()
  assert.deepEqual(nodes, ['c', 'gr', 'ta'])
})

test('a thread that already holds a findings message of no execution is sent nothing again', (t) => {
  const fx = fixture(t)
  const sent = append(fx.dir, E, 'events', {
    kind: 'message', node: 'c', thread: 'producer:c', from: 'code', msg: 'findings', payload: { findings: [] }, round: 2, execution: '',
  })
  assert.equal(sent.ok, true)
  const p = plan(fx.dir)
  assert.ok(!planned(p, 'c').some((m) => m.thread === 'producer:c'))
  apply(p)
  assert.equal(messagesOn(fx.dir, 'c').length, 1)
})

test('a findings message of an execution does not count as sent', (t) => {
  const fx = fixture(t)
  const sent = append(fx.dir, E, 'events', {
    kind: 'message', node: 'c', thread: 'producer:c', from: 'code', msg: 'findings', payload: { findings: [] }, round: 2, execution: OPEN,
  })
  assert.equal(sent.ok, true)
  assert.deepEqual(byThread(planned(plan(fx.dir), 'c')), [['producer:c', 2]])
})

test('a migrated findings message is read by the next execution', (t) => {
  const fx = fixture(t)
  const next = '20270101-000000'
  const mine = (log) => log.entries().filter((e) => e.kind === 'message' && e.node === 'c')
  assert.equal(mine(executionLog(fx.dir, E, next)).length, 0)
  apply(plan(fx.dir))
  const read = mine(executionLog(fx.dir, E, next))
  assert.equal(read.length, 1)
  assert.equal(read[0].thread, 'producer:c')
  assert.equal(read[0].execution, '')
})

// ------------------------------------------------------------------ evidence

test("each id's latest judged line, still the item's latest, is appended again with its verdict as ruling", (t) => {
  const fx = fixture(t)
  const p = plan(fx.dir)
  assert.equal(p.judged.length, 1)
  assert.equal(p.judged[0].id, S1)
  assert.equal(p.judged[0].seq, fx.judged.S1)
  const old = readProjectLog(fx.dir, 'items').entries.find((e) => e.seq === fx.judged.S1)
  assert.equal(old.verdict, 'stale')
  apply(p)
  const fresh = readProjectLog(fx.dir, 'items').entries.filter((e) => e.kind === 'judged' && e.id === S1 && e.ruling !== undefined)
  assert.equal(fresh.length, 1)
  assert.ok(fresh[0].seq > old.seq)
  assert.equal(fresh[0].ruling, old.verdict)
  assert.equal(fresh[0].at, old.at)
  assert.ok(!('verdict' in fresh[0]))
  assertSameBut({ ...fresh[0], verdict: fresh[0].ruling }, old, ['seq', 'ruling'])
})

test('a judged line outdated by a later item revision is not appended again', (t) => {
  const fx = fixture(t)
  const p = plan(fx.dir)
  assert.ok(!p.judged.some((j) => j.id === S2))
  apply(p)
  const ruled = readProjectLog(fx.dir, 'items').entries.filter((e) => e.kind === 'judged' && e.id === S2 && e.ruling !== undefined)
  assert.equal(ruled.length, 0)
})

// ------------------------------------------------------------------ the whole move

test("migration leaves every node's derived status as it was", (t) => {
  const fx = fixture(t)
  const before = statuses(fx.dir)
  assert.equal(before.f.status, 'integrated')
  assert.equal(before.g.status, 'reviewing')
  assert.equal(before.a.status, 'escalated')
  assert.equal(before.b.status, 'escalated')
  apply(plan(fx.dir))
  assert.deepEqual(statuses(fx.dir), before)
})

test('apply deletes and rewrites nothing: every old file survives and every log only grows', (t) => {
  const fx = fixture(t)
  const before = snapshot(fx.dir)
  apply(plan(fx.dir))
  const after = snapshot(fx.dir)
  for (const [rel, bytes] of before) {
    assert.ok(after.has(rel), rel + ' survives')
    if (bytes === null || rel === 'seq' || rel.endsWith('/seq')) continue
    const now = after.get(rel).toString('utf8')
    if (rel.endsWith('.jsonl')) assert.ok(now.startsWith(bytes.toString('utf8')), rel + ' only grows')
    else assert.equal(now, bytes.toString('utf8'), rel)
  }
})

test('a second apply appends nothing', (t) => {
  const fx = fixture(t)
  const p1 = plan(fx.dir)
  const lines = totalLines(fx.dir)
  const first = apply(p1)
  assert.ok(first.applied > 0)
  assert.equal(first.applied, totalLines(fx.dir) - lines)

  const after = snapshot(fx.dir)
  const counts = jsonlLines(fx.dir)
  const p2 = plan(fx.dir)
  for (const part of ['executions', 'stops', 'claims', 'reviewed', 'messages']) assert.deepEqual(flat(p2, part), [], part)
  assert.deepEqual(p2.judged, [])
  assert.deepEqual(p2.refused, p1.refused)
  assert.equal(apply(p2).applied, 0)
  assert.deepEqual(jsonlLines(fx.dir), counts)
  assert.deepEqual(hexed(snapshot(fx.dir)), hexed(after))
})

test('an apply cut short is finished by the next one', (t) => {
  const fx = fixture(t)
  const before = statuses(fx.dir)
  const p1 = plan(fx.dir)
  const keep = (m) => m.node === 'gr' && m.thread === 'producer:r'
  assert.ok(flat(p1, 'messages').some(keep))
  const cut = {
    ...p1,
    efforts: p1.efforts.map((e) => ({ ...e, claims: [], reviewed: [], messages: (e.messages || []).filter(keep) })),
    judged: [],
  }
  apply(cut)
  assert.equal(messagesOn(fx.dir, 'gr').length, 1)
  assert.equal(eventsOn(fx.dir, 'f', 'claims').length, 1)

  const p2 = plan(fx.dir)
  assert.deepEqual(flat(p2, 'executions'), [])
  assert.deepEqual(flat(p2, 'stops'), [])
  assert.deepEqual(flat(p2, 'claims'), flat(p1, 'claims'))
  assert.deepEqual(flat(p2, 'reviewed'), flat(p1, 'reviewed'))
  assert.deepEqual(p2.judged, p1.judged)
  assert.deepEqual(flat(p2, 'messages'), flat(p1, 'messages').filter((m) => !keep(m)))

  apply(p2)
  const p3 = plan(fx.dir)
  for (const part of ['executions', 'stops', 'claims', 'reviewed', 'messages']) assert.deepEqual(flat(p3, part), [], part)
  assert.deepEqual(p3.judged, [])
  assert.deepEqual(statuses(fx.dir), before)
})

// ------------------------------------------------------------------ refusals

test('a live 4.x job refuses the effort', (t) => {
  const fx = fixture(t)
  put(join(fx.openDir, 'jobs', 'leaf-close-live.pid'), String(process.pid))
  const before = hexed(snapshot(fx.dir), E + '/')
  const p = plan(fx.dir)
  assert.ok(!p.efforts.some((e) => e.effort === E))
  const refusal = p.refused.find((r) => r.what === 'effort ' + E)
  assert.ok(refusal)
  assert.ok(String(refusal.why).includes(String(process.pid)), 'the why names the pid')
  assert.ok(!p.left.some((l) => posix(l.path).includes('/' + E + '/')), 'nothing of the effort is listed')
  apply(p)
  assert.deepEqual(hexed(snapshot(fx.dir), E + '/'), before)
})

test('a live 4.x job under a closed execution refuses the effort too', (t) => {
  const fx = fixture(t)
  put(join(executionDir(fx.dir, E, CLOSED), 'jobs', 'leaf-close-live.pid'), String(process.pid))
  const p = plan(fx.dir)
  assert.ok(!p.efforts.some((e) => e.effort === E))
  assert.ok(p.refused.some((r) => r.what === 'effort ' + E && String(r.why).includes(String(process.pid))))
})

test('a dead 4.x job does not refuse the effort', (t) => {
  const fx = fixture(t)
  assert.ok(existsSync(join(fx.openDir, 'jobs', 'leaf-close-1.pid')))
  const p = plan(fx.dir)
  assert.ok(p.efforts.some((e) => e.effort === E))
  assert.ok(!p.refused.some((r) => /^effort /.test(String(r.what))))
})

test('a held effort lock refuses the effort', (t) => {
  const fx = fixture(t)
  put(join(effortStateDir(fx.dir, E), '.lock', 'holder'), JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }))
  const p = plan(fx.dir)
  assert.ok(!p.efforts.some((e) => e.effort === E))
  const refusal = p.refused.find((r) => r.what === 'effort ' + E)
  assert.ok(refusal)
  assert.match(String(refusal.why), /lock/i)
})

test('a refused effort leaves the other efforts planned and applied', (t) => {
  const fx = fixture(t)
  const other = 'e2'
  const stamp = '20260905-100000'
  const seeded = seedTree(fx.dir, other, [{ id: '.', kind: 'composite', title: 'root' }, leaf('z')])
  assert.equal(seeded.ok, true, JSON.stringify(seeded.problems))
  put(join(executionDir(fx.dir, other, stamp), 'execution.json'), JSON.stringify({ root: '.' }))
  assert.equal(append(fx.dir, other, 'state:' + stamp, { kind: 'invocation' }).ok, true)
  put(join(fx.openDir, 'jobs', 'leaf-close-live.pid'), String(process.pid))
  const before = hexed(snapshot(fx.dir), E + '/')

  const p = plan(fx.dir)
  assert.deepEqual(p.efforts.map((e) => e.effort), [other])
  apply(p)
  assert.equal(executionSummary(fx.dir, other, stamp).status, 'migrated')
  assert.deepEqual(hexed(snapshot(fx.dir), E + '/'), before)
})

// ------------------------------------------------------------------ what is left on disk

const LEFT = [
  ['4.x job files', 'executions/' + OPEN + '/jobs'],
  ['4.x launch cards', 'executions/' + OPEN + '/cards'],
  ['4.x fixes files', 'executions/' + OPEN + '/fixes'],
  ['4.x said files', 'executions/' + OPEN + '/said'],
  ['4.x briefs', 'executions/' + OPEN + '/briefs'],
  ['4.x close records', 'executions/' + OPEN + '/closes'],
  ['4.x review records', 'executions/' + OPEN + '/reviews'],
  ['a 4.x stale brief', 'executions/' + OPEN + '/stale-0a1b2c3.md'],
  ['an unknown file of a 4.x execution', 'executions/' + OPEN + '/mystery.txt'],
  ['the fixes files of a closed 4.x execution', 'executions/' + CLOSED + '/fixes'],
  ['reports and progress files', 'reports'],
]
for (const [what, rel] of LEFT) {
  test('the left list names ' + what, (t) => {
    const fx = fixture(t)
    const p = plan(fx.dir)
    const named = p.left.filter((l) => tail(l.path).endsWith('/' + E + '/.state/' + rel))
    assert.equal(named.length, 1, rel)
    assert.equal(typeof named[0].why, 'string')
    assert.ok(named[0].why.trim() !== '')
  })
}

test('the left list never names what 5.0 reads: an envelope, a state log, a journal, stored returns', (t) => {
  const fx = fixture(t)
  const check = (p, when) => {
    for (const l of p.left) {
      const path = tail(l.path)
      for (const name of ['execution.json', 'state.jsonl', 'journal.jsonl', 'returns']) {
        assert.ok(!path.endsWith('/executions/' + OPEN + '/' + name), when + ': ' + path)
      }
      assert.ok(!path.includes('/.agentics/.state'), when + ': ' + path)
    }
  }
  check(plan(fx.dir), 'before')
  apply(plan(fx.dir))
  assert.ok(existsSync(join(fx.openDir, 'returns')), 'the stored returns are there')
  check(plan(fx.dir), 'after')
})

// ------------------------------------------------------------------ what 5.0 reads of the migrated store

const DISPATCH = /^[A-Za-z0-9][A-Za-z0-9.-]*$/
const DAY = 24 * 60 * 60 * 1000

/** Append to a log of the fixture's effort; the seqs. */
function record(dir, log, entries) {
  const out = append(dir, E, log, entries)
  assert.equal(out.ok, true, out.error)
  return out.seqs
}

/** The `findings` message of `node` that leaf-review would record at `round`, as freshRecords keeps it over the disk. */
function keptFindings(dir, node, thread, round) {
  const tree = readTree(dir, E)
  return freshRecords([message(node, thread, 'findings', { findings: [] }, round)], { nodes: tree.nodes, status: tree.status, events: tree.events })
}

for (const [node, thread] of [['c', 'producer:c'], ['gr', 'producer:r']]) {
  test('a migrated findings message does not stand for the one leaf-review records on ' + thread + ' of ' + node, (t) => {
    const fx = fixture(t)
    const p = plan(fx.dir)
    const round = planned(p, node).find((m) => m.thread === thread).round
    apply(p)
    const migrated = messagesOn(fx.dir, node).filter((m) => m.thread === thread && m.round === round)
    assert.equal(migrated.length, 1, 'the migrated message is on the disk at its fixes file round')
    assert.equal(keptFindings(fx.dir, node, thread, round).length, 1)
    executionLog(fx.dir, E, V5).append('message', { node, thread, from: 'code', msg: 'findings', payload: { findings: [] }, round })
    assert.equal(keptFindings(fx.dir, node, thread, round).length, 0, 'the message a boundary recorded stands')
  })
}

// ------------------------------------------------------------------ the effort lock

/** A holder file in the effort's lock, written `ageMs` ago. */
function lockHolder(dir, fields, ageMs = 0) {
  const path = join(effortStateDir(dir, E), '.lock', 'holder-' + fields.pid + '-' + fields.host)
  put(path, JSON.stringify({ at: new Date().toISOString(), ...fields }))
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs)
    utimesSync(path, then, then)
  }
}

test('a lock holder on another host, written now, refuses the effort though its pid is not alive here', (t) => {
  const fx = fixture(t)
  lockHolder(fx.dir, { pid: DEAD_PID, host: hostname() + '-elsewhere' })
  const p = plan(fx.dir)
  assert.ok(!p.efforts.some((e) => e.effort === E))
  assert.ok(p.refused.some((r) => r.what === 'effort ' + E && /lock/i.test(String(r.why))))
})

test('a lock holder on another host, older than the stale age, does not refuse the effort though its pid is alive here', (t) => {
  const fx = fixture(t)
  lockHolder(fx.dir, { pid: process.pid, host: hostname() + '-elsewhere' }, DAY)
  const p = plan(fx.dir)
  assert.ok(p.efforts.some((e) => e.effort === E))
  assert.ok(!p.refused.some((r) => /^effort /.test(String(r.what))))
})

test('a lock holder on this host whose pid is dead does not refuse the effort', (t) => {
  const fx = fixture(t)
  lockHolder(fx.dir, { pid: DEAD_PID, host: hostname() })
  const p = plan(fx.dir)
  assert.ok(p.efforts.some((e) => e.effort === E))
  assert.ok(!p.refused.some((r) => /^effort /.test(String(r.what))))
})

// ------------------------------------------------------------------ the marker and the gate

/** A complete review of `f` at its hash that leaves ambiguity A1 open, in section s1. */
const reviewOfF = (fx, fields = {}) => record(fx.dir, 'ledger', {
  kind: 'reviewed', folder: 'f', hash: fx.hashes.f, complete: true, remaining: [], ambiguities: ['A1'], clean: [], sections: { A1: 's1' }, ...fields,
})
const disposeOfF = (fx, outcome) => record(fx.dir, 'ledger', { kind: 'disposition', folder: 'f', finding: 'A1', outcome, by: 'user' })

test('the incomplete marker leaves the open ambiguities of the gate as the review left them', (t) => {
  const fx = fixture(t)
  reviewOfF(fx)
  const before = approvalGate(fx.dir, E, 'f')
  assert.deepEqual(before.open, ['A1'])
  apply(plan(fx.dir))
  const after = approvalGate(fx.dir, E, 'f')
  assert.deepEqual(after.open, before.open)
  assert.equal(after.ratifiable, false)
})

test('the incomplete marker does not settle an ambiguity incorporated after the review', (t) => {
  const fx = fixture(t)
  reviewOfF(fx, { clean: ['s1'] })
  disposeOfF(fx, 'incorporated')
  const before = approvalGate(fx.dir, E, 'f')
  assert.deepEqual(before.open, ['A1'], 'an incorporation settles only once a later review lists its section clean')
  apply(plan(fx.dir))
  const after = approvalGate(fx.dir, E, 'f')
  assert.deepEqual(after.open, before.open)
  assert.equal(after.ratifiable, false)
})

test('the incomplete marker keeps an ambiguity settled before the review by the sections it names', (t) => {
  const fx = fixture(t)
  disposeOfF(fx, 'incorporated')
  reviewOfF(fx, { clean: ['s1'] })
  const before = approvalGate(fx.dir, E, 'f')
  assert.deepEqual(before.open, [], 'the review after the incorporation lists its section clean')
  apply(plan(fx.dir))
  const after = approvalGate(fx.dir, E, 'f')
  assert.deepEqual(after.open, before.open)
  assert.equal(after.ratifiable, false)
})

// ------------------------------------------------------------------ the evidence a review wrote

/** A standing root `claims` event of 4.x, naming a said file of its execution. */
function rootClaims(fx) {
  const file = posix(join(fx.openDir, 'said', 'root-review.md'))
  const text = 'the root review said this about the evidence\n'
  put(file, text)
  const [seq] = record(fx.dir, 'events', {
    kind: 'claims', node: '.', execution: OPEN, head_sha: '4'.repeat(40), review: 'done', said: file,
    claims: [{ claim: 'the root holds together', verdict: 'met' }],
  })
  return { seq, file, text }
}

test('the landing view prints the file a restated root claims event named, which nothing else reads', (t) => {
  const fx = fixture(t)
  const root = rootClaims(fx)
  const p = plan(fx.dir)
  assert.equal(flat(p, 'claims').find((c) => c.node === '.').seq, root.seq)
  apply(p)
  assert.ok(renderLanding(fx.dir, E).includes('What the review said of the evidence behind each verdict:\n\n' + root.text.trim()))
})

test('a restated claims event names a stored return of its said file, which saidOf reads', (t) => {
  const fx = fixture(t)
  const p = plan(fx.dir)
  const dispatch = 'migrated-' + nodeKey('f') + '-' + fx.seq.fClaims
  const entry = flat(p, 'claims').find((c) => c.node === 'f')
  assert.equal(entry.dispatch, dispatch)
  assert.equal(posix(entry.file), fx.files.f)
  const old = eventsOn(fx.dir, 'f', 'claims')[0]
  apply(p)
  const fresh = eventsOn(fx.dir, 'f', 'claims').find((e) => e.seq !== old.seq)
  assert.equal(fresh.said, dispatch)
  assert.match(fresh.said, DISPATCH)
  const text = readFileSync(fx.files.f, 'utf8')
  assert.equal(readFileSync(storedReturnPath(fx, dispatch), 'utf8'), storedBytes(text))
  assert.equal(saidOf(fx.dir, E, fresh), text.trim())
})

test('a claims event whose said file is gone is refused and keeps its 4.x said', (t) => {
  const fx = fixture(t)
  rmSync(fx.files.f)
  const p = plan(fx.dir)
  assert.ok(!flat(p, 'claims').some((c) => c.node === 'f'))
  assert.ok(refusalsOf(p, 'f').some((r) => posix(r.why).includes(basename(fx.files.f))), 'the why names the file')
  const before = eventsOn(fx.dir, 'f', 'claims')
  apply(p)
  assert.deepEqual(eventsOn(fx.dir, 'f', 'claims'), before)
  assert.equal(before[0].said, fx.files.f)
})

test('a claims event whose stored return exists with other bytes is refused and keeps its 4.x said', (t) => {
  const fx = fixture(t)
  const dispatch = 'migrated-' + nodeKey('f') + '-' + fx.seq.fClaims
  const other = JSON.stringify({ status: 'migrated', text: 'someone else wrote this' })
  put(storedReturnPath(fx, dispatch), other)
  const p = plan(fx.dir)
  assert.ok(!flat(p, 'claims').some((c) => c.node === 'f'))
  assert.ok(refusalsOf(p, 'f').some((r) => posix(r.why).includes('returns/' + dispatch + '.json')), 'the why names the path')
  const before = eventsOn(fx.dir, 'f', 'claims')
  apply(p)
  assert.equal(readFileSync(storedReturnPath(fx, dispatch), 'utf8'), other)
  assert.deepEqual(eventsOn(fx.dir, 'f', 'claims'), before)
  assert.equal(before[0].said, fx.files.f)
})

// ------------------------------------------------------------------ the fixes file a later round superseded

test('a leaf dispatched in a later round than its newest fixes file gets no findings message', (t) => {
  const fx = fixture(t)
  record(fx.dir, 'events', { kind: 'dispatched', node: 'c', execution: OPEN, role: 'implementer', round: 3 })
  const p = plan(fx.dir)
  assert.deepEqual(planned(p, 'c'), [])
  assert.ok(planned(p, 'gr').length > 0, 'a leaf no later round superseded is still sent')
  apply(p)
  assert.equal(messagesOn(fx.dir, 'c').length, 0)
})

test('a leaf dispatched in a newer execution after its older fixes file gets no findings message', (t) => {
  const fx = fixture(t)
  const fixes = flat(plan(fx.dir), 'messages').find((m) => m.node === 'c').file
  assert.ok(tail(fixes).includes('/executions/' + OPEN + '/'), 'the newest fixes file is in the older execution')
  record(fx.dir, 'events', { kind: 'dispatched', node: 'c', execution: NOENV, role: 'implementer', round: 3 })
  assert.deepEqual(planned(plan(fx.dir), 'c'), [])
})

test('a fixes file of a later round than any dispatch is still sent', (t) => {
  const fx = fixture(t)
  put(fixesPath(fx.dir, E, OPEN, 'c', 3), JSON.stringify(F.c2.map(reviewEntry)))
  const [entry] = planned(plan(fx.dir), 'c')
  assert.equal(entry.round, 3)
})

// ------------------------------------------------------------------ the first 5.0 round of a migrated green

const CYCLE_SPEC = [
  '# Migrated cycle', '', '## Intent', '', 'A cycle under test.', '',
  '## Decisions', '', '| id | decision | why |', '|---|---|---|', '| D1 | It runs. | The unit needs it. |', '',
  '## Design', '', 'Files under src.', '',
  '## Plan', '',
  '- **r** — task · realises: D1 · rigor: tdd-pair · role: red · locus: test/r.test.mjs',
  '  Make r',
  '  - [ ] r says ok — check: `node pass.mjs`', '',
  '- **g** — task · realises: D1 · after: r · rigor: tdd-pair · role: green · locus: src/r.mjs',
  '  Make g',
  '  - [ ] g says ok — check: `node pass.mjs`', '',
  '## Open questions', '', '## Evidence', '', 'None yet.', '',
].join('\n')

const CYCLE_CASES = [
  ['only tests findings', [finding('G1', 'major', 'tests')], 'test-author', 'producer:r'],
  ['code findings', [finding('G2', 'major', 'code')], 'implementer', 'producer:g'],
  ['tests findings carried beside code findings', [finding('G1', 'major', 'tests', { carried: true }), finding('G2', 'major', 'code')], 'implementer', 'producer:g'],
  ['no fixes file', null, 'implementer', 'producer:g'],
  ['no fixes file, beside the tests findings migrated for its red', null, 'implementer', 'producer:g', true],
]
for (const [what, findings, role, thread, redToo] of CYCLE_CASES) {
  test('the first 5.0 round of a migrated green with ' + what + ' goes to ' + role + ' on ' + thread, { timeout: 120_000 }, async (t) => {
    const rig = executionRig(t, { spec: CYCLE_SPEC, files: { 'pass.mjs': '' } })
    rig.git('branch', rig.branchOf('r'), rig.branchOf('.'))
    const fourX = (kind, fields) => record(rig.repo, 'events', { kind, execution: rig.stamp, ...fields })
    fourX('approved', { node: 'r', head_sha: rig.git('rev-parse', 'refs/heads/' + rig.branchOf('r')), review_rounds: 1, at_integration: false })
    fourX('dispatched', { node: 'g', role: 'implementer', round: 1 })
    if (findings) put(fixesPath(rig.repo, E, rig.stamp, 'g', 1), JSON.stringify(findings.map(reviewEntry)))
    if (redToo) {
      fourX('message', { node: 'r', thread: 'producer:r', from: 'code', msg: 'findings', payload: { findings: [{ id: 'R1', severity: 'major', claim: 'c', evidence: 'e', failure_scenario: '' }] }, round: 1, execution: '' })
    }
    assert.equal(apply(plan(rig.repo)).applied > 0, true)

    const next = '20260102-000000'
    const dir = executionDir(rig.repo, E, next)
    put(join(dir, 'execution.json'), JSON.stringify(rig.envelope))
    const xc = executionContext({ repo: rig.repo, effort: E, execution: next, log: executionLog(rig.repo, E, next) })
    const opened = await leafOpen(xc, { node: 'g' })
    assert.equal(opened.status, 'opened')
    assert.deepEqual([opened.round, opened.role, opened.thread], [1, role, thread])
  })
}

// ------------------------------------------------------------------ the edges of each part

test('a claims event that names no said file is appended again without a stored return', (t) => {
  const fx = fixture(t)
  const [seq] = record(fx.dir, 'events', {
    kind: 'claims', node: '.', execution: OPEN, head_sha: '5'.repeat(40), review: 'done', claims: [{ claim: 'the root holds together', verdict: 'met' }],
  })
  const p = plan(fx.dir)
  const entry = flat(p, 'claims').find((c) => c.node === '.')
  assert.equal(entry.seq, seq)
  assert.equal(entry.dispatch, undefined)
  apply(p)
  const fresh = eventsOn(fx.dir, '.', 'claims').find((e) => e.seq !== seq)
  assert.equal(fresh.said, undefined)
  assert.deepEqual(fresh.claims, [{ claim: 'the root holds together', ruling: 'met' }])
  assert.ok(!existsSync(storedReturnPath(fx, 'migrated-root-' + seq)))
})

test('an open escalation whose said is empty is neither stated again nor refused', (t) => {
  const fx = fixture(t)
  record(fx.dir, 'events', { kind: 'escalated', node: 'c', execution: OPEN, reason: 'blocked', detail: 'c is blocked', said: '' })
  const p = plan(fx.dir)
  assert.equal(stopOf(p, 'c'), undefined)
  assert.deepEqual(refusalsOf(p, 'c'), [])
})

test('an open escalation whose said is no string is neither stated again nor refused', (t) => {
  const fx = fixture(t)
  record(fx.dir, 'events', { kind: 'escalated', node: 'c', execution: OPEN, reason: 'blocked', detail: 'c is blocked', said: { path: fx.files.a } })
  let p
  assert.doesNotThrow(() => { p = plan(fx.dir) })
  assert.equal(stopOf(p, 'c'), undefined)
  assert.deepEqual(refusalsOf(p, 'c'), [])
})

test('a review entry with no claim and no evidence becomes a finding with empty strings', (t) => {
  const fx = fixture(t)
  put(fixesPath(fx.dir, E, OPEN, 'c', 2), JSON.stringify([{ source: 'review major F7' }]))
  apply(plan(fx.dir))
  const [sent] = messagesOn(fx.dir, 'c')
  assert.deepEqual(sent.payload.findings.map(pick), [{ id: 'F7', severity: 'major', claim: '', evidence: '', failure_scenario: '' }])
})

test('a file in jobs that is not a pid file does not refuse the effort', (t) => {
  const fx = fixture(t)
  put(join(fx.openDir, 'jobs', 'leaf-close-live.json'), String(process.pid))
  const p = plan(fx.dir)
  assert.ok(p.efforts.some((e) => e.effort === E))
  assert.ok(!p.refused.some((r) => /^effort /.test(String(r.what))))
})

test('a pid file holding 0 does not refuse the effort', (t) => {
  const fx = fixture(t)
  put(join(fx.openDir, 'jobs', 'leaf-close-zero.pid'), '0')
  const p = plan(fx.dir)
  assert.ok(p.efforts.some((e) => e.effort === E))
  assert.ok(!p.refused.some((r) => /^effort /.test(String(r.what))))
})

test('a directory under executions that is no stamp is neither closed nor listed', (t) => {
  const fx = fixture(t)
  const odd = join(executionsRoot(fx.dir, E), 'scratch')
  put(join(odd, 'execution.json'), JSON.stringify({ root: '.' }))
  put(join(odd, 'notes.txt'), 'x\n')
  const p = plan(fx.dir)
  assert.ok(!flat(p, 'executions').some((x) => x.stamp === 'scratch'))
  assert.ok(!p.left.some((l) => posix(l.path).split('/').includes('scratch')))
  apply(p)
  assert.deepEqual(readdirSync(odd).sort(), ['execution.json', 'notes.txt'])
})

test('a leaf is matched to its fixes files by its whole key', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-migrate-v5-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const seeded = seedTree(dir, E, [{ id: '.', kind: 'composite', title: 'root' }, composite('f'), leaf('f/x'), leaf('fax')])
  assert.equal(seeded.ok, true, JSON.stringify(seeded.problems))
  assert.equal(nodeKey('f/x'), 'f.x')
  put(join(executionDir(dir, E, OPEN), 'execution.json'), JSON.stringify({ root: '.' }))
  put(fixesPath(dir, E, OPEN, 'f/x', 1), JSON.stringify(F.fx2.map(reviewEntry)))
  put(fixesPath(dir, E, OPEN, 'fax', 3), JSON.stringify(F.fx2.map(reviewEntry)))
  const p = plan(dir)
  assert.deepEqual(planned(p, 'f/x').map((m) => m.round), [1])
  assert.deepEqual(planned(p, 'fax').map((m) => m.round), [3])
})

test('a composite with a fixes file gets no findings message', (t) => {
  const fx = fixture(t)
  put(fixesPath(fx.dir, E, OPEN, 'g', 1), JSON.stringify(F.fx2.map(reviewEntry)))
  const p = plan(fx.dir)
  assert.deepEqual(planned(p, 'g'), [])
  apply(p)
  assert.equal(messagesOn(fx.dir, 'g').length, 0)
})

test('a findings message of another node on the same thread does not count as sent', (t) => {
  const fx = fixture(t)
  record(fx.dir, 'events', { kind: 'message', node: 'r', thread: 'producer:r', from: 'code', msg: 'findings', payload: { findings: [] }, round: 2, execution: '' })
  assert.ok(planned(plan(fx.dir), 'gr').some((m) => m.thread === 'producer:r'))
})

test('a message of another kind on the same node and thread does not count as sent', (t) => {
  const fx = fixture(t)
  record(fx.dir, 'events', { kind: 'message', node: 'c', thread: 'producer:c', from: 'code', msg: 'retried', payload: { reason: '', notes: [] }, round: 2, execution: '' })
  assert.ok(planned(plan(fx.dir), 'c').some((m) => m.thread === 'producer:c'))
})

for (const [what, rel] of LEFT.filter(([, rel]) => !rel.endsWith('mystery.txt'))) {
  test('the left list says what ' + what + ' is, not that it is unknown', (t) => {
    const fx = fixture(t)
    const why = (path) => plan(fx.dir).left.find((l) => tail(l.path).endsWith('/' + E + '/.state/' + path)).why
    assert.notEqual(why(rel), why('executions/' + OPEN + '/mystery.txt'))
  })
}

for (const [what, name] of [['4.x merge records', 'merges'], ['4.x gate records', 'gates']]) {
  test('the left list names the ' + what + ' of an execution once, saying what they are', (t) => {
    const fx = fixture(t)
    put(join(fx.openDir, name, 'main-0a1b2c3d4e.json'))
    const left = plan(fx.dir).left
    const named = left.filter((l) => tail(l.path).endsWith('/executions/' + OPEN + '/' + name))
    assert.equal(named.length, 1)
    assert.notEqual(named[0].why, left.find((l) => tail(l.path).endsWith('/executions/' + OPEN + '/mystery.txt')).why)
  })
}

test('a stored return written between the plan and the apply keeps its bytes', (t) => {
  const fx = fixture(t)
  const p = plan(fx.dir)
  const { dispatch } = stopOf(p, 'a')
  const other = JSON.stringify({ status: 'migrated', text: 'written after the plan was made' })
  put(storedReturnPath(fx, dispatch), other)
  apply(p)
  assert.equal(readFileSync(storedReturnPath(fx, dispatch), 'utf8'), other)
})
