// test/harness/execution-world.mjs — the fixtures the boundaries-execution-preflight, -moved-base and
// -schedule tests share: a repository with a tree, the execution context over it, its envelope and
// the readers of the records a boundary leaves. Nothing here runs at import.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preflight } from '../../lib/boundaries/execution.mjs'
import { executionContext } from '../../lib/boundaries/records.mjs'
import { executionLog, readLog } from '../../lib/ledger.mjs'
import { executionDir } from '../../lib/store.mjs'
import { COMMANDS, STAMP, commitIn, git, leaf, repo, root } from './boundary-fixture.mjs'
import { seedTree } from './seed-tree.mjs'

export const E = 'e1'
export const STAMP2 = '20260925-130000'

export const ADD = 'src/add.mjs'

// ------------------------------------------------------------------ the fixtures

/** A repository with a CLAUDE.md (so the guidance is not empty) and the tree `nodes` seeded. */
export function world(t, nodes) {
  const r = repo()
  t.after(() => rmSync(r, { recursive: true, force: true }))
  commitIn(r, { 'CLAUDE.md': '# Rules\nKeep the change small.\n', '.gitignore': '.claude/\n.agentics/\n' }, 'Add guidance')
  const seeded = seedTree(r, E, nodes)
  assert.equal(seeded.ok, true, JSON.stringify(seeded.problems))
  return r
}

/** An execution's context. A new run of it is another call: its log appends `run` first. */
export function ctxOf(r, stamp = STAMP, { run = true } = {}) {
  const log = executionLog(r, E, stamp)
  if (run) log.append('run', { program: 'execute', scope: { effort: E }, pid: 1 })
  return executionContext({ repo: r, effort: E, execution: stamp, log })
}

/** A commands file the session wrote, removed with the test. */
export function commandsFile(t, value = COMMANDS, name = 'commands.json') {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-commands-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, name)
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
  return path
}

export const envPath = (r, stamp = STAMP) => join(executionDir(r, E, stamp), 'execution.json')
export const envelopeOf = (r, stamp = STAMP) => JSON.parse(readFileSync(envPath(r, stamp), 'utf8'))
export const stateOf = (r, stamp = STAMP) => readLog(r, E, 'state:' + stamp).entries
export const journalOf = (r, stamp = STAMP) => readLog(r, E, 'journal:' + stamp).entries
export const stateKind = (r, kind, stamp = STAMP) => stateOf(r, stamp).filter((e) => e.kind === kind)

export const head = (r, ref = 'HEAD') => git(r, 'rev-parse', ref)

export const NO_GAPS = [root(), leaf('a', { expects: [ADD] }), leaf('b', { expects: ['README.md'] })]

/** A world whose first preflight already wrote the envelope at the repository's head. */
export async function started(t, nodes = NO_GAPS) {
  const r = world(t, nodes)
  const cf = commandsFile(t)
  const base = head(r)
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(out.ok, true)
  assert.equal(out.checkpoint, null)
  return { r, cf, base }
}
