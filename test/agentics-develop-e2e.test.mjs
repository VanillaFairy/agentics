// test/agentics-develop-e2e.test.mjs — agentics-develop against the real boundaries.
//
// The scenario suite answers every boundary from an in-memory simulation; test/boundary.test.mjs
// runs the boundaries without the workflow. This runs the two together: every courier dispatch the
// workflow makes really executes `lib/boundary.mjs` in a real repository, and only the model
// agents — the executors and the reviewer — are scripted, committing real files in the worktrees
// the boundaries cut. A disagreement between what the workflow sends and what the boundaries read
// fails here and nowhere else.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { runWorkflow } from './harness/workflow-host.mjs'
import { land } from '../lib/boundary.mjs'
import { readTree } from '../lib/tree.mjs'
import { seedTree } from './harness/seed-tree.mjs'

delete process.env.NODE_TEST_CONTEXT

const PLUGIN = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const WF = join(PLUGIN, 'workflows', 'agentics-develop.workflow.js')
const COMMANDS = {
  suite: 'node --test --test-reporter=spec', test_one: 'node --test --test-reporter=spec {file}',
  absent: { build: true, typecheck: true },
}

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr)
  return r.stdout.trim()
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-e2e-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 'T')
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'test'))
  writeFileSync(join(dir, '.gitignore'), '.claude/\n')
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  writeFileSync(join(dir, 'test', 'base.test.mjs'), "import { test } from 'node:test'\ntest('base', () => {})\n")
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  return dir
}

/** What each scripted executor writes, by leaf id. */
const WORK = {
  a: {
    'test/a.test.mjs': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { a } from '../src/a.mjs'\ntest('a is 1', () => assert.equal(a(), 1))\n",
    'src/a.mjs': 'export const a = () => 1\n',
  },
  'b/c': { 'NOTES.md': 'notes\n' },
}

function agents(calls, jobs) {
  return (prompt, opts) => {
    const type = String(opts.agentType || '').replace('agentics:', '')
    calls.push(opts.label)
    if (type === 'courier') {
      const command = /^(node "[^\n]+)$/m.exec(prompt)[1]
      const run = spawnSync('sh', ['-c', command], { encoding: 'utf8', env: { ...process.env, AGENTICS_INLINE_JOBS: jobs === 'inline' ? '1' : '' } })
      return { stop_reason: run.status === 0 ? 'carried' : 'failed', payload_raw: run.stdout.trim(), task_ids: [], task_tools: 'skipped', notes: run.stderr }
    }
    if (type === 'implementer' || type === 'test-author') {
      const id = /for leaf (\S+) /.exec(prompt)[1]
      const worktree = /Worktree: (\S+) /.exec(prompt)[1]
      for (const [path, text] of Object.entries(WORK[id])) {
        mkdirSync(join(worktree, path, '..'), { recursive: true })
        writeFileSync(join(worktree, path), text)
      }
      git(worktree, 'add', '-A')
      git(worktree, 'commit', '-q', '-m', 'Do ' + id)
      return { status: 'done', detail: '', concerns: [], commits: [{ sha: git(worktree, 'rev-parse', 'HEAD'), subject: 'Do ' + id }] }
    }
    if (type === 'reviewer') return { findings: [], fix_verdicts: [], notes: '' }
    throw new Error('unscripted ' + type)
  }
}

for (const jobs of ['inline', 'detached']) test('an effort executes end to end through the real boundaries and lands (' + jobs + ' jobs)', async () => {
  const r = repo()
  const added = seedTree(r, 'e1', [
    { id: '.', kind: 'composite', title: 'the change', defines: [{ id: 'D1', text: 'a exists' }, { id: 'D2', text: 'greet the world' }] },
    { id: 'a', kind: 'leaf', title: 'Add a', rigor: 'tdd', locus: ['src/a.mjs', 'test/a.test.mjs'], decisions: ['D1'], acceptance: [{ text: 'a() is 1', check: 'node --test', decisions: ['D1'] }] },
    { id: 'b', kind: 'composite', title: 'Greet', decisions: ['D2'] },
    { id: 'b/c', kind: 'leaf', title: 'Write notes', rigor: 'trivial', locus: ['NOTES.md'], decisions: ['D2'], acceptance: [{ text: 'notes exist', check: 'the suite', decisions: ['D2'] }] },
  ])
  assert.equal(added.ok, true, JSON.stringify(added.problems))

  const calls = []
  const { result, logs } = await runWorkflow(WF, {
    args: { repo: r, effort: 'e1', execution: '20260925-120000', plugin_root: PLUGIN, commands: COMMANDS, progress: false },
    agent: agents(calls, jobs),
  })
  assert.deepEqual(result.escalations, [], logs.join('\n'))
  assert.equal(result.coverage.complete, true, JSON.stringify(result.coverage) + '\n' + logs.join('\n'))
  assert.deepEqual(result.implemented.map((i) => i.id).sort(), ['a', 'b/c'])

  const tree = readTree(r, 'e1')
  assert.equal(tree.status.get('.').status, 'integrated')
  assert.equal(tree.status.get('b').status, 'merged', 'the composite merged up into the root')
  assert.ok(calls.includes('review:integration:.'), 'two children with work met at the root')

  const landed = land(r, 'e1', 'merge')
  assert.equal(landed.ok, true, landed.error)
  assert.ok(existsSync(join(r, 'src', 'a.mjs')) && existsSync(join(r, 'NOTES.md')))
  assert.equal(git(r, 'status', '--porcelain'), '', 'nothing the execution did touched the user tree before landing')
})
