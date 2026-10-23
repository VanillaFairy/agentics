// test/harness/execute-program-world.mjs — what the program-execute-* tests share: the plan specs,
// the scripted answers of a leaf's producer, reviewer and rulers, and the execution rig world they
// run over. Nothing here runs at import.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { executionLog, readLog } from '../../lib/ledger.mjs'
import { programContext } from '../../lib/programs/common.mjs'
import { execute } from '../../lib/programs/execute.mjs'
import { launch } from '../../lib/run.mjs'
import { configPath, dispatchKey, writeJson } from '../../lib/store.mjs'
import { readTree } from '../../lib/tree.mjs'
import { executionRig } from './program-rig.mjs'
import { scriptedRunner } from '../fast/harness/scripted-runner.mjs'

export const T = { timeout: 300_000 }
export const E = 'e1'
export const NOW_ISO = '2026-01-01T00:00:00.000Z'
const CLOCK = () => new Date(NOW_ISO)
/** A sleep that yields to the timers: the rig's resolves at once and would starve a measurement's child of its exit. */
export const YIELD = () => new Promise((r) => setTimeout(r, 10))

// ------------------------------------------------------------------ the specs

const CHECK_MJS = "import { readFileSync } from 'node:fs'\nlet ok = false\n" +
  "try { ok = readFileSync('src/' + process.argv.slice(2).join('/') + '.txt', 'utf8').trim() === 'ok' } catch {}\nprocess.exit(ok ? 0 : 1)\n"
const FILES = { 'check.mjs': CHECK_MJS, 'pass.mjs': '' }

/** One Plan entry: a leaf whose check reads `src/<words joined by '/'>.txt`; `words` default to its name. */
export function leafEntry(name, { realises = 'D1', after = '', provides = '', consumes = '', rigor = 'trivial', role = '', expects, words, check } = {}) {
  const parts = words ?? [name]
  const paths = expects ?? ['src/' + parts.join('/') + '.txt']
  const cmd = check ?? 'node check.mjs ' + parts.join(' ')
  const fields = [
    'task', 'realises: ' + realises, ...(after ? ['after: ' + after] : []), ...(provides ? ['provides: ' + provides] : []),
    ...(consumes ? ['consumes: ' + consumes] : []), 'rigor: ' + rigor, ...(role ? ['role: ' + role] : []),
    ...(paths.length ? ['expects: ' + paths.join(', ')] : []),
  ]
  return ['- **' + name + '** — ' + fields.join(' · '), '  Make ' + name, '  - [ ] ' + name + ' says ok — check: `' + cmd + '`', '']
}

/** One Plan entry for a sub-effort; a planner's carries its ground and realises nothing of its own. */
export const subEffort = (name, { realises = 'D1', after = '', planner = false } = {}) => [
  '- **' + name + '** — sub-effort' + (planner ? ' · author: planner · ground: src' : ' · realises: ' + realises) + (after ? ' · after: ' + after : ''),
  '  Folder ' + name, '',
]

/** A spec text: the six sections, the Decisions rows given ([id, text]) and the Plan entries (arrays of lines). */
export function specText(entries, { decisions = [['D1', 'The leaves run.']], title = 'Execute program' } = {}) {
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

// ------------------------------------------------------------------ scripted steps

export const done = (text = 'did the work', usage = null, cost = null) => ({
  output: { status: 'done', text, concerns: [] }, ...(usage ? { usage } : {}), ...(cost === null ? {} : { cost_total: cost }),
})
export const said = (status, text = 'the producer says so') => ({ output: { status, text } })
export const failed = (cause) => ({ status: 'failed', cause })

export const ruling = (node, kind, why = 'because ' + node, question = '') => ({ node, ruling: kind, why, question: kind === 'affected' ? (question || 'Does ' + node + ' still hold?') : question })
export const rulings = (...list) => ({ output: { rulings: list } })
export const REVIEW_EMPTY = { units: [], findings: [], fix_rulings: [], claims: [], notes: '' }
export const claim = (text) => ({ claim: text, ruling: 'met', evidence: 'src/x.mjs:1' })
export const reviewed = (...claims) => ({ output: { ...REVIEW_EMPTY, claims } })

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

export const staleRuler = (head, ...steps) => ({ ['ruler|.|ruler:stale:' + head]: steps })
export const rootReview = (n = 1, ...claims) => ({ ['reviewer|.|integration:.:' + n]: [reviewed(...(claims.length ? claims : [claim('the leaves are there')]))] })
export const IMPL = (id) => `implementer|${id}|producer:${id}`

// ------------------------------------------------------------------ the world

export const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim()

function write(cwd, files) {
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

/** Wait for `pred` by the clock; rejects after two minutes. */
export async function until(pred, label, ms = 120_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await pred()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('never reached: ' + label)
}

export const ARGS0 = {
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
export function world(t, { spec, leaves, files = {}, commands, config } = {}) {
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
    const ctx = programContext({ intelligence: 'normal',
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

export const entriesOf = (rig, stamp = rig.stamp) => executionLog(rig.repo, E, stamp).entries()
export const kinds = (rig, kind, node, stamp) => entriesOf(rig, stamp).filter((e) => e.kind === kind && (node === undefined || e.node === node))
export const stateOf = (rig, stamp = rig.stamp) => readLog(rig.repo, E, 'state:' + stamp).entries
export const statusOf = (rig, id) => (readTree(rig.repo, E).status.get(id) || {}).status
export const callsOf = (w, role, node) => w.calls.filter((c) => c.role.name === role && (node === undefined || c.node === node))
/** The calls of a role on a node, one per dispatch (a host stop calls the same dispatch again), first start first. */
export const startsOf = (w, role, node) => [...new Map(callsOf(w, role, node).map((c) => [c.dispatch, c])).values()]
export const dispatchedOf = (rig, node, role = 'implementer') => kinds(rig, 'dispatched', node).filter((e) => e.role === role)
export const producerKey = (node, round = 1, role = 'implementer') => dispatchKey({ node, role, thread: 'producer:' + node, round })
export const rootHead = (rig) => rig.git('rev-parse', 'refs/heads/' + rig.branchOf('.'))
export const same = (a, b) => String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase()
export const isAncestor = (rig, ancestor, of) => {
  try {
    git(rig.repo, 'merge-base', '--is-ancestor', ancestor, of)
    return true
  } catch {
    return false
  }
}
export const seqOfFirst = (list) => (list.length ? Math.min(...list.map((e) => e.seq)) : Infinity)

export const idsOf = (list) => list.map((x) => x.id).sort()

/** A file holding the session's commands, under `.claude/` of the rig's repository. */
export function commandsFile(rig, name = 'commands.json') {
  const file = join(rig.repo, '.claude', name)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(rig.envelope.commands))
  return file
}

/** A commit on `main` touching `file`, after the rig was built: the user's base moved. */
export function moveBase(rig, file, text = 'moved\n') {
  work(rig.repo, { [file]: text }, 'the user moves the base')
  return rig.git('rev-parse', 'main')
}

/** Every claim of coverage a finished, whole execution makes. */
export function assertComplete(res, label = 'the execution') {
  assert.equal(res.coverage.complete, true, label + ' is complete: ' + JSON.stringify(res.coverage.unreached))
  assert.deepEqual(res.coverage.unreached, [])
  assert.deepEqual(res.coverage.failed_channels, [])
}

export const chainSpec = (...names) => specText(names.map((n, i) => leafEntry(n, i ? { after: names[i - 1] } : {})))

/** The root `.`, a user-written folder `c` with the leaf `k`, and the leaf `y`; `after` makes `c` wait for `y`. */
export const folderSpecs = ({ after = '' } = {}) => ({
  '.': specText([leafEntry('y', { realises: 'D1' }), subEffort('c', { realises: 'D2', after })], { decisions: [['D1', 'y is there.'], ['D2', 'c is there.']] }),
  c: subSpec([leafEntry('k', { realises: 'D2, c.D1' })]),
})
export const C_REVIEW = { 'reviewer|c|integration:c:1': [reviewed(claim('c.D1 holds'))] }
