// test/program-execute-program.test.mjs — pins the execute program (lib/programs/execute.mjs) end
// to end: its arguments, scope and home, its checkpoints and a start's run, started through
// lib/run.mjs or called directly over the execution rig (real git, the real measurement, a scripted
// runner).
//
// What is pinned here:
//
//   the program   PROGRAM_NAMES, ARGS and scopeOf; homeOf resumes the latest open execution of a
//                 folder (from its envelope, or from the run.json a cut start left), passes over a
//                 closed one and mints a numbered stamp; bad input is refused before anything is
//                 recorded; a start runs in its execution's home (run id, result, returns, roles,
//                 sessions), detached or attached, a live home is refused, a cut start is
//                 launch_failed and the next start reaches the same execution
//   checkpoints   one dispatches nothing; the relaunch with --confirmed <seq> reaches the same
//                 execution and runs it; a preflight refusal ends the run with the refusal in its
//                 result
//
// Every claim is read from the records (`executionLog(...).entries()`, `readTree(...).status`), the
// result and the calls the runner received. Expected values are computed: heads with `git
// rev-parse`, sessions with `sessionOf`, stamps with `stampNow`, tiers with `producerTier` and
// `tierFor`. Where the contract leaves a value open (a note's wording beyond its named start, a
// park's question beyond what the ruler gave) nothing here pins it. The execution rig and the specs
// the parts share are in test/harness/execute-program-world.mjs.
//
// Design: docs/DESIGN.md#execution, docs/DESIGN.md#resume-and-checkpoints, docs/DESIGN.md#program-results.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ARGS, execute, homeOf, scopeOf } from '../lib/programs/execute.mjs'
import { PROGRAM_NAMES } from '../lib/run.mjs'
import {
  executionDir, executionRunId, executionsRoot, resultPath, returnPath, runJsonPath, runsDir, sessionOf,
  stampNow,
} from '../lib/store.mjs'
import { executionRig } from './harness/program-rig.mjs'
import {
  T, E, NOW_ISO, leafEntry, specText, done, claim, rootReview, IMPL, until, ARGS0, world, kinds, stateOf,
  statusOf, startsOf, same, commandsFile, assertComplete, folderSpecs, C_REVIEW,
} from './harness/execute-program-world.mjs'

// leaf-close, merge-batch and the suite gate measure through `node --test` grandchildren, which
// refuse to run under the test runner's marker; the rig does not clear it.
delete process.env.NODE_TEST_CONTEXT

// ================================================================== more of the world

/** An open execution of the rig's effort: its directory holding an envelope for `root`; its run id. */
function openExecution(rig, stamp, root) {
  const dir = executionDir(rig.repo, E, stamp)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'execution.json'), JSON.stringify({
    stamp, root, base_branch: 'main', base_sha: rig.base_sha, dial: 'normal', pace: 'balanced', commands: null,
  }))
  return executionRunId(E, stamp)
}

// ================================================================== the tests

describe('the execute program', { concurrency: 4 }, () => {
  // ------------------------------------------------------------------ the program, its arguments and its home

  test('execute is a program lib/run.mjs starts, with its arguments, scope and home', T, () => {
    assert.ok(PROGRAM_NAMES.includes('execute'))
    assert.deepEqual(Object.keys(ARGS), ['effort', 'folder', 'intelligence', 'pace', 'plan_only', 'pause', 'budget', 'confirmed', 'base_ref', 'commands_file'])
    assert.equal(ARGS.effort.kind, 'effort')
    assert.equal(ARGS.effort.required, true)
    assert.equal(ARGS.folder.kind, 'folder')
    assert.equal(ARGS.folder.default, '.')
    assert.equal(ARGS.intelligence.kind, 'enum')
    assert.deepEqual([...ARGS.intelligence.values].sort(), ['low', 'max', 'normal'])
    assert.equal(ARGS.intelligence.default, 'normal')
    assert.equal(ARGS.pace.kind, 'enum')
    assert.deepEqual([...ARGS.pace.values].sort(), ['balanced', 'fast', 'frugal'])
    assert.equal(ARGS.pace.default, 'balanced')
    assert.equal(ARGS.plan_only.kind, 'bool')
    assert.equal(ARGS.pause.kind, 'bool')
    assert.equal(ARGS.budget.kind, 'int')
    assert.equal(ARGS.confirmed.kind, 'int')
    assert.equal(ARGS.base_ref.kind, 'text', 'the envelope keeps the branch name the session gave, not a resolved commit')
    assert.equal(ARGS.commands_file.kind, 'file')
    for (const [key, a] of Object.entries(ARGS)) if (key !== 'effort') assert.notEqual(a.required, true, key + ' is optional')

    assert.deepEqual(scopeOf({ ...ARGS0 }), { effort: E, folder: '.' })
    const flagged = { ...ARGS0, effort: 'other', folder: 'c', intelligence: 'max', pace: 'fast', plan_only: true, pause: true, budget: 9, confirmed: 3, base_ref: 'dev', commands_file: '/x' }
    assert.deepEqual(scopeOf(flagged), { effort: 'other', folder: 'c' }, 'the scope is the effort and the folder, whatever the flags')
    assert.equal(typeof homeOf, 'function')
    assert.equal(typeof execute, 'function')
  })

  test('homeOf resumes the open execution that runs the folder', T, (t) => {
    const rig = executionRig(t)
    const at = { repo: rig.repo, now: new Date('2026-02-02T02:02:02.000Z') }
    assert.equal(homeOf({ ...ARGS0 }, at).run, rig.run, 'the rig\'s open execution on .')

    const later = openExecution(rig, '20260301-000000', '.')
    const other = openExecution(rig, '20260401-000000', 'c')
    assert.equal(homeOf({ ...ARGS0 }, at).run, later, 'the latest open execution of the folder')
    assert.equal(homeOf({ ...ARGS0, folder: 'c' }, at).run, other, 'an execution of another folder is not this folder\'s')
    assert.deepEqual(readdirSync(executionsRoot(rig.repo, E)).sort(), [rig.stamp, '20260301-000000', '20260401-000000'], 'resuming mints no stamp')
  })

  test('homeOf mints a stamp from now when no open execution runs the folder, numbered on when it is taken', T, (t) => {
    const rig = executionRig(t)
    const now = new Date('2026-05-05T05:05:05.000Z')
    const minted = homeOf({ ...ARGS0, folder: 'c' }, { repo: rig.repo, now })
    assert.equal(minted.run, executionRunId(E, stampNow(now)))
    assert.ok(existsSync(executionDir(rig.repo, E, stampNow(now))), 'taken by making its directory')

    rmSync(join(rig.dir, 'execution.json'))
    const atRig = new Date('2026-01-01T00:00:00.000Z')
    assert.equal(stampNow(atRig), rig.stamp, 'the fixture: now is the rig\'s stamp time')
    const second = homeOf({ ...ARGS0 }, { repo: rig.repo, now: atRig })
    assert.equal(second.run, executionRunId(E, rig.stamp + '-2'))
    assert.ok(existsSync(executionDir(rig.repo, E, rig.stamp + '-2')))
    const third = homeOf({ ...ARGS0 }, { repo: rig.repo, now: atRig })
    assert.equal(third.run, executionRunId(E, rig.stamp + '-3'), 'numbered on while taken')
    assert.ok(existsSync(executionDir(rig.repo, E, rig.stamp + '-3')))
  })

  test('homeOf passes over a closed execution', T, (t) => {
    const rig = executionRig(t)
    const now = new Date('2026-06-06T06:06:06.000Z')
    assert.equal(homeOf({ ...ARGS0 }, { repo: rig.repo, now }).run, rig.run, 'the fixture: open, it is the home')
    rig.log.append('closed', { status: 'done' })
    const out = homeOf({ ...ARGS0 }, { repo: rig.repo, now })
    assert.notEqual(out.run, rig.run)
    assert.equal(out.run, executionRunId(E, stampNow(now)))
  })

  test('homeOf finds a home that holds only the run.json a start cut before its child wrote', T, (t) => {
    const rig = executionRig(t)
    const now = new Date('2026-07-07T07:07:07.000Z')
    const meta = (stamp, program, folder) => ({
      run: executionRunId(E, stamp), program, scope: { effort: E, folder }, scope_key: 'k', args: {}, args_digest: 'd', pid: 0, heartbeat_at: NOW_ISO,
    })
    const cut = '20260101-020000'
    mkdirSync(executionDir(rig.repo, E, cut), { recursive: true })
    writeFileSync(runJsonPath(rig.repo, executionRunId(E, cut)), JSON.stringify(meta(cut, 'execute', 'c')))
    assert.equal(homeOf({ ...ARGS0, folder: 'c' }, { repo: rig.repo, now }).run, executionRunId(E, cut))
    assert.equal(homeOf({ ...ARGS0 }, { repo: rig.repo, now }).run, rig.run, 'it runs c, not .')

    const alien = '20260101-030000'
    mkdirSync(executionDir(rig.repo, E, alien), { recursive: true })
    writeFileSync(runJsonPath(rig.repo, executionRunId(E, alien)), JSON.stringify(meta(alien, 'survey', 'c')))
    assert.equal(homeOf({ ...ARGS0, folder: 'c' }, { repo: rig.repo, now }).run, executionRunId(E, cut), 'a run of another program is no execution')
  })

  test('bad input is refused by lib/run.mjs before anything is recorded', T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    const cases = [
      [['--effort', 'nope'], 'unknown_effort'],
      [['--effort', E, '--folder', 'nope'], 'unknown_folder'],
      [['--effort', E, '--intelligence', 'wild'], 'bad_arg'],
      [['--effort', E, '--pace', 'slow'], 'bad_arg'],
      [['--effort', E, '--confirmed', 'x'], 'bad_arg'],
      [['--effort', E, '--budget', '-1'], 'bad_arg'],
      [['--effort', E, '--commands-file', 'nope.json'], 'unknown_file'],
      [[], 'missing_arg'],
    ]
    for (const [argv, kind] of cases) {
      const out = await w.start(argv)
      assert.equal(out.ok, false, argv.join(' '))
      assert.equal(out.error.kind, kind, argv.join(' '))
    }
    assert.deepEqual(readdirSync(executionsRoot(w.rig.repo, E)), [w.rig.stamp], 'no execution was made')
    assert.equal(existsSync(runJsonPath(w.rig.repo, w.rig.run)), false, 'no run.json was written')
    assert.deepEqual(existsSync(runsDir(w.rig.repo)) ? readdirSync(runsDir(w.rig.repo)).filter((n) => !n.startsWith('.')) : [], [])
    assert.equal(w.calls.length, 0)
  })

  test("a start runs in its execution's home: the run id, the result, the returns and the roles under executions/<stamp>, every session minted from the stamp", T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    const { rig } = w
    w.script({ [IMPL('a')]: [done()] }, rootReview(1, claim('D1 holds')))
    const out = await w.start(['--effort', E])

    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(out.run, executionRunId(E, rig.stamp))
    assert.equal(out.run, E + '.' + rig.stamp)
    assert.ok(same(out.result_file, resultPath(rig.repo, out.run)))
    assert.ok(same(dirname(out.result_file), rig.dir), 'the result is inside the execution\'s directory')
    assert.deepEqual(JSON.parse(readFileSync(out.result_file, 'utf8')), JSON.parse(JSON.stringify(out.result)), 'the file holds the printed result')
    assert.equal(out.result.execution, rig.stamp)
    assert.ok(w.calls.length >= 2, 'the producer and the root reviewer were called')
    for (const c of w.calls) {
      assert.ok(same(c.dir, rig.dir), 'the call ' + c.dispatch + ' is stored in the execution\'s directory')
      assert.ok(existsSync(returnPath(c.dir, c.dispatch)), 'its stored return exists')
    }
    assert.ok(readdirSync(join(rig.dir, 'roles')).length > 0, 'the roles\' prompts are written in the home')
    const [producer] = startsOf(w, 'implementer', 'a')
    assert.equal(producer.thread.session, sessionOf({ effort: E, execution: rig.stamp, node: 'a', role: 'implementer', thread: 'producer:a', gen: 0 }))
    assert.deepEqual(existsSync(runsDir(rig.repo)) ? readdirSync(runsDir(rig.repo)).filter((n) => !n.startsWith('.')) : [], [], 'no run directory under runs/')
    const started = stateOf(rig).filter((e) => e.kind === 'run')
    assert.equal(started.length, 1)
    assert.equal(started[0].program, 'execute')
    assert.deepEqual(started[0].scope, { effort: E, folder: '.' })
    const ended = stateOf(rig).filter((e) => e.kind === 'ended').at(-1)
    assert.equal(ended.result.complete, true)
  })

  test('a start cut before its child started is launch_failed, and the next start reaches the same execution', T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    const { rig } = w
    rmSync(join(rig.dir, 'execution.json'))
    const file = commandsFile(rig)
    const now = () => new Date('2026-03-04T05:06:07.000Z')
    const run = executionRunId(E, stampNow(now()))
    const cut = await w.start(['--effort', E, '--detach', '--commands-file', file], { now, spawnChild: () => 0 })

    assert.equal(cut.ok, false)
    assert.equal(cut.error.kind, 'launch_failed')
    assert.equal(cut.error.run, run)
    assert.ok(cut.error.message.includes(run), cut.error.message)
    assert.equal(w.calls.length, 0)

    const again = await w.start(['--effort', E, '--plan-only', '--commands-file', file], { now })
    assert.equal(again.ok, true, JSON.stringify(again))
    assert.equal(again.run, run, 'the same run id')
    assert.equal(again.result.execution, stampNow(now()), 'and the same execution')
    assert.equal(again.result.checkpoint.reason, 'parked')
    assert.equal(w.calls.length, 0)
  })

  test('a second start while the run is live is refused run_live, even during a long check', T, async (t) => {
    const marker = join(tmpdir(), 'agentics-execute-go-' + process.pid + '-' + Date.now())
    t.after(() => { rmSync(marker, { force: true }); rmSync(marker + '.started', { force: true }) })
    const WAIT = "import { existsSync, writeFileSync } from 'node:fs'\nconst go = " + JSON.stringify(marker) + "\nwriteFileSync(go + '.started', 'x')\n" +
      "const end = Date.now() + 120000\nwhile (!existsSync(go) && Date.now() < end) await new Promise((r) => setTimeout(r, 25))\nprocess.exit(existsSync(go) ? 0 : 1)\n"
    const w = world(t, { spec: specText([leafEntry('a', { check: 'node wait.mjs' })]), files: { 'wait.mjs': WAIT } })
    w.script({ [IMPL('a')]: [done()] }, rootReview(1, claim('D1 holds')))
    const first = w.start(['--effort', E])
    await until(() => existsSync(marker + '.started'), 'the leaf\'s check runs')

    const second = await w.start(['--effort', E])
    assert.equal(second.ok, false)
    assert.equal(second.error.kind, 'run_live')
    assert.equal(second.error.run, w.rig.run)
    assert.equal(second.error.pid, process.pid)

    writeFileSync(marker, 'go')
    const out = await first
    assert.equal(out.ok, true, JSON.stringify(out))
    assertComplete(out.result)
  })

  test("coverage.resumable names the program, its scope and the flags as given; plan_only parks at a checkpoint", T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    w.script({})
    const out = await w.start(['--effort', E, '--plan-only'])

    assert.equal(out.ok, true, JSON.stringify(out))
    assert.deepEqual(out.result.coverage.resumable, { program: 'execute', scope: { effort: E, folder: '.' }, args: { effort: E, plan_only: true } })
    assert.equal(out.result.checkpoint.reason, 'parked')
    assert.equal(out.result.coverage.complete, false)
    assert.equal(w.calls.length, 0)
  })

  // ------------------------------------------------------------------ checkpoints

  test('a checkpoint dispatches nothing; the relaunch with --confirmed <seq> reaches the same execution and runs it', T, async (t) => {
    const w = world(t, { spec: folderSpecs() })
    const { rig } = w
    w.script({ [IMPL('c/k')]: [done()] }, C_REVIEW)
    const file = commandsFile(rig)
    const now = () => new Date('2026-01-01T01:00:00.000Z')
    const stamp = stampNow(now())
    const argv = ['--effort', E, '--folder', 'c', '--commands-file', file]
    const first = await w.start(argv, { now })

    assert.equal(first.ok, true, JSON.stringify(first))
    assert.notEqual(first.run, rig.run, 'c is not the rig\'s execution')
    assert.equal(first.run, executionRunId(E, stamp))
    const cp = first.result.checkpoint
    assert.equal(cp.reason, 'existing_execution')
    assert.ok(cp.detail.includes(rig.stamp), cp.detail)
    const lines = stateOf(rig, stamp).filter((e) => e.kind === 'checkpoint')
    assert.equal(lines.length, 1)
    assert.equal(cp.seq, lines[0].seq)
    assert.equal(w.calls.length, 0)
    assert.equal(kinds(rig, 'dispatched', undefined, stamp).length, 0)
    assert.equal(first.result.coverage.complete, false)
    assert.ok(first.result.coverage.unreached.some((l) => l.includes('existing_execution')), JSON.stringify(first.result.coverage.unreached))

    const second = await w.start([...argv, '--confirmed', String(cp.seq)], { now })
    assert.equal(second.ok, true, JSON.stringify(second))
    assert.equal(second.run, first.run, 'the same run id')
    assert.equal(second.result.checkpoint, null)
    assert.equal(stateOf(rig, stamp).filter((e) => e.kind === 'checkpoint-confirmed').length, 1)
    assert.equal(statusOf(rig, 'c'), 'merged')
    assertComplete(second.result)
  })
  test('a preflight refusal ends the run with the refusal in its result, dispatching nothing', T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    const { rig } = w
    rmSync(join(rig.dir, 'execution.json'))
    const file = commandsFile(rig)
    w.script({})
    const res = await w.run({ base_ref: 'no-such-branch', commands_file: file })

    assert.equal(res.error.kind, 'no_base')
    assert.equal(typeof res.error.message, 'string')
    assert.equal(res.checkpoint, null)
    assert.equal(res.coverage.complete, false)
    assert.ok(res.coverage.unreached.includes('preflight refused (no_base): nothing was dispatched'), JSON.stringify(res.coverage.unreached))
    assert.equal(w.calls.length, 0)
    assert.equal(kinds(rig, 'dispatched').length, 0)
    assert.equal(existsSync(join(rig.dir, 'execution.json')), false, 'no envelope was written')
  })
})
