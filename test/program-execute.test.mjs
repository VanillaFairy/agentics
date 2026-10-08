// test/program-execute.test.mjs — pins the execute program (lib/programs/execute.mjs) end to end:
// its arguments, scope and home, started through lib/run.mjs or called directly over the execution
// rig (real git, the real measurement, a scripted runner).
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
//   the tick loop independent leaves end to end, dependencies (a leaf, a composite), a tdd-pair
//                 cycle merged in one batch, escalations that block dependents and never siblings,
//                 a park that stops its own leaf, a folder the user wrote with nothing beneath it,
//                 faults that hold a leaf without crowding out the pool, a leaf held by a locus, a
//                 leaf that finds no slot, pause, the budget, a stop carried and a stop answered
//                 while the run goes on
//   integration   a leaf failing alone on the merged head gets its fix round, a resumed approval
//                 merges the head it approved, a lost review, a checkout fault and a rejecting
//                 unit hold their node; drift is ruled before its consumer starts, and a consumer
//                 ruled affected under a folder the user wrote parks needs_respec
//   replans       a moved base is ruled before any leaf runs; an affected ruling goes to the
//                 planner (a decision parks the folder, an unchanged leaf escalates, a fault holds
//                 the asking leaf); a leaf's request goes to its planner folder with its slot given
//                 back; a stale ruler that rejects holds its leaves
//   relaunches    a run killed between a return and its close, or while a reviewer's host stop is
//                 waited out, resumes where it stood and lands nothing twice
//   the dial      every unit is tiered from the envelope's dial; a fresh execution's dial is the
//                 argument
//
// Every claim is read from the records (`executionLog(...).entries()`, `readTree(...).status`), the
// result and the calls the runner received. Expected values are computed: heads with `git
// rev-parse`, sessions with `sessionOf`, stamps with `stampNow`, tiers with `producerTier` and
// `tierFor`. Where the contract leaves a value open (a note's wording beyond its named start, a
// park's question beyond what the ruler gave) nothing here pins it.
//
// Design: docs/DESIGN.md#execution, docs/DESIGN.md#scheduling, docs/DESIGN.md#landing-and-drift,
// docs/DESIGN.md#resume-and-checkpoints, docs/DESIGN.md#coverage-block, docs/DESIGN.md#program-results.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { land } from '../lib/boundary.mjs'
import { STANDING_AXES } from '../lib/briefs/probe.mjs'
import { renderMessage } from '../lib/conversation.mjs'
import { sectionsOf, unitsOf } from '../lib/evidence.mjs'
import { ensureLeaf } from '../lib/integration.mjs'
import { append, executionLog, readLog } from '../lib/ledger.mjs'
import { acquire, heldBy, releaseSlots } from '../lib/locks.mjs'
import { programContext } from '../lib/programs/common.mjs'
import { ARGS, execute, homeOf, scopeOf } from '../lib/programs/execute.mjs'
import { loadRole, producerTier, tierFor } from '../lib/roles.mjs'
import { PROGRAM_NAMES, launch } from '../lib/run.mjs'
import {
  closePath, configPath, dispatchKey, executionDir, executionRunId, executionsRoot, resultPath, returnPath,
  runJsonPath, runsDir, sessionOf, specPath, stampNow, writeJson,
} from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { executionRig } from './harness/program-rig.mjs'
import { scriptedRunner } from './harness/scripted-runner.mjs'

// leaf-close, merge-batch and the suite gate measure through `node --test` grandchildren, which
// refuse to run under the test runner's marker; the rig does not clear it.
delete process.env.NODE_TEST_CONTEXT

const T = { timeout: 300_000 }
const E = 'e1'
const NOW_ISO = '2026-01-01T00:00:00.000Z'
const CLOCK = () => new Date(NOW_ISO)
/** A sleep that yields to the timers: the rig's resolves at once and would starve a measurement's child of its exit. */
const YIELD = () => new Promise((r) => setTimeout(r, 10))
const NEVER = () => new Promise(() => {})

// ------------------------------------------------------------------ the specs

const CHECK_MJS = "import { readFileSync } from 'node:fs'\nlet ok = false\n" +
  "try { ok = readFileSync('src/' + process.argv.slice(2).join('/') + '.txt', 'utf8').trim() === 'ok' } catch {}\nprocess.exit(ok ? 0 : 1)\n"
const FILES = { 'check.mjs': CHECK_MJS, 'pass.mjs': '' }

/** One Plan entry: a leaf whose check reads `src/<words joined by '/'>.txt`; `words` default to its name. */
function leafEntry(name, { realises = 'D1', after = '', provides = '', consumes = '', rigor = 'trivial', role = '', locus, words, check } = {}) {
  const parts = words ?? [name]
  const paths = locus ?? ['src/' + parts.join('/') + '.txt']
  const cmd = check ?? 'node check.mjs ' + parts.join(' ')
  const fields = [
    'task', 'realises: ' + realises, ...(after ? ['after: ' + after] : []), ...(provides ? ['provides: ' + provides] : []),
    ...(consumes ? ['consumes: ' + consumes] : []), 'rigor: ' + rigor, ...(role ? ['role: ' + role] : []),
    ...(paths.length ? ['locus: ' + paths.join(', ')] : []),
  ]
  return ['- **' + name + '** — ' + fields.join(' · '), '  Make ' + name, '  - [ ] ' + name + ' says ok — check: `' + cmd + '`', '']
}

/** One Plan entry for a sub-effort; a planner's carries its ground and realises nothing of its own. */
const subEffort = (name, { realises = 'D1', after = '', planner = false } = {}) => [
  '- **' + name + '** — sub-effort' + (planner ? ' · author: planner · ground: src' : ' · realises: ' + realises) + (after ? ' · after: ' + after : ''),
  '  Folder ' + name, '',
]

/** A spec text: the six sections, the Decisions rows given ([id, text]) and the Plan entries (arrays of lines). */
function specText(entries, { decisions = [['D1', 'The leaves run.']], title = 'Execute program' } = {}) {
  return [
    '# ' + title, '', '## Intent', '', 'Leaves under test.', '',
    '## Decisions', '', '| id | decision | why |', '|---|---|---|',
    ...decisions.map(([id, text]) => `| ${id} | ${text} | The program needs it. |`), '',
    '## Design', '', 'Files under src.', '',
    '## Plan', '', ...entries.flat(),
    '## Open questions', '', '## Evidence', '', 'None yet.', '',
  ].join('\n')
}
const flatRoot = (...names) => specText(names.map((n) => leafEntry(n)))
/** A sub-folder the user wrote: its own decision, its leaves realising the root's D2 as well as c.D1. */
const subSpec = (entries) => specText(entries, { decisions: [['c.D1', 'c holds.']], title: 'Folder c' })
/** A planner folder's spec: no decision of its own, its leaves realise the root's D1. */
const plannerSpec = (...entries) => specText(entries, { decisions: [], title: 'Build p' })

// ------------------------------------------------------------------ scripted steps

const done = (text = 'did the work', usage = null, cost = null) => ({
  output: { status: 'done', text, concerns: [] }, ...(usage ? { usage } : {}), ...(cost === null ? {} : { cost_total: cost }),
})
const said = (status, text = 'the producer says so') => ({ output: { status, text } })
const failed = (cause) => ({ status: 'failed', cause })
const stopped = () => ({ status: 'stopped', cause: 'rate_limit' })

const ruling = (node, kind, why = 'because ' + node, question = '') => ({ node, ruling: kind, why, question: kind === 'affected' ? (question || 'Does ' + node + ' still hold?') : question })
const rulings = (...list) => ({ output: { rulings: list } })
const REVIEW_EMPTY = { units: [], findings: [], fix_rulings: [], claims: [], notes: '' }
const claim = (text) => ({ claim: text, ruling: 'met', evidence: 'src/x.mjs:1' })
const reviewed = (...claims) => ({ output: { ...REVIEW_EMPTY, claims } })
/** A leaf reviewer's return that rules every unit a world here can produce clean. */
const UNITS = ['criterion:1', 'file:test/r.test.mjs', 'file:src/r.mjs']
const verdict = () => ({ output: { ...REVIEW_EMPTY, units: UNITS.map((unit) => ({ unit, ruling: 'clean', why: 'read it' })) } })

/** The scripted runner looks a step list up as `script[role|node|thread]`; this reads several scripts and prefixes. */
const script = (...parts) => new Proxy({}, {
  get(_, key) {
    for (const part of parts) {
      const v = part[key]
      if (v !== undefined) return v
    }
    return undefined
  },
})
/** Steps for every key starting with `prefix` (a computed thread name). */
const byPrefix = (prefix, ...steps) => new Proxy({}, { get: (_, key) => (String(key).startsWith(prefix) ? steps : undefined) })
const driftRuler = (...steps) => byPrefix('ruler|.|ruler:drift:', ...steps)
const staleRuler = (head, ...steps) => ({ ['ruler|.|ruler:stale:' + head]: steps })
const rootReview = (n = 1, ...claims) => ({ ['reviewer|.|integration:.:' + n]: [reviewed(...(claims.length ? claims : [claim('the leaves are there')]))] })
const IMPL = (id) => `implementer|${id}|producer:${id}`
const REVIEWER = (id, n = 1) => `reviewer|${id}|reviewer:${id}:${n}`

// ------------------------------------------------------------------ the world

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim()

function write(cwd, files) {
  for (const [path, text] of Object.entries(files)) {
    const full = join(cwd, ...path.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
}

/** Write `files` in `cwd` and commit them; the new head. */
function work(cwd, files, subject = 'work') {
  write(cwd, files)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', subject)
  return git(cwd, 'rev-parse', 'HEAD')
}

/** Wait for `pred` by the clock; rejects after two minutes. */
async function until(pred, label, ms = 120_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await pred()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('never reached: ' + label)
}

/** A promise a test awaits and a hung run resolves: the signal that a run reached the point it is killed at. */
function signal() {
  let hit
  const reached = new Promise((resolveIt) => { hit = resolveIt })
  return { reached, hit }
}

const ARGS0 = {
  effort: E, folder: '.', intelligence: 'normal', pace: 'balanced', plan_only: false, pause: false, budget: 0, confirmed: 0,
  base_ref: '', commands_file: '',
}

/**
 * A world: the execution rig over the specs given, and the test's plays. `jobs[<role>|<node>#<round>]`
 * is what a producer's round does to its worktree (a function `(cwd, call)` or a files object):
 * an implementer's files are committed, a test author's only written, and an implementer's first
 * round with no job commits `src/<name>.txt` reading ok. `before(call)` and `after(call, out)` hooks
 * run around the scripted call; `calls` is every call the runner received, in order.
 */
function world(t, { spec, leaves, files = {}, commands, config } = {}) {
  const text = spec ?? flatRoot(...(leaves ?? ['a']))
  const rig = executionRig(t, { spec: text, files: { ...FILES, ...files }, ...(commands ? { commands } : {}) })
  if (config) writeJson(configPath(rig.repo), config)
  const w = { rig, calls: [], sleeps: [], ran: new Set(), jobs: {}, steps: {}, before: [], after: [], earlier: [] }

  w.script = (...parts) => { w.steps = script(...parts); w.rig.script(w.steps) }
  w.agent = (inner) => async (call) => {
    w.calls.push(call)
    if (!w.ran.has(call.dispatch)) {
      w.ran.add(call.dispatch)
      await play(w, call)
    }
    for (const hook of w.before) await hook(call)
    const out = await inner(call)
    for (const hook of w.after) await hook(call, out)
    return out
  }
  /** A direct leg: the program context over the current rig, its sleep and runner wrapped. */
  w.leg = ({ sleep = YIELD } = {}) => {
    const ctx = programContext({
      ...w.rig.ctx,
      sleep: (ms) => { w.sleeps.push(ms); return sleep(ms) },
      runAgent: w.agent(w.rig.ctx.runAgent),
    })
    return { ctx, run: (args = {}) => execute(ctx, { ...ARGS0, ...args }) }
  }
  w.run = (args = {}, over = {}) => w.leg(over).run(args)
  w.relaunch = () => {
    w.earlier.push(...w.calls)
    w.calls = []
    w.rig = w.rig.relaunch()
  }
  /** A start through lib/run.mjs: the CLI as the session runs it, on this world's runner. */
  w.start = (argv, over = {}) => launch({
    argv: ['execute', ...argv], cwd: w.rig.repo, env: {}, now: CLOCK, heartbeatMs: 50,
    runner: (o) => w.agent(scriptedRunner(w.steps, { log: o.log, now: () => NOW_ISO }).runAgent),
    spawnChild: () => { throw new Error('this test starts no child') },
    ...over,
  })
  return w
}

/** What a producer's round does to its worktree, before the scripted call returns. */
async function play(w, call) {
  const key = `${call.role.name}|${call.node}#${call.round}`
  const job = w.jobs[key]
  if (job !== undefined) {
    if (typeof job === 'function') return job(call.cwd, call)
    return call.role.name === 'implementer' ? work(call.cwd, job, 'round ' + call.round + ' of ' + call.node) : write(call.cwd, job)
  }
  if (call.role.name === 'implementer' && call.round === 1 && /^producer:/.test(call.thread.key)) {
    return work(call.cwd, { ['src/' + call.node.split('/').pop() + '.txt']: 'ok\n' }, 'make ' + call.node)
  }
  return undefined
}

// ------------------------------------------------------------------ reading the records

const entriesOf = (rig, stamp = rig.stamp) => executionLog(rig.repo, E, stamp).entries()
const kinds = (rig, kind, node, stamp) => entriesOf(rig, stamp).filter((e) => e.kind === kind && (node === undefined || e.node === node))
const stateOf = (rig, stamp = rig.stamp) => readLog(rig.repo, E, 'state:' + stamp).entries
const statusOf = (rig, id) => (readTree(rig.repo, E).status.get(id) || {}).status
const callsOf = (w, role, node) => w.calls.filter((c) => c.role.name === role && (node === undefined || c.node === node))
/** The calls of a role on a node, one per dispatch (a host stop calls the same dispatch again), first start first. */
const startsOf = (w, role, node) => [...new Map(callsOf(w, role, node).map((c) => [c.dispatch, c])).values()]
const dispatchedOf = (rig, node, role = 'implementer') => kinds(rig, 'dispatched', node).filter((e) => e.role === role)
const producerKey = (node, round = 1, role = 'implementer') => dispatchKey({ node, role, thread: 'producer:' + node, round })
const rootHead = (rig) => rig.git('rev-parse', 'refs/heads/' + rig.branchOf('.'))
const same = (a, b) => String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase()
const isAncestor = (rig, ancestor, of) => {
  try {
    git(rig.repo, 'merge-base', '--is-ancestor', ancestor, of)
    return true
  } catch {
    return false
  }
}
const seqOfFirst = (list) => (list.length ? Math.min(...list.map((e) => e.seq)) : Infinity)
const byId = (a, b) => (a.id < b.id ? -1 : 1)
/** The result's implemented entries as `[id, rigor, role, rounds, review_rounds, at_integration, salvaged]`. */
const implementedOf = (res) => [...res.implemented].sort(byId).map((i) => [i.id, i.rigor, i.role, i.rounds, i.review_rounds, i.at_integration, i.salvaged])
const idsOf = (list) => list.map((x) => x.id).sort()

/** A file holding the session's commands, under `.claude/` of the rig's repository. */
function commandsFile(rig, name = 'commands.json') {
  const file = join(rig.repo, '.claude', name)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(rig.envelope.commands))
  return file
}

/** A commit on `main` touching `file`, after the rig was built: the user's base moved. */
function moveBase(rig, file, text = 'moved\n') {
  work(rig.repo, { [file]: text }, 'the user moves the base')
  return rig.git('rev-parse', 'main')
}

/** Every claim of coverage a finished, whole execution makes. */
function assertComplete(res, label = 'the execution') {
  assert.equal(res.coverage.complete, true, label + ' is complete: ' + JSON.stringify(res.coverage.unreached))
  assert.deepEqual(res.coverage.unreached, [])
  assert.deepEqual(res.coverage.failed_channels, [])
}

/** The planner folder world: the root holds `p` (planner-written, ground known) and the leaf `q`; `p` holds the leaf `x`. */
function plannerWorld(t, over = {}) {
  return world(t, {
    spec: {
      '.': specText([subEffort('p', { planner: true }), leafEntry('q')]),
      p: plannerSpec(leafEntry('x')),
    },
    ...over,
  })
}

// A planner's write is played in the runAgent wrapper by writing p's spec; its probe round is scripted as test/execute-folder.test.mjs scripts it.
const putSpec = (rig, folder, text) => {
  mkdirSync(dirname(specPath(rig.repo, E, folder)), { recursive: true })
  writeFileSync(specPath(rig.repo, E, folder), text)
}
const STANDING = STANDING_AXES.map((a) => a.key)
const located = () => ({ hits: [], searched: ['the repository'], no_match: '', not_reached: '', stop_reason: 'exhausted' })
const cleanProber = (units) => ({
  findings: [], units: units.map((unit) => ({ unit, ruling: 'clean', ids: [], why: 'why ' + unit })), notes: '', stop_reason: 'exhausted', not_reached: '',
})
/** Probe round `n` over `text` for folder `p`: a located return with no hits, and one prober that rules every unit clean. */
const probing = (n, text) => ({
  ['scout||probe:p:' + n + '/locate']: [{ output: located() }],
  ['analyst||probe:p:' + n + '/prober:1']: [{ output: cleanProber(unitsOf(STANDING, sectionsOf(text))) }],
})
const PLANNER = 'planner|p|planner:p'

/**
 * The drift world: `p` provides `api (src/api/)` and merged before the run, `q` writes under src/api/
 * without providing it, `s` is a sibling, `c` (after p and q) consumes `api`.
 */
function driftWorld(t, over = {}) {
  const w = world(t, {
    spec: specText([
      leafEntry('p', { provides: 'api (src/api/)', words: ['api', 'p'] }),
      leafEntry('q', { words: ['api', 'q'] }),
      leafEntry('s'),
      leafEntry('c', { after: 'p, q', consumes: 'api' }),
    ]),
    ...over,
  })
  const wt = w.rig.worktreeOf('.')
  const sha = work(wt, { 'src/api/p.txt': 'ok\n' }, 'Add p')
  w.rig.log.append('merged', { node: 'p', into: w.rig.branchOf('.'), merged_sha: sha, head_sha: sha })
  w.jobs['implementer|q#1'] = { 'src/api/q.txt': 'ok\n' }
  return w
}

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

const chainSpec = (...names) => specText(names.map((n, i) => leafEntry(n, i ? { after: names[i - 1] } : {})))

/** The root `.`, a user-written folder `c` with the leaf `k`, and the leaf `y`; `after` makes `c` wait for `y`. */
const folderSpecs = ({ after = '' } = {}) => ({
  '.': specText([leafEntry('y', { realises: 'D1' }), subEffort('c', { realises: 'D2', after })], { decisions: [['D1', 'y is there.'], ['D2', 'c is there.']] }),
  c: subSpec([leafEntry('k', { realises: 'D2, c.D1' })]),
})
const C_REVIEW = { 'reviewer|c|integration:c:1': [reviewed(claim('c.D1 holds'))] }

const R_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { r } from '../src/r.mjs'\ntest('doubles 2', () => assert.equal(r(2), 4))\n"
const R_SRC = 'export const r = (x) => x * 2\n'
const ADD_OK = 'export const add = (a, b) => a + b\n'
const ADD_BAD = 'export const add = (a, b) => a - b\n'

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

  test("a detached start prints the execution's run, log and result file, and its child runs there", T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    const { rig } = w
    w.script({ [IMPL('a')]: [done()] }, rootReview(1, claim('D1 holds')))
    const seen = []
    const out = await w.start(['--effort', E, '--detach'], { spawnChild: (o) => { seen.push(o); return process.pid } })

    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(out.run, rig.run)
    assert.equal(out.pid, process.pid)
    assert.ok(same(out.log, join(rig.dir, 'run.log')))
    assert.ok(same(out.result_file, join(rig.dir, 'result.json')))
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0].args, ['execute', '--effort', E, '--child', out.run])
    assert.equal(w.calls.length, 0, 'nothing runs before the child')

    const child = await w.start(seen[0].args.slice(1))
    assert.equal(child.ok, true, JSON.stringify(child))
    assert.equal(child.run, out.run, 'the child runs in the same home')
    assert.equal(child.result.execution, rig.stamp)
    assertComplete(child.result, 'the child\'s execution')
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

  // ------------------------------------------------------------------ the tick loop

  test('two independent leaves run end to end: approved at integration, merged, the root reviewed and integrated, the execution closed, its land check clean', T, async (t) => {
    const w = world(t, { leaves: ['a', 'b'] })
    const { rig } = w
    w.script({ [IMPL('a')]: [done()], [IMPL('b')]: [done()] }, rootReview(1, claim('D1 holds')))
    const res = await w.run()

    assert.deepEqual(implementedOf(res), [['a', 'trivial', 'none', 1, 0, true, false], ['b', 'trivial', 'none', 1, 0, true, false]])
    assert.equal(statusOf(rig, 'a'), 'merged')
    assert.equal(statusOf(rig, 'b'), 'merged')
    const reviewers = callsOf(w, 'reviewer')
    assert.equal(reviewers.length, 1, 'one reviewer call')
    assert.equal(reviewers[0].node, '.')
    assert.equal(reviewers[0].thread.key, 'integration:.:1')
    assert.deepEqual(res.integration, { branch: rig.branchOf('.'), head_sha: rootHead(rig), reviews: [{ target: '.', said: reviewers[0].dispatch }] })
    assert.equal(statusOf(rig, '.'), 'integrated')
    assert.deepEqual(stateOf(rig).filter((e) => e.kind === 'closed').map((e) => e.status), ['done'], 'one closed {status: done}')
    assert.deepEqual([res.effort, res.root, res.execution, res.checkpoint, res.nodes_n], [E, '.', rig.stamp, null, 3])
    for (const list of ['escalations', 'parked', 'faults', 'blocked', 'drift']) assert.deepEqual(res[list], [], list)
    assert.equal(res.stopped, '')
    const remaining = ['a', 'b'].filter((id) => git(rig.repo, 'branch', '--list', rig.branchOf(id)) !== '')
    assert.deepEqual(remaining, ['a', 'b'], 'the fixture: both merged branches remain')
    assert.equal(res.cleanup_n, remaining.length)
    assertComplete(res)
    assert.deepEqual(res.coverage.incomplete, [])
    const check = land(rig.repo, E, 'check')
    assert.equal(check.ok, true, JSON.stringify(check.error))
    assert.equal(check.root_status, 'integrated')
    assert.deepEqual(check.open_escalations, [])
    assert.deepEqual(check.parked, [])
  })

  test('a dependency opens only after its provider merged', T, async (t) => {
    const w = world(t, { spec: chainSpec('a', 'b') })
    w.script({ [IMPL('a')]: [done()], [IMPL('b')]: [done()] }, rootReview(1, claim('D1 holds')))
    const res = await w.run()

    const mergedA = kinds(w.rig, 'merged', 'a')
    assert.equal(mergedA.length, 1)
    assert.ok(seqOfFirst(dispatchedOf(w.rig, 'b')) > mergedA[0].seq, 'b opened after a merged')
    assert.equal(statusOf(w.rig, 'b'), 'merged')
    assertComplete(res)
  })

  test('a dependency on a composite binds every leaf beneath it', T, async (t) => {
    const w = world(t, { spec: folderSpecs({ after: 'y' }) })
    w.script({ [IMPL('y')]: [done()], [IMPL('c/k')]: [done()] }, C_REVIEW, rootReview(1, claim('D1 holds'), claim('D2 holds')))
    const res = await w.run()

    const mergedY = kinds(w.rig, 'merged', 'y')
    assert.equal(mergedY.length, 1)
    const opened = dispatchedOf(w.rig, 'c/k')
    assert.equal(opened.length, 1)
    assert.ok(opened[0].seq > mergedY[0].seq, 'c/k opened after y merged')
    assertComplete(res)
  })

  test('a tdd-pair cycle: the red held on its approval, the green cut from it, the pair merged in one batch', T, async (t) => {
    const w = world(t, {
      spec: specText([
        leafEntry('r', { rigor: 'tdd-pair', role: 'red', locus: ['test/r.test.mjs'], check: 'node pass.mjs' }),
        leafEntry('g', { rigor: 'tdd-pair', role: 'green', after: 'r', locus: ['src/r.mjs'], check: 'node pass.mjs' }),
      ]),
    })
    const { rig } = w
    w.jobs['test-author|r#1'] = { 'test/r.test.mjs': R_TEST }
    w.jobs['implementer|g#1'] = { 'src/r.mjs': R_SRC }
    w.script({
      'test-author|r|producer:r': [done('red')], [REVIEWER('r')]: [verdict()],
      [IMPL('g')]: [done()], [REVIEWER('g')]: [verdict()],
    }, rootReview(1, claim('D1 holds')))
    const res = await w.run()

    const batches = kinds(rig, 'batch-started')
    assert.equal(batches.length, 1, 'one batch')
    assert.deepEqual(batches[0].children, ['r', 'g'])
    const merged = ['r', 'g'].map((id) => kinds(rig, 'merged', id))
    assert.deepEqual(merged.map((m) => m.length), [1, 1])
    assert.equal(merged[0][0].merged_sha, merged[1][0].merged_sha, 'both merged events share one merged_sha')
    const approvedG = kinds(rig, 'approved', 'g')
    const approvedR = kinds(rig, 'approved', 'r')
    assert.ok(merged[0][0].seq > approvedG[0].seq, 'the red merged after the green was approved')
    assert.ok(isAncestor(rig, approvedR[0].head_sha, approvedG[0].head_sha), 'the green was cut from the red\'s approved head')
    const [green] = startsOf(w, 'implementer', 'g')
    assert.ok(same(resolve(green.cwd), resolve(rig.worktreeOf('g'))), 'the green\'s call ran in g\'s worktree')
    const pairs = res.implemented.map((i) => [i.id, i.role, i.rounds, i.at_integration]).sort((a, b) => (a[0] < b[0] ? -1 : 1))
    assert.deepEqual(pairs, [['g', 'green', 1, false], ['r', 'red', 1, false]])
    assertComplete(res)
  })

  test('an escalation blocks its dependents, never its siblings, and a park stops only its own leaf', T, async (t) => {
    const w = world(t, { spec: specText([leafEntry('a'), leafEntry('b', { after: 'a' }), leafEntry('c'), leafEntry('d')]) })
    const { rig } = w
    w.script({ [IMPL('a')]: [said('blocked', 'a is stuck')], [IMPL('c')]: [said('needs_decision', 'which of the two?')], [IMPL('d')]: [done()] })
    const res = await w.run()

    assert.deepEqual(res.escalations, [{ id: 'a', reason: 'blocked', said: producerKey('a') }])
    assert.deepEqual(res.blocked, [{ blocked_by: 'a', leaves_n: 1 }])
    assert.equal(dispatchedOf(rig, 'b').length, 0, 'b never dispatched')
    assert.equal(callsOf(w, 'implementer', 'b').length, 0)
    assert.equal(statusOf(rig, 'd'), 'merged', 'the sibling merged')
    assert.deepEqual(idsOf(res.implemented), ['d'], 'and is the only one implemented')
    assert.deepEqual(res.parked, [{ id: 'c', return: 'needs_decision', said: producerKey('c') }])
    const lines = res.coverage.unreached
    const at = (line) => lines.indexOf(line)
    assert.ok(at('a: escalated — blocked') >= 0, JSON.stringify(lines))
    assert.ok(at('c: parked — needs_decision') >= 0, JSON.stringify(lines))
    assert.ok(at('1 leaf/leaves blocked — a did not land') >= 0, JSON.stringify(lines))
    assert.ok(at('a: escalated — blocked') < at('c: parked — needs_decision'), 'escalations lead the parks')
    assert.ok(at('c: parked — needs_decision') < at('1 leaf/leaves blocked — a did not land'), 'and the parks lead the blocked count')
    assert.ok(lines.findIndex((l) => /^\d+ of 4 leaves not merged/.test(l)) > at('1 leaf/leaves blocked — a did not land'), 'then the leaves not merged')
    assert.equal(res.coverage.complete, false)
  })

  test('a childless folder the user wrote parks needs_design and no planner runs', T, async (t) => {
    const w = world(t, {
      spec: specText([leafEntry('y'), subEffort('c', { realises: 'D2' })], { decisions: [['D1', 'y is there.'], ['D2', 'c is there.']] }),
    })
    w.script({ [IMPL('y')]: [done()] })
    const res = await w.run()

    const c = res.parked.find((p) => p.id === 'c')
    assert.ok(c, JSON.stringify(res.parked))
    assert.equal(c.return, 'needs_design')
    assert.equal(callsOf(w, 'planner').length, 0, 'no planner call')
    assert.deepEqual(w.calls.map((x) => x.role.name), ['implementer'], 'the leaf beside it is the only call')
    assert.equal(statusOf(w.rig, 'y'), 'merged')
    assert.equal(res.coverage.complete, false)
  })

  test('leaves held on faults never crowd out the pool', T, async (t) => {
    const w = world(t, { leaves: ['a', 'b', 'c', 'd'], config: { max_parallel: 2 } })
    w.script({ [IMPL('a')]: [failed('host_error')], [IMPL('b')]: [failed('host_error')], [IMPL('c')]: [done()], [IMPL('d')]: [done()] })
    const res = await w.run()

    assert.deepEqual(res.faults.map((f) => [f.id, f.channel]).sort(), [['a', 'host_error'], ['b', 'host_error']])
    assert.equal(statusOf(w.rig, 'c'), 'merged')
    assert.equal(statusOf(w.rig, 'd'), 'merged')
    assert.equal(dispatchedOf(w.rig, 'a').length, 1, 'a dispatched once')
    assert.equal(dispatchedOf(w.rig, 'b').length, 1, 'b dispatched once')
    assert.ok(res.coverage.unreached.some((l) => l.startsWith('a: held on a fault (host_error)')), JSON.stringify(res.coverage.unreached))
    assert.equal(res.coverage.complete, false)
  })

  test('a leaf whose files another leaf holds is reported blocked by its holder, at no dispatch', T, async (t) => {
    const w = world(t, { spec: specText([leafEntry('z', { locus: ['src/z.txt', 'src/b.txt'] }), leafEntry('b')]) })
    const { rig } = w
    const held = acquire(rig.repo, { effort: E, execution: rig.stamp, node: 'z', locus: ['src/z.txt', 'src/b.txt'], waitMs: 0 })
    assert.equal(held.ok, true, JSON.stringify(held))
    rig.log.append('escalated', { node: 'z', reason: 'blocked', detail: 'stopped before the run' })
    w.script({})
    const res = await w.run()

    assert.deepEqual(res.blocked, [{ blocked_by: 'z', leaves_n: 1 }])
    assert.equal(w.calls.length, 0, 'no call at all')
    assert.equal(res.coverage.complete, false)
  })

  test('a leaf that finds no slot waits in the tick loop, then runs once one frees', T, async (t) => {
    const w = world(t, {
      spec: specText([leafEntry('z'), leafEntry('x', { after: 'z' }), leafEntry('b')]), config: { max_parallel: 1 },
    })
    const { rig } = w
    rig.log.append('escalated', { node: 'z', reason: 'blocked', detail: 'stopped before the run' })
    const held = acquire(rig.repo, { effort: E, execution: '20250101-000000', node: 'x', locus: ['src/x.txt'], waitMs: 0 })
    assert.equal(held.ok, true, JSON.stringify(held))
    w.script({ [IMPL('b')]: [done()] })
    const sleepsAtFirstCall = []
    w.before.push((call) => { if (call.role.name === 'implementer' && call.node === 'b') sleepsAtFirstCall.push(w.sleeps.length) })
    const frees = () => { releaseSlots(rig.repo, { effort: E, node: 'x' }); return YIELD() }
    const res = await w.run({}, { sleep: frees })

    assert.ok(sleepsAtFirstCall.length > 0 && sleepsAtFirstCall[0] >= 1, 'the program slept before b\'s first call: ' + JSON.stringify(sleepsAtFirstCall))
    assert.equal(dispatchedOf(rig, 'b').length, 1, 'b dispatched once')
    assert.equal(statusOf(rig, 'b'), 'merged')
    assert.deepEqual(idsOf(res.implemented), ['b'])
  })

  test('pause stops new leaves after the next merge-batch, and the relaunch costs every call of every run once, by model', T, async (t) => {
    const w = world(t, { spec: chainSpec('a', 'b') })
    const { rig } = w
    const A = { input_tokens: 10, output_tokens: 5 }
    const B = { input_tokens: 20, output_tokens: 5 }
    const R = { input_tokens: 7, output_tokens: 3 }
    w.script({
      [IMPL('a')]: [done('a', A, 0.5)], [IMPL('b')]: [done('b', B, 0.25)],
    }, { 'reviewer|.|integration:.:1': [{ ...reviewed(claim('D1 holds')), usage: R, cost_total: 0.125 }] })

    const first = await w.start(['--effort', E, '--pause'])
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(first.result.stopped, 'pause')
    assert.equal(statusOf(rig, 'a'), 'merged')
    assert.equal(statusOf(rig, 'b'), 'planned')
    assert.equal(dispatchedOf(rig, 'b').length, 0, 'b planned and never called')
    assert.ok(first.result.coverage.unreached.includes('1 of 2 leaves not merged (stopped: pause)'), JSON.stringify(first.result.coverage.unreached))

    const second = await w.start(['--effort', E])
    assert.equal(second.ok, true, JSON.stringify(second))
    assert.equal(second.result.stopped, '')
    assert.deepEqual(idsOf(second.result.implemented), ['b'], 'implemented is this run\'s')
    assertComplete(second.result)
    const cost = second.result.cost
    assert.equal(cost.dispatches, 3, 'every returned of both runs')
    assert.equal(cost.tokens, 15 + 25 + 10)
    assert.ok(Math.abs(cost.usd - 0.875) < 1e-9, 'usd ' + cost.usd)
    const modelOf = (key) => entriesOf(rig).filter((e) => e.kind === 'dispatched' && e.dispatch === key).at(-1).model
    const calls = [[producerKey('a'), 15, 0.5], [producerKey('b'), 25, 0.25], [dispatchKey({ node: '.', role: 'reviewer', thread: 'integration:.:1', round: 1 }), 10, 0.125]]
    const want = {}
    for (const [key, tokens, usd] of calls) {
      const m = (want[modelOf(key)] ||= { dispatches: 0, tokens: 0, usd: 0 })
      m.dispatches += 1
      m.tokens += tokens
      m.usd += usd
    }
    assert.deepEqual(Object.keys(cost.by_model).sort(), Object.keys(want).sort())
    for (const [model, m] of Object.entries(want)) {
      assert.equal(cost.by_model[model].dispatches, m.dispatches, model)
      assert.equal(cost.by_model[model].tokens, m.tokens, model)
      assert.ok(Math.abs(cost.by_model[model].usd - m.usd) < 1e-9, model)
    }
  })

  test('budget: a leaf the target cannot cover at the measured tokens per merged leaf is not started', T, async (t) => {
    const w = world(t, { spec: chainSpec('a', 'b', 'c') })
    const { rig } = w
    const U = { input_tokens: 10, output_tokens: 5 }
    w.script({ [IMPL('a')]: [done('a', U, 0.1)], [IMPL('b')]: [done('b', U, 0.1)], [IMPL('c')]: [done('c', U, 0.1)] }, rootReview(1, claim('D1 holds')))
    const res = await w.run({ budget: 40 })

    assert.equal(statusOf(rig, 'a'), 'merged')
    assert.equal(statusOf(rig, 'b'), 'merged', '25 tokens left cover 15 per leaf')
    assert.equal(statusOf(rig, 'c'), 'planned')
    assert.equal(dispatchedOf(rig, 'c').length, 0, 'c planned and never called: 10 left do not')
    assert.equal(res.stopped, 'budget')
    assert.ok(res.coverage.unreached.includes('1 of 3 leaves not merged (stopped: budget)'), JSON.stringify(res.coverage.unreached))

    const more = await w.run({ budget: 0 })
    assert.equal(more.stopped, '', 'with no budget the same execution goes on')
    assert.equal(statusOf(rig, 'c'), 'merged')
    assertComplete(more)
  })

  // ------------------------------------------------------------------ stops carried and answered

  test('an escalation carried from an earlier run leads the result and keeps it incomplete', T, async (t) => {
    const w = world(t, { leaves: ['a', 'b'] })
    w.rig.log.append('escalated', { node: 'a', reason: 'blocked', detail: 'from an earlier run' })
    w.script({ [IMPL('b')]: [done()] })
    const res = await w.run()

    assert.deepEqual(res.escalations, [{ id: 'a', reason: 'blocked', said: '' }])
    assert.equal(res.coverage.unreached[0], 'a: escalated — blocked')
    assert.equal(res.coverage.complete, false)
    assert.equal(statusOf(w.rig, 'b'), 'merged')
    assert.equal(callsOf(w, 'implementer', 'a').length, 0)
  })

  test('a stop answered while the run goes on is taken up by the same run', T, async (t) => {
    const w = world(t, { leaves: ['a', 'b'] })
    const { rig } = w
    rig.log.append('escalated', { node: 'a', reason: 'blocked', detail: 'from an earlier run' })
    // The session answered and another writer recorded the retry, while b is running.
    w.jobs['implementer|b#1'] = (cwd) => {
      append(rig.repo, E, 'events', { kind: 'replanned', node: 'a', execution: rig.stamp, reason: 'retry_escalated', by: 'session' })
      return work(cwd, { 'src/b.txt': 'ok\n' }, 'make b')
    }
    w.script({ [IMPL('a')]: [done()], [IMPL('b')]: [done()] }, rootReview(1, claim('D1 holds')))
    const res = await w.run()

    assert.equal(dispatchedOf(rig, 'a').length, 1, 'a ran, once')
    assert.equal(statusOf(rig, 'a'), 'merged')
    assert.deepEqual(res.escalations, [])
    assertComplete(res)
  })

  // ------------------------------------------------------------------ integration

  test('a leaf failing alone on the merged head gets its fix round, its failures delivered, and merges', T, async (t) => {
    const w = world(t, { spec: specText([leafEntry('a', { locus: ['src/a.txt', 'src/add.mjs'] })]) })
    const { rig } = w
    w.jobs['implementer|a#1'] = { 'src/a.txt': 'ok\n', 'src/add.mjs': ADD_BAD }
    w.jobs['implementer|a#2'] = { 'src/add.mjs': ADD_OK }
    w.script({ [IMPL('a')]: [done(), done()] }, rootReview(1, claim('D1 holds')))
    const res = await w.run()

    assert.deepEqual(dispatchedOf(rig, 'a').map((e) => e.round), [1, 2], 'rounds 1 and 2')
    const sent = kinds(rig, 'message', 'a').filter((e) => e.msg === 'failures')
    assert.equal(sent.length, 1, 'one failures message')
    assert.equal(sent[0].payload.source, 'integration')
    const [one, two] = startsOf(w, 'implementer', 'a')
    assert.equal(two.round, 2)
    assert.equal(two.resume, true)
    assert.equal(two.thread.session, one.thread.session, 'round 2 resumes the session')
    assert.deepEqual(two.carries, [sent[0].seq], 'and carries exactly that message')
    assert.equal(kinds(rig, 'merged', 'a').length, 1, 'one merged')
    assert.deepEqual(res.implemented.map((i) => [i.id, i.rounds]), [['a', 2]])
    assertComplete(res)
  })

  test('a resumed approval merges the head it approved, not the branch as it stands', T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    const { rig } = w
    const open = ensureLeaf(rig.repo, E, 'a', { from: rootHead(rig), parentBranch: rig.branchOf('.') })
    assert.equal(open.ok, true, open.error)
    rig.log.append('dispatched', { node: 'a', dispatch: producerKey('a'), round: 1, thread: 'producer:a', role: 'implementer' })
    const approvedSha = work(open.worktree, { 'src/a.txt': 'ok\n' }, 'Make a')
    rig.log.append('approved', { node: 'a', head_sha: approvedSha, review_rounds: 0, at_integration: true })
    const laterSha = work(open.worktree, { 'src/a.txt': 'later\n' }, 'A change after the approval')
    w.script(rootReview(1, claim('D1 holds')))
    const res = await w.run()

    assert.equal(callsOf(w, 'implementer').length, 0, 'no producer call')
    assert.equal(isAncestor(rig, approvedSha, rig.branchOf('.')), true, 'the root holds the approved head')
    assert.equal(isAncestor(rig, laterSha, rig.branchOf('.')), false, 'and not the later one')
    assertComplete(res)
  })

  test('a lost integration review is a failed channel, and the review is not launched again in the run', T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    w.script({ [IMPL('a')]: [done()], 'reviewer|.|integration:.:1': [failed('host_error')] })
    const res = await w.run()

    assert.equal(callsOf(w, 'reviewer').length, 1, 'one reviewer call')
    assert.deepEqual(res.faults.map((f) => [f.id, f.channel]), [['.', 'host_error']])
    assert.ok(res.coverage.failed_channels.includes('integration-review'), JSON.stringify(res.coverage.failed_channels))
    assert.ok(res.coverage.unreached.includes('. is not integrated: reviewing'), JSON.stringify(res.coverage.unreached))
    assert.deepEqual(res.integration.reviews, [])
    assert.equal(res.coverage.complete, false)
  })

  test('a merge held on a checkout fault is not launched again in the run', T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    const { rig } = w
    w.script({ [IMPL('a')]: [done()] })
    // The user's checkout moves while the merge measures: a branch made once the batch has started.
    let moved = false
    const timer = setInterval(() => {
      if (!moved && stateOf(rig).some((e) => e.kind === 'batch-started')) {
        moved = true
        git(rig.repo, 'branch', 'side')
      }
    }, 5)
    let res
    try {
      res = await w.run()
    } finally {
      clearInterval(timer)
    }

    assert.equal(moved, true, 'the fixture: the checkout moved')
    assert.equal(kinds(rig, 'batch-started').length, 1, 'one batch')
    assert.deepEqual(res.faults.map((f) => [f.id, f.channel]), [['.', 'checkout']])
    assert.equal(statusOf(rig, 'a'), 'approved')
    assert.equal(callsOf(w, 'reviewer').length, 0, 'no reviewer call')
    assert.equal(res.coverage.complete, false)
  })

  test('a unit that rejects is a program fault on its node, and the run ends with it held', T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    w.script({ [IMPL('a')]: [done()] })
    w.before.push((call) => {
      if (call.role.name === 'reviewer' && call.node === '.') throw new Error('the runner threw on the root\'s reviewer')
    })
    const res = await w.run()

    assert.deepEqual(res.faults.map((f) => [f.id, f.channel]), [['.', 'program']])
    assert.ok(res.notes.some((n) => n.startsWith('review:. threw')), JSON.stringify(res.notes))
    assert.equal(statusOf(w.rig, '.'), 'reviewing')
    assert.equal(res.coverage.complete, false)
  })

  // ------------------------------------------------------------------ drift

  test('a consumer is not launched while the merge that drifted it is being ruled', T, async (t) => {
    const w = driftWorld(t)
    const { rig } = w
    w.script(
      { [IMPL('q')]: [done()], [IMPL('s')]: [done()], [IMPL('c')]: [done()] },
      driftRuler(rulings(ruling('c', 'unaffected', 'the api is the same'))),
      rootReview(1, claim('D1 holds')),
    )
    // s ends only once the merge of q is under way, and q's ruler answers only once s is approved:
    // the ticks s's end wakes see c ready on disk while the merge that drifted it is still out.
    w.before.push(async (call) => {
      if (call.role.name === 'implementer' && call.node === 's') await until(() => stateOf(rig).some((e) => e.kind === 'batch-started'), 'the merge of q starts')
      if (call.role.name === 'ruler') await until(() => kinds(rig, 'approved', 's').length > 0, 's is approved')
    })
    const res = await w.run()

    const ruled = kinds(rig, 'drift-ruled')
    assert.deepEqual(ruled.map((r) => [r.node, r.contract, r.ruling]), [['c', 'api', 'unaffected']])
    assert.ok(kinds(rig, 'approved', 's')[0].seq < ruled[0].seq, 's was approved before the ruling')
    const opened = dispatchedOf(rig, 'c')
    assert.equal(opened.length, 1)
    assert.ok(opened[0].seq > ruled[0].seq, 'c opened only after the ruling')
    assert.deepEqual(res.drift, [{ node: 'c', contract: 'api' }])
    assertComplete(res)
  })

  test("a drifted consumer ruled affected under a folder the user wrote parks needs_respec with the ruler's question", T, async (t) => {
    const w = driftWorld(t)
    const { rig } = w
    const Q = 'Does c still read the api as it was?'
    w.script({ [IMPL('q')]: [done()], [IMPL('s')]: [done()] }, driftRuler(rulings(ruling('c', 'affected', 'the api changed', Q))))
    const res = await w.run()

    const ruled = kinds(rig, 'drift-ruled')
    assert.deepEqual(ruled.map((r) => [r.node, r.contract, r.ruling]), [['c', 'api', 'affected']])
    assert.deepEqual(res.parked, [{ id: 'c', return: 'needs_respec', said: ruled[0].said }])
    const parks = kinds(rig, 'parked', 'c')
    assert.equal(parks.length, 1)
    assert.ok(String(parks[0].question).includes(Q), 'the ruler\'s question: ' + parks[0].question)
    assert.equal(dispatchedOf(rig, 'c').length, 0, 'c never dispatched')
    assert.equal(callsOf(w, 'planner').length, 0, 'no planner call')
  })

  // ------------------------------------------------------------------ a moved base and replans

  test('a moved base is ruled before any leaf runs', T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    const { rig } = w
    const head = moveBase(rig, 'src/a.txt')
    w.script(staleRuler(head, rulings(ruling('a', 'unaffected', 'the base change is elsewhere'))), { [IMPL('a')]: [done()] }, rootReview(1, claim('D1 holds')))
    const res = await w.run()

    assert.equal(w.calls[0].role.name, 'ruler', 'the first call is the ruler\'s')
    assert.ok(seqOfFirst(dispatchedOf(rig, '.', 'ruler')) < seqOfFirst(dispatchedOf(rig, 'a')), 'its dispatched is before a\'s')
    assert.deepEqual(kinds(rig, 'stale-ruled').map((r) => [r.node, r.base_now, r.ruling]), [['a', head, 'unaffected']])
    assertComplete(res)
  })

  test("a leaf ruled affected on a moved base goes to its planner with the ruler's question; a planner that needs a decision parks its folder, the leaf waits and the rest runs", T, async (t) => {
    const w = plannerWorld(t)
    const { rig } = w
    const Q = 'Does p/x still hold on the new base?'
    const head = moveBase(rig, 'src/x.txt')
    w.script(
      staleRuler(head, rulings(ruling('p/x', 'affected', 'x\'s file moved', Q))),
      { [PLANNER]: [said('needs_decision', 'Which reading is meant?')], [IMPL('q')]: [done()] },
      rootReview(1, claim('D1 holds')),
    )
    const res = await w.run()

    const planners = callsOf(w, 'planner')
    assert.equal(planners.length, 1, 'one planner call')
    assert.equal(planners[0].thread.key, 'planner:p')
    assert.ok(planners[0].brief.includes(Q), 'its brief holds the question')
    assert.deepEqual(res.parked, [{ id: 'p', return: 'needs_decision', said: planners[0].dispatch }])
    assert.equal(dispatchedOf(rig, 'p/x').length, 0, 'p/x never dispatched')
    assert.equal(statusOf(rig, 'q'), 'merged', 'the rest runs')
    assert.deepEqual(kinds(rig, 'stale-ruled').map((r) => [r.node, r.ruling]), [['p/x', 'affected']])
  })

  test('a moved premise the planner answers without changing the leaf escalates replan_not_converging, and the leaf never runs', T, async (t) => {
    const w = plannerWorld(t)
    const { rig } = w
    const head = moveBase(rig, 'src/x.txt')
    const untouched = plannerSpec(leafEntry('x')).replace('Files under src.', 'Files under src, and a paragraph that answers nothing about x.')
    w.jobs['planner|p#1'] = () => putSpec(rig, 'p', untouched)
    w.script(
      staleRuler(head, rulings(ruling('p/x', 'affected', 'x\'s file moved', 'Does p/x still hold?'))),
      { [PLANNER]: [{ output: { status: 'written', text: '' } }], [IMPL('q')]: [done()] },
      probing(1, untouched),
      rootReview(1, claim('D1 holds')),
    )
    const res = await w.run()

    assert.deepEqual(res.escalations, [{ id: 'p/x', reason: 'replan_not_converging', said: '' }])
    assert.equal(dispatchedOf(rig, 'p/x').length, 0, 'p/x never dispatched')
    assert.equal(statusOf(rig, 'q'), 'merged')
  })

  test('a replan a fault ended holds the asking leaf, and its ruling stays unanswered for the next run', T, async (t) => {
    const w = plannerWorld(t)
    const { rig } = w
    const head = moveBase(rig, 'src/x.txt')
    w.script(
      staleRuler(head, rulings(ruling('p/x', 'affected', 'x\'s file moved', 'Does p/x still hold?'))),
      { [PLANNER]: [failed('host_error')], [IMPL('q')]: [done()] },
      rootReview(1, claim('D1 holds')),
    )
    const res = await w.run()

    assert.deepEqual(res.faults.map((f) => [f.id, f.channel]).sort(), [['p', 'host_error'], ['p/x', 'program']])
    assert.deepEqual(res.parked, [], 'no park')
    const ruled = kinds(rig, 'stale-ruled')
    assert.deepEqual(ruled.map((r) => [r.node, r.ruling]), [['p/x', 'affected']])
    const after = entriesOf(rig).filter((e) => e.seq > ruled[0].seq && e.node === 'p/x' && ['parked', 'escalated', 'replanned'].includes(e.kind))
    assert.deepEqual(after, [], 'nothing answers the ruling on p/x')
    assert.equal(dispatchedOf(rig, 'p/x').length, 0, 'p/x never dispatched')
    assert.equal(statusOf(rig, 'q'), 'merged')
  })

  test('a stale ruler that rejects holds every leaf it was to rule on a program fault', T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    const { rig } = w
    moveBase(rig, 'src/a.txt')
    w.script({ [IMPL('a')]: [done()] })
    w.before.push((call) => { if (call.role.name === 'ruler') throw new Error('the runner threw on the ruler') })
    const res = await w.run()

    assert.deepEqual(res.faults.map((f) => [f.id, f.channel]), [['a', 'program']])
    assert.equal(dispatchedOf(rig, 'a').length, 0, 'a never dispatched')
    assert.equal(callsOf(w, 'implementer').length, 0)
    assert.equal(res.coverage.complete, false)
  })

  test("a leaf's request goes to its planner folder, its slot given back, and it does not run again until its plan revises it", T, async (t) => {
    const w = plannerWorld(t)
    const { rig } = w
    const ASK = 'which format does the folder want?'
    w.script(
      { [IMPL('p/x')]: [said('needs_context', ASK)], [PLANNER]: [said('needs_decision', 'Which format?')], [IMPL('q')]: [done()] },
      rootReview(1, claim('D1 holds')),
    )
    const slotsAtPlanner = []
    w.before.push((call) => { if (call.role.name === 'planner') slotsAtPlanner.push(heldBy(rig.repo).slots.map((s) => s.node)) })
    const res = await w.run()

    const planners = callsOf(w, 'planner')
    assert.equal(planners.length, 1)
    const sent = kinds(rig, 'message').filter((e) => e.thread === 'planner:p' && e.msg === 'needs_context')
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0].payload, { node: 'p/x', text: ASK })
    assert.deepEqual(planners[0].carries, [sent[0].seq], 'the planner\'s call carries exactly the needs_context message')
    assert.equal(slotsAtPlanner.length, 1)
    assert.ok(!slotsAtPlanner[0].includes('p/x'), 'no slot names p/x when the planner is called: ' + JSON.stringify(slotsAtPlanner[0]))
    assert.equal(dispatchedOf(rig, 'p/x').length, 1, 'p/x dispatched once')
    assert.deepEqual(res.parked, [{ id: 'p', return: 'needs_decision', said: planners[0].dispatch }])
  })

  // ------------------------------------------------------------------ a relaunch

  test('a run killed between a return and its close is closed on relaunch at its own round, nothing dispatched again', T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    w.script({ [IMPL('a')]: [done()] })
    const killed = signal()
    w.after.push(async (call) => {
      if (call.role.name === 'implementer') {
        killed.hit()
        await NEVER()
      }
    })
    w.run().catch(() => {})
    await killed.reached
    const closeFile = closePath(w.rig.repo, E, w.rig.stamp, 'a', 'implementer', 1)
    assert.equal(existsSync(closeFile), false, 'killed before the close')

    w.relaunch()
    w.after.length = 0
    w.script(rootReview(1, claim('D1 holds')))
    const res = await w.run()

    assert.equal(callsOf(w, 'implementer').length, 0, 'no producer call')
    assert.equal(existsSync(closeFile), true, 'the close record of round 1 exists')
    assert.equal(kinds(w.rig, 'approved', 'a').length, 1, 'one approved')
    assert.deepEqual(res.implemented.map((i) => [i.id, i.rounds]), [['a', 1]])
    assertComplete(res)
  })

  test('a relaunch resumes the open dispatches in their own sessions and lands nothing twice', T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    w.script({ [IMPL('a')]: [done()], 'reviewer|.|integration:.:1': [stopped()] })
    const killed = signal()
    const sleep = () => {
      if (callsOf(w, 'reviewer').length === 0) return YIELD()
      killed.hit()
      return NEVER()
    }
    w.run({}, { sleep }).catch(() => {})
    await killed.reached
    const [cut] = startsOf(w, 'reviewer', '.')
    assert.ok(cut, 'the first run called the root reviewer')

    w.relaunch()
    w.script(rootReview(1, claim('D1 holds')))
    const res = await w.run()

    assert.equal(w.calls.length, 1, 'the relaunch\'s one call')
    const [call] = w.calls
    assert.equal(call.role.name, 'reviewer')
    assert.equal(call.dispatch, cut.dispatch, 'is that reviewer\'s dispatch')
    assert.equal(call.resume, true)
    assert.equal(call.thread.session, cut.thread.session, 'in the same session')
    assert.equal(call.brief, renderMessage({ msg: 'cut_off' }), 'briefed cut_off')
    assert.equal(kinds(w.rig, 'approved', 'a').length, 1)
    assert.equal(kinds(w.rig, 'merged', 'a').length, 1)
    assert.equal(kinds(w.rig, 'claims', '.').length, 1)
    assert.equal(kinds(w.rig, 'batch').length, 1)
    assert.equal(stateOf(w.rig).filter((e) => e.kind === 'closed').length, 1)
    assertComplete(res)
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

  // ------------------------------------------------------------------ the dial

  /** The tier each unit's call must have at `dial`, computed from the roles. */
  const tierAt = (rig, dial) => ({
    ruler: tierFor(loadRole('ruler').role, { intelligence: dial }),
    reviewer: tierFor(loadRole('reviewer').role, { intelligence: dial }),
    producer: producerTier(readTree(rig.repo, E).nodes.get('a'), loadRole('implementer').role, { intelligence: dial }),
  })

  test("a relaunch with no --intelligence tiers every unit, the stale ruler first, at its envelope's dial", T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    const { rig } = w
    writeJson(join(rig.dir, 'execution.json'), { ...rig.envelope, dial: 'max' })
    const head = moveBase(rig, 'src/a.txt')
    w.script(staleRuler(head, rulings(ruling('a', 'unaffected', 'the base change is elsewhere'))), { [IMPL('a')]: [done()] }, rootReview(1, claim('D1 holds')))
    const out = await w.start(['--effort', E])

    assert.equal(out.ok, true, JSON.stringify(out))
    assert.deepEqual(w.calls.map((c) => c.role.name), ['ruler', 'implementer', 'reviewer'], 'the stale ruler first')
    const max = tierAt(rig, 'max')
    const normal = tierAt(rig, 'normal')
    for (const key of ['ruler', 'producer', 'reviewer']) assert.notDeepEqual(max[key], normal[key], 'the fixture: max tiers the ' + key + ' otherwise than normal')
    assert.deepEqual(w.calls.map((c) => c.tier), [max.ruler, max.producer, max.reviewer])
    assert.equal(JSON.parse(readFileSync(join(rig.dir, 'execution.json'), 'utf8')).dial, 'max')
  })

  test("a relaunch's --intelligence leaves its envelope's dial in force; a fresh execution's dial is the argument", T, async (t) => {
    const resumed = world(t, { leaves: ['a'] })
    writeJson(join(resumed.rig.dir, 'execution.json'), { ...resumed.rig.envelope, dial: 'max' })
    resumed.script({ [IMPL('a')]: [done()] }, rootReview(1, claim('D1 holds')))
    await resumed.run({ intelligence: 'low' })

    const max = tierAt(resumed.rig, 'max')
    assert.notDeepEqual(max.reviewer, tierAt(resumed.rig, 'low').reviewer, 'the fixture: the dials tier differently')
    assert.deepEqual(resumed.calls.map((c) => c.role.name), ['implementer', 'reviewer'])
    assert.deepEqual(resumed.calls.map((c) => c.tier), [max.producer, max.reviewer], 'each at the tier max gives it')
    assert.equal(JSON.parse(readFileSync(join(resumed.rig.dir, 'execution.json'), 'utf8')).dial, 'max')

    const fresh = world(t, { leaves: ['a'] })
    rmSync(join(fresh.rig.dir, 'execution.json'))
    fresh.script({ [IMPL('a')]: [done()] }, rootReview(1, claim('D1 holds')))
    await fresh.run({ intelligence: 'low', commands_file: commandsFile(fresh.rig) })

    const low = tierAt(fresh.rig, 'low')
    assert.equal(JSON.parse(readFileSync(join(fresh.rig.dir, 'execution.json'), 'utf8')).dial, 'low', 'the envelope written has the argument\'s dial')
    assert.deepEqual(fresh.calls.map((c) => c.role.name), ['implementer', 'reviewer'])
    assert.deepEqual(fresh.calls.map((c) => c.tier), [low.producer, low.reviewer], 'each at the tier low gives it')
  })
})
