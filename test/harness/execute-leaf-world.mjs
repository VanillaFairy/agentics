// test/harness/execute-leaf-world.mjs — what the execute-leaf-* tests share: the leaf specs, the
// scripted answers of a producer, reviewer and ruler, and the world and the cycle world they run
// over. Nothing here runs at import.

import { after } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { executionLog, readLog } from '../../lib/ledger.mjs'
import { programContext } from '../../lib/programs/common.mjs'
import { runLeaf } from '../../lib/programs/execute/leaf.mjs'
import { loadRole } from '../../lib/roles.mjs'
import { dispatchKey, sessionOf } from '../../lib/store.mjs'
import { readTree } from '../../lib/tree.mjs'
import { executionRig } from './program-rig.mjs'

export const T = { timeout: 300_000 }
export const E = 'e1'

// ------------------------------------------------------------------ the world

const CHECK_MJS = "import { readFileSync } from 'node:fs'\nlet ok = false\n" +
  "try { ok = readFileSync('src/' + process.argv[2] + '.txt', 'utf8').trim() === 'ok' } catch {}\nprocess.exit(ok ? 0 : 1)\n"
const FILES = { 'check.mjs': CHECK_MJS, 'pass.mjs': '' }

/** One Plan entry and its criterion. */
export function leafEntry(id, { rigor = 'trivial', role = '', after = '', provides = '', locus, check } = {}) {
  const paths = locus ?? ['src/' + id + '.txt']
  const cmd = check ?? 'node check.mjs ' + id
  return [
    '- **' + id + '** — task · realises: D1' + (after ? ' · after: ' + after : '') + ' · rigor: ' + rigor +
      (role ? ' · role: ' + role : '') + (paths.length ? ' · locus: ' + paths.join(', ') : '') +
      (provides ? ' · provides: ' + provides : ''),
    '  Make ' + id,
    '  - [ ] ' + id + ' says ok — check: `' + cmd + '`',
    '',
  ]
}

/** A spec text: the six sections, one Decisions row (none for a planner's), and the Plan entries given. */
export function specText(entries, { decisions = true } = {}) {
  return [
    '# Leaf unit', '', '## Intent', '', 'Leaves under test.', '',
    '## Decisions', '', '| id | decision | why |', '|---|---|---|',
    ...(decisions ? ['| D1 | They run. | The unit needs them. |'] : []), '',
    '## Design', '', 'Files under src.', '',
    '## Plan', '', ...entries.flat(),
    '## Open questions', '', '## Evidence', '', 'None yet.', '',
  ].join('\n')
}

const B_LOCUS = ['src/b.txt', 'src/b2.txt']
export const YARD = { provides: 'b-file (src/b.txt)' }
export const bLeaf = (extra = {}) => leafEntry('b', { locus: B_LOCUS, ...extra })

export const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim()

export function write(cwd, files) {
  for (const [path, text] of Object.entries(files)) {
    const full = join(cwd, ...path.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
}

/** Write `files` in `cwd` and commit them; the new head. */
export function work(cwd, files, subject = 'work') {
  write(cwd, files)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', subject)
  return git(cwd, 'rev-parse', 'HEAD')
}

const jobKey = (call) => call.role.name + '|' + call.node + '#' + call.round

/**
 * A leg of a world: a program context over `rig` whose `runAgent(call)` first runs the test's job
 * for `<role>|<node>#<round>` (once per dispatch, in the call's worktree), then the real call
 * (`around(call, real)` when a test replaces it). `sleep` replaces the rig's hand-resolved one.
 */
function leg(w, rig, { sleep, around } = {}) {
  const ctx = programContext({
    ...rig.ctx,
    ...(sleep ? { sleep } : {}),
    runAgent: async (call) => {
      if (!w.ran.has(call.dispatch)) {
        w.ran.add(call.dispatch)
        const job = w.jobs[jobKey(call)]
        if (job) await job(call.cwd, call)
      }
      return around ? around(call, rig.ctx.runAgent) : rig.ctx.runAgent(call)
    },
  })
  return { rig, ctx, xc: rig.xc, run: (id = 'b', over = {}) => runLeaf(ctx, rig.xc, { id, ...over }) }
}

/**
 * A world: the rig over the Plan entries given (`leaves`), the spec text given, or the rig's own
 * spec (`rigSpec`); the test's jobs; and a leg over the rig.
 */
export function world(t, { leaves, spec, rigSpec = false, commands, files = {} } = {}) {
  const text = rigSpec ? undefined : spec ?? specText(leaves ?? [bLeaf()])
  const rig = executionRig(t, { spec: text, commands, files: { ...FILES, ...files } })
  const w = { rig, jobs: {}, ran: new Set() }
  w.job = (key, fn) => { w.jobs[key] = fn }
  Object.assign(w, leg(w, rig))
  w.leg = (over) => leg(w, rig, over)
  w.relaunch = (over) => leg(w, rig.relaunch(), over)
  return w
}

// ------------------------------------------------------------------ reading the records

const all = (rig) => executionLog(rig.repo, rig.effort, rig.stamp).entries()
export const ofKind = (rig, kind, node) => all(rig).filter((e) => e.kind === kind && (node === undefined || e.node === node))
export const messages = (rig, thread, msg) => ofKind(rig, 'message').filter((e) => (thread === undefined || e.thread === thread) && (msg === undefined || e.msg === msg))
export const stateOf = (rig) => readLog(rig.repo, rig.effort, 'state:' + rig.stamp).entries
export const faultsOf = (rig, node = 'b') => ofKind(rig, 'fault', node)
export const callsOf = (rig, role, node) => rig.calls.filter((c) => c.role.name === role && (node === undefined || c.node === node))
/** The calls of a role on a node, one per dispatch (a host stop calls the same dispatch again), first start first. */
export const startsOf = (rig, role, node) => [...new Map(callsOf(rig, role, node).map((c) => [c.dispatch, c])).values()]
export const headOf = (rig, id = 'b') => rig.git('rev-parse', 'refs/heads/' + rig.branchOf(id))
export const approvals = (rig, id = 'b') => ofKind(rig, 'approved', id)
export const stopsOn = (rig, id = 'b') => [...ofKind(rig, 'escalated', id), ...ofKind(rig, 'parked', id)]
export const stepsOf = (rig, key) => ofKind(rig, 'step').filter((e) => e.key === key)

export const keyOf = (node, role, thread, round) => dispatchKey({ node, role, thread, round })
export const sessionFor = (rig, { node, role, thread, gen = 0 }) =>
  sessionOf({ effort: rig.effort, execution: rig.stamp, node, role, thread, gen })
export const nodeOf = (rig, id = 'b') => readTree(rig.repo, rig.effort).nodes.get(id)
export const roleOf = (name) => loadRole(name).role

// ------------------------------------------------------------------ scripted steps

export const IMPL = 'implementer|b|producer:b'
export const REV = (n, id = 'b') => 'reviewer|' + id + '|reviewer:' + id + ':' + n

export const done = (text = 'did the work', extra = {}) => ({ output: { status: 'done', text, concerns: [], ...extra } })
export const said = (status, text = 'the producer says so') => ({ output: { status, text } })

export const failed = (cause) => ({ status: 'failed', cause })

/** Every unit any world here can produce: a reviewer step rules them all clean unless a test means some unruled. */
export const ALL_UNITS = [
  'criterion:1', 'file:src/b.txt', 'file:src/b2.txt', 'file:src/r.mjs', 'file:test/r.test.mjs',
  'file:docs/audit.md', 'file:src/a.mjs', 'file:test/a.test.mjs',
]
export const verdict = ({ ruled = ALL_UNITS, findings = [], fix = [] } = {}) => ({
  output: {
    units: ruled.map((unit) => ({ unit, ruling: 'clean', why: 'read it' })),
    findings, fix_rulings: fix, claims: [], notes: '',
  },
})
export const finding = (id, extra = {}) => ({
  id, severity: 'critical', claim: 'CLAIM-' + id + ' is wrong', evidence: 'evidence of ' + id, failure_scenario: 'breaks when ' + id, ...extra,
})
export const fixed = (id) => ({ id, status: 'fixed', evidence: 'ruled ' + id })
