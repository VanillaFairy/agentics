// tools/migrate-v56.mjs — the one-shot move of a store whose searches ran in a shape 5.6.0 does not
// read, run once, on the user's go.
//
// Design: docs/DESIGN.md#migration-from-4x.
//
// An old-shape search — a 5.4.1 round search or a 5.5.0 navigator search — is a searcher's dispatch
// on a search thread (`scout:*`, `common`, `locate`, `history`, `docs`, `research:*` or `repo`,
// under any scope) whose `searchDir(<home>, <thread>)` holds no `server-*.json` spec without an
// `asks` key, the lean scout's spec. A stopped program run holding one gets a `program` fault
// (`migrate-v56: <n> of its searches are in a shape 5.6.0 does not read; start the program
// again`) and a failed end, so its next claim mints
// a new run; a run whose latest segment the 5.4.1 migration faulted (`migrate-search-ledger:`)
// gets nothing more. A folder of an open execution holding one under `probe:<folder>:<n>` or
// `survey:<folder>[:<basis>]` gets `replanned {reason: retry_escalated, by: migration}`, which plans it
// afresh under a new basis, only where that record, dry-applied, leaves every node's derived
// status, every affected ruling's answer and every review's standing as they were (an unaffected
// ruling stands outright, so no replan moves it); every other folder is listed with the user's
// options. A live home is refused. Each part is read from disk again as it is written, so a
// second run, or the run after one cut short, appends nothing twice. It never deletes. The default
// is a dry run; `--yes` applies; the exit is 1 while a folder is excluded, a home is refused, or
// the ledger refused a record.

import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { openExecutions } from '../lib/boundaries/execution.mjs'
import { rulingAnswered } from '../lib/boundaries/records.mjs'
import { append, appendRun, readLog, readRunLog, runState } from '../lib/ledger.mjs'
import { loadRole } from '../lib/roles.mjs'
import { searchDir } from '../lib/search/server.mjs'
import {
  agenticsRoot, executionRunId, isRunId, mainCheckout, posix, readJson, runHome, runJsonPath, runsDir, safeSlug,
} from '../lib/store.mjs'
import { deriveStatus, readTree, standingReview } from '../lib/tree.mjs'

const MARK = 'migrate-v56:'
const OLD_MARK = 'migrate-search-ledger:'
const ROUND_NAME = /(?:^|\/)(?:scout:[^/]+|common|locate|history|docs|research:[^/]+|repo)$/
const FOLDER = '(\\.|[a-z0-9][a-z0-9-]*(?:/[a-z0-9][a-z0-9-]*)*)'
const PROBE = new RegExp('^probe:' + FOLDER + ':\\d+/locate$')
const SURVEY = new RegExp('^survey:' + FOLDER + '(?::.*)?/(?:scout:[^/]+|common|history|docs|research:[^/]+)$')
const BOUNDARY = posix(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'boundary.mjs'))

const seqOf = (e) => (e && Number.isInteger(e.seq) ? e.seq : 0)
const dirsOf = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}
const filesOf = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
  } catch {
    return []
  }
}
const empty = (root) => ({ root, runs: [], folders: [], excluded: [], left: [], refused: [] })

const kinds = new Map()
/** Whether `name` is a role of kind searcher, as the role table has it. */
function isSearcher(name) {
  const key = String(name || '')
  if (!kinds.has(key)) {
    const loaded = /^[a-z][a-z-]*$/.test(key) ? loadRole(key) : { ok: false }
    kinds.set(key, loaded.ok && loaded.role.kind === 'searcher')
  }
  return kinds.get(key)
}

/** Whether a search thread's directory holds a server spec of the lean scout: one without `asks`. */
function leanSpec(dir, thread) {
  const at = searchDir(dir, thread)
  for (const name of filesOf(at).filter((f) => /^server-.*\.json$/.test(f))) {
    const spec = readJson(join(at, name))
    if (spec && typeof spec === 'object' && !Object.hasOwn(spec, 'asks')) return true
  }
  return false
}

/** The old-shape searches among one home's records: each thread, with the seq of its latest dispatch. */
function oldSearches(dir, entries) {
  const out = new Map()
  for (const e of entries) {
    if (e.kind !== 'dispatched' || typeof e.thread !== 'string' || !ROUND_NAME.test(e.thread)) continue
    if (!isSearcher(e.role) || leanSpec(dir, e.thread)) continue
    out.set(e.thread, Math.max(out.get(e.thread) || 0, seqOf(e)))
  }
  return out
}

/** Pure. The records of a run log's latest segment: those after its last `run` record. */
const segmentOf = (entries) => entries.slice(entries.findLastIndex((e) => e.kind === 'run') + 1)

/** Pure. Whether a segment holds a fault whose detail starts with `mark`. */
const faultedWith = (since, mark) => since.some((e) => e.kind === 'fault' && String(e.detail || '').startsWith(mark))

/** Pure. The folder an execution's search thread names, or '' when it names none. */
function folderOf(thread) {
  const m = thread.match(PROBE) || thread.match(SURVEY)
  return m ? m[1] : ''
}

/** Pure. The seq of the folder's latest retry (`replanned`, reason `retry_escalated`), whoever wrote it; 0 before any. */
const retriedAt = (events, folder) => events
  .filter((e) => e.kind === 'replanned' && e.reason === 'retry_escalated' && e.node === folder)
  .reduce((at, e) => Math.max(at, seqOf(e)), 0)

/**
 * Pure. What the migration's replan of `folder`, dry-applied, changes: each node's derived status,
 * the answer of each `affected` ruling (of all the rulings given) and each node's standing review. [] when it changes none of them.
 */
function changesOf(tree, allRulings, folder, stamp) {
  const rulings = allRulings.filter((e) => typeof e.node === 'string' && e.ruling === 'affected')
  const top = [...tree.events, ...tree.nodes.values(), ...rulings].reduce((m, e) => Math.max(m, seqOf(e)), 0)
  const events = [...tree.events, { kind: 'replanned', node: folder, execution: stamp, reason: 'retry_escalated', by: 'migration', seq: top + 1 }]
  const changes = []
  const status = deriveStatus(tree.nodes, events)
  for (const [node, was] of tree.status) {
    const now = status.get(node)
    if (now.status !== was.status) changes.push({ derivation: 'status', node, before: was.status, after: now.status })
  }
  for (const r of rulings) {
    const before = rulingAnswered(r, tree)
    const after = rulingAnswered(r, { nodes: tree.nodes, events })
    if (before !== after) changes.push({ derivation: 'ruling', node: r.node, seq: r.seq, before, after })
  }
  for (const node of tree.nodes.keys()) {
    const before = seqOf(standingReview(tree.nodes, tree.events, node)) || null
    const after = seqOf(standingReview(tree.nodes, events, node)) || null
    if (before !== after) changes.push({ derivation: 'review', node, before, after })
  }
  return changes
}

/** The user's two ways past an excluded folder. */
const optionsOf = (root, effort, stamp, folder) => [
  {
    option: 'retry',
    how: 'node "' + BOUNDARY + '" retry --repo "' + root + '" --effort ' + effort + ' --node ' + folder +
      ' — the user accepts the changes listed, and the folder is planned afresh',
  },
  {
    option: 'discard',
    how: 'discard execution ' + effort + '/' + stamp + ' and execute ' + folder + ' again: a new execution plans every folder afresh',
  },
]

/** The stopped program runs holding an old-shape search; a live one is refused. */
function runParts(root, out) {
  for (const run of dirsOf(runsDir(root)).filter((r) => isRunId(r) && !runHome(root, r).stamp).sort()) {
    const meta = readJson(runJsonPath(root, run))
    if (!meta || typeof meta !== 'object') continue
    const st = runState(root, run)
    if (st.state !== 'live' && st.state !== 'stopped') continue
    const { entries } = readRunLog(root, run)
    if (faultedWith(segmentOf(entries), OLD_MARK)) continue
    const threads = [...oldSearches(runHome(root, run).dir, entries).keys()].sort()
    if (threads.length === 0) continue
    if (st.state === 'live') out.refused.push({ what: 'run ' + run, why: 'it is live: pid ' + st.run.pid })
    else out.runs.push({ run, program: String(meta.program || ''), threads })
  }
}

/** One effort's open executions: each folder holding an old-shape search, planned, excluded or left; a live execution refused. */
function effortParts(root, effort, out) {
  const tree = readTree(root, effort)
  const open = openExecutions({ repo: root, effort, execution: '' })
  const rulings = open.flatMap(({ stamp }) => readLog(root, effort, 'state:' + stamp).entries)
  for (const { stamp } of open) {
    const run = executionRunId(effort, stamp)
    const found = oldSearches(runHome(root, run).dir, readRunLog(root, run).entries)
    if (found.size === 0) continue
    const st = runState(root, run)
    if (st.state === 'live') {
      out.refused.push({ what: 'execution ' + effort + '/' + stamp, why: 'it is live: pid ' + st.run.pid })
      continue
    }
    const byFolder = new Map()
    for (const [thread, seq] of found) {
      const folder = folderOf(thread)
      const at = byFolder.get(folder) || { threads: [], seq: 0 }
      at.threads.push(thread)
      at.seq = Math.max(at.seq, seq)
      byFolder.set(folder, at)
    }
    for (const folder of [...byFolder.keys()].sort()) {
      const { threads, seq } = byFolder.get(folder)
      const part = { effort, execution: stamp, folder, threads: threads.sort() }
      const node = tree.nodes.get(folder)
      if (!folder) {
        out.left.push({ ...part, why: 'its threads name no folder, so nothing plans them again' })
      } else if (!node || node.kind === 'leaf' || node.kind === 'group') {
        out.left.push({ ...part, why: 'no live folder ' + folder + ' holds them, so nothing plans them again' })
      } else if (retriedAt(tree.events, folder) <= seq) {
        const changes = changesOf(tree, rulings, folder, stamp)
        if (changes.length === 0) out.folders.push(part)
        else out.excluded.push({ ...part, changes, options: optionsOf(root, effort, stamp, folder) })
      }
    }
  }
}

/** What the store needs, without writing anything. */
export function plan(repo) {
  const root = posix(mainCheckout(resolve(String(repo))))
  const out = empty(root)
  runParts(root, out)
  for (const effort of dirsOf(agenticsRoot(root)).filter((x) => safeSlug(x) === x).sort()) effortParts(root, effort, out)
  return out
}

/**
 * The records a run still lacks of its migration, from the disk now: none unless it is stopped,
 * holds an old-shape search and its latest segment carries no 5.4.1 migration fault.
 */
function runRecords(root, run) {
  if (runState(root, run).state !== 'stopped') return []
  const { entries } = readRunLog(root, run)
  const since = segmentOf(entries)
  if (faultedWith(since, OLD_MARK)) return []
  const found = oldSearches(runHome(root, run).dir, entries)
  if (found.size === 0) return []
  return [
    ...(faultedWith(since, MARK) ? [] : [{
      kind: 'fault', node: '', channel: 'program',
      detail: MARK + ' ' + found.size + ' of its searches are in a shape 5.6.0 does not read; start the program again',
    }]),
    { kind: 'ended', result: { status: 'failed', file: '', complete: false } },
  ]
}

/** Whether the folder is still planned, read from disk now. */
function stillPlanned(root, f) {
  const out = empty(root)
  effortParts(root, f.effort, out)
  return out.folders.some((x) => x.execution === f.execution && x.folder === f.folder)
}

/**
 * Perform what the plan lists: `{applied, error}`, `applied` the number of records appended and
 * `error` '' when every one landed. Each part is read from disk again first, and skipped once it
 * is no longer due. The first record the ledger refuses, or anything that throws, stops the run
 * there; what landed before it stays, and the next run finishes the rest.
 */
export function apply(p) {
  let applied = 0
  const add = (out) => {
    if (!out.ok) throw new Error('the ledger refused a migrated record: ' + out.error)
    applied += out.seqs.length
  }
  try {
    for (const r of p.runs) {
      const records = runRecords(p.root, r.run)
      if (records.length) add(appendRun(p.root, r.run, records))
    }
    for (const f of p.folders) {
      if (!stillPlanned(p.root, f)) continue
      add(append(p.root, f.effort, 'events', { kind: 'replanned', node: f.folder, execution: f.execution, reason: 'retry_escalated', by: 'migration' }))
    }
  } catch (err) {
    return { applied, error: String(err && err.message ? err.message : err) }
  }
  return { applied, error: '' }
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  const argv = process.argv.slice(2)
  const repo = argv.find((a) => !a.startsWith('--')) || '.'
  const p = plan(repo)
  const done = argv.includes('--yes') ? apply(p) : { applied: 0, error: '' }
  console.log(JSON.stringify({ applied: done.applied, ...p, error: done.error }, null, 1))
  process.exitCode = done.error || p.excluded.length || p.refused.length ? 1 : 0
}
