// test/boundaries-leaf-close-measure.test.mjs — lib/boundaries/leaf-close.mjs: series-done, the
// measurement through `measure` and the gotchas, over real git and the real measurement.
//
// What is pinned here:
//
//   leafClose        series-done, the measurement through `measure` and its key, a green measured
//                    on its red's tests, a checkout fault, a measurement that could not be taken,
//                    and the gotchas (a producer never establishes a command)
//
// A close is never seeded by hand: every close record and every `breach_reverted` line comes from a
// `leafClose` call. Expected ids, shas, paths and keys are computed. The world builders the
// leaf-close files share are in test/harness/leaf-close-world.mjs.
//
// Design: docs/DESIGN.md#boundaries.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { ruleNets } from '../lib/boundary.mjs'
import { commandsOf, gotchaId, writeGotcha } from '../lib/gotchas.mjs'
import { append } from '../lib/ledger.mjs'
import { A_TEST, COMMANDS, git, root } from './harness/boundary-fixture.mjs'
import {
  E, SLOW, PASS, world, open, commit, write, stored, close, run, recs, msgs, observed, rec, head, stopOf,
  shapeOf, claimsOf, DONE, A_SRC, A_FILES, MORE_TEST, crit, lf, tdd, R_BITES, R_TEST, cycle, gotcha, command,
  ESTABLISHED, gotchaOf,
} from './harness/leaf-close-world.mjs'

const posix = (p) => String(p).split('\\').join('/')

/** A trivial leaf `a` over README.md, opened, its edit committed. */
function trivial(t, check = PASS) {
  const w = world(t, (r) => [root(), lf('a', { rigor: 'trivial', expects: ['README.md'], acceptance: crit('a', typeof check === 'function' ? check(r) : check) })])
  const o = open(w, 'a')
  commit(o.worktree, { 'README.md': 'hello\nmore\n' }, 'Edit the readme')
  return { w, o }
}

const establish = (w, skip = []) => { for (const g of ESTABLISHED().filter((x) => !skip.includes('command-' + x.command.name))) assert.equal(writeGotcha(w.r, E, g, { source: { role: 'investigator' } }).ok, true) }

// ================================================================== the series and the measurement

describe('leaf-close and the measurement', { concurrency: 4 }, () => {
  test('series-done is journalled from git when the producer said done', SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, { 'test/a.test.mjs': A_TEST }, 'Add the test')
    commit(o.worktree, { 'src/a.mjs': A_SRC }, 'Add a')
    await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    const done = recs(w, 'series-done', 'a')
    assert.equal(done.length, 1)
    assert.equal(done[0].branch, o.branch)
    assert.equal(done[0].head_sha, head(o.worktree))
    const expected = git(o.worktree, 'log', '--reverse', '--no-merges', '--format=%H%x09%s', o.base_sha + '..HEAD').split('\n')
      .map((l) => ({ sha: l.split('\t')[0], subject: l.split('\t')[1] }))
    assert.equal(expected.length, 2)
    assert.deepEqual(done[0].commits, expected, 'oldest first')
  })

  test('series-done is journalled when the producer said done_with_concerns', SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, A_FILES, 'Add a')
    await run(w, { node: 'a', role: 'implementer', round: 1, ret: { status: 'done_with_concerns', text: 'done', concerns: ['slow'] }, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(recs(w, 'series-done', 'a').length, 1)
  })

  test("an auditor's round over commits of its branch journals series-done as a done round does", SLOW, async (t) => {
    const c = cycle(t, { triad: true })
    write(c.audit.worktree, { 'docs/audit.md': 'the net holds\n' })
    const ret = { mutations: [R_BITES], units: [], text: 'audited' }
    await run(c.w, { node: 'au', role: 'auditor', round: 1, thread: 'producer:au', ret, base_sha: c.audit.base_sha })
    const tip = head(c.audit.worktree)
    const done = recs(c.w, 'series-done', 'au')
    assert.equal(done.length, 1)
    assert.equal(done[0].head_sha, tip)
    assert.deepEqual(done[0].commits.map((x) => x.sha), [tip])
  })

  test('the measurement is taken through measure, journalled with its key', SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, A_FILES, 'Add a')
    await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    const lines = observed(w, 'a')
    assert.equal(lines.length, 1)
    assert.match(lines[0].key, /^[0-9a-f]{8}$/)
    assert.equal(lines[0].head_sha, head(o.worktree))
    assert.equal(lines[0].producer, 'implementer')
    assert.equal(stopOf(rec(w, 'a', 'implementer', 1)), lines[0].stop_reason)
  })

  test('a second close at the same key measures nothing', SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, A_FILES, 'Add a')
    let spawned = 0
    const ports = { spawn: (cmd, args, opts) => { spawned++; return spawn(cmd, args, opts) } }
    const spec = { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha, ports }
    const dispatch = stored(w, spec)
    const first = await close(w, { ...spec, dispatch })
    const after = spawned
    assert.ok(after > 0, 'the first close measured')
    const second = await close(w, { ...spec, dispatch })
    assert.equal(spawned, after, 'the second close spawned nothing')
    assert.equal(observed(w, 'a').length, 1)
    assert.deepEqual(shapeOf(second), shapeOf(first))
  })

  test("a green is measured on its red's tests: one that breaks them fails, and the failures go to the green's producer", SLOW, async (t) => {
    const c = cycle(t, { greenFiles: { 'src/r.mjs': 'export const r = (x) => x + 3\n' } })
    const { out } = await run(c.w, { node: 'g', role: 'implementer', round: 1, ret: DONE, base_sha: c.green.base_sha, head_before: c.green.base_sha })
    assert.equal(out.decision.next, 'fix', JSON.stringify(out.decision))
    const sent = msgs(c.w, 'failures', 'g')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].thread, 'producer:g')
    assert.equal(sent[0].round, 2)
    assert.equal(sent[0].payload.source, 'verification')
  })

  test('a user ref moved during the check is a checkout fault on the leaf', SLOW, async (t) => {
    const { w, o } = trivial(t, (r) => "git -C '" + posix(r) + "' branch moved-by-check")
    const { out } = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.deepEqual([out.decision.next, out.decision.reason], ['stop', 'checkout'])
    const faults = recs(w, 'fault', 'a')
    assert.equal(faults.length, 1)
    assert.equal(faults[0].channel, 'checkout')
    assert.deepEqual(out.stops, [{ id: 'a', status: 'held', reason: 'checkout', said: '' }])
  })

  test("a watch that cannot read the user's checkout is a checkout fault on the leaf", SLOW, async (t) => {
    const { w, o } = trivial(t)
    const ports = { watch: { before: () => { throw new Error('unreadable') }, after: () => ({ moved: [] }) } }
    const { out } = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha, ports })
    assert.deepEqual([out.decision.next, out.decision.reason], ['stop', 'checkout'])
    const faults = recs(w, 'fault', 'a')
    assert.equal(faults.length, 1)
    assert.equal(faults[0].channel, 'checkout')
  })

  test('a measurement that could not be taken escalates the leaf by its error kind', SLOW, async (t) => {
    const { w, o } = trivial(t)
    const ports = { spawn: (cmd, args, opts) => spawn(process.execPath, ['-e', 'process.exit(3)'], opts) }
    const { out } = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha, ports })
    assert.deepEqual([out.decision.next, out.decision.reason], ['stop', 'measure_failed'])
    assert.equal(out.stops.length, 1)
    assert.deepEqual([out.stops[0].id, out.stops[0].status, out.stops[0].reason], ['a', 'escalated', 'measure_failed'])
  })

  test('a test that holds at base goes back to the producer once; still holding the round after, it escalates with the failing claims', SLOW, async (t) => {
    const w = world(t, [root(), lf('a', { expects: ['test/more.test.mjs'] })])
    const o = open(w, 'a')
    commit(o.worktree, { 'test/more.test.mjs': MORE_TEST }, 'Add a test of what exists')
    const first = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.deepEqual([first.out.decision.next, first.out.decision.reason], ['fix', 'discriminator_sent_back'])
    assert.equal(msgs(w, 'failures', 'a').at(-1).payload.failures[0].check, 'discriminator', 'the producer is told')
    assert.deepEqual(recs(w, 'escalated', 'a'), [])
    const moved = head(o.worktree)
    commit(o.worktree, { 'test/more.test.mjs': MORE_TEST + '// tried again\n' }, 'Tighten the test')
    const { out } = await run(w, { node: 'a', role: 'implementer', round: 2, ret: DONE, base_sha: o.base_sha, head_before: moved })
    assert.deepEqual([out.decision.next, out.decision.reason], ['stop', 'discriminator_undecidable'])
    assert.ok(out.decision.failures.length > 0)
    const events = recs(w, 'escalated', 'a')
    assert.equal(events.length, 1)
    assert.equal(events[0].reason, 'discriminator_undecidable')
    for (const claim of claimsOf(out)) assert.ok(events[0].detail.includes(claim), 'the detail holds ' + claim)
  })

  test('a net ruling on an undecidable leaf, retried, closes it at the ruled head; a commit after it voids the ruling', SLOW, async (t) => {
    const w = world(t, [root(), lf('a', { expects: ['test/more.test.mjs'] })])
    const o = open(w, 'a')
    commit(o.worktree, { 'test/more.test.mjs': MORE_TEST }, 'Add a test of what exists')
    const sent = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(sent.out.decision.reason, 'discriminator_sent_back')
    const before = head(o.worktree)
    commit(o.worktree, { 'test/more.test.mjs': MORE_TEST + '// tried again\n' }, 'Tighten the test')
    const first = await run(w, { node: 'a', role: 'implementer', round: 2, ret: DONE, base_sha: o.base_sha, head_before: before })
    assert.equal(first.out.decision.reason, 'discriminator_undecidable')
    const WHY = 'pins add over negatives, which already held at base'
    assert.equal(ruleNets(w.r, E, 'a', { nets: [{ file: 'test/other.test.mjs', why: WHY }] }).error.kind, 'not_measured')
    assert.equal(ruleNets(w.r, E, 'a', { nets: [{ file: 'test/more.test.mjs', why: '' }] }).error.kind, 'no_reason')
    const ruled = ruleNets(w.r, E, 'a', { nets: [{ file: 'test/more.test.mjs', why: WHY }] })
    assert.deepEqual([ruled.ok, ruled.all, ruled.head_sha], [true, true, head(o.worktree)])
    const retry = () => assert.equal(append(w.r, E, 'events', [{ kind: 'replanned', node: 'a', execution: w.stamp, reason: 'retry_escalated', by: 'session' }]).ok, true)
    retry()
    const again = await close(w, { node: 'a', round: 2, dispatch: '', base_sha: o.base_sha, head_before: before })
    assert.ok(['approve', 'review'].includes(again.decision.next), JSON.stringify(again.decision))
    assert.equal(ruleNets(w.r, E, 'a', { nets: [{ file: 'test/more.test.mjs', why: WHY }] }).error.kind, 'not_undecidable', 'nothing left to rule')

    commit(o.worktree, { 'test/more.test.mjs': MORE_TEST + '// more\n' }, 'Touch the net')
    retry()
    const moved = await close(w, { node: 'a', round: 2, dispatch: '', base_sha: o.base_sha, head_before: before })
    assert.equal(moved.decision.reason, 'discriminator_undecidable', 'the ruling binds to the head it was made at')
  })

  test("a red's test file that only keeps compiling passes at base and now, and the red goes to review with no round sent", SLOW, async (t) => {
    const w = world(t, [root(),
      lf('r', { rigor: 'tdd-pair', role: 'red', expects: ['test/r.test.mjs', 'test/add.test.mjs'] }),
      lf('g', { rigor: 'tdd-pair', role: 'green', deps: ['r'], expects: ['src/r.mjs'] })])
    const o = open(w, 'r')
    const upkeep = git(o.worktree, 'show', 'HEAD:test/add.test.mjs') + '\n// a fake of add, given the new method so it typechecks\n'
    commit(o.worktree, { 'test/r.test.mjs': R_TEST, 'test/add.test.mjs': upkeep }, 'Pin r')
    const { out } = await run(w, { node: 'r', role: 'test-author', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.deepEqual(observed(w, 'r')[0].discriminator.map((d) => [d.test_id, d.adds_test]), [['test/add.test.mjs', false], ['test/r.test.mjs', true]])
    assert.equal(out.decision.next, 'review', JSON.stringify(out.decision))
    assert.deepEqual(msgs(w, 'failures', 'r'), [])
  })

  test("a red's file of cases over what held at base escalates on round one; a net over it, retried, sends the red to review", SLOW, async (t) => {
    const w = world(t, [root(),
      lf('r', { rigor: 'tdd-pair', role: 'red', expects: ['test/r.test.mjs', 'test/more.test.mjs'] }),
      lf('g', { rigor: 'tdd-pair', role: 'green', deps: ['r'], expects: ['src/r.mjs'] })])
    const o = open(w, 'r')
    commit(o.worktree, { 'test/r.test.mjs': R_TEST, 'test/more.test.mjs': MORE_TEST }, 'Pin r beside add')
    const first = await run(w, { node: 'r', role: 'test-author', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.deepEqual([first.out.decision.next, first.out.decision.reason], ['stop', 'discriminator_undecidable'], JSON.stringify(first.out.decision))
    const ruled = ruleNets(w.r, E, 'r', { nets: [{ file: 'test/more.test.mjs', why: 'pins add over negatives, which held at base' }] })
    assert.deepEqual([ruled.ok, ruled.all], [true, false])
    assert.equal(append(w.r, E, 'events', [{ kind: 'replanned', node: 'r', execution: w.stamp, reason: 'retry_escalated', by: 'session' }]).ok, true)
    const again = await close(w, { node: 'r', round: 1, dispatch: '', base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(again.decision.next, 'review', JSON.stringify(again.decision))
    assert.deepEqual(msgs(w, 'failures', 'r'), [], 'no producer round was sent')
  })

  test("uncommitted work left in a shell producer's worktree is put back to the head before measuring", SLOW, async (t) => {
    const { w, o } = tdd(t)
    const tip = commit(o.worktree, A_FILES, 'Add a')
    write(o.worktree, { 'src/a.mjs': A_SRC + '// wip\n' })
    const { out } = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(git(o.worktree, 'status', '--porcelain'), '', 'the worktree is clean at the head')
    assert.equal(head(o.worktree), tip)
    assert.equal(out.decision.next, 'approve', JSON.stringify(out.decision))
    assert.deepEqual(recs(w, 'approved', 'a').map((e) => e.head_sha), [tip])
    assert.ok(rec(w, 'a', 'implementer', 1).notes.some((n) => n.includes('src/a.mjs')), 'a note names the file')
  })
})

// ================================================================== the gotchas

describe('leaf-close and the gotchas', { concurrency: 4 }, () => {
  test('returned gotchas are written, observed at the head and sourced to the round', SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, A_FILES, 'Add a')
    const g = gotcha('the helper is imported before it is built')
    await run(w, { node: 'a', role: 'implementer', round: 1, ret: { ...DONE, gotchas: [g] }, base_sha: o.base_sha, head_before: o.base_sha })
    const id = gotchaId(g)
    assert.deepEqual(rec(w, 'a', 'implementer', 1).gotchas_written, [id])
    const written = gotchaOf(w, id)
    assert.ok(written, 'the gotcha is on disk')
    assert.equal(written.observed_at, head(o.worktree))
    assert.deepEqual(written.source, { node: 'a', role: 'implementer' })
  })

  test('stale gotchas the return names are deleted', SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, A_FILES, 'Add a')
    const here = gotcha('a trap that no longer holds')
    const gone = gotcha('a trap that was never written')
    assert.equal(writeGotcha(w.r, E, here, { source: { node: 'a', role: 'implementer' } }).ok, true)
    await run(w, { node: 'a', role: 'implementer', round: 1, ret: { ...DONE, gotchas_stale: [gotchaId(here), gotchaId(gone)] }, base_sha: o.base_sha, head_before: o.base_sha })
    assert.deepEqual(rec(w, 'a', 'implementer', 1).gotchas_deleted, [gotchaId(here)], 'only the id that had a file is listed')
    assert.equal(gotchaOf(w, gotchaId(here)), undefined)
  })

  test('a refused gotcha is noted on the close record and the others are written', SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, A_FILES, 'Add a')
    const bad = gotcha('a trap with no proof', { evidence: { command: '', output: '' } })
    const good = gotcha('a trap with proof')
    await run(w, { node: 'a', role: 'implementer', round: 1, ret: { ...DONE, gotchas: [bad, good] }, base_sha: o.base_sha, head_before: o.base_sha })
    const record = rec(w, 'a', 'implementer', 1)
    assert.deepEqual(record.gotchas_written, [gotchaId(good)])
    assert.ok(record.notes.some((n) => /gotcha refused/.test(n)), 'a note says one was refused')
  })

  test("a producer's command gotchas are not written, a note names each, and its other gotchas are", SLOW, async (t) => {
    const w = world(t, [root(), lf('a', { expects: ['src/a.mjs', 'test/a.test.mjs'] })], { commands: null })
    const o = open(w, 'a')
    commit(o.worktree, A_FILES, 'Add a')
    establish(w, ['command-build'])
    assert.equal(gotchaOf(w, 'command-build'), undefined, 'no command-build on file before the round')
    const before = JSON.stringify(gotchaOf(w, 'command-build') || null)
    const pit = gotcha('a pitfall beside the commands')
    const ret = { ...DONE, gotchas: [command('suite', 'echo not-the-suite'), command('build', 'make'), pit] }
    await run(w, { node: 'a', role: 'implementer', round: 1, ret, base_sha: o.base_sha, head_before: o.base_sha })
    const record = rec(w, 'a', 'implementer', 1)
    assert.deepEqual(record.gotchas_written, [gotchaId(pit)], 'the pitfall is the one entry')
    assert.ok(gotchaOf(w, gotchaId(pit)), 'the pitfall is on disk')
    assert.equal(gotchaOf(w, 'command-suite').source.role, 'investigator', 'the investigator keeps command-suite')
    assert.equal(commandsOf(w.r, E).suite, COMMANDS.suite)
    assert.equal(JSON.stringify(gotchaOf(w, 'command-build') || null), before, 'command-build is what it was before the round')
    assert.equal(gotchaOf(w, 'command-build'), undefined, 'a producer establishes no command nobody wrote')
    assert.ok(record.notes.some((n) => n.includes('command-suite')))
    assert.ok(record.notes.some((n) => n.includes('command-build')))
  })

  test("a producer's stale id naming a command gotcha deletes nothing, and a note names it", SLOW, async (t) => {
    const w = world(t, [root(), lf('a', { expects: ['src/a.mjs', 'test/a.test.mjs'] })], { commands: null })
    const o = open(w, 'a')
    commit(o.worktree, A_FILES, 'Add a')
    establish(w)
    const pit = gotcha('a pitfall that went stale')
    assert.equal(writeGotcha(w.r, E, pit, { source: { node: 'a', role: 'implementer' } }).ok, true)
    await run(w, { node: 'a', role: 'implementer', round: 1, ret: { ...DONE, gotchas_stale: ['command-suite', gotchaId(pit)] }, base_sha: o.base_sha, head_before: o.base_sha })
    const record = rec(w, 'a', 'implementer', 1)
    assert.deepEqual(record.gotchas_deleted, [gotchaId(pit)], 'only the pitfall went')
    assert.ok(gotchaOf(w, 'command-suite'), 'the command-suite file stays')
    assert.equal(commandsOf(w.r, E).suite, COMMANDS.suite)
    assert.ok(record.notes.some((n) => n.includes('command-suite')))
  })
})
