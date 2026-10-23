// test/harness/snapshot-world.mjs — what the snapshot-payload and snapshot-cards tests share: the
// effort fixtures (real git branches, worktrees, specs and the ledger) and the readers of a
// snapshot. Nothing here runs at import.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { append } from '../../lib/ledger.mjs'
import { hashSpec } from '../../lib/spec.mjs'
import * as statusModule from '../../lib/status.mjs'
import {
  branchOf, dispatchKey, executionDir, posix, returnPath, specPath, worktreeOf, writeJson,
} from '../../lib/store.mjs'

export const { nodeOf, renderNode, snapshotOf } = statusModule

export const CLI = fileURLToPath(new URL('../../lib/status.mjs', import.meta.url))

export const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

export const leaf = (id, extra = {}) => ({
  id, title: 'do ' + id, kind: 'leaf', rigor: 'trivial', expects: ['src/' + id.split('/').join('-') + '.js'],
  acceptance: [{ text: id + ' works', check: 'true' }], deps: [], ...extra,
})
export const composite = (id, extra = {}) => ({ id, title: 'folder ' + id, kind: 'composite', deps: [], ...extra })
const design = (id, extra = {}) => ({ id, title: 'design ' + id, kind: 'design', author: 'you', deps: [], ...extra })

const EFFORT = 'eff'
const STAMP = '20260927-100000'
export const FIX_REASON = 'verify_oscillating'
export const FIX_DETAIL = 'the fix diverged twice'
export const WAIT_RETURN = 'needs_decision'
export const WAIT_QUESTION = 'what does the wait step wait for?'

export const round = (id, n, role = 'implementer') => dispatchKey({ node: id, role, thread: 'producer:' + id, round: n })
export const D_IMPL = round('a/impl', 1)
const D_FIX = round('a/fix', 1)
export const IMPL_TEXT = 'report for a/impl'

export const ROOT_SPEC = [
  '# Eff root', '',
  '## Intent', '',
  'Ship the eff.', '',
  '## Decisions', '',
  '| id | decision | why |',
  '|---|---|---|',
  '| D1 | a happens | needed |',
  '| D2 | c happens | needed |',
  '',
  '## Design', '',
  'As planned.', '',
  '## Plan', '',
  '- **a** — sub-effort · realises: D1',
  '  Build a.',
  '- **c** — task · realises: D2 · rigor: trivial · expects: src/c.js',
  '  Do c.',
  '  - [ ] c works — check: `true`',
  '',
  '## Open questions', '',
  '## Evidence', '',
  'None yet.', '',
].join('\n')

export const A_SPEC = [
  '# A', '',
  '## Intent', '',
  'Build a.', '',
  '## Decisions', '',
  '| id | decision | why |',
  '|---|---|---|',
  '| a.D1 | impl happens | needed |',
  '| a.D2 | fix happens | needed |',
  '| a.D3 | wait happens | needed |',
  '',
  '## Design', '',
  'As planned.', '',
  '## Plan', '',
  '- **impl** — task · realises: a.D1 · rigor: trivial · expects: src/impl.js',
  '  Implement it.',
  '  - [ ] impl works — check: `true`',
  '- **fix** — task · realises: a.D2 · rigor: trivial · expects: src/fix.js · after: impl',
  '  Fix it.',
  '  - [ ] fix works — check: `true`',
  '- **wait** — task · realises: a.D3 · rigor: trivial · expects: src/wait.js',
  '  Wait for it.',
  '  - [ ] wait works — check: `true`',
  '',
  '## Open questions', '',
  '- **blocking:** ' + WAIT_QUESTION,
  '',
  '## Evidence', '',
  'None yet.', '',
].join('\n')

export const RAW_NODES = [
  composite('.'),
  composite('a'),
  leaf('a/impl'),
  leaf('a/fix', { deps: ['a/impl'] }),
  leaf('a/wait'),
  leaf('c'),
]

function writeSpec(repo, effort, folderId, text) {
  const p = specPath(repo, effort, folderId)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
}

export function effortFixture() {
  const repo = posix(mkdtempSync(join(tmpdir(), 'agentics-snapshot-')))
  git(repo, 'init', '-q', '.')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'README.md'), 'root\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  const mainBranch = git(repo, 'symbolic-ref', '--short', 'HEAD')

  writeSpec(repo, EFFORT, '.', ROOT_SPEC)
  writeSpec(repo, EFFORT, 'a', A_SPEC)
  append(repo, EFFORT, 'ledger', { kind: 'approved', folder: '.', hash: hashSpec(ROOT_SPEC), decisions: [], by: 'user' })

  append(repo, EFFORT, 'nodes', RAW_NODES.map((node) => ({ kind: 'node', node })))

  const ev = (kind, node, extra = {}) => append(repo, EFFORT, 'events', { kind, node, execution: STAMP, ...extra })
  ev('dispatched', 'a/impl', { dispatch: D_IMPL, role: 'implementer', round: 1, model: 'sonnet', effort: 'medium' })
  ev('dispatched', 'a/fix', { dispatch: D_FIX, role: 'implementer', round: 1, model: 'sonnet', effort: 'medium' })
  ev('escalated', 'a/fix', { reason: FIX_REASON, detail: FIX_DETAIL })
  ev('parked', 'a/wait', { return: WAIT_RETURN, question: WAIT_QUESTION })

  git(repo, 'branch', branchOf(EFFORT, 'a'))
  git(repo, 'checkout', '-q', branchOf(EFFORT, 'a'))
  writeFileSync(join(repo, 'a-integration.txt'), 'integration\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'a folder integration commit')
  git(repo, 'checkout', '-q', mainBranch)

  git(repo, 'branch', branchOf(EFFORT, 'a/impl'), branchOf(EFFORT, 'a'))
  const wt = worktreeOf(repo, EFFORT, 'a/impl')
  mkdirSync(dirname(wt), { recursive: true })
  git(repo, 'worktree', 'add', '-q', wt, branchOf(EFFORT, 'a/impl'))
  writeFileSync(join(wt, 'note.txt'), 'first\n')
  git(wt, 'add', '-A')
  git(wt, 'commit', '-qm', 'a/impl: first change')
  writeFileSync(join(wt, 'note.txt'), 'second\n')
  git(wt, 'add', '-A')
  git(wt, 'commit', '-qm', 'a/impl: second change')

  mkdirSync(executionDir(repo, EFFORT, STAMP), { recursive: true })
  writeFileSync(join(executionDir(repo, EFFORT, STAMP), 'execution.json'), JSON.stringify({ root: '.' }))
  // a/impl's call returned and stored its words; a/fix's never returned, in a run that is not live.
  writeJson(returnPath(executionDir(repo, EFFORT, STAMP), D_IMPL), { status: 'done', text: IMPL_TEXT })
  append(repo, EFFORT, 'state:' + STAMP, {
    kind: 'returned', dispatch: D_IMPL, session: 's1', status: 'returned', cause: '', denials: [], cost_total: 0.5, cost_usd: 0.5,
    usage: { input_tokens: 100, output_tokens: 60, cache_read_input_tokens: 1000, cache_creation_input_tokens: 40 },
  })

  return { repo, effort: EFFORT, stamp: STAMP }
}

let shared = null
/** One fixture for every test that only reads it. A test that writes to its repository builds its own. */
export const sharedFixture = () => (shared ??= effortFixture())

export function statusFixture() {
  const repo = posix(mkdtempSync(join(tmpdir(), 'agentics-snapshot-status-')))
  const effort = 'st'
  const nodes = [
    composite('.'),
    leaf('planned-leaf'),
    leaf('active-leaf'),
    leaf('approved-leaf'),
    leaf('merged-leaf'),
    composite('merged-folder'),
    leaf('merged-folder/x'),
    leaf('merged-folder/y'),
    composite('reviewed-folder'),
    leaf('reviewed-folder/z'),
    leaf('parked-leaf'),
    leaf('escalated-leaf'),
    design('design-node'),
  ]
  append(repo, effort, 'nodes', nodes.map((node) => ({ kind: 'node', node })))
  const ev = (kind, node, extra = {}) => append(repo, effort, 'events', { kind, node, execution: 'x', ...extra })
  ev('dispatched', 'active-leaf', { role: 'implementer', round: 1, model: 'sonnet', effort: 'medium' })
  ev('dispatched', 'approved-leaf', { role: 'implementer', round: 1, model: 'sonnet', effort: 'medium' })
  ev('approved', 'approved-leaf', { head_sha: 'a1' })
  ev('merged', 'merged-leaf', { into: 'agentics/st', merged_sha: 'm', head_sha: 'h' })
  ev('merged', 'merged-folder/x', { into: 'agentics/st--merged-folder', merged_sha: 'm', head_sha: 'h' })
  ev('merged', 'merged-folder/y', { into: 'agentics/st--merged-folder', merged_sha: 'm', head_sha: 'h' })
  ev('merged', 'reviewed-folder/z', { into: 'agentics/st--reviewed-folder', merged_sha: 'm', head_sha: 'h' })
  ev('claims', 'reviewed-folder', { head_sha: 'h', review: 'not_earned', claims: [] })
  ev('parked', 'parked-leaf', { return: 'needs_decision', question: 'q' })
  ev('escalated', 'escalated-leaf', { reason: 'r', detail: 'd' })
  return { repo, effort }
}
