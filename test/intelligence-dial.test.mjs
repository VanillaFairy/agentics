// test/intelligence-dial.test.mjs — one intelligence dial per program run: set on the context at
// entry (`ctx.intelligence`) and per nested program (`scoped`), read by every dispatch and search a
// program makes, the probe's and the solutions' searches and rulers included; a call's own tier wins.
// A scripted host plays every navigator turn idle, so each search stalls, goes to its ruler, and ends.
//
// Design: docs/DESIGN.md#programs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dispatch, programContext, scoped } from '../lib/programs/common.mjs'
import { probe } from '../lib/programs/probe.mjs'
import { solutions } from '../lib/programs/solutions.mjs'
import { survey } from '../lib/programs/survey.mjs'
import { loadRole, tierFor } from '../lib/roles.mjs'
import { launch } from '../lib/run.mjs'
import { memoryLog } from './fast/harness/memory-log.mjs'
import { scriptedRunner } from './fast/harness/scripted-runner.mjs'

const RUN = '20260101-000000-test'
const NOW = () => '2026-01-01T00:00:00.000Z'
const SHA = 'a'.repeat(40)
const ARTEFACT = '# The thing\n\n## Design\n\nA token bucket per key.\n'

const IDLE = { output: { hits: [], dismissed: [], leads: [], asks: [] } }
const FAILED = { status: 'failed', cause: 'host_error' }
const FRAME = {
  output: {
    capability_line: 'a TOML reader', hard_constraints: [], disqualifiers: [],
    angles: [{ key: 'npm', find: 'TOML readers on npm' }], repo_question: 'where is config read',
  },
}
const PLAN = { output: { topics: [{ key: 'store', find: 'where the store is written', subtree: '' }], common_ground: '', history_question: '', docs_question: '' } }

/** What the host plays for a call keyed `role|node|thread`: a navigator turn is idle, a frame or plan returns, every other call fails. */
function stepFor(key) {
  const [role, , thread] = key.split('|')
  if (['scout', 'doc-researcher', 'historian'].includes(role)) return IDLE
  if (thread.endsWith('frame')) return FRAME
  if (thread.endsWith('plan')) return PLAN
  return FAILED
}
const endless = (key) => new Proxy([], { get: (_, p) => (p === 'length' ? Infinity : /^\d+$/.test(String(p)) ? stepFor(key) : undefined) })
const SCRIPT = new Proxy({}, { get: (_, key) => endless(String(key)) })

/** A run's world: a scratch repo holding the artefact, a pinned tree, and a context at `intelligence`. */
function world(t, { intelligence } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agentics-dial-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  mkdirSync(join(home, 'tree'), { recursive: true })
  writeFileSync(join(home, 'doc.md'), ARTEFACT)
  writeFileSync(join(home, 'tree', 'doc.md'), ARTEFACT)
  for (const dir of [home, join(home, 'tree')]) {
    const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'pipe' })
    git('init', '-q')
    git('add', '-A')
    git('commit', '-qm', 'start')
  }
  const log = memoryLog()
  const runner = scriptedRunner(SCRIPT, { log, now: NOW })
  const ctx = {
    ...programContext({ repo: home, root: home, run: RUN, log, runAgent: runner.runAgent, now: NOW, sleep: () => Promise.resolve(), dir: join(home, 'run'), intelligence }),
    groundOf: async () => ({ rows: [], seeds: [] }),
  }
  return { ctx, calls: runner.calls, tree: { root: join(home, 'tree'), sha: SHA }, home }
}

const tierOf = (role, intelligence, base = '') => tierFor(loadRole(role).role, { intelligence, base })
const ofRole = (calls, role) => calls.filter((c) => c.role.name === role)

test('solutions hands its dial to its searches', async (t) => {
  const w = world(t, { intelligence: 'max' })
  await solutions(w.ctx, { capability: 'Parse TOML.', roots: ['.'], constraints: '', notes: '', max_angles: 4, intelligence: 'max', tree: w.tree })
  for (const role of ['scout', 'doc-researcher', 'ruler']) {
    const calls = ofRole(w.calls, role)
    assert.ok(calls.length > 0, role + ' was dispatched')
    for (const c of calls) assert.deepEqual(c.tier, tierOf(role, 'max'), role + ' on ' + c.thread.key)
  }
  assert.ok(ofRole(w.calls, 'ruler').some((c) => c.thread.key.includes('research:npm')), "the researcher's ruler")
  assert.ok(ofRole(w.calls, 'ruler').some((c) => c.thread.key.includes(':repo:')), "the repo scout's ruler")
})

test('the probe has a dial', async (t) => {
  const w = world(t, { intelligence: 'low' })
  await probe(w.ctx, { artifact: join(w.home, 'doc.md'), artifact_text: ARTEFACT, roots: ['.'], context: '', per_axis: false, since: '', intelligence: 'low', tree: w.tree })
  const analysts = ofRole(w.calls, 'analyst')
  assert.ok(analysts.length > 0, 'an analyst was dispatched')
  for (const c of analysts) assert.deepEqual(c.tier, tierOf('analyst', 'low'), c.thread.key)
  const rulers = ofRole(w.calls, 'ruler').filter((c) => c.thread.key.includes('locate'))
  assert.ok(rulers.length > 0, 'the locate ruler was dispatched')
  for (const c of rulers) assert.deepEqual(c.tier, tierOf('ruler', 'low'), c.thread.key)
  for (const c of ofRole(w.calls, 'scout')) assert.deepEqual(c.tier, tierOf('scout', 'low'), c.thread.key)
})

test('an explicit tier wins', async (t) => {
  const w = world(t, { intelligence: 'max' })
  const tier = { model: 'haiku', effort: 'low' }
  await dispatch(w.ctx, { role: 'analyst', schema: 'frame', thread: 'frame', brief: 'frame it', tier })
  await dispatch(w.ctx, { role: 'analyst', schema: 'frame', thread: 'other-frame', brief: 'frame it', intelligence: 'low', tier })
  assert.deepEqual(w.calls.map((c) => c.tier), [tier, tier])
})

test('a dispatch with no dial of its own takes the context\'s', async (t) => {
  const w = world(t, { intelligence: 'max' })
  await dispatch(w.ctx, { role: 'analyst', schema: 'frame', thread: 'frame', brief: 'frame it', base: 'medium' })
  await dispatch(w.ctx, { role: 'analyst', schema: 'frame', thread: 'other-frame', brief: 'frame it', intelligence: 'low', base: 'medium' })
  assert.deepEqual(w.calls.map((c) => c.tier), [tierOf('analyst', 'max', 'medium'), tierOf('analyst', 'low', 'medium')])
})

test('survey reads the dial from ctx', async (t) => {
  const w = world(t, { intelligence: 'max' })
  await survey(w.ctx, { question: 'Where is the store written?', roots: ['.'], notes: '', prior: '', max_topics: 8, pace: 'balanced', ground: [], tree: w.tree })
  const judges = ofRole(w.calls, 'analyst').filter((c) => c.thread.key.startsWith('judge:'))
  assert.ok(judges.length > 0, 'a judge was dispatched')
  for (const c of judges) assert.deepEqual(c.tier, tierOf('analyst', 'max', 'high'), c.thread.key)
  const plan = ofRole(w.calls, 'analyst').find((c) => c.thread.key === 'plan')
  assert.deepEqual(plan.tier, tierOf('analyst', 'max', 'medium'))
  for (const c of ofRole(w.calls, 'scout')) assert.deepEqual(c.tier, tierOf('scout', 'max'), c.thread.key)
})

test('scoped carries a dial', async (t) => {
  const w = world(t, { intelligence: 'normal' })
  const nested = scoped(w.ctx, 'x', { intelligence: 'max' })
  assert.equal(nested.intelligence, 'max')
  assert.equal(nested.prefix, 'x')
  assert.equal(w.ctx.intelligence, 'normal', "the parent's dial is untouched")
  assert.equal(scoped(w.ctx, 'y').intelligence, 'normal', 'no dial given keeps the parent\'s')
  await dispatch(nested, { role: 'analyst', schema: 'frame', thread: 'frame', brief: 'frame it' })
  await dispatch(w.ctx, { role: 'analyst', schema: 'frame', thread: 'frame', brief: 'frame it' })
  assert.deepEqual(w.calls.map((c) => [c.thread.key, c.tier]), [['x/frame', tierOf('analyst', 'max')], ['frame', tierOf('analyst', 'normal')]])
})

/** An attached start of a stand-in program declaring `spec` with `flags`: the dial its context held. */
async function dialAt(t, spec, flags) {
  const w = world(t)
  let seen = null
  const mod = { ARGS: spec, scopeOf: () => ({}), review: (ctx) => { seen = ctx.intelligence; return { coverage: { complete: true } } } }
  const out = await launch({ argv: ['review', ...flags], cwd: w.home, env: {}, now: () => new Date(NOW()), heartbeatMs: 20, load: async () => mod, runner: () => async () => ({}) })
  assert.equal(out.ok, true, JSON.stringify(out))
  return seen
}

test('run.mjs defaults the dial', async (t) => {
  assert.equal(await dialAt(t, {}, []), 'normal', 'a program that declares no dial runs at normal')
  const DIAL = { intelligence: { kind: 'enum', values: ['low', 'normal', 'max'], default: 'normal' } }
  assert.equal(await dialAt(t, DIAL, ['--intelligence', 'max']), 'max', "the program's own dial")
})
