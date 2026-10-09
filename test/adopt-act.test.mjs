// test/adopt-act.test.mjs — the adopt act against real git: the records it writes in one batch,
// the branch a handover creates, the user's word it rests on, and everything it refuses without
// writing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { adopt } from '../lib/adopt.mjs'
import { adoptAct, land } from '../lib/boundary.mjs'
import { append, readLog } from '../lib/ledger.mjs'
import { resumeLeaves } from '../lib/resume.mjs'
import { branchOf, effortStateDir, git as storeGit, revParse, worktreeOf } from '../lib/store.mjs'
import { readTree, standingReview } from '../lib/tree.mjs'
import { commitIn, git, leaf, repo, root } from './harness/boundary-fixture.mjs'
import { seedTree } from './harness/seed-tree.mjs'

const BOUNDARY = fileURLToPath(new URL('../lib/boundary.mjs', import.meta.url))
const E = 'e1'
const NODES = [root(), { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] }, leaf('c/a', { locus: ['src/a.mjs'] }), leaf('c/b', { locus: ['src/b.mjs'] })]

function world(t) {
  const r = repo()
  t.after(() => rmSync(r, { recursive: true, force: true }))
  assert.equal(seedTree(r, E, NODES).ok, true)
  const base = git(r, 'rev-parse', 'HEAD')
  git(r, 'branch', branchOf(E, '.'), base)
  git(r, 'branch', branchOf(E, 'c'), base)
  const wt = worktreeOf(r, E, 'c')
  git(r, 'worktree', 'add', '-q', wt, branchOf(E, 'c'))
  const dir = mkdtempSync(join(tmpdir(), 'agentics-map-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let n = 0
  const mapFile = (doc) => {
    const path = join(dir, 'map-' + n++ + '.json')
    writeFileSync(path, JSON.stringify(doc))
    return path
  }
  return { r, base, wt, mapFile }
}
const events = (r) => readLog(r, E, 'events').entries
const statusOf = (r, id) => readTree(r, E).status.get(id).status
const handBranch = (w, name) => {
  const path = join(w.r, '.claude', 'worktrees', 'hand-' + name.replace(/\W/g, '-'))
  git(w.r, 'worktree', 'add', '-q', '-b', name, path, branchOf(E, 'c'))
  return path
}
function terminal(typed, before = () => {}) {
  const prompts = []
  const ask = async (prompt) => {
    prompts.push(prompt)
    before()
    return typed
  }
  return { opts: { env: {}, stdinIsTTY: true, ask }, prompts }
}
const nobody = () => ({ env: {}, stdinIsTTY: false, ask: async () => { throw new Error('nobody may be asked') } })
const tokenOf = (w, folder, map) => adopt(w.r, E, folder, map, 'check').token

// ---------------------------------------------------------------- what an act records

test("an act adopting straight commits records the leaf merged, by the word's giver, and resume has nothing left", (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/a.mjs': '1\n' }, 'one')
  const out = adopt(w.r, E, 'c', w.mapFile({ done: [{ node: 'c/a', commits: [one] }] }), 'act', { by: 'terminal' })
  assert.equal(out.ok, true, JSON.stringify(out))
  const merged = events(w.r).filter((e) => e.kind === 'merged')
  assert.equal(merged.length, 1)
  assert.equal(merged[0].by, 'terminal')
  assert.equal(merged[0].execution, '')
  assert.deepEqual(merged[0].commits, [one])
  assert.equal(statusOf(w.r, 'c/a'), 'merged')
  const [row] = resumeLeaves(w.r, E, '', readTree(w.r, E).nodes).filter((l) => l.id === 'c/a')
  assert.equal(row.next_action, 'none')
})

test("an act's records land in one batch: one seq each, consecutive, the act's recorded seqs", (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/a.mjs': '1\n' }, 'one')
  const two = commitIn(w.wt, { 'docs/x.md': 'x\n' }, 'two')
  const out = adopt(w.r, E, 'c', w.mapFile({ done: [{ node: 'c/a', commits: [one] }], outside: [{ commits: [two] }] }), 'act', { by: 'user' })
  assert.equal(out.ok, true, JSON.stringify(out))
  const mine = events(w.r).filter((e) => e.kind === 'merged' || e.kind === 'outside')
  assert.deepEqual(mine.map((e) => e.seq), out.recorded)
  assert.equal(out.recorded.length, 2)
  assert.equal(out.recorded[1], out.recorded[0] + 1)
})

test("an outside act records outside on the folder and voids the folder's standing review", (t) => {
  const w = world(t)
  append(w.r, E, 'events', { kind: 'claims', node: 'c', execution: '', head_sha: 'h', review: 'done', claims: [] })
  assert.notEqual(standingReview(readTree(w.r, E).nodes, events(w.r), 'c'), null)
  const stray = commitIn(w.wt, { 'docs/x.md': 'x\n' }, 'stray')
  const out = adopt(w.r, E, 'c', w.mapFile({ outside: [{ commits: [stray] }] }), 'act', { by: 'user' })
  assert.equal(out.ok, true, JSON.stringify(out))
  const outside = events(w.r).filter((e) => e.kind === 'outside')
  assert.equal(outside.length, 1)
  assert.equal(outside[0].node, 'c')
  assert.deepEqual(outside[0].commits, [stray])
  assert.equal(standingReview(readTree(w.r, E).nodes, events(w.r), 'c'), null)
})

test('a handover creates the canonical branch at the given head, notes it, and resume continues its series', (t) => {
  const w = world(t)
  const hand = handBranch(w, 'hand/b')
  const tip = commitIn(hand, { 'src/b.mjs': 'half\n' }, 'started by hand')
  const out = adopt(w.r, E, 'c', w.mapFile({ handover: [{ node: 'c/b', branch: 'hand/b' }] }), 'act', { by: 'user' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual(out.created, [branchOf(E, 'c/b')])
  assert.equal(revParse(w.r, 'refs/heads/' + branchOf(E, 'c/b')), tip)
  const noted = events(w.r).filter((e) => e.kind === 'noted' && e.node === 'c/b')
  assert.equal(noted.length, 1)
  assert.ok(noted[0].text.includes('hand/b') && noted[0].text.includes(tip), noted[0].text)
  const [row] = resumeLeaves(w.r, E, '', readTree(w.r, E).nodes).filter((l) => l.id === 'c/b')
  assert.equal(row.next_action, 'continue-series')
})

test('a handover onto a canonical branch already at its head creates nothing and still notes it', (t) => {
  const w = world(t)
  const hand = handBranch(w, 'hand/b')
  const tip = commitIn(hand, { 'src/b.mjs': 'half\n' }, 'started by hand')
  git(w.r, 'branch', branchOf(E, 'c/b'), tip)
  const out = adopt(w.r, E, 'c', w.mapFile({ handover: [{ node: 'c/b', branch: 'hand/b' }] }), 'act', { by: 'user' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual(out.created, [])
  assert.equal(events(w.r).filter((e) => e.kind === 'noted').length, 1)
})

test('an act after one killed between its branch and its records creates nothing and records once', (t) => {
  const w = world(t)
  const hand = handBranch(w, 'hand/b')
  const tip = commitIn(hand, { 'src/b.mjs': 'half\n' }, 'started by hand')
  git(w.r, 'branch', branchOf(E, 'c/b'), tip)
  const map = w.mapFile({ handover: [{ node: 'c/b', branch: 'hand/b' }] })
  assert.equal(events(w.r).filter((e) => e.kind === 'noted').length, 0, 'the killed act wrote no record')
  assert.equal(adopt(w.r, E, 'c', map, 'act', { by: 'user' }).ok, true)
  assert.equal(events(w.r).filter((e) => e.kind === 'noted').length, 1)
})

test('every record of a mixed act carries the word-giver and no execution, whatever its kind', (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/a.mjs': '1\n' }, 'one')
  const two = commitIn(w.wt, { 'docs/x.md': 'x\n' }, 'two')
  commitIn(handBranch(w, 'hand/b'), { 'src/b.mjs': 'half\n' }, 'started by hand')
  const out = adopt(w.r, E, 'c', w.mapFile({
    done: [{ node: 'c/a', commits: [one] }], outside: [{ commits: [two] }], handover: [{ node: 'c/b', branch: 'hand/b' }],
  }), 'act', { by: 'terminal' })
  assert.equal(out.ok, true, JSON.stringify(out))
  const mine = events(w.r).filter((e) => out.recorded.includes(e.seq))
  assert.deepEqual(mine.map((e) => e.kind).sort(), ['merged', 'noted', 'outside'])
  for (const e of mine) {
    assert.equal(e.by, 'terminal', e.kind)
    assert.equal(e.execution, '', e.kind)
  }
})

// ---------------------------------------------------------------- what it refuses, writing nothing

test('an act whose check refuses writes nothing and creates no branch, even when the refused entry comes last', (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/a.mjs': '1\n' }, 'one')
  const hand = handBranch(w, 'hand/b')
  commitIn(hand, { 'src/b.mjs': 'half\n' }, 'started by hand')
  const before = events(w.r).length
  const out = adopt(w.r, E, 'c', w.mapFile({
    done: [{ node: 'c/a', commits: [one] }],
    handover: [{ node: 'c/b', branch: 'hand/b' }, { node: 'c/zz', branch: 'hand/b' }],
  }), 'act', { by: 'user' })
  assert.equal(out.ok, false)
  assert.deepEqual(out.refusals.map((x) => [x.entry, x.kind]), [['handover[1]', 'unknown_node']])
  assert.equal(events(w.r).length, before)
  assert.equal(revParse(w.r, 'refs/heads/' + branchOf(E, 'c/b')), '')
})

test('a branch git refuses to create stops the act with branch_failed: what was made is named, nothing recorded', (t) => {
  const w = world(t)
  commitIn(handBranch(w, 'hand/a'), { 'src/a.mjs': 'half\n' }, 'a, started')
  commitIn(handBranch(w, 'hand/b'), { 'src/b.mjs': 'half\n' }, 'b, started')
  const map = w.mapFile({ handover: [{ node: 'c/a', branch: 'hand/a' }, { node: 'c/b', branch: 'hand/b' }] })
  const before = events(w.r).length
  const refuseB = (cwd, args, input) => (args[0] === 'branch' && args[1] === branchOf(E, 'c/b')
    ? { ok: false, status: 128, stdout: '', stderr: 'refused' } : storeGit(cwd, args, input))
  const out = adopt(w.r, E, 'c', map, 'act', { by: 'user', run: refuseB })
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'branch_failed')
  assert.deepEqual(out.created, [branchOf(E, 'c/a')])
  assert.equal(events(w.r).length, before)
  const again = adopt(w.r, E, 'c', map, 'act', { by: 'user' })
  assert.equal(again.ok, true, JSON.stringify(again))
  assert.deepEqual(again.created, [branchOf(E, 'c/b')], 'the branch made before stands at its head: not made again')
  assert.equal(events(w.r).filter((e) => e.kind === 'noted').length, 2)
})

test('an append the ledger refuses stops the act with append_failed after its branches: the next act records once', (t) => {
  const w = world(t)
  commitIn(handBranch(w, 'hand/b'), { 'src/b.mjs': 'half\n' }, 'b, started')
  const map = w.mapFile({ handover: [{ node: 'c/b', branch: 'hand/b' }] })
  const counter = join(effortStateDir(w.r, E), 'seq')
  rmSync(counter, { force: true })
  mkdirSync(counter)
  const out = adopt(w.r, E, 'c', map, 'act', { by: 'user' })
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'append_failed')
  assert.deepEqual(out.created, [branchOf(E, 'c/b')])
  assert.equal(events(w.r).filter((e) => e.kind === 'noted').length, 0)
  rmSync(counter, { recursive: true, force: true })
  const again = adopt(w.r, E, 'c', map, 'act', { by: 'user' })
  assert.equal(again.ok, true, JSON.stringify(again))
  assert.deepEqual(again.created, [])
  assert.equal(events(w.r).filter((e) => e.kind === 'noted').length, 1)
})

test("an adopted leaf reads in land's report and in resume exactly as one agentics merged", (t) => {
  const read = (by) => {
    const w = world(t)
    const one = commitIn(w.wt, { 'src/a.mjs': '1\n' }, 'one')
    if (by) assert.equal(adopt(w.r, E, 'c', w.mapFile({ done: [{ node: 'c/a', commits: [one] }] }), 'act', { by }).ok, true)
    else append(w.r, E, 'events', { kind: 'merged', node: 'c/a', execution: '20261009-120000', into: branchOf(E, 'c'), merged_sha: one, head_sha: one })
    const report = land(w.r, E, 'check')
    const [row] = resumeLeaves(w.r, E, '', readTree(w.r, E).nodes).filter((l) => l.id === 'c/a')
    return {
      open_escalations: report.open_escalations, parked: report.parked, human: report.human, root_status: report.root_status,
      root_claims: report.root_claims, next_action: row.next_action, note: row.note, status: readTree(w.r, E).status.get('c/a').status,
    }
  }
  assert.deepEqual(read('user'), read(''))
})

test('an act bound to another digest refuses head_moved', (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/a.mjs': '1\n' }, 'one')
  const before = events(w.r).length
  const out = adopt(w.r, E, 'c', w.mapFile({ done: [{ node: 'c/a', commits: [one] }] }), 'act', { by: 'user', askedDigest: '00000000' })
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'head_moved')
  assert.equal(events(w.r).length, before)
})

test('an act bound to the digest its own check named records', (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/a.mjs': '1\n' }, 'one')
  const map = w.mapFile({ done: [{ node: 'c/a', commits: [one] }] })
  const checked = adopt(w.r, E, 'c', map, 'check')
  const out = adopt(w.r, E, 'c', map, 'act', { by: 'user', askedDigest: checked.digest })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(events(w.r).filter((e) => e.kind === 'merged').length, 1)
})

test('adopting again after an act refuses and writes nothing more', (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/a.mjs': '1\n' }, 'one')
  const two = commitIn(w.wt, { 'docs/x.md': 'x\n' }, 'two')
  const map = w.mapFile({ done: [{ node: 'c/a', commits: [one] }], outside: [{ commits: [two] }] })
  assert.equal(adopt(w.r, E, 'c', map, 'act', { by: 'user' }).ok, true)
  const after = events(w.r).length
  const again = adopt(w.r, E, 'c', map, 'act', { by: 'user' })
  assert.equal(again.ok, false)
  assert.deepEqual(again.refusals.map((x) => x.kind).sort(), ['already_merged', 'claimed_twice'])
  assert.equal(events(w.r).length, after)
})

test('a leaf agentics merged is not adopted', (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/a.mjs': '1\n' }, 'one')
  append(w.r, E, 'events', { kind: 'merged', node: 'c/a', execution: '20261009-120000', into: branchOf(E, 'c'), merged_sha: one, head_sha: one })
  const before = events(w.r).length
  const out = adopt(w.r, E, 'c', w.mapFile({ done: [{ node: 'c/a', commits: [one] }] }), 'act', { by: 'user' })
  assert.deepEqual(out.refusals.map((x) => x.kind), ['already_merged'])
  assert.equal(events(w.r).length, before)
})

// ---------------------------------------------------------------- the user's word

test('adoptAct records on the token typed back, by: terminal', async (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/a.mjs': '1\n' }, 'one')
  const map = w.mapFile({ done: [{ node: 'c/a', commits: [one] }] })
  const token = tokenOf(w, 'c', map)
  const { opts, prompts } = terminal(token)
  const out = await adoptAct(w.r, E, 'c', map, opts)
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(prompts.length, 1)
  assert.ok(prompts[0].includes(token), prompts[0])
  assert.equal(events(w.r).find((e) => e.kind === 'merged').by, 'terminal')
})

test('adoptAct puts the word-giver on every record of a handover too, and creates its branch', async (t) => {
  const w = world(t)
  const tip = commitIn(handBranch(w, 'hand/b'), { 'src/b.mjs': 'half\n' }, 'started by hand')
  const map = w.mapFile({ handover: [{ node: 'c/b', branch: 'hand/b' }] })
  const out = await adoptAct(w.r, E, 'c', map, terminal(tokenOf(w, 'c', map)).opts)
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(revParse(w.r, 'refs/heads/' + branchOf(E, 'c/b')), tip)
  assert.deepEqual(events(w.r).filter((e) => e.kind === 'noted').map((e) => e.by), ['terminal'])
})

test('adoptAct refuses a word that is not the token, and anyone who cannot give one, writing nothing', async (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/a.mjs': '1\n' }, 'one')
  const map = w.mapFile({ done: [{ node: 'c/a', commits: [one] }] })
  const before = events(w.r).length
  const wrong = await adoptAct(w.r, E, 'c', map, terminal('adopt c@00000000').opts)
  assert.equal(wrong.error.kind, 'not_approved')
  const none = await adoptAct(w.r, E, 'c', map, nobody())
  assert.equal(none.error.kind, 'answer_unverifiable')
  assert.equal(events(w.r).length, before)
})

test('a refused word creates no branch for a handover either', async (t) => {
  const w = world(t)
  commitIn(handBranch(w, 'hand/b'), { 'src/b.mjs': 'half\n' }, 'started by hand')
  const map = w.mapFile({ handover: [{ node: 'c/b', branch: 'hand/b' }] })
  const out = await adoptAct(w.r, E, 'c', map, terminal('no').opts)
  assert.equal(out.ok, false)
  assert.equal(revParse(w.r, 'refs/heads/' + branchOf(E, 'c/b')), '')
  assert.equal(events(w.r).filter((e) => e.kind === 'noted').length, 0)
})

test('adoptAct never asks about a mapping its check refuses', async (t) => {
  const w = world(t)
  const { opts, prompts } = terminal('anything')
  const out = await adoptAct(w.r, E, 'c', w.mapFile({ outside: [{ commits: ['deadbeefdeadbeef'] }] }), opts)
  assert.equal(out.ok, false)
  assert.equal(prompts.length, 0)
})

test('a folder branch that moved while the word was asked refuses head_moved and writes nothing', async (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/a.mjs': '1\n' }, 'one')
  const map = w.mapFile({ done: [{ node: 'c/a', commits: [one] }] })
  const before = events(w.r).length
  const { opts } = terminal(tokenOf(w, 'c', map), () => commitIn(w.wt, { 'docs/later.md': 'l\n' }, 'later'))
  const out = await adoptAct(w.r, E, 'c', map, opts)
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'head_moved')
  assert.equal(events(w.r).length, before)
})

test('a map file gone by the act refuses and writes nothing', async (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/a.mjs': '1\n' }, 'one')
  const map = w.mapFile({ done: [{ node: 'c/a', commits: [one] }] })
  const before = events(w.r).length
  const out = await adoptAct(w.r, E, 'c', map, terminal(tokenOf(w, 'c', map), () => rmSync(map)).opts)
  assert.equal(out.ok, false)
  assert.equal(events(w.r).length, before)
})

test('a source branch deleted after the check refuses unknown_branch and writes nothing', async (t) => {
  const w = world(t)
  const hand = handBranch(w, 'hand/b')
  commitIn(hand, { 'src/b.mjs': 'half\n' }, 'started by hand')
  const map = w.mapFile({ handover: [{ node: 'c/b', branch: 'hand/b' }] })
  const before = events(w.r).length
  const gone = () => {
    git(w.r, 'worktree', 'remove', '--force', hand)
    git(w.r, 'branch', '-D', 'hand/b')
  }
  const out = await adoptAct(w.r, E, 'c', map, terminal(tokenOf(w, 'c', map), gone).opts)
  assert.equal(out.ok, false)
  assert.deepEqual(out.refusals.map((x) => x.kind), ['unknown_branch'])
  assert.equal(revParse(w.r, 'refs/heads/' + branchOf(E, 'c/b')), '')
  assert.equal(events(w.r).length, before)
})

// ---------------------------------------------------------------- the CLI

test('the adopt verb checks through the CLI: one JSON object, exit 0, and refuses a flag it does not take', (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/a.mjs': '1\n' }, 'one')
  const map = w.mapFile({ done: [{ node: 'c/a', commits: [one] }] })
  const run = (...args) => spawnSync(process.execPath, [BOUNDARY, 'adopt', ...args], { encoding: 'utf8' })
  const ok = run('--repo', w.r, '--effort', E, '--folder', 'c', '--map-file', map, '--action', 'check')
  assert.equal(ok.status, 0, ok.stderr)
  const printed = JSON.parse(ok.stdout)
  assert.equal(printed.ok, true)
  assert.match(printed.token, /^adopt c@[0-9a-f]{8}$/)
  const bad = run('--repo', w.r, '--effort', E, '--folder', 'c', '--map-file', map, '--action', 'check', '--execution', 'x')
  assert.equal(bad.status, 0)
  assert.equal(JSON.parse(bad.stdout).error.kind, 'bad_arg')
  const missing = run('--repo', w.r, '--effort', E, '--folder', 'c', '--map-file', join(w.r, 'no-such.json'), '--action', 'check')
  assert.equal(missing.status, 0)
  assert.equal(JSON.parse(missing.stdout).error.kind, 'unknown_file')
})

test('the adopt verb with --action act and nobody to give the word writes nothing', (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/a.mjs': '1\n' }, 'one')
  const map = w.mapFile({ done: [{ node: 'c/a', commits: [one] }] })
  const before = events(w.r).length
  const env = { ...process.env }
  delete env.CLAUDE_CODE_SESSION_ID
  const out = spawnSync(process.execPath, [BOUNDARY, 'adopt', '--repo', w.r, '--effort', E, '--folder', 'c', '--map-file', map, '--action', 'act'],
    { encoding: 'utf8', env, input: '', timeout: 30_000 })
  assert.equal(out.status, 0, out.stderr)
  const printed = JSON.parse(out.stdout)
  assert.equal(printed.ok, false)
  assert.equal(events(w.r).length, before)
})
