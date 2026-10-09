// test/program-drafts.test.mjs — the drafts program: one analyst per stance, all at once, each draft
// recorded as an `approach` return, and the coverage block, over the scripted runner.
//
// Design: docs/DESIGN.md#programs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { fnv1a } from '../lib/plan-digest.mjs'
import { programContext } from '../lib/programs/common.mjs'
import { drafts, scopeOf } from '../lib/programs/drafts.mjs'
import { loadRole, tierFor } from '../lib/roles.mjs'
import { schemaOf } from '../lib/schemas.mjs'
import { evidenceReturnsDir } from '../lib/store.mjs'
import { programRig } from './harness/program-rig.mjs'

const GUIDE = 'GUIDE-MARK: keep modules small'
const QUESTION = 'How should the config loader read TOML? Decisions so far: D1 config is read once at startup.'
const draft = (stance) => ({
  approach: 'the ' + stance + ' approach', shape: stance + ' parts', contracts: ['loadConfig(path) returns an object'],
  cites: [], risks: [stance + ' risk'],
})
const script = (stances, over = {}) => ({
  ...Object.fromEntries(stances.map((s) => ['analyst||draft:' + s, [{ output: draft(s) }]])),
  ...over,
})
const argsOf = (over = {}) => ({ question_file: '/elsewhere/q.md', question: QUESTION, stances: ['minimal-change', 'long-horizon'], intelligence: 'normal', ...over })
const rigOf = (t, s) => {
  const rig = programRig({ files: { 'CLAUDE.md': GUIDE + '\n' }, script: s })
  t.after(() => rig.cleanup())
  return rig
}
const callsOn = (rig, thread) => rig.calls.filter((c) => c.thread.key === thread)
const returnFile = (repo, name) => join(evidenceReturnsDir(repo), name + '.json')
const returnsIn = (repo) => (existsSync(evidenceReturnsDir(repo)) ? readdirSync(evidenceReturnsDir(repo)).length : 0)
const blockStore = (repo) => {
  const at = evidenceReturnsDir(repo)
  mkdirSync(dirname(at), { recursive: true })
  writeFileSync(at, 'not a directory')
  return () => rmSync(at, { force: true })
}

test('one analyst drafts each stance, on its own thread, with the approach schema', async (t) => {
  const rig = rigOf(t, script(['minimal-change', 'long-horizon']))
  await drafts(rig.ctx, argsOf())
  assert.deepEqual(rig.calls.map((c) => c.thread.key).sort(), ['draft:long-horizon', 'draft:minimal-change'])
  for (const c of rig.calls) {
    assert.equal(c.role.name, 'analyst')
    assert.deepEqual(c.schema, schemaOf('approach'))
  }
})

test('every stance is dispatched at once', async (t) => {
  const rig = rigOf(t, script(['minimal-change', 'long-horizon']))
  let open = 0
  let most = 0
  const runAgent = async (call) => {
    open++
    most = Math.max(most, open)
    await new Promise((resolve) => setImmediate(resolve))
    try {
      return await rig.ctx.runAgent(call)
    } finally {
      open--
    }
  }
  await drafts(programContext({ ...rig.ctx, runAgent }), argsOf())
  assert.equal(most, 2)
})

test("each draft's brief holds the question, its stance and the guidance, and no other stance", async (t) => {
  const rig = rigOf(t, script(['minimal-change', 'long-horizon']))
  await drafts(rig.ctx, argsOf())
  for (const [mine, other] of [['minimal-change', 'long-horizon'], ['long-horizon', 'minimal-change']]) {
    const brief = callsOn(rig, 'draft:' + mine)[0].brief
    assert.ok(brief.includes(QUESTION) && brief.includes(mine) && brief.includes(GUIDE), mine)
    assert.ok(!brief.includes(other), mine)
  }
})

test("each draft's tier is the analyst's at the dial", async (t) => {
  for (const intelligence of ['low', 'normal', 'max']) {
    const rig = rigOf(t, script(['minimal-change', 'long-horizon']))
    await drafts(rig.ctx, argsOf({ intelligence }))
    for (const c of rig.calls) assert.deepEqual(c.tier, tierFor(loadRole('analyst').role, { intelligence }), intelligence)
  }
})

test('each draft is recorded as an approach return holding its stance', async (t) => {
  const rig = rigOf(t, script(['minimal-change', 'long-horizon']))
  const out = await drafts(rig.ctx, argsOf())
  for (const d of out.drafts) {
    const kept = JSON.parse(readFileSync(returnFile(rig.repo, d.return), 'utf8'))
    assert.equal(kept.stance, d.stance)
    assert.equal(kept.approach, draft(d.stance).approach)
    assert.ok(d.return.endsWith('-approach'))
  }
  assert.equal(returnsIn(rig.repo), 2)
})

test('the result lists each stance in order with its return and its draft', async (t) => {
  const rig = rigOf(t, script(['minimal-change', 'long-horizon']))
  const out = await drafts(rig.ctx, argsOf())
  assert.deepEqual(out.drafts.map((d) => d.stance), ['minimal-change', 'long-horizon'])
  for (const d of out.drafts) {
    assert.deepEqual(d.draft, draft(d.stance))
    assert.ok(existsSync(returnFile(rig.repo, d.return)))
  }
})

test('complete when every stance is drafted and recorded', async (t) => {
  const rig = rigOf(t, script(['minimal-change', 'long-horizon']))
  const out = await drafts(rig.ctx, argsOf())
  assert.equal(out.coverage.complete, true)
  assert.deepEqual(out.coverage.failed_channels, [])
  assert.deepEqual(out.coverage.unreached, [])
})

test('a stance whose analyst failed has no draft and is a failed channel', async (t) => {
  const rig = rigOf(t, script(['minimal-change'], { 'analyst||draft:long-horizon': [{ status: 'failed', cause: 'host_error' }] }))
  const out = await drafts(rig.ctx, argsOf())
  assert.deepEqual(out.drafts[1], { stance: 'long-horizon', return: '', draft: null })
  assert.ok(existsSync(returnFile(rig.repo, out.drafts[0].return)))
  assert.deepEqual(out.coverage.failed_channels, ['draft:long-horizon'])
  assert.ok(out.coverage.unreached.some((l) => l.includes('draft:long-horizon') && l.includes('host_error')))
  assert.equal(out.coverage.complete, false)
})

test('a draft whose record failed is a failed channel, its draft still returned', async (t) => {
  const rig = rigOf(t, script(['minimal-change']))
  t.after(blockStore(rig.repo))
  const out = await drafts(rig.ctx, argsOf({ stances: ['minimal-change'] }))
  assert.ok(statSync(evidenceReturnsDir(rig.repo)).isFile(), 'the fixture: the store stayed blocked')
  assert.deepEqual(out.drafts, [{ stance: 'minimal-change', return: '', draft: draft('minimal-change') }])
  assert.deepEqual(out.coverage.failed_channels, ['record:minimal-change'])
  assert.ok(out.coverage.unreached.some((l) => l.includes('record:minimal-change')))
  assert.equal(out.coverage.complete, false)
})

test('a draft whose record failed is recorded on relaunch', async (t) => {
  const rig = rigOf(t, script(['minimal-change']))
  const unblock = blockStore(rig.repo)
  await drafts(rig.ctx, argsOf({ stances: ['minimal-change'] }))
  unblock()
  const again = rig.relaunch({})
  const out = await drafts(again.ctx, argsOf({ stances: ['minimal-change'] }))
  assert.equal(again.calls.length, 0)
  assert.ok(existsSync(returnFile(rig.repo, out.drafts[0].return)))
  assert.equal(out.coverage.complete, true)
})

test('a stance that breaks the name rule drafts nothing', async (t) => {
  const rig = rigOf(t, {})
  const out = await drafts(rig.ctx, argsOf({ stances: ['minimal-change', 'Bad Name'] }))
  assert.equal(rig.calls.length, 0)
  assert.deepEqual(out.drafts, [])
  assert.equal(out.coverage.unreached.length, 1)
  assert.ok(out.coverage.unreached[0].includes('Bad Name'))
  assert.equal(out.coverage.complete, false)
})

test('a stance named twice is drafted once', async (t) => {
  const rig = rigOf(t, script(['minimal-change']))
  const out = await drafts(rig.ctx, argsOf({ stances: ['minimal-change', 'minimal-change'] }))
  assert.equal(rig.calls.length, 1)
  assert.deepEqual(out.drafts.map((d) => d.stance), ['minimal-change'])
  assert.equal(out.coverage.complete, true)
})

test('a blank question drafts nothing', async (t) => {
  const rig = rigOf(t, {})
  const out = await drafts(rig.ctx, argsOf({ question: '  ' }))
  assert.equal(rig.calls.length, 0)
  assert.deepEqual(out.drafts, [])
  assert.equal(out.coverage.unreached.length, 1)
  assert.equal(out.coverage.complete, false)
})

test('no stance drafts nothing', async (t) => {
  const rig = rigOf(t, {})
  const out = await drafts(rig.ctx, argsOf({ stances: [] }))
  assert.equal(rig.calls.length, 0)
  assert.deepEqual(out.drafts, [])
  assert.equal(out.coverage.unreached.length, 1)
  assert.equal(out.coverage.complete, false)
})

test('a relaunch calls nothing that returned', async (t) => {
  const rig = rigOf(t, script(['minimal-change', 'long-horizon']))
  const first = await drafts(rig.ctx, argsOf())
  const again = rig.relaunch({})
  const second = await drafts(again.ctx, argsOf())
  assert.equal(again.calls.length, 0)
  assert.deepEqual(second, first)
  assert.equal(returnsIn(rig.repo), 2)
})

test("the result's coverage carries the run's resumable", async (t) => {
  const rig = rigOf(t, script(['minimal-change', 'long-horizon']))
  const out = await drafts(rig.ctx, argsOf())
  assert.deepEqual(out.coverage.resumable, rig.ctx.resumable)
})

test("the scope is the question's digest, whatever stances are asked", () => {
  const args = argsOf()
  assert.deepEqual(scopeOf(args), { question: fnv1a(QUESTION) })
  assert.deepEqual(scopeOf(argsOf({ stances: ['adopt-dont-build'], intelligence: 'max' })), scopeOf(args))
})
