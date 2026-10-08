// test/harness/program-rig.mjs — a program test's world: a temporary git repository holding the
// given files, one run's log over it, and a program context whose runner is the scripted one.
// `relaunch(script)` is the same run started again: a fresh log port and context over the same
// repository, so a test sees exactly what a relaunched program reads back. `executionRig` is the
// same for one execution: an approved, compiled effort, its effort branch, the execution's home,
// log port and boundary context.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { recordApproval } from '../../lib/approval.mjs'
import { writeSessionCommands } from '../../lib/boundaries/execution.mjs'
import { executionContext } from '../../lib/boundaries/records.mjs'
import { compileEffort } from '../../lib/compile.mjs'
import { openEffort } from '../../lib/effort.mjs'
import { ensureIntegration } from '../../lib/integration.mjs'
import { executionLog, runLog } from '../../lib/ledger.mjs'
import { programContext } from '../../lib/programs/common.mjs'
import {
  ROOT_ID, branchOf, configPath, executionDir, mkdirState, specPath, worktreeOf, writeJson,
} from '../../lib/store.mjs'
import { scriptedRunner } from './scripted-runner.mjs'
import { seededRepo } from './seeded-repo.mjs'

const RUN = '20260101-000000-test'
const NOW = () => '2026-01-01T00:00:00.000Z'

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })

export function programRig({ files = {}, script = {}, effort = '', maxAgents = 6, env = {}, config = {} } = {}) {
  const repo = seededRepo('agentics-program-', { message: 'init', files, autocrlf: false })
  if (Object.keys(config).length) writeJson(configPath(repo), config)
  const cleanup = () => rmSync(repo, { recursive: true, force: true })
  const build = (s) => {
    const sleeps = []
    const log = runLog(repo, RUN)
    const runner = scriptedRunner(s, { log, now: NOW })
    const ctx = programContext({
      repo, run: RUN, effort, log, runAgent: runner.runAgent, now: NOW,
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve() },
      env, maxAgents, resumable: { program: 'test', scope: {}, args: {} },
    })
    return { repo, run: RUN, ctx, calls: runner.calls, sleeps, log, relaunch: (next = {}) => build(next), cleanup }
  }
  return build(script)
}

const EFFORT = 'e1'
const STAMP = '20260101-000000'

/** The rig's default root spec: one tdd leaf `a`, writing `src/a.mjs` and its test. */
const RIG_SPEC = [
  '# Add a', '',
  '## Intent', '', 'A function `a` in src.', '',
  '## Decisions', '', '| id | decision | why |', '|---|---|---|', '| D1 | `a` returns 1. | Callers need it. |', '',
  '## Design', '', 'One function in src/a.mjs.', '',
  '## Plan', '',
  '- **a** — task · realises: D1 · rigor: tdd · locus: src/a.mjs, test/a.test.mjs',
  '  Write a',
  '  - [ ] a returns 1 — check: `node --test test/a.test.mjs`', '',
  '## Open questions', '',
  '## Evidence', '', 'None yet.', '',
].join('\n')

/** The commands the session named, as the envelope holds them. */
const RIG_COMMANDS = {
  suite: 'node --test --test-reporter=spec', test_one: 'node --test --test-reporter=spec {file}',
  absent: { build: true, typecheck: true },
}

const RIG_FILES = {
  '.gitignore': '.claude/\n',
  'src/add.mjs': 'export const add = (a, b) => a + b\n',
  'test/add.test.mjs': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\n" +
    "import { add } from '../src/add.mjs'\ntest('adds', () => assert.equal(add(1, 2), 3))\n",
}

/**
 * One execution's world: a temporary repository on `main` holding `src/`, a test and `files`; the
 * effort `e1` whose specs (`spec`: the root spec's text, or `{<folder>: text}` with the root at
 * `.`) are approved and compiled; the effort branch cut at `main`; the execution's home with its
 * `execution.json` (`commands` as the session named them); its log port, its boundary context
 * `xc` and a program context `ctx` over the scripted runner. `script(steps)` replaces the script
 * the runner plays, each key from its first step; `relaunch()` is the program started again: a
 * fresh log port read back from disk, a fresh `xc` and `ctx`, the current script. `git(...args)`
 * runs in the repository and returns its trimmed output. The repository is removed in `t.after`.
 */
export function executionRig(t, { spec = RIG_SPEC, commands = RIG_COMMANDS, files = {}, maxAgents = 6, env = {} } = {}) {
  const repo = seededRepo('agentics-execution-', { branch: 'main', message: 'base', files: { ...RIG_FILES, ...files }, autocrlf: false })
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const inRepo = (...args) => git(repo, ...args).trim()
  const base_sha = inRepo('rev-parse', 'HEAD')

  const opened = openEffort(repo, { slug: EFFORT, about: 'the rig', roots: ['src'], now: new Date(NOW()) })
  if (!opened.ok) throw new Error('executionRig: ' + opened.error)
  const specs = typeof spec === 'string' ? { [ROOT_ID]: spec } : spec
  for (const [id, text] of Object.entries(specs)) {
    mkdirState(dirname(specPath(repo, EFFORT, id)))
    writeFileSync(specPath(repo, EFFORT, id), text)
  }
  const depth = (id) => (id === ROOT_ID ? 0 : id.split('/').length)
  for (const id of Object.keys(specs).sort((a, b) => depth(a) - depth(b))) {
    const out = recordApproval(repo, EFFORT, id)
    if (!out.ok) throw new Error('executionRig: approving ' + id + ': ' + out.error)
  }
  const compiled = compileEffort(repo, EFFORT)
  if (!compiled.ok) throw new Error('executionRig: compile: ' + JSON.stringify(compiled.problems || compiled.error))

  const envelope = { stamp: STAMP, root: ROOT_ID, base_branch: 'main', base_sha, dial: 'normal', pace: 'balanced', commands }
  const dir = executionDir(repo, EFFORT, STAMP)
  mkdirState(dir)
  writeFileSync(join(dir, 'execution.json'), JSON.stringify(envelope, null, 1) + '\n')
  writeSessionCommands(executionContext({ repo, effort: EFFORT, execution: STAMP, log: null }), envelope)
  const branch = ensureIntegration(repo, EFFORT, ROOT_ID, envelope)
  if (!branch.ok) throw new Error('executionRig: the effort branch: ' + branch.error)

  const build = (initial) => {
    let runner = null
    let steps = initial
    const calls = []
    const sleeps = []
    const log = executionLog(repo, EFFORT, STAMP)
    const xc = executionContext({ repo, effort: EFFORT, execution: STAMP, log })
    const ctx = programContext({
      repo, run: EFFORT + '.' + STAMP, effort: EFFORT, log, now: NOW, dir, execution: STAMP,
      runAgent: (call) => { calls.push(call); return runner.runAgent(call) },
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve() },
      env, maxAgents, resumable: { program: 'execute', scope: { effort: EFFORT, folder: ROOT_ID }, args: { effort: EFFORT, folder: ROOT_ID } },
    })
    const script = (next) => { steps = next; runner = scriptedRunner(next, { log, now: NOW }) }
    script(steps)
    return {
      repo, effort: EFFORT, stamp: STAMP, run: ctx.run, dir, base_sha, envelope, log, xc, ctx, calls, sleeps,
      script, relaunch: () => build(steps), git: inRepo,
      branchOf: (id) => branchOf(EFFORT, id), worktreeOf: (id) => worktreeOf(repo, EFFORT, id),
    }
  }
  return build({})
}
