// test/execute-folder.test.mjs — pins the execute program's folder unit (lib/programs/execute/folder.mjs):
// `planFolder` over the execution rig. The planner writes (or answers a producer's request) on
// `planner:<folder>` in the session the folder mints; the spec is checked; the nested probe attacks it
// round by round; the planner settles the findings; the gate and the preparation decide. Every
// boundary decision is journaled, so a unit run again after a cut replays and records nothing twice.
// The planner's writes are played by a runner that writes the folder's spec as a planner round starts;
// the probe and the survey are scripted through their own scoped threads.
//
// Design: docs/DESIGN.md#autonomous-review, docs/DESIGN.md#replanning, docs/DESIGN.md#survey.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

import { approvalState } from '../lib/approval.mjs'
import { parked, recordAll } from '../lib/boundaries/records.mjs'
import { guidanceOf, leafBrief } from '../lib/brief.mjs'
import { plannerBrief } from '../lib/briefs/execute.mjs'
import { STANDING_AXES } from '../lib/briefs/probe.mjs'
import { renderMessage } from '../lib/conversation.mjs'
import { sectionsOf, unitsOf } from '../lib/evidence.mjs'
import { commandsOf } from '../lib/gotchas.mjs'
import { append, readLog } from '../lib/ledger.mjs'
import { permissionsFor } from '../lib/locus.mjs'
import { dispatch, programContext } from '../lib/programs/common.mjs'
import { planFolder } from '../lib/programs/execute/folder.mjs'
import { loadRole, tierFor } from '../lib/roles.mjs'
import { schemaOf } from '../lib/schemas.mjs'
import { checkFolder, hashSpec } from '../lib/spec.mjs'
import { dispatchKey, mainCheckout, posix, readConfig, readJson, sessionOf, specPath } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { closedSearch, endSearch, hitTurn } from './harness/navigator.mjs'
import { executionRig } from './harness/program-rig.mjs'

const E = 'e1'

// ------------------------------------------------------------------ the specs

/** The root spec: `p` a sub-effort the planner writes (`known`: its ground is `src`), `q` a task realising D1. */
const rootSpec = ({ known = true } = {}) => [
  '# The change', '', '## Intent', '', 'Make the change.', '',
  '## Decisions', '', '| id | decision | why |', '|---|---|---|', '| D1 | do it | asked for |', '',
  '## Design', '', 'A sub-effort the planner writes and a task.', '',
  '## Plan', '',
  '- **p** — sub-effort · author: planner' + (known ? ' · ground: src' : ''), '  Build p.', '  The planner writes its spec.',
  '- **q** — task · realises: D1 · rigor: tdd · locus: src/q.mjs', '  Add q.', '  Write q and its test.',
  '  - [ ] q works — check: `node --test test/add.test.mjs`', '',
  '## Open questions', '', '## Evidence', '', 'None gathered.', '',
].join('\n')

/** p's spec: one task `x` realising D1; each option is one way a test changes it. */
const folderSpec = ({ locus = 'src/x.mjs, test/x.test.mjs', extra = '', after = '', design = 'One function.', title = 'Add x.', rigor = 'tdd', decisions = [], plan } = {}) => [
  '# Build p', '', '## Intent', '', 'Build p, as the root plans it.', '',
  '## Decisions', ...(decisions.length ? ['', '| id | decision | why |', '|---|---|---|', ...decisions.map(([id, text]) => '| ' + id + ' | ' + text + ' | faster |')] : []), '',
  '## Design', '', design, '', ...(extra ? [extra, ''] : []),
  '## Plan', '',
  ...(plan || ['- **x** — task · realises: D1 · rigor: ' + rigor + ' · locus: ' + locus + after, '  ' + title, '  Write x and its test.',
    '  - [ ] x works — check: `node --test test/x.test.mjs`']), '',
  '## Open questions', '', '## Evidence', '', 'The root\'s.', '',
].join('\n')

const DESIGN_A = 'Design line: x is a pure function.'
const DESIGN_B = 'Design line: x is a pure function that rejects bad input.'
const INTENT_NEEDLE = 'as the root plans it'
const S1 = folderSpec({ design: DESIGN_A })
const S2 = folderSpec({ design: DESIGN_B })
const BAD = folderSpec({ rigor: 'wild' })
const SPLIT = folderSpec({
  plan: [
    '- **x1** — task · realises: D1 · rigor: tdd · locus: src/x1.mjs, test/x1.test.mjs', '  Add x1.', '  Write x1 and its test.',
    '  - [ ] x1 works — check: `node --test test/x1.test.mjs`',
    '- **x2** — task · realises: D1 · rigor: tdd · locus: src/x2.mjs, test/x2.test.mjs', '  Add x2.', '  Write x2 and its test.',
    '  - [ ] x2 works — check: `node --test test/x2.test.mjs`',
  ],
})

// ------------------------------------------------------------------ the world

const specFile = (rig) => specPath(rig.repo, E, 'p')
const putSpec = (rig, text) => {
  mkdirSync(dirname(specFile(rig)), { recursive: true })
  writeFileSync(specFile(rig), text)
}
const readSpec = (rig) => readFileSync(specFile(rig), 'utf8')

/** A context whose runner writes p's spec as a planner round starts (`writes[round]`) and throws where `trap` says. */
const playing = (rig, writes, trap) => programContext({ intelligence: 'normal',
  ...rig.ctx,
  runAgent(call) {
    if (trap && trap(call, rig)) throw new Error('the runner was cut off at ' + call.thread.key)
    if (call.role.name === 'planner' && Object.hasOwn(writes, call.round)) putSpec(rig, writes[call.round])
    return rig.ctx.runAgent(call)
  },
})

/**
 * An execution whose root plans `p` for the planner (`known`: with its ground); `planned` is p's spec
 * when it exists already (the rig approves and compiles it).
 */
function world(t, { known = true, planned = null, steps = {}, writes = {}, trap = null } = {}) {
  const specs = { '.': rootSpec({ known }) }
  if (planned) specs.p = planned
  const rig = executionRig(t, { spec: specs })
  rig.script(typeof steps === 'function' ? steps(rig) : steps)
  const ctx = playing(rig, writes, trap)
  return { rig, ctx, run: (args = {}) => planFolder(ctx, rig.xc, { folder: 'p', ...args }) }
}

// ------------------------------------------------------------------ the script

const planner = (...steps) => ({ 'planner|p|planner:p': steps })
const written = { output: { status: 'written', text: '' } }
const settled = (...pairs) => ({ output: { status: 'settled', dispositions: pairs.map(([finding, outcome]) => ({ finding, outcome })), text: '' } })
const hostError = { status: 'failed', cause: 'host_error' }
const schemaFailed = { status: 'failed', cause: 'schema_failed' }

const STANDING = STANDING_AXES.map((a) => a.key)
const unitsFor = (text) => unitsOf(STANDING, sectionsOf(text))
const proberOut = (units, findings = []) => ({
  findings,
  units: units.map((unit) => ({ unit, ruling: findings.some((f) => f.axis + '@' + f.section === unit) ? 'findings' : 'clean', ids: [], why: 'why ' + unit })),
  notes: '', stop_reason: 'exhausted', not_reached: '',
})
/** Probe round `n` over `text`: a locate turn that ends every ask, and one prober holding the standing axes. */
const probing = (n, text, findings = [], { units } = {}) => ({
  ...closedSearch({ name: 'probe:p:' + n + '/locate', asks: ['guidance', ...sectionsOf(text).map((s) => 'ground:' + s.slug)] }),
  ['analyst||probe:p:' + n + '/prober:1']: [{ output: proberOut(units || unitsFor(text), findings) }],
})
const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1
/** A prober's finding on the line of `text` holding `needle`. */
function found(text, { axis = 'yagni', severity = 'gap', section, needle, claim }) {
  const n = lineOf(text, needle)
  assert.ok(n > 0, 'the fixture: ' + needle + ' is a line of the spec')
  return { axis, severity, section, claim, evidence: 'line ' + n, start: n, end: n }
}
const GAP = found(S1, { section: 'design', needle: DESIGN_A, claim: 'x hides state in a module global' })
const GAP_INTENT = found(S1, { section: 'intent', needle: INTENT_NEEDLE, claim: 'who the root is stays open' })
const AMBIGUITY = found(S1, { axis: 'ambiguity', severity: 'ambiguity', section: 'intent', needle: INTENT_NEEDLE, claim: 'plans it could mean two things' })

const surveying = (prefix) => {
  const end = endSearch({ name: prefix + 'scout:adder', turn: 1, asks: ['adder'], ruling: 'answered' })
  return {
  ['analyst||' + prefix + 'plan']: [{ output: { topics: [{ key: 'adder', find: 'FIND-adder', subtree: 'src' }], common_ground: '', history_question: '', docs_question: '' } }],
  ['scout||' + prefix + 'scout:adder']: [hitTurn('adder', [['src/add.mjs', 1]]), ...end.navigator],
  [end.ruler.key]: end.ruler.steps,
  ['analyst||' + prefix + 'judge:1']: [{ output: {
    items: [{ topic: 'adder', kind: 'behaviour', claim: 'SURVEYED-a9 add sums its two arguments', spans: [{ path: 'src/add.mjs', start: 1, end: 1 }], queries: [], sources: [], rests_on: [] }],
    risks: [], units: [{ unit: 'adder', ruling: 'anchored', ids: [], why: 'anchored' }],
  } }],
  }
}

/** The common script: the planner writes at round 1 and the first probe round is clean. */
const clean = (text = S1) => ({ ...planner(written), ...probing(1, text) })

// ------------------------------------------------------------------ what is on disk

const ledger = (rig, kind) => readLog(rig.repo, E, 'ledger').entries.filter((e) => e.kind === kind && e.folder === 'p')
const events = (rig, kind, pred = () => true) => readTree(rig.repo, E).events.filter((e) => e.kind === kind && pred(e))
const escalations = (rig, node = 'p') => events(rig, 'escalated', (e) => e.node === node)
const parks = (rig, node = 'p') => events(rig, 'parked', (e) => e.node === node)
const messages = (rig, msg, thread = 'planner:p') => events(rig, 'message', (e) => e.thread === thread && (!msg || e.msg === msg))
const faults = (rig, channel) => readLog(rig.repo, E, 'state:' + rig.stamp).entries
  .filter((e) => e.kind === 'fault' && e.node === 'p' && (!channel || e.channel === channel))
const stepValue = (rig, key) => (rig.log.entries().find((e) => e.kind === 'step' && e.key === key) || {}).value
const plannerCalls = (rig) => rig.calls.filter((c) => c.role.name === 'planner')
const under = (rig, prefix) => rig.calls.filter((c) => c.thread.key.startsWith(prefix))
const nodeOf = (rig, id) => readTree(rig.repo, E).nodes.get(id)
/** The tree roots the search servers of the calls under `prefix` were started over. */
const searchedUnder = (rig, prefix) => new Set(under(rig, prefix).filter((c) => c.mcpConfig).map((c) => {
  const args = JSON.parse(readFileSync(c.mcpConfig, 'utf8')).mcpServers.search.args
  return JSON.parse(readFileSync(args[args.indexOf('--spec') + 1], 'utf8')).tree.root
}))
/** The basis of p's first plan, as `planFolder` names it. */
const basisOf = (rig) => 'write:' + (nodeOf(rig, 'p').seq || 0) + ':0'
/** Where the tree pinned at `sha` is made for p's searches. */
const pinOf = (rig, sha) => join(rig.repo, '.claude', 'worktrees', 'search-' + E + '-' + sha.slice(0, 8))
const liveNode = (rig, id) => { const n = nodeOf(rig, id); return n && !n.retired ? n : null }
const findingsIn = (file) => { const read = readJson(file); return Array.isArray(read) ? read : read.findings }
const sessionKey = (rig) => sessionOf({ effort: E, execution: rig.stamp, node: 'p', role: 'planner', thread: 'planner:p', gen: 0 })

// ------------------------------------------------------------------ what a prompt should be

const guidance = (rig) => guidanceOf(rig.repo, { config: readConfig(rig.repo) })
/** The prompt `plannerBrief` gives for p as the tree holds it now. */
function briefFor(rig, { mode, why = '', spec = '', request = null, context = '', node = nodeOf(rig, 'p') }) {
  assert.deepEqual(node.decisions, [], 'the fixture: p realises no decision, so its brief lists none')
  return plannerBrief({
    folder: { id: 'p', title: node.title, intent: node.intent, spec_path: specFile(rig), why },
    mode, spec, decisions: [], request, guidance: guidance(rig), context,
  })
}
/** Prompts compare with their paths spelt alike: the spec path is native on one side and POSIX on the other. */
const sameBrief = (got, want, message) => assert.equal(posix(got), posix(want), message)

// ================================================================== writing a design node

test('a design node the planner writes is written, checked, reviewed once, prepared and compiled', async (t) => {
  const w = world(t, { steps: clean(), writes: { 1: S1 } })
  assert.equal(nodeOf(w.rig, 'p').kind, 'design', 'the fixture: p is a frontier node')
  const out = await w.run()
  assert.deepEqual(out, { outcome: 'prepared', survey: null })
  assert.equal(plannerCalls(w.rig).length, 1)
  const reviewed = ledger(w.rig, 'reviewed')
  const prepared = ledger(w.rig, 'prepared')
  assert.equal(reviewed.length, 1)
  assert.equal(reviewed[0].complete, true)
  assert.equal(prepared.length, 1)
  assert.ok(reviewed[0].seq < prepared[0].seq, 'reviewed before prepared')
  assert.equal(nodeOf(w.rig, 'p').kind, 'composite')
  assert.equal(nodeOf(w.rig, 'p/x').kind, 'leaf')
  const scope = stepValue(w.rig, 'probe:p:1/scope')
  assert.equal(scope.full, true, 'probe round 1 is not narrowed')
  const probes = under(w.rig, 'probe:')
  assert.ok(probes.length > 0, 'the round probed')
  assert.deepEqual(probes.map((c) => c.thread.key).filter((k) => !k.startsWith('probe:p:1/')), [], 'one probe round only')
})

test("a ratifiable round is prepared naming the probe's review return, else its snapshot", async (t) => {
  const w = world(t, { steps: clean(), writes: { 1: S1 } })
  assert.equal((await w.run()).outcome, 'prepared')
  const record = stepValue(w.rig, 'probe:p:1/record')
  const scope = stepValue(w.rig, 'probe:p:1/scope')
  const [prepared] = ledger(w.rig, 'prepared')
  assert.ok(record.return, 'the fixture: the round recorded a review return')
  assert.equal(prepared.review, record.return)
  assert.notEqual(prepared.review, scope.snapshot)
  assert.equal(prepared.hash, approvalState(w.rig.repo, E, 'p').hash)
})

test("the planner writes on planner:<folder> in the session the folder mints, at the planner's tier, writing its spec alone", async (t) => {
  const role = loadRole('planner').role
  const tiers = new Set()
  for (const intelligence of ['low', 'normal', 'max']) {
    const w = world(t, { steps: clean(), writes: { 1: S1 } })
    assert.equal((await w.run({ intelligence })).outcome, 'prepared')
    const [call, ...rest] = plannerCalls(w.rig)
    assert.equal(rest.length, 0)
    assert.equal(call.thread.key, 'planner:p')
    assert.equal(call.node, 'p')
    assert.equal(call.thread.session, sessionKey(w.rig))
    assert.deepEqual(call.tier, tierFor(role, { intelligence }), 'the tier under the dial ' + intelligence)
    tiers.add(JSON.stringify(call.tier))
    assert.deepEqual(call.schema, schemaOf('planner_write'))
    assert.equal(call.cwd, w.rig.repo)
    assert.equal(call.round, 1)
    const rel = posix(relative(mainCheckout(w.rig.repo), specFile(w.rig)))
    const fence = permissionsFor({ locus: [rel], tests: false })
    const writes = (list) => list.filter((rule) => /^(Edit|Write)\(/.test(rule)).sort()
    assert.deepEqual(writes(call.permissions.allowed), writes(fence.allowed), 'Edit and Write are the spec\'s alone')
    assert.ok(writes(call.permissions.allowed).length > 0)
    assert.ok(call.permissions.allowed.includes('Read'))
    for (const rule of fence.disallowed) assert.ok(call.permissions.disallowed.includes(rule), rule)
  }
  assert.equal(tiers.size, 3, 'the three dials give three tiers')
})

test("a folder's probe gets its dial", async (t) => {
  for (const intelligence of ['low', 'max']) {
    const w = world(t, { steps: clean(), writes: { 1: S1 } })
    assert.equal((await w.run({ intelligence })).outcome, 'prepared')
    const gated = w.rig.calls.filter((c) => c.thread.key.includes('probe:p:1/')).filter((c) => ['analyst', 'ruler'].includes(c.role.name))
    assert.ok(gated.some((c) => c.role.name === 'analyst') && gated.some((c) => c.role.name === 'ruler'), 'the probe dispatched its prober and its locate ruler')
    for (const c of gated) assert.deepEqual(c.tier, tierFor(loadRole(c.role.name).role, { intelligence }), c.thread.key + ' under the dial ' + intelligence)
  }
})

test("the first round of a fresh plan is the planner's write brief", async (t) => {
  const w = world(t, { steps: clean(), writes: { 1: S1 } })
  // The first round's brief carries the folder as it stood before the run: compile rewrites its title and intent from the spec.
  const before = nodeOf(w.rig, 'p')
  assert.equal((await w.run()).outcome, 'prepared')
  const [call] = plannerCalls(w.rig)
  assert.equal(call.resume, false, 'the first call starts a session')
  sameBrief(call.brief, briefFor(w.rig, { mode: 'write', node: before }))
  assert.deepEqual(call.carries, [])
})

// ================================================================== the spec check

test('a spec with problems goes back to the planner as a problems message, and the round that answers it is checked', async (t) => {
  const w = world(t, { steps: { ...planner(written, written), ...probing(2, S1) }, writes: { 1: BAD, 2: S1 } })
  putSpec(w.rig, BAD)
  const problems = checkFolder(w.rig.repo, E, 'p').problems
  rmSync(specFile(w.rig))
  assert.ok(problems.length > 0, 'the fixture: the spec has problems')
  const out = await w.run()
  assert.deepEqual(out, { outcome: 'prepared', survey: null })
  const sent = messages(w.rig, 'problems')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].round, 2)
  assert.deepEqual(sent[0].payload.problems, problems)
  const calls = plannerCalls(w.rig)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].resume, true)
  assert.equal(calls[1].round, 2)
  assert.deepEqual(calls[1].carries, [sent[0].seq])
  assert.equal(calls[1].brief, renderMessage({ msg: 'problems', payload: sent[0].payload }))
  assert.equal(calls[1].thread.session, calls[0].thread.session)
  assert.equal(under(w.rig, 'probe:p:1/').length, 0, 'the spec with problems was not probed')
  assert.ok(under(w.rig, 'probe:p:2/').length > 0, 'the corrected spec is probed after planner round 2')
  const reviewed = ledger(w.rig, 'reviewed')
  assert.equal(reviewed.length, 1)
  assert.equal(reviewed[0].hash, hashSpec(S1))
  assert.equal(ledger(w.rig, 'prepared').length, 1)
})

test('the same problems again escalate spec_refused before any probe', async (t) => {
  const w = world(t, { steps: planner(written, written), writes: { 1: BAD } })
  const out = await w.run()
  assert.equal(out.outcome, 'stopped')
  assert.equal(messages(w.rig, 'problems').length, 1)
  assert.equal(plannerCalls(w.rig).length, 2)
  const stops = escalations(w.rig)
  assert.deepEqual(stops.map((e) => e.reason), ['spec_refused'])
  assert.equal(under(w.rig, 'probe:').length, 0)
  assert.equal(ledger(w.rig, 'prepared').length, 0)
  assert.equal(ledger(w.rig, 'reviewed').length, 0)
})

test('a folder the user retried after its stop is planned again, not replayed to the same stop', async (t) => {
  const w = world(t, { steps: { ...planner(written, written, written), ...probing(3, S1) }, writes: { 1: BAD, 3: S1 } })
  assert.equal((await w.run()).outcome, 'stopped', 'the fixture: the same problems twice escalate spec_refused')
  append(w.rig.repo, E, 'events', [{ kind: 'replanned', node: 'p', execution: w.rig.stamp, reason: 'retry_escalated', by: 'session' }])
  const out = await w.run()
  assert.equal(out.outcome, 'prepared')
  assert.deepEqual(plannerCalls(w.rig).map((c) => c.round), [1, 2, 3], 'the retry runs on from the thread\'s latest round')
  assert.equal(ledger(w.rig, 'prepared').length, 1)
})

test('a planner dispatch that fails host_error is a host_error fault on the folder', async (t) => {
  const w = world(t, { steps: planner(hostError), writes: {} })
  const out = await w.run()
  assert.equal(out.outcome, 'faulted')
  assert.equal(faults(w.rig, 'host_error').length, 1)
  assert.equal(faults(w.rig).length, 1)
  assert.equal(under(w.rig, 'probe:').length, 0)
  assert.equal(ledger(w.rig, 'reviewed').length, 0)
})

test('a planner dispatch that fails its schema twice is a role fault on the folder', async (t) => {
  const w = world(t, { steps: planner(schemaFailed, schemaFailed), writes: {} })
  const out = await w.run()
  assert.equal(out.outcome, 'faulted')
  assert.equal(faults(w.rig, 'role').length, 1)
  assert.equal(faults(w.rig).length, 1)
  assert.equal(under(w.rig, 'probe:').length, 0)
})

// ================================================================== the survey

test('a folder whose ground is unknown is surveyed first, nested under survey:<folder>:<basis>', async (t) => {
  const w = world(t, { known: false, steps: (rig) => ({ ...surveying('survey:p:' + basisOf(rig) + '/'), ...clean() }), writes: { 1: S1 } })
  assert.equal(nodeOf(w.rig, 'p').ground_known, false, 'the fixture: the ground is unknown')
  const prefix = 'survey:p:' + basisOf(w.rig) + '/'
  const out = await w.run()
  assert.equal(out.outcome, 'prepared')
  const context = stepValue(w.rig, prefix + 'context')
  assert.ok(context && context.context, 'the survey wrote its context file')
  assert.deepEqual(out.survey, { complete: true, context: context.context })
  const surveyed = under(w.rig, prefix)
  assert.deepEqual([...new Set(surveyed.map((c) => c.thread.key))].sort(), [prefix + 'judge:1', prefix + 'plan', prefix + 'scout:adder'])
  const first = w.rig.calls.findIndex((c) => c.role.name === 'planner')
  const lastSurvey = w.rig.calls.map((c) => c.thread.key.startsWith(prefix)).lastIndexOf(true)
  assert.ok(first > lastSurvey, 'the planner\'s first call follows the survey')
})

test("the planner's write brief carries the survey's context text whole", async (t) => {
  const w = world(t, { known: false, steps: (rig) => ({ ...surveying('survey:p:' + basisOf(rig) + '/'), ...clean() }), writes: { 1: S1 } })
  const out = await w.run()
  assert.equal(out.outcome, 'prepared')
  const text = readFileSync(out.survey.context, 'utf8')
  assert.ok(text.includes('SURVEYED-a9'), 'the fixture: the context holds the surveyed item')
  const [call] = plannerCalls(w.rig)
  assert.ok(call.brief.includes(text.trim()), 'the context file\'s text is in the first prompt')
})

// ================================================================== the pinned tree

test('the survey and the probe search a tree pinned at the nearest integration head', async (t) => {
  const w = world(t, { known: false, steps: (rig) => ({ ...surveying('survey:p:' + basisOf(rig) + '/'), ...clean() }), writes: { 1: S1 } })
  const root = w.rig.worktreeOf('.')
  writeFileSync(join(root, 'changed.txt'), 'a change since the base\n')
  w.rig.git('-C', root, 'add', '-A')
  w.rig.git('-C', root, 'commit', '-qm', 'a change since the base')
  const head = w.rig.git('rev-parse', w.rig.branchOf('.'))
  const basis = basisOf(w.rig)
  assert.equal((await w.run()).outcome, 'prepared')
  const ground = stepValue(w.rig, 'survey:p:' + basis + '/ground')
  assert.deepEqual(ground.rows.filter((r) => r.kind === 'change').map((r) => r.key), ['changed.txt'], 'the survey was handed the change from the base to the pinned head')
  assert.equal(stepValue(w.rig, 'tree:p:' + basis), head, "p has no branch yet, so the root's head is pinned")
  assert.equal(w.rig.git('-C', pinOf(w.rig, head), 'rev-parse', 'HEAD'), head)
  for (const prefix of ['survey:p:' + basis + '/', 'probe:p:1/']) {
    assert.deepEqual([...searchedUnder(w.rig, prefix)], [posix(pinOf(w.rig, head))], prefix + ' searched the pinned tree')
  }
})

test('a relaunch after the branch moved still searches the journaled sha', async (t) => {
  const writes = { 1: S1 }
  const w = world(t, { steps: clean(), writes, trap: (call) => call.thread.key === 'probe:p:1/prober:1' })
  await assert.rejects(w.run(), /the runner was cut off at probe:p:1\/prober:1/)
  const basis = basisOf(w.rig)
  const pinned = stepValue(w.rig, 'tree:p:' + basis)
  w.rig.git('-C', w.rig.worktreeOf('.'), 'commit', '--allow-empty', '-qm', 'a leaf merged meanwhile')
  const moved = w.rig.git('rev-parse', w.rig.branchOf('.'))
  assert.notEqual(moved, pinned, 'the fixture: the root branch moved')
  rmSync(pinOf(w.rig, pinned), { recursive: true, force: true })
  const again = w.rig.relaunch()
  const out = await planFolder(playing(again, writes, null), again.xc, { folder: 'p' })
  assert.equal(out.outcome, 'prepared')
  assert.equal(stepValue(again, 'tree:p:' + basis), pinned)
  assert.ok(existsSync(pinOf(again, pinned)), 'a pinned tree deleted after the step is made again at the journaled sha')
  assert.ok(!existsSync(pinOf(again, moved)), 'nothing was pinned at the moved head')
})

test('a retried folder pins the head it is planned on now', async (t) => {
  const w = world(t, { steps: { ...planner(written, written, written), ...probing(3, S1) }, writes: { 1: BAD, 3: S1 } })
  assert.equal((await w.run()).outcome, 'stopped')
  const before = stepValue(w.rig, 'tree:p:' + basisOf(w.rig))
  w.rig.git('-C', w.rig.worktreeOf('.'), 'commit', '--allow-empty', '-qm', 'a leaf merged meanwhile')
  append(w.rig.repo, E, 'events', [{ kind: 'replanned', node: 'p', execution: w.rig.stamp, reason: 'retry_escalated', by: 'session' }])
  assert.equal((await w.run()).outcome, 'prepared')
  const retried = w.rig.log.entries().filter((e) => e.kind === 'step' && e.key.startsWith('tree:p:') && e.key.includes(':retry:'))
  assert.equal(retried.length, 1)
  assert.equal(retried[0].value, w.rig.git('rev-parse', w.rig.branchOf('.')))
  assert.notEqual(retried[0].value, before)
})

// ================================================================== settling the review

test("fresh findings go to the planner's own session as a findings message, and its dispositions are recorded", async (t) => {
  const w = world(t, {
    steps: { ...planner(written, settled(['P1', 'incorporated'])), ...probing(1, S1, [GAP]), ...probing(2, S2) },
    writes: { 1: S1, 2: S2 },
  })
  const out = await w.run()
  assert.deepEqual(out, { outcome: 'prepared', survey: null })
  const record = stepValue(w.rig, 'probe:p:1/record')
  const fresh = findingsIn(record.findings_file)
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0].id, 'P1')
  assert.equal(fresh[0].claim, GAP.claim)
  const sent = messages(w.rig, 'findings')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].round, 2)
  assert.deepEqual(sent[0].payload, { findings: fresh })
  const [write, settle, ...rest] = plannerCalls(w.rig)
  assert.equal(rest.length, 0)
  assert.equal(settle.resume, true)
  assert.equal(settle.thread.session, write.thread.session)
  assert.deepEqual(settle.schema, schemaOf('planner_settle'))
  assert.ok(settle.carries.includes(sent[0].seq))
  assert.ok(settle.brief.includes(renderMessage({ msg: 'findings', payload: sent[0].payload })))
  const dispositions = ledger(w.rig, 'disposition')
  assert.equal(dispositions.length, 1)
  assert.equal(dispositions[0].outcome, 'incorporated')
  assert.equal(dispositions[0].by, 'planner')
  assert.equal(dispositions[0].finding, record.findings[0].item)
  assert.equal(ledger(w.rig, 'reviewed').length, 2)
  assert.equal(ledger(w.rig, 'prepared').length, 1)
})

test("the re-review after an edit is narrowed to the round before's snapshot", async (t) => {
  const w = world(t, {
    steps: { ...planner(written, settled(['P1', 'incorporated'])), ...probing(1, S1, [GAP]), ...probing(2, S2) },
    writes: { 1: S1, 2: S2 },
  })
  assert.equal((await w.run()).outcome, 'prepared')
  const first = stepValue(w.rig, 'probe:p:1/scope')
  const second = stepValue(w.rig, 'probe:p:2/scope')
  assert.equal(first.full, true)
  assert.equal(first.since, '', 'the first round reads from nothing')
  assert.equal(second.full, false, 'the second round is narrowed')
  assert.equal(second.since, first.snapshot)
  assert.notEqual(second.snapshot, first.snapshot)
  const [prepared] = ledger(w.rig, 'prepared')
  assert.equal(prepared.review, stepValue(w.rig, 'probe:p:2/record').return, 'the preparation names round 2\'s review')
  assert.notEqual(prepared.review, stepValue(w.rig, 'probe:p:1/record').return)
})

test("the planner's session is resumed for every message on its folder", async (t) => {
  const w = world(t, {
    steps: {
      ...planner(written, written, settled(), settled(['P1', 'incorporated'])),
      ...probing(2, S1, [GAP]), ...probing(4, S2),
    },
    writes: { 1: BAD, 2: S1, 4: S2 },
  })
  const out = await w.run()
  assert.equal(out.outcome, 'prepared')
  const calls = plannerCalls(w.rig)
  assert.equal(calls.length, 4)
  assert.deepEqual(calls.map((c) => c.round), [1, 2, 3, 4])
  assert.deepEqual(calls.map((c) => c.resume), [false, true, true, true])
  for (const call of calls) assert.equal(call.thread.session, calls[0].thread.session, 'round ' + call.round)
  const problems = messages(w.rig, 'problems')
  const findings = messages(w.rig, 'findings')
  const refusals = messages(w.rig, 'refusals')
  assert.deepEqual([problems.length, findings.length, refusals.length], [1, 1, 1])
  assert.deepEqual(calls[1].carries, [problems[0].seq])
  assert.deepEqual(calls[2].carries, [findings[0].seq])
  assert.deepEqual(calls[3].carries, [refusals[0].seq])
  assert.deepEqual([problems[0].round, findings[0].round, refusals[0].round], [2, 3, 4])
  assert.ok(calls[3].brief.includes(renderMessage({ msg: 'refusals', payload: refusals[0].payload })))
  assert.deepEqual(calls[1].schema, schemaOf('planner_write'))
  assert.deepEqual(calls[2].schema, schemaOf('planner_settle'))
  assert.deepEqual(calls[3].schema, schemaOf('planner_settle'))
})

test('a discard refused once, then incorporated, is reviewed again and prepared', async (t) => {
  const w = world(t, {
    steps: {
      ...planner(written, settled(['P1', 'discarded']), settled(['P1', 'incorporated'])),
      ...probing(1, S1, [GAP]), ...probing(3, S2),
    },
    writes: { 1: S1, 3: S2 },
  })
  const out = await w.run()
  assert.equal(out.outcome, 'prepared')
  assert.equal(messages(w.rig, 'refusals').length, 1)
  const dispositions = ledger(w.rig, 'disposition')
  assert.equal(dispositions.length, 1)
  assert.equal(dispositions[0].outcome, 'incorporated')
  assert.equal(ledger(w.rig, 'reviewed').length, 2)
  const [prepared] = ledger(w.rig, 'prepared')
  assert.equal(prepared.review, stepValue(w.rig, 'probe:p:3/record').return)
  assert.equal(plannerCalls(w.rig).length, 3)
})

test('a discarded ambiguity is refused once, and discarded again escalates review_not_converging', async (t) => {
  const w = world(t, {
    steps: { ...planner(written, settled(['P1', 'discarded']), settled(['P1', 'discarded'])), ...probing(1, S1, [AMBIGUITY]) },
    writes: { 1: S1 },
  })
  const out = await w.run()
  assert.equal(out.outcome, 'stopped')
  assert.deepEqual(escalations(w.rig).map((e) => e.reason), ['review_not_converging'])
  assert.equal(messages(w.rig, 'refusals').length, 1)
  assert.equal(ledger(w.rig, 'disposition').length, 0)
  assert.equal(ledger(w.rig, 'prepared').length, 0)
  assert.equal(nodeOf(w.rig, 'p/x'), undefined, 'p/x was never compiled')
  assert.equal(nodeOf(w.rig, 'p').kind, 'design')
})

test('a finding back unchanged after it was incorporated escalates review_not_converging', async (t) => {
  const again = { ...GAP, claim: GAP.claim.toUpperCase().replace(/ /g, '  '), start: lineOf(S2, DESIGN_B), end: lineOf(S2, DESIGN_B) }
  const w = world(t, {
    steps: { ...planner(written, settled(['P1', 'incorporated'])), ...probing(1, S1, [GAP]), ...probing(2, S2, [again]) },
    writes: { 1: S1, 2: S2 },
  })
  const out = await w.run()
  assert.equal(out.outcome, 'stopped')
  assert.deepEqual(escalations(w.rig).map((e) => e.reason), ['review_not_converging'])
  assert.equal(ledger(w.rig, 'prepared').length, 0)
  assert.equal(under(w.rig, 'probe:p:2/').length > 0, true, 'the fixture: round 2 ran')
})

test('an ambiguity incorporated by an edit elsewhere keeps the gate shut, and the round that edited nothing escalates review_not_converging naming it', async (t) => {
  const w = world(t, {
    steps: { ...planner(written, settled(['P1', 'incorporated'])), ...probing(1, S1, [AMBIGUITY]), ...probing(2, S2) },
    writes: { 1: S1, 2: S2 },
  })
  const out = await w.run()
  assert.equal(out.outcome, 'stopped')
  const stops = escalations(w.rig)
  assert.deepEqual(stops.map((e) => e.reason), ['review_not_converging'])
  const dispositions = ledger(w.rig, 'disposition')
  assert.equal(dispositions.length, 1, 'round 2 carries the ambiguity, and nothing is settled again')
  assert.ok(String(stops[0].detail).includes(dispositions[0].finding), 'the detail names the ambiguity\'s item: ' + stops[0].detail)
  assert.equal(plannerCalls(w.rig).length, 2)
  assert.equal(ledger(w.rig, 'reviewed').length, 2)
  assert.equal(ledger(w.rig, 'prepared').length, 0)
})

test('a settle whose edit states a decision parks the folder before another probe', async (t) => {
  const stating = folderSpec({ design: DESIGN_B, decisions: [['p.D1', 'keep it in memory']] })
  const w = world(t, {
    steps: { ...planner(written, settled(['P1', 'incorporated'])), ...probing(1, S1, [GAP]), ...probing(2, stating) },
    writes: { 1: S1, 2: stating },
  })
  const out = await w.run()
  assert.equal(out.outcome, 'stopped')
  assert.deepEqual(parks(w.rig).map((e) => e.return), ['needs_decision'])
  assert.equal(under(w.rig, 'probe:p:2/').length, 0, 'no second probe round')
  assert.equal(ledger(w.rig, 'reviewed').length, 1)
  assert.equal(ledger(w.rig, 'prepared').length, 0)
})

test('a carried finding a disposition settled is not settled again', async (t) => {
  const w = world(t, {
    steps: { ...planner(written, settled(['P1', 'incorporated'])), ...probing(1, S1, [GAP_INTENT]), ...probing(2, S2) },
    writes: { 1: S1, 2: S2 },
  })
  const out = await w.run()
  assert.equal(out.outcome, 'prepared')
  assert.equal(plannerCalls(w.rig).length, 2, 'one settle call in all')
  assert.equal(ledger(w.rig, 'disposition').length, 1)
  assert.equal(messages(w.rig, 'findings').length, 1)
  const second = stepValue(w.rig, 'probe:p:2/record')
  assert.ok(second.findings.some((f) => f.carried), 'the fixture: round 2 carries the gap whose line the edit left')
  assert.equal(ledger(w.rig, 'reviewed').length, 2)
  assert.equal(ledger(w.rig, 'prepared').length, 1)
})

test('a round whose prober returned nothing holds the folder on a role fault and records no round', async (t) => {
  const steps = { ...planner(written), ...probing(1, S1), 'analyst||probe:p:1/prober:1': [hostError] }
  const w = world(t, { steps, writes: { 1: S1 } })
  const out = await w.run()
  assert.equal(out.outcome, 'faulted')
  assert.equal(faults(w.rig, 'role').length, 1)
  assert.equal(faults(w.rig).length, 1)
  assert.equal(ledger(w.rig, 'reviewed').length, 0)
  assert.equal(escalations(w.rig).length, 0)
  assert.equal(ledger(w.rig, 'prepared').length, 0)
})

test('a probe that throws rejects planFolder, recording no round', async (t) => {
  const w = world(t, {
    steps: clean(), writes: { 1: S1 }, trap: (call) => call.thread.key === 'probe:p:1/prober:1',
  })
  await assert.rejects(w.run(), /the runner was cut off at probe:p:1\/prober:1/)
  assert.equal(ledger(w.rig, 'reviewed').length, 0)
  assert.equal(ledger(w.rig, 'prepared').length, 0)
})

test('a settle dispatch that fails is a fault on the folder, recording no disposition', async (t) => {
  const w = world(t, { steps: { ...planner(written, hostError), ...probing(1, S1, [GAP]) }, writes: { 1: S1 } })
  const out = await w.run()
  assert.equal(out.outcome, 'faulted')
  assert.equal(faults(w.rig, 'host_error').length, 1)
  assert.equal(ledger(w.rig, 'disposition').length, 0)
  assert.equal(escalations(w.rig).length, 0)
  assert.equal(ledger(w.rig, 'prepared').length, 0)
})

test('a settle that needs a decision parks the folder on its dispatch', async (t) => {
  const asking = { output: { status: 'needs_decision', text: 'Which of the two readings is meant?' } }
  const w = world(t, { steps: { ...planner(written, asking), ...probing(1, S1, [GAP]) }, writes: { 1: S1 } })
  const out = await w.run()
  assert.equal(out.outcome, 'stopped')
  const stops = parks(w.rig)
  assert.deepEqual(stops.map((e) => e.return), ['needs_decision'])
  assert.equal(stops[0].said, dispatchKey({ node: 'p', role: 'planner', thread: 'planner:p', round: 2 }))
  assert.equal(ledger(w.rig, 'disposition').length, 0)
  assert.equal(ledger(w.rig, 'prepared').length, 0)
})

// ================================================================== preparing

test('a compile refusal at preparation escalates compile_refused', async (t) => {
  const refused = folderSpec({ after: ' · after: /nowhere' })
  const w = world(t, { steps: clean(refused), writes: { 1: refused } })
  const out = await w.run()
  assert.equal(out.outcome, 'stopped')
  assert.deepEqual(escalations(w.rig).map((e) => e.reason), ['compile_refused'])
  assert.equal(nodeOf(w.rig, 'p').kind, 'design')
})

test('a folder compiled with nothing beneath it escalates planner_wrote_nothing', async (t) => {
  const empty = folderSpec({ plan: ['- **x** — deferred', '  Later.'] })
  const w = world(t, { steps: clean(empty), writes: { 1: empty } })
  const out = await w.run()
  assert.equal(out.outcome, 'stopped')
  assert.equal(ledger(w.rig, 'prepared').length, 1)
  assert.deepEqual(escalations(w.rig).map((e) => e.reason), ['planner_wrote_nothing'])
})

// ================================================================== answering a request

/** An unknown-ground world whose p is planned already (so `p/x` is its leaf): a request is never surveyed. */
const planned = (t, over = {}) => world(t, { known: false, planned: folderSpec(), ...over })
const request = (status, text, paths = []) => ({ node: 'p/x', status, text, paths })

test('a needs_context request reaches the planner as a needs_context message, and the edit that answers it is reviewed and prepared', async (t) => {
  const answer = folderSpec({ title: 'Add x, returning an empty result for empty input.' })
  const w = planned(t, { steps: clean(answer), writes: { 1: answer } })
  const before = nodeOf(w.rig, 'p/x').seq
  const ask = request('needs_context', 'What does x return for empty input?')
  const out = await w.run({ request: ask })
  assert.deepEqual(out, { outcome: 'prepared', survey: null })
  const sent = messages(w.rig, 'needs_context')
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].payload, { node: 'p/x', text: ask.text })
  const [call] = plannerCalls(w.rig)
  assert.ok(call.carries.includes(sent[0].seq), 'the first call carries the message')
  assert.ok(call.brief.includes(renderMessage({ msg: 'needs_context', payload: sent[0].payload })))
  assert.equal(under(w.rig, 'survey:').length, 0)
  const reviewed = ledger(w.rig, 'reviewed')
  assert.equal(reviewed.length, 1)
  assert.equal(reviewed[0].hash, hashSpec(answer))
  assert.equal(ledger(w.rig, 'prepared').length, 1)
  assert.ok(nodeOf(w.rig, 'p/x').seq > before, 'p/x has a new revision')
})

test("an answered needs_context leaves the asker's thread brief changed, so its next resume carries brief_changed", async (t) => {
  const answer = folderSpec({ title: 'Add x, returning an empty result for empty input.' })
  const producer = { role: 'implementer', schema: 'producer', thread: 'producer:p/x', node: 'p/x' }
  const done = { output: { status: 'done', text: 'finished' } }
  const w = planned(t, { steps: { ...clean(answer), 'implementer|p/x|producer:p/x': [done, done] }, writes: { 1: answer } })
  const open = (rig) => leafBrief(rig.repo, E, 'p/x', { worktree: rig.worktreeOf('p/x'), commands: commandsOf(rig.repo, E) })
  const before = open(w.rig)
  const first = await dispatch(w.rig.ctx, { ...producer, round: 1, threadBrief: before.text, briefParts: before.parts })
  assert.equal(first.status, 'returned')
  const out = await w.run({ request: request('needs_context', 'What does x return for empty input?') })
  assert.equal(out.outcome, 'prepared')
  const after = open(w.rig)
  assert.notEqual(after.digest, before.digest, 'the answer moved the leaf\'s brief')
  const next = await dispatch(w.rig.ctx, { ...producer, round: 2, threadBrief: after.text, briefParts: after.parts })
  assert.equal(next.status, 'returned')
  const changed = messages(w.rig, 'brief_changed', 'producer:p/x')
  assert.equal(changed.length, 1)
  assert.ok(changed[0].payload.changed.includes('Task'), JSON.stringify(changed[0].payload.changed))
  const call = w.rig.calls.filter((c) => c.role.name === 'implementer').pop()
  assert.ok(call.carries.includes(changed[0].seq), 'the resumed dispatch carries the message')
})

test('a needs_locus request reaches the planner as a needs_locus message naming its paths', async (t) => {
  const answer = folderSpec({ locus: 'src/x.mjs, src/y.mjs, test/x.test.mjs' })
  const w = planned(t, { steps: clean(answer), writes: { 1: answer } })
  const ask = request('needs_locus', 'x also reads and writes src/y.mjs', ['src/y.mjs'])
  const out = await w.run({ request: ask })
  assert.equal(out.outcome, 'prepared')
  const sent = messages(w.rig, 'needs_locus')
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].payload, { node: 'p/x', paths: ['src/y.mjs'], why: ask.text })
  const [call] = plannerCalls(w.rig)
  assert.ok(call.carries.includes(sent[0].seq))
  assert.ok(call.brief.includes(renderMessage({ msg: 'needs_locus', payload: sent[0].payload })))
  assert.ok(nodeOf(w.rig, 'p/x').locus.includes('src/y.mjs'), 'p/x has the widened locus')
  assert.equal(ledger(w.rig, 'prepared').length, 1)
})

test("a decompose request is answered from the planner's answer brief, reviewed, prepared and compiled into the split", async (t) => {
  const w = planned(t, { steps: clean(SPLIT), writes: { 1: SPLIT } })
  const before = readSpec(w.rig)
  const ask = request('decompose', 'x is two functions: split it into x1 and x2')
  const out = await w.run({ request: ask })
  assert.equal(out.outcome, 'prepared')
  const [call] = plannerCalls(w.rig)
  sameBrief(call.brief, briefFor(w.rig, { mode: 'answer', spec: before, request: { node: 'p/x', status: 'decompose', text: ask.text } }))
  assert.ok(call.brief.includes(ask.text) && call.brief.includes('decompose'))
  assert.deepEqual(call.carries, [])
  assert.equal(messages(w.rig).length, 0, 'an answer brief is no message')
  assert.equal(ledger(w.rig, 'reviewed').length, 1)
  assert.equal(ledger(w.rig, 'prepared').length, 1)
  assert.equal(liveNode(w.rig, 'p/x1').kind, 'leaf')
  assert.equal(liveNode(w.rig, 'p/x2').kind, 'leaf')
  assert.equal(liveNode(w.rig, 'p/x'), null, 'p/x is retired')
})

test('a replan that leaves the leaf as it was escalates replan_not_converging on the leaf', async (t) => {
  const untouched = folderSpec({ design: 'A design paragraph that says nothing about the split.' })
  const w = planned(t, { steps: clean(untouched), writes: { 1: untouched } })
  const before = nodeOf(w.rig, 'p/x').seq
  const out = await w.run({ request: request('decompose', 'x is two functions: split it') })
  assert.equal(out.outcome, 'stopped')
  assert.deepEqual(escalations(w.rig, 'p/x').map((e) => e.reason), ['replan_not_converging'])
  assert.equal(nodeOf(w.rig, 'p/x').seq, before, 'the fixture: p/x is as it was')
})

test('a needs_context answered without changing the asking leaf escalates replan_not_converging on the leaf', async (t) => {
  const untouched = folderSpec({ design: 'A design paragraph that answers nothing about x.' })
  const w = planned(t, { steps: clean(untouched), writes: { 1: untouched } })
  const out = await w.run({ request: request('needs_context', 'What does x return for empty input?') })
  assert.equal(out.outcome, 'stopped')
  assert.deepEqual(escalations(w.rig, 'p/x').map((e) => e.reason), ['replan_not_converging'])
})

test('a verify finding on a planner folder is replanned in its own spec and reviewed again', async (t) => {
  const answer = folderSpec({ design: 'A design paragraph that settles the verify finding.' })
  const w = planned(t, { steps: clean(answer), writes: { 1: answer } })
  const before = nodeOf(w.rig, 'p/x').seq
  const was = readSpec(w.rig)
  const ask = request('verify_finding', 'the suite fails on the empty input')
  const out = await w.run({ request: ask })
  assert.equal(out.outcome, 'prepared', 'no replan check on a verify finding')
  const [call] = plannerCalls(w.rig)
  sameBrief(call.brief, briefFor(w.rig, { mode: 'answer', spec: was, request: { node: 'p/x', status: 'verify_finding', text: ask.text } }))
  assert.equal(nodeOf(w.rig, 'p/x').seq, before, 'the fixture: p/x is as it was')
  assert.equal(escalations(w.rig, 'p/x').length, 0)
  const reviewed = ledger(w.rig, 'reviewed')
  assert.equal(reviewed.length, 1)
  assert.equal(reviewed[0].hash, approvalState(w.rig.repo, E, 'p').hash)
  assert.equal(ledger(w.rig, 'prepared').length, 1)
})

test('a spec_changed park on a planner folder is re-derived from its spec as it stands, and prepared', async (t) => {
  const w = planned(t, { steps: clean(folderSpec()), writes: {} })
  recordAll(w.rig.xc, [parked('p', 'spec_changed', 'the spec changed after work under it was dispatched')])
  assert.equal(readTree(w.rig.repo, E).status.get('p').status, 'parked', 'the fixture: p is parked')
  const was = readSpec(w.rig)
  const out = await w.run()
  assert.deepEqual(out, { outcome: 'prepared', survey: null })
  const [call] = plannerCalls(w.rig)
  assert.ok(call.brief.includes('spec_changed'))
  assert.ok(call.brief.includes(was.trim()), 'the prompt holds the spec as it stands')
  sameBrief(call.brief, briefFor(w.rig, { mode: 'write', why: 'spec_changed', spec: was }))
  assert.equal(under(w.rig, 'survey:').length, 0, 'the ground is unknown, and a re-derivation is not surveyed')
  assert.equal(ledger(w.rig, 'prepared').length, 1)
})

// ================================================================== beyond the acceptance lines

test('planner rounds run on from the thread\'s latest round in the execution', async (t) => {
  // Each answer retitles p/x, so the asking leaf's revision moves: the second invocation has another
  // basis (the same request over the leaf as it now stands), so it is a new plan and not a relaunch.
  const first = folderSpec({ title: 'Add x, first answer to the verify finding.' })
  const second = folderSpec({ title: 'Add x, second answer to the verify finding.' })
  const w = planned(t, { steps: { ...planner(written, written), ...probing(1, first), ...probing(2, second) }, writes: { 1: first, 2: second } })
  const ask = request('verify_finding', 'the suite fails')
  const before = nodeOf(w.rig, 'p/x').seq
  assert.equal((await w.run({ request: ask })).outcome, 'prepared')
  const between = nodeOf(w.rig, 'p/x').seq
  assert.ok(between > before, 'the fixture: the first answer moved the asking leaf\'s revision')
  assert.equal((await w.run({ request: ask })).outcome, 'prepared')
  assert.ok(nodeOf(w.rig, 'p/x').seq > between, 'the fixture: so did the second')
  const calls = plannerCalls(w.rig)
  assert.deepEqual(calls.map((c) => c.round), [1, 2])
  assert.equal(calls[1].resume, true, 'the second plan resumes the thread')
  assert.equal(calls[1].thread.session, calls[0].thread.session)
  assert.equal(stepValue(w.rig, 'probe:p:2/scope').full, true, 'the first round of a run reads from nothing')
  assert.ok(under(w.rig, 'probe:p:2/').length > 0)
})

test('a boundary that refuses the round is a program fault on the folder', async (t) => {
  const moved = folderSpec({ design: 'The planner moved the spec under the prober.' })
  const w = world(t, {
    steps: clean(), writes: { 1: S1 },
    trap: (call, rig) => {
      if (call.thread.key === 'probe:p:1/prober:1') putSpec(rig, moved)
      return false
    },
  })
  const out = await w.run()
  assert.equal(out.outcome, 'faulted')
  assert.equal(faults(w.rig, 'program').length, 1)
  assert.equal(ledger(w.rig, 'prepared').length, 0)
})

// ================================================================== relaunch

test('a relaunch mid-review repeats no recorded round', async (t) => {
  const writes = { 1: S1, 2: S2 }
  const steps = { ...planner(written, settled(['P1', 'incorporated'])), ...probing(1, S1, [GAP]), ...probing(2, S2) }
  const w = world(t, { steps, writes, trap: (call) => call.thread.key === 'probe:p:2/prober:1' })
  await assert.rejects(w.run(), /the runner was cut off at probe:p:2\/prober:1/)
  assert.equal(ledger(w.rig, 'reviewed').length, 1, 'the fixture: round 1 was recorded before the cut')
  const again = w.rig.relaunch()
  const out = await planFolder(playing(again, writes, null), again.xc, { folder: 'p' })
  assert.deepEqual(out, { outcome: 'prepared', survey: null })
  assert.deepEqual(again.calls.map((c) => c.thread.key), ['probe:p:2/prober:1'], 'the relaunch calls only the prober that never returned')
  assert.equal(ledger(again, 'reviewed').length, 2)
  assert.equal(ledger(again, 'disposition').length, 1)
  assert.equal(messages(again, 'findings').length, 1)
  const prepared = ledger(again, 'prepared')
  assert.equal(prepared.length, 1)
  assert.equal(prepared[0].review, stepValue(again, 'probe:p:2/record').return)
})
