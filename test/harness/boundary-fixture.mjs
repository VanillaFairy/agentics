// test/harness/boundary-fixture.mjs — the repository, tree rows and calls the test/boundary-*.test.mjs
// files share.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { ARGS, runBoundary } from '../../lib/boundary.mjs'
import { handleArgs, handleEnvelope } from '../../lib/store.mjs'

// The fixtures' own suites run `node --test`; a grandchild that sees this runner's marker runs
// nothing and exits 0, which would make every measurement a pass. It is cleared here so that every
// file building these fixtures is covered by importing them.
delete process.env.NODE_TEST_CONTEXT
process.env.AGENTICS_INLINE_JOBS = '1'

export const BOUNDARY = fileURLToPath(new URL('../../lib/boundary.mjs', import.meta.url))

export const STAMP = '20260925-120000'
export const COMMANDS = {
  suite: 'node --test --test-reporter=spec', test_one: 'node --test --test-reporter=spec {file}',
  absent: { build: true, typecheck: true },
}

export const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr)
  return r.stdout.trim()
}

export function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-boundary-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 'T')
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'test'))
  writeFileSync(join(dir, '.gitignore'), '.claude/\n')
  writeFileSync(join(dir, 'src', 'add.mjs'), 'export const add = (a, b) => a + b\n')
  writeFileSync(join(dir, 'test', 'add.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../src/add.mjs'\ntest('adds', () => assert.equal(add(1, 2), 3))\n")
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  return dir
}

export const leaf = (id, extra = {}) => ({
  id, kind: 'leaf', title: 'do ' + id, rigor: 'tdd', decisions: ['D1'],
  acceptance: [{ text: id + ' works', check: 'node --test', decisions: ['D1'] }], ...extra,
})
export const root = (extra = {}) => ({ id: '.', kind: 'composite', title: 'the change', defines: [{ id: 'D1', text: 'do it' }], ...extra })

/** A file an agent wrote, as JSON: a review, a rulings file, a settlement. Its path. */
export function wrote(value, name = 'agent.json') {
  const path = join(mkdtempSync(join(tmpdir(), 'agentics-wrote-')), name)
  writeFileSync(path, JSON.stringify(value))
  return path
}

/** A review with no finding and no claim, as a reviewer writes it. */
export const CLEAN_REVIEW = { findings: [], fix_verdicts: [], claims: [], notes: '' }

/**
 * A boundary called the way a courier calls it: the arguments as argv flags parsed by
 * `handleArgs` over the boundary's own `ARGS`, the payload printed through `handleEnvelope`, which
 * throws on anything that is not a handle. What a test would hand over as data the session or an
 * agent writes to a file first: the commands the user named, a merge's children (its card).
 */
export function B(r, name, args, stamp = STAMP) {
  const given = { ...args }
  if (given.commands && typeof given.commands === 'object') {
    given.commands_file = join(mkdtempSync(join(tmpdir(), 'agentics-commands-')), 'commands.json')
    writeFileSync(given.commands_file, JSON.stringify(given.commands))
  }
  if (given.children) {
    given.card = join(mkdtempSync(join(tmpdir(), 'agentics-card-')), 'card.json')
    writeFileSync(given.card, JSON.stringify({ unit: 'merge', id: given.target, children: given.children, cycles: given.cycles || [] }))
  }
  const { value, problem } = handleArgs(argvFor(name, given), ARGS[name])
  if (problem) throw new Error(name + ': ' + problem.kind + ' — ' + problem.message)
  return handleEnvelope(runBoundary(name, r, 'e1', stamp, value)).payload
}

/** The flags a boundary's arguments travel as, one per value. */
export function argvFor(name, args) {
  const argv = []
  for (const [key, kind] of Object.entries(ARGS[name])) {
    const v = args[key]
    if (kind === 'many') for (const x of v || []) argv.push('--' + key, String(x))
    else if (kind === 'bool') argv.push('--' + key, v === true ? '1' : '0')
    else if (v !== undefined && v !== '') argv.push('--' + key, String(v))
  }
  return argv
}

export function commitIn(wt, files, subject) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(wt, path, '..'), { recursive: true })
    writeFileSync(join(wt, path), text)
  }
  git(wt, 'add', '-A')
  git(wt, 'commit', '-q', '-m', subject)
  return git(wt, 'rev-parse', 'HEAD')
}

export const A_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { a } from '../src/a.mjs'\ntest('a is 1', () => assert.equal(a(), 1))\n"
