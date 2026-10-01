// test/agentics-develop-nested-e2e.test.mjs — a planner folder executed end to end, nested workflows and all.
//
// test/agentics-develop-e2e.test.mjs runs execute-approved-plan-in-worktrees against the real
// boundaries, but a plan unit there never runs; the scenario suite runs plan units with the survey
// and the autonomous review stubbed. Here every workflow is the real script: the survey a plan unit
// buys, the attack on the spec the planner wrote, and the execution of what the planner planned,
// and every courier in all three really runs its lib command. Only the model agents are scripted,
// each writing what its dispatch names in the shape its prompt demands. A return one workflow
// writes in a shape another's boundary cannot read fails here and nowhere else.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { courierCommand, courierProblems, returnFileOf, runWorkflow } from './harness/workflow-host.mjs'
import { recordApproval } from '../lib/approval.mjs'
import { compileEffort } from '../lib/compile.mjs'
import { readLog } from '../lib/ledger.mjs'
import { specPath } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'

delete process.env.NODE_TEST_CONTEXT

const PLUGIN = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')
const WF = join(PLUGIN, 'service-workflows', 'execute-approved-plan-in-worktrees.workflow.js')
const COMMANDS = {
  suite: 'node --test --test-reporter=spec', test_one: 'node --test --test-reporter=spec {file}',
  absent: { build: true, typecheck: true },
}

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr)
  return r.stdout.trim()
}

const ROOT_SPEC = [
  '# The change', '', '## Intent', '', 'Add x beside hello.', '',
  '## Decisions', '', '| id | decision | why |', '|---|---|---|', '| D1 | x lives beside hello | asked for |', '',
  '## Design', '', 'One sub-effort the planner writes.', '',
  '## Plan', '', '- **p** — sub-effort · realises: D1 · author: planner', '  Build x.', '  The planner writes its spec.', '',
  '## Open questions', '', '## Evidence', '', 'None gathered.', '',
].join('\n')

/** The line the probe reads two ways, and what the settling planner rewrites it to. */
const VAGUE = 'One function.'
const CLEAR = 'One function, x, that takes nothing and returns the number 1.'

const P_SPEC = [
  '# Build x', '', '## Intent', '', 'Build x, as the root plans it.', '',
  '## Decisions', '',
  '## Design', '', VAGUE, '',
  '## Plan', '',
  '- **x** — task · realises: D1 · rigor: tdd · locus: src/x.mjs, test/x.test.mjs',
  '  Add x.', '  Write x and its test.', '  - [ ] x() is 1 — check: `node --test test/x.test.mjs`', '',
  '## Open questions', '', '## Evidence', '', 'The survey\'s.', '',
].join('\n')

const HELLO = "export const hello = () => 'hello'\n"
const CLAIM = 'src/hello.mjs exports hello, which returns the string hello'

/** What the executor of p/x commits. */
const WORK = {
  'test/x.test.mjs': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { x } from '../src/x.mjs'\ntest('x is 1', () => assert.equal(x(), 1))\n",
  'src/x.mjs': 'export const x = () => 1\n',
}

/** A repository whose effort's root plans one sub-effort for the planner, approved and compiled. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-nested-e2e-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 'T')
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'test'))
  writeFileSync(join(dir, '.gitignore'), '.claude/\n')
  writeFileSync(join(dir, 'src', 'hello.mjs'), HELLO)
  writeFileSync(join(dir, 'test', 'base.test.mjs'), "import { test } from 'node:test'\ntest('base', () => {})\n")
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  const root = specPath(dir, 'e1', '.')
  mkdirSync(join(root, '..'), { recursive: true })
  writeFileSync(root, ROOT_SPEC)
  assert.equal(recordApproval(dir, 'e1', '.').ok, true)
  const compiled = compileEffort(dir, 'e1')
  assert.equal(compiled.ok, true, JSON.stringify(compiled.problems))
  return dir
}

const write = (path, value) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}

const match = (re, prompt) => {
  const m = re.exec(prompt)
  if (!m) throw new Error('the prompt does not carry ' + re + ':\n' + prompt)
  return m[1]
}

/**
 * The model agents, each writing what its dispatch names, and every courier running its command.
 * `settle` is how the settling planner answers a finding: 'incorporate' rewrites the line the
 * finding is about, 'discard' leaves the spec alone.
 */
function agents(settle) {
  return (prompt, opts) => {
    const type = String(opts.agentType || '').replace('agentics:', '')
    const label = String(opts.label || '')

    if (type === 'courier') {
      const run = spawnSync('sh', ['-c', courierCommand(prompt)], { encoding: 'utf8', env: { ...process.env, AGENTICS_INLINE_JOBS: '1' } })
      return { stop_reason: run.status === 0 ? 'carried' : 'failed', payload_raw: run.stdout.trim(), notes: run.stderr.trim() }
    }

    // ---- the survey
    if (type === 'analyst' && label === 'plan') {
      const question = match(/QUESTION: (.*)\n/, prompt)
      write(returnFileOf(prompt), {
        question, topics: [{ key: 'hello', find: 'Find what src/hello.mjs exports and what it returns.', subtree: 'src' }],
        common_ground: '', history_question: '', docs_question: '',
      })
      return { topics: [{ key: 'hello', subtree: 'src' }], common_ground: false, docs_needed: false, history_needed: false }
    }
    if (type === 'scout' && label.startsWith('scout:')) {
      write(returnFileOf(prompt), {
        hits: [{ path: 'src/hello.mjs', line: 1, note: 'hello is exported' }], searched: ['src/'], no_match: '', not_reached: '', stop_reason: 'exhausted',
      })
      return { hits: [{ path: 'src/hello.mjs', line: 1 }], stop_reason: 'exhausted', not_reached: '' }
    }
    if (type === 'analyst' && label.startsWith('judge')) {
      write(returnFileOf(prompt), {
        items: [{ topic: 'hello', kind: 'behaviour', claim: CLAIM, spans: [{ path: 'src/hello.mjs', start: 1, end: 1 }], queries: [], sources: [], rests_on: [] }],
        risks: [],
      })
      return { topics: [{ topic: 'hello', items_n: 1, risks_n: 0 }] }
    }

    // ---- the autonomous review
    if (type === 'scout' && label.startsWith('locate')) {
      write(returnFileOf(prompt), {
        hits: [{ path: 'src/hello.mjs', line: 1, note: 'what x is planned beside', kind: 'ground' }],
        searched: ['CLAUDE.md', 'AGENTS.md', 'docs/', 'src/'], no_match: 'no review or design guidance in this repository', not_reached: '', stop_reason: 'exhausted',
      })
      return { hits: [{ path: 'src/hello.mjs', line: 1, kind: 'ground' }], stop_reason: 'exhausted', not_reached: '' }
    }
    if (type === 'analyst' && label.startsWith('probe:')) {
      const artefact = match(/THE ARTEFACT — read it in full before you write anything:\n(.+)\n/, prompt)
      const lines = readFileSync(artefact, 'utf8').split(/\r?\n/)
      const at = lines.indexOf(VAGUE) + 1
      const findings = at > 0
        ? [{
            axis: 'ambiguity', severity: 'ambiguity', section: 'Design', claim: 'the Design names one function but not what it takes or returns, so x reads two ways',
            evidence: '"' + VAGUE + '"', start: at, end: at,
          }]
        : []
      write(returnFileOf(prompt), { findings, notes: '', stop_reason: 'exhausted', not_reached: '' })
      return { findings_n: findings.length, stop_reason: 'exhausted', not_reached: '' }
    }

    // ---- the execution
    if (type === 'planner' && label.startsWith('plan:')) {
      write(match(/Write its spec: (.+?)\.\n/, prompt), P_SPEC)
      return { status: 'written' }
    }
    if (type === 'planner' && label.startsWith('settle:')) {
      const spec = match(/Its spec: (.+?)\. The review's findings/, prompt)
      const all = JSON.parse(readFileSync(match(/The review's findings, in full: (.+?)\.\n/, prompt), 'utf8')).findings
      const asked = match(/Findings to settle: ([^.\n]+)\./, prompt).split(', ')
      const these = all.filter((f) => asked.includes(f.id))
      if (settle === 'incorporate') writeFileSync(spec, readFileSync(spec, 'utf8').replace(VAGUE, CLEAR))
      write(match(/as JSON, to (.+?): \{"dispositions"/, prompt), {
        dispositions: these.map((f) => ({ finding: f.id, outcome: settle === 'incorporate' ? 'incorporated' : 'discarded' })),
      })
      return { status: 'settled' }
    }
    if (type === 'implementer') {
      const worktree = match(/Worktree: (\S+) /, prompt)
      for (const [path, text] of Object.entries(WORK)) write(join(worktree, path), text)
      git(worktree, 'add', '-A')
      git(worktree, 'commit', '-q', '-m', 'Add x')
      return { status: 'done' }
    }
    if (type === 'reviewer') {
      write(prompt.split('\n').pop(), { findings: [], fix_verdicts: [], claims: [{ claim: 'x() is 1', verdict: 'met', evidence: 'src/x.mjs:1' }], notes: '' })
      return { status: 'written' }
    }
    throw new Error('unscripted ' + type + ' ' + label)
  }
}

/** Execute the effort, every nested workflow run for real with the same agents. Every prompt any of them dispatched comes back. */
async function execute(r, settle) {
  const commandsFile = join(r, '.git', 'agentics-commands.json')
  writeFileSync(commandsFile, JSON.stringify(COMMANDS))
  const agent = agents(settle)
  const nested = []
  const top = await runWorkflow(WF, {
    args: { repo: r, effort: 'e1', execution: '20260925-120000', plugin_root: PLUGIN, commands_file: commandsFile },
    agent,
    workflow: async (ref, wargs) => {
      const run = await runWorkflow(ref.scriptPath, { args: wargs, agent })
      nested.push({ script: ref.scriptPath, ...run })
      return run.result
    },
  })
  return { ...top, nested, prompts: top.prompts.concat(nested.flatMap((n) => n.prompts)) }
}

const ledgerOf = (r, kind) => readLog(r, 'e1', 'ledger').entries.filter((e) => e.kind === kind && e.folder === 'p')
const promptOf = (prompts, label) => (prompts.find((p) => p.opts.label === label) || {}).prompt || ''

test('a planner folder is surveyed, planned, reviewed, settled, prepared and built through every real workflow', async () => {
  const r = repo()
  const { result, logs, nested, prompts } = await execute(r, 'incorporate')
  const trace = logs.concat(nested.flatMap((n) => n.logs)).join('\n')

  assert.deepEqual(result.escalations, [], trace)
  assert.deepEqual(result.faults, [], trace)
  assert.equal(result.coverage.complete, true, JSON.stringify(result.coverage) + '\n' + trace)
  assert.deepEqual(result.implemented.map((i) => i.id), ['p/x'])
  assert.equal(readTree(r, 'e1').status.get('.').status, 'integrated')

  // The survey: the planner is pointed at its one context file, which holds what the judge found.
  const survey = nested.find((n) => /gather-evidence-without-concluding/.test(n.script))
  assert.equal(survey.result.coverage.complete, true, JSON.stringify(survey.result.coverage))
  const plan = promptOf(prompts, 'plan:p')
  const context = match(/a survey of this folder's ground is in (\S+)\.\n/, plan)
  assert.ok(existsSync(context), context)
  assert.ok(readFileSync(context, 'utf8').includes(CLAIM), 'the context file holds the surveyed item\'s claim')

  // The review: its one ambiguity reached the ledger under its settlement id, the planner was handed
  // the findings file, and its disposition landed under the same id.
  const settle = promptOf(prompts, 'settle:p#1')
  assert.ok(settle, 'the review\'s ambiguity was handed to the planner to settle')
  const findingsFile = match(/The review's findings, in full: (.+?)\.\n/, settle)
  const [finding] = JSON.parse(readFileSync(findingsFile, 'utf8')).findings
  assert.equal(finding.severity, 'ambiguity')
  assert.ok(finding.item, 'the probe recorded the finding as an evidence item')
  assert.deepEqual(ledgerOf(r, 'reviewed')[0].ambiguities, [finding.item])
  assert.deepEqual(ledgerOf(r, 'disposition').map((d) => [d.finding, d.outcome]), [[finding.item, 'incorporated']])
  assert.equal(ledgerOf(r, 'reviewed').length, 2, 'the edited spec was reviewed again before it was prepared')
  assert.equal(ledgerOf(r, 'prepared').length, 1)

  assert.deepEqual(courierProblems(prompts), [])
})

test('a planner that leaves the review\'s ambiguity unsettled stops its folder: nothing is prepared and nothing below it runs', async () => {
  const r = repo()
  const { result, logs, nested, prompts } = await execute(r, 'discard')
  const trace = logs.concat(nested.flatMap((n) => n.logs)).join('\n')

  assert.deepEqual(result.escalations.map((e) => [e.id, e.reason]), [['p', 'review_not_converging']], trace)
  assert.deepEqual(ledgerOf(r, 'prepared'), [])
  assert.deepEqual(ledgerOf(r, 'disposition'), [], 'a refused discard is never recorded')
  assert.ok(promptOf(prompts, 'settle:p#2'), 'the refused discard went back to the planner once')
  assert.deepEqual(result.implemented, [])
  assert.equal(readTree(r, 'e1').nodes.has('p/x'), false, 'the folder was never compiled into work')
  assert.deepEqual(courierProblems(prompts), [])
})
