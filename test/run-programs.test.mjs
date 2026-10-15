// test/run-programs.test.mjs — every program behind lib/run.mjs: its arguments resolved from the
// flags a skill types, each absent one to its default; its run claimed on the scope its scopeOf
// states; and an attached run's result written whole, with its coverage, run and cost. A claim is
// read from a detached start whose child is a stand-in that never runs; a result from an attached
// run over the scripted runner, on a path that dispatches nothing where the program has one.
//
// Design: docs/DESIGN.md#programs and docs/DESIGN.md#program-results.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readRunLog } from '../lib/ledger.mjs'
import { fnv1a } from '../lib/plan-digest.mjs'
import { loadRole, tierFor } from '../lib/roles.mjs'
import { launch } from '../lib/run.mjs'
import { ARGS as SURVEY_ARGS } from '../lib/programs/survey.mjs'
import { posix, readJson, resultPath, revParse, runJsonPath, specPath } from '../lib/store.mjs'
import { closedSearch } from './harness/navigator.mjs'
import { programRig } from './harness/program-rig.mjs'
import { scriptedRunner } from './fast/harness/scripted-runner.mjs'

const NOW = new Date('2026-01-01T00:00:00.000Z')
const QUESTION = 'Where is the store written?'
const CAPABILITY = 'Rate limiting per key'
const DOC = '# Limiter\n\n## Design\nA token bucket per key.\n'
const CRITERIA = '- [ ] the limiter refuses the eleventh call\n'
const GUIDE = 'GUIDETOKEN: cite every claim by path and line.'
const ROOT_SPEC = readFileSync(fileURLToPath(new URL('./fixtures/compile/root.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
const FILES = {
  'CLAUDE.md': '# Guide\n\n' + GUIDE + '\n', 'q.md': QUESTION + '\n', 'q-crlf.md': '\r\n' + QUESTION + '\r\n\r\n', 'cap.md': CAPABILITY + '\n',
  'doc.md': DOC, 'criteria.md': CRITERIA, 'blank.md': '\n',
  'prior.md': 'what the earlier pass found\r\n',
}
const PROBE_SCRIPT = {
  ...closedSearch({ name: 'locate', asks: ['guidance', 'ground:design'] }),
  'analyst||prober:1': [{ output: { findings: [], units: [], notes: '', stop_reason: 'exhausted', not_reached: '' } }],
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim()
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]))

function rigOf(t) {
  const rig = programRig({ files: FILES })
  t.after(() => rig.cleanup())
  return rig.repo
}

/** The `e1` effort with its root spec written and never approved. */
function withSpec(repo) {
  mkdirSync(dirname(specPath(repo, 'e1', '.')), { recursive: true })
  writeFileSync(specPath(repo, 'e1', '.'), ROOT_SPEC)
}

/** A detached start whose child never runs: what the claim resolved and wrote to run.json. `flags` may be a function of the repository. */
async function claimed(t, program, flags, { setup = () => {} } = {}) {
  const repo = rigOf(t)
  setup(repo)
  const out = await launch({
    argv: [program, '--detach', ...(typeof flags === 'function' ? flags(repo) : flags)], cwd: repo, env: {}, now: () => NOW,
    runner: () => { throw new Error('a detached start runs nothing here') }, spawnChild: () => process.pid,
  })
  assert.equal(out.ok, true, JSON.stringify(out))
  return { repo, out, meta: readJson(runJsonPath(repo, out.run)) }
}

/** An attached start over the scripted runner, and the calls it dispatched. */
async function attached(t, program, flags, { script = {}, setup = () => {} } = {}) {
  const repo = rigOf(t)
  setup(repo)
  let runner = null
  const out = await launch({
    argv: [program, ...flags], cwd: repo, env: {}, now: () => NOW, heartbeatMs: 20,
    runner: ({ log }) => (runner = scriptedRunner(script, { log })).runAgent,
  })
  return { repo, out, calls: runner ? runner.calls : [] }
}

/** The run wrote its result whole: the printed result, with its run, a coverage block resumable as the run, and its cost. */
async function assertResultWritten(t, program, flags, opts) {
  const { repo, out, calls } = await attached(t, program, flags, opts)
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.result_file, resultPath(repo, out.run))
  const written = readJson(out.result_file)
  assert.deepEqual(written, out.result)
  assert.equal(written.run, out.run)
  const meta = readJson(runJsonPath(repo, out.run))
  assert.equal(typeof written.coverage.complete, 'boolean')
  assert.deepEqual(written.coverage.resumable, { program, scope: meta.scope, args: meta.raw })
  const returned = readRunLog(repo, out.run).entries.filter((e) => e.kind === 'returned')
  assert.equal(written.cost.dispatches, returned.length)
  assert.equal(written.cost.unmeasured, returned.filter((e) => typeof e.cost_usd !== 'number').length)
  assert.equal(typeof written.cost.tokens, 'number')
  assert.equal(typeof written.cost.usd, 'number')
  return { repo, written, calls }
}

// ------------------------------------------------------------------ survey

test('survey: an absent flag takes its default', async (t) => {
  const { repo, meta } = await claimed(t, 'survey', ['--question-file', 'q.md'])
  assert.deepEqual(pick(meta.args, ['question_file', 'question', 'roots', 'notes', 'prior', 'max_topics', 'intelligence', 'pace', 'ground']), {
    question_file: resolve(repo, 'q.md'), question: QUESTION, roots: ['.'], notes: '', prior: '', max_topics: 8, intelligence: 'normal',
    pace: 'balanced', ground: [],
  })
})

test('survey: every flag resolves', async (t) => {
  const { meta } = await claimed(t, 'survey', [
    '--question-file', 'q.md', '--roots', 'src,lib', '--notes', 'the notes', '--prior-file', 'prior.md', '--max-topics', '3',
    '--intelligence', 'max', '--pace', 'fast', '--ground', 'src/a.js,src/b.js',
  ])
  assert.deepEqual(pick(meta.args, ['roots', 'notes', 'prior', 'max_topics', 'intelligence', 'pace', 'ground']), {
    roots: ['src', 'lib'], notes: 'the notes', prior: 'what the earlier pass found', max_topics: 3, intelligence: 'max', pace: 'fast', ground: ['src/a.js', 'src/b.js'],
  })
})

test("survey: the run is claimed on the question's digest, its roots and its ground", async (t) => {
  const { meta } = await claimed(t, 'survey', ['--question-file', 'q.md', '--roots', 'src', '--ground', 'src/a.js'])
  assert.deepEqual(meta.scope, { question: fnv1a(QUESTION), roots: ['src'], ground: ['src/a.js'] })
})

test('survey: an attached run writes its result with coverage, run and cost', async (t) => {
  await assertResultWritten(t, 'survey', ['--question-file', 'blank.md'])
})

test('run.mjs starts a survey from its question file with every default', async (t) => {
  const { out, calls } = await attached(t, 'survey', ['--question-file', 'q-crlf.md'], {
    script: { 'analyst||plan': [{ output: { topics: [], common_ground: '', history_question: '', docs_question: '' } }] },
  })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.result.question, QUESTION)
  assert.deepEqual(out.result.ground, [])
  assert.deepEqual(calls.map((c) => c.thread.key), ['plan'])
  const [plan] = calls
  assert.deepEqual(plan.tier, tierFor(loadRole('analyst').role, { intelligence: 'normal', base: 'medium' }))
  assert.ok(plan.brief.includes('aim for at most ' + SURVEY_ARGS.max_topics.default + '.'), 'max_topics defaults to its ARGS default')
  assert.ok(plan.brief.includes(GUIDE), "roots default to the repository, whose CLAUDE.md is the guidance")
})

// ------------------------------------------------------------------ probe

test('probe: an absent flag takes its default', async (t) => {
  const { repo, meta } = await claimed(t, 'probe', ['--artifact', 'doc.md'])
  assert.deepEqual(pick(meta.args, ['artifact', 'artifact_text', 'roots', 'context', 'per_axis', 'since']), {
    artifact: resolve(repo, 'doc.md'), artifact_text: DOC.trim(), roots: ['.'], context: '', per_axis: false, since: '',
  })
})

test('probe: every flag resolves', async (t) => {
  const { meta } = await claimed(t, 'probe', [
    '--artifact', 'doc.md', '--roots', 'src', '--context', 'the limiter design', '--per-axis', '--since', 'snapshot:0a1b2c3d',
  ])
  assert.deepEqual(pick(meta.args, ['roots', 'context', 'per_axis', 'since']), {
    roots: ['src'], context: 'the limiter design', per_axis: true, since: 'snapshot:0a1b2c3d',
  })
})

test("probe: the run is claimed on the artefact's absolute path", async (t) => {
  const { repo, meta } = await claimed(t, 'probe', ['--artifact', 'doc.md'])
  assert.deepEqual(meta.scope, { artifact: posix(resolve(repo, 'doc.md')) })
})

test('probe: an attached run writes its result with coverage, run and cost', async (t) => {
  const { written } = await assertResultWritten(t, 'probe', ['--artifact', 'doc.md'], { script: PROBE_SCRIPT })
  assert.equal(written.cost.dispatches, 4, 'two locate turns, the ruler and the prober')
})

test('run.mjs refuses a probe with no artefact', async (t) => {
  const { out } = await attached(t, 'probe', [])
  assert.deepEqual([out.ok, out.error.kind], [false, 'missing_arg'])
  assert.match(out.error.message, /--artifact/)
})

test('a probe started by run.mjs probes the file it names, under the guidance of the repository root', async (t) => {
  const { written, calls } = await assertResultWritten(t, 'probe', ['--artifact', 'doc.md'], { script: PROBE_SCRIPT })
  assert.equal(written.artifact, 'doc.md')
  const brief = calls.find((c) => c.thread.key === 'prober:1').brief
  for (const line of DOC.trim().split('\n').filter(Boolean)) assert.ok(brief.includes(line), line)
  assert.ok(brief.includes(GUIDE), "the repository root's CLAUDE.md is the guidance")
})

// ------------------------------------------------------------------ solutions

test('solutions: an absent flag takes its default', async (t) => {
  const { repo, meta } = await claimed(t, 'solutions', ['--capability-file', 'cap.md'])
  assert.deepEqual(pick(meta.args, ['capability_file', 'capability', 'roots', 'constraints', 'notes', 'max_angles', 'intelligence']), {
    capability_file: resolve(repo, 'cap.md'), capability: CAPABILITY, roots: ['.'], constraints: '', notes: '', max_angles: 4, intelligence: 'normal',
  })
})

test('solutions: every flag resolves', async (t) => {
  const { meta } = await claimed(t, 'solutions', [
    '--capability-file', 'cap.md', '--roots', 'src', '--constraints', 'no new dependency', '--notes', 'the notes', '--max-angles', '2',
    '--intelligence', 'low',
  ])
  assert.deepEqual(pick(meta.args, ['roots', 'constraints', 'notes', 'max_angles', 'intelligence']), {
    roots: ['src'], constraints: 'no new dependency', notes: 'the notes', max_angles: 2, intelligence: 'low',
  })
})

test("solutions: the run is claimed on the capability's digest", async (t) => {
  const { meta } = await claimed(t, 'solutions', ['--capability-file', 'cap.md', '--constraints', 'no new dependency'])
  assert.deepEqual(meta.scope, { capability: fnv1a(CAPABILITY) })
})

test('solutions: an attached run writes its result with coverage, run and cost', async (t) => {
  await assertResultWritten(t, 'solutions', ['--capability-file', 'blank.md'])
})

// ------------------------------------------------------------------ investigate

test('investigate: an absent flag takes its default', async (t) => {
  const { repo, meta } = await claimed(t, 'investigate', ['--question-file', 'q.md'])
  assert.deepEqual(pick(meta.args, ['question_file', 'question', 'roots', 'notes', 'as_tasks', 'intelligence', 'pace']), {
    question_file: resolve(repo, 'q.md'), question: QUESTION, roots: ['.'], notes: '', as_tasks: false, intelligence: 'normal', pace: 'balanced',
  })
})

test('investigate: every flag resolves', async (t) => {
  const { meta } = await claimed(t, 'investigate', [
    '--question-file', 'q.md', '--roots', 'src', '--notes', 'the notes', '--as-tasks', '--intelligence', 'max', '--pace', 'frugal',
  ])
  assert.deepEqual(pick(meta.args, ['roots', 'notes', 'as_tasks', 'intelligence', 'pace']), {
    roots: ['src'], notes: 'the notes', as_tasks: true, intelligence: 'max', pace: 'frugal',
  })
})

test("investigate: the run is claimed on the question's digest", async (t) => {
  const { meta } = await claimed(t, 'investigate', ['--question-file', 'q.md', '--roots', 'src'])
  assert.deepEqual(meta.scope, { question: fnv1a(QUESTION) })
})

test('investigate: an attached run writes its result with coverage, run and cost', async (t) => {
  await assertResultWritten(t, 'investigate', ['--question-file', 'blank.md'])
})

// ------------------------------------------------------------------ drafts

test('drafts: an absent flag takes its default', async (t) => {
  const { repo, meta } = await claimed(t, 'drafts', ['--question-file', 'q.md', '--stances', 'minimal-change'])
  assert.deepEqual(pick(meta.args, ['question_file', 'question', 'stances', 'intelligence']), {
    question_file: resolve(repo, 'q.md'), question: QUESTION, stances: ['minimal-change'], intelligence: 'normal',
  })
})

test('drafts: every flag resolves', async (t) => {
  const { meta } = await claimed(t, 'drafts', [
    '--question-file', 'q.md', '--stances', 'minimal-change,long-horizon,adopt-dont-build', '--intelligence', 'max',
  ])
  assert.deepEqual(pick(meta.args, ['stances', 'intelligence']), {
    stances: ['minimal-change', 'long-horizon', 'adopt-dont-build'], intelligence: 'max',
  })
})

test('drafts: a start without --stances is refused missing_arg', async (t) => {
  const { out } = await attached(t, 'drafts', ['--question-file', 'q.md'])
  assert.deepEqual([out.ok, out.error.kind], [false, 'missing_arg'])
  assert.match(out.error.message, /--stances/)
})

test("drafts: the run is claimed on the question's digest", async (t) => {
  const { meta } = await claimed(t, 'drafts', ['--question-file', 'q.md', '--stances', 'long-horizon'])
  assert.deepEqual(meta.scope, { question: fnv1a(QUESTION) })
})

test('drafts: an attached run writes its result with coverage, run and cost', async (t) => {
  await assertResultWritten(t, 'drafts', ['--question-file', 'blank.md', '--stances', 'minimal-change'])
})

// ------------------------------------------------------------------ rule

test('rule: every flag resolves', async (t) => {
  const { repo, out } = await attached(t, 'rule', ['--effort', 'e1', '--folder', '.'], { setup: withSpec })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual(pick(readJson(runJsonPath(repo, out.run)).args, ['effort', 'folder']), { effort: 'e1', folder: '.' })
})

test('rule: the run is claimed on its effort and folder', async (t) => {
  const { meta } = await claimed(t, 'rule', ['--effort', 'e1', '--folder', '.'], { setup: withSpec })
  assert.deepEqual(meta.scope, { effort: 'e1', folder: '.' })
})

test('rule: an attached run writes its result with coverage, run and cost', async (t) => {
  const { written } = await assertResultWritten(t, 'rule', ['--effort', 'e1', '--folder', '.'], { setup: withSpec })
  assert.deepEqual([written.status, written.next], ['refused', 'user_approves'])
})

// ------------------------------------------------------------------ review

test('review: an absent flag takes its default', async (t) => {
  const { repo, meta } = await claimed(t, 'review', ['--base', 'HEAD', '--criteria-file', 'criteria.md'])
  assert.deepEqual(pick(meta.args, ['base', 'criteria_file', 'criteria', 'prior']), {
    base: revParse(repo, 'HEAD'), criteria_file: resolve(repo, 'criteria.md'), criteria: CRITERIA.trim(), prior: '',
  })
})


test('review: the run is claimed on the checkout it reads and the base resolved there', async (t) => {
  const readerOf = (repo) => join(repo, '.claude', 'worktrees', 'reader')
  const { meta, repo } = await claimed(t, 'review', (repo) => ['--root', readerOf(repo), '--base', 'HEAD', '--criteria-file', 'criteria.md'], {
    setup: (repo) => {
      git(repo, 'worktree', 'add', '-q', '--detach', readerOf(repo), 'HEAD')
      writeFileSync(join(readerOf(repo), 'later.md'), 'a later commit\n')
      git(readerOf(repo), 'add', '-A')
      git(readerOf(repo), 'commit', '-q', '-m', 'later')
    },
  })
  assert.notEqual(revParse(readerOf(repo), 'HEAD'), revParse(repo, 'HEAD'))
  assert.deepEqual(meta.scope, { root: posix(readerOf(repo)), base: revParse(readerOf(repo), 'HEAD') })
})

test('review: an attached run writes its result with coverage, run and cost', async (t) => {
  const ruled = { units: [{ unit: 'criterion:1', ruling: 'clean', ids: [], why: 'it refuses the eleventh call' }], findings: [], fix_rulings: [], claims: [], notes: '' }
  const { written } = await assertResultWritten(t, 'review', ['--base', 'HEAD', '--criteria-file', 'criteria.md'], {
    script: { 'reviewer||reviewer': [{ output: ruled }] },
  })
  assert.equal(written.cost.dispatches, 1)
})
