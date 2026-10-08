// tools/migrate-v5.mjs — the one-shot move of a repository's 4.x effort store to 5.0, run once, on
// the user's go.
//
// Design: docs/DESIGN.md#migration-from-4x.
//
// Every part appends at a new seq, so each part takes only what keeps every derived status as it
// was: a stop is stated again only while it is its node's open stop, a `claims` event only while
// it stands, a `judged` line only while it judges its item's latest revision, a fixes file only
// while no later round superseded it. A 4.x said file is stated again as a stored return, so
// nothing reads one. A 4.x execution is one whose state holds no `run` line. Each part recognises
// its own work, so a second run, or the run after one cut short, appends nothing twice. It never
// deletes: what 5.0 does not read is listed in `left`. The default is a dry run; `--yes` applies.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { approvalState } from '../lib/approval.mjs'
import { append, appendProject, readLog, readProjectLog } from '../lib/ledger.mjs'
import {
  ROOT_ID, STAMP, agenticsRoot, effortStateDir, executionDir, executionsRoot, holderGone, nodeKey, pidAlive, posix, readJson,
  returnPath, safeSlug, writeWhole,
} from '../lib/store.mjs'
import { claimsEventOf, cycleOf, readTree, standingReview } from '../lib/tree.mjs'
import { remedyOf } from '../lib/verdict.mjs'

const MARKER = 'migrated: a 5.0 review rules units'
const DISPATCH_KEY = /^[A-Za-z0-9][A-Za-z0-9.-]*$/
const KEPT = new Set(['execution.json', 'state.jsonl', 'journal.jsonl', 'returns'])
const LEFT = {
  jobs: '4.x detached jobs', cards: '4.x launch cards', fixes: '4.x fixes files', said: '4.x said files',
  briefs: '4.x briefs', closes: '4.x close records', reviews: '4.x review records', merges: '4.x merge records',
  gates: '4.x gate records',
}

const list = (v) => (Array.isArray(v) ? v : [])
const objectOf = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {})
const entriesOf = (dir, dirs) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() === dirs).map((e) => e.name)
  } catch {
    return []
  }
}
const readText = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Pure. A `said` naming a 4.x file: a path, not a dispatch key. */
const fourX = (said) => typeof said === 'string' && said !== '' && !DISPATCH_KEY.test(said)

/** Pure. The bytes of a re-stated stop's stored return. */
const storedBytes = (text) => JSON.stringify({ status: 'migrated', text })

/** Pure. A fixes-file entry a 4.x review wrote: `source` `review <severity> <id>`. */
const isReview = (x) => x && typeof x.source === 'string' && x.source.startsWith('review ')

/** Pure. A review entry of a 4.x fixes file as a 5.0 finding. */
function asFinding(x) {
  const [, severity = '', id = ''] = x.source.split(' ')
  return { id, severity, claim: String(x.claim || ''), evidence: String(x.evidence || ''), failure_scenario: '' }
}

/** Pure. A leaf's review entries by the thread that answers them: a cycle's tests to its test session. */
function findingsByThread(nodes, leaf, entries) {
  const out = new Map()
  for (const x of entries.filter(isReview)) {
    const toTests = (leaf.role === 'green' || leaf.role === 'audit') && remedyOf(x) === 'tests'
    const thread = toTests ? 'producer:' + (cycleOf(nodes, leaf.id)[0] || leaf.id)
      : leaf.role === 'audit' ? 'auditor:' + leaf.id : 'producer:' + leaf.id
    out.set(thread, [...(out.get(thread) || []), asFinding(x)])
  }
  return out
}

/** Why the effort must wait: its lock held, as the lock itself judges a holder, or a 4.x job still running; '' when free. */
function busyWhy(root, effort) {
  const lock = join(effortStateDir(root, effort), '.lock')
  for (const name of entriesOf(lock, false)) {
    const path = join(lock, name)
    if (holderGone(path, new Map())) continue
    const { pid } = objectOf(readJson(path))
    return 'the effort lock is held' + (Number.isInteger(pid) ? ' by pid ' + pid : '')
  }
  for (const stamp of entriesOf(executionsRoot(root, effort), true)) {
    const jobs = join(executionDir(root, effort, stamp), 'jobs')
    for (const name of entriesOf(jobs, false).filter((n) => n.endsWith('.pid'))) {
      const pid = Number.parseInt(readText(join(jobs, name)) || '', 10)
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return 'a 4.x job is running: pid ' + pid + ' (' + posix(join(jobs, name)) + ')'
    }
  }
  return ''
}

/** The effort's 4.x executions, oldest first: those whose state holds no `run` line. */
function fourXExecutions(root, effort) {
  return entriesOf(executionsRoot(root, effort), true).filter((s) => STAMP.test(s)).sort()
    .map((stamp) => ({ stamp, dir: executionDir(root, effort, stamp), state: readLog(root, effort, 'state:' + stamp).entries }))
    .filter((x) => !x.state.some((e) => e.kind === 'run'))
}

/** The leaf's latest fixes file among the 4.x executions: the newest execution holding one, its highest round. */
function latestFixes(executions, leafId) {
  const name = new RegExp('^' + nodeKey(leafId).replace(/[.]/g, '\\.') + '-r(\\d+)\\.json$')
  for (const x of [...executions].reverse()) {
    const rounds = entriesOf(join(x.dir, 'fixes'), false).map((n) => n.match(name)).filter(Boolean).map((m) => Number(m[1]))
    if (rounds.length) {
      const round = Math.max(...rounds)
      return { file: posix(join(x.dir, 'fixes', nodeKey(leafId) + '-r' + round + '.json')), round }
    }
  }
  return null
}

/** The highest round any `dispatched` event records for `leafId`: a fixes file of an earlier round was answered by it. */
const dispatchedRound = (events, leafId) =>
  Math.max(0, ...events.filter((e) => e.kind === 'dispatched' && e.node === leafId && Number.isInteger(e.round)).map((e) => e.round))

/**
 * The dispatch a 4.x said file of `ev` is stated again as: the stored return of its text under the
 * event's execution. Null once the reason it cannot be is in `out.refused`: the event names no
 * execution, the file cannot be read, or the return is there with other bytes.
 */
function restatement(root, effort, id, ev, what, out) {
  if (!STAMP.test(String(ev.execution || ''))) {
    out.refused.push({ what, why: 'it names no execution to keep its text in' })
    return null
  }
  const text = readText(resolve(root, ev.said))
  if (text === null) {
    out.refused.push({ what, why: 'its said file ' + ev.said + ' cannot be read' })
    return null
  }
  // A shortened node key carries `_`, which no dispatch key holds: saidOf would never read it.
  const dispatch = 'migrated-' + (id === ROOT_ID ? 'root' : nodeKey(id).replace(/_/g, '-')) + '-' + ev.seq
  const target = returnPath(executionDir(root, effort, ev.execution), dispatch)
  if (existsSync(target) && readText(target) !== storedBytes(text)) {
    out.refused.push({ what, why: posix(target) + ' exists with other bytes' })
    return null
  }
  return dispatch
}

/** Keep the text of `file` as the return `dispatch` names under the execution of `old`; a return already there stays as it is. */
function storeSaid(root, effort, old, { file, dispatch }) {
  const target = returnPath(executionDir(root, effort, old.execution), dispatch)
  if (!existsSync(target)) writeWhole(target, storedBytes(readFileSync(resolve(root, file), 'utf8')))
}

/** What one effort needs, appended to `out.refused` and `out.left` where it applies. */
function effortPlan(root, effort, out) {
  const tree = readTree(root, effort)
  const executions = fourXExecutions(root, effort)
  const e = { effort, executions: [], stops: [], claims: [], reviewed: [], messages: [] }

  for (const x of executions) {
    if (readJson(join(x.dir, 'execution.json')) && !x.state.some((s) => s.kind === 'closed')) e.executions.push({ stamp: x.stamp })
  }

  for (const [id, s] of tree.status) {
    const ev = s.last
    if (!ev || (ev.kind !== 'escalated' && ev.kind !== 'parked') || !fourX(ev.said)) continue
    const dispatch = restatement(root, effort, id, ev, 'the ' + ev.kind + ' stop of ' + id + ' at seq ' + ev.seq + ' in ' + effort, out)
    if (dispatch) e.stops.push({ node: id, seq: ev.seq, file: ev.said, dispatch })
  }

  for (const id of tree.nodes.keys()) {
    const c = claimsEventOf(tree.events, id)
    if (!c || standingReview(tree.nodes, tree.events, id) !== c || !c.claims.some((x) => x && Object.hasOwn(x, 'verdict'))) continue
    if (!fourX(c.said)) {
      e.claims.push({ node: id, seq: c.seq })
      continue
    }
    const dispatch = restatement(root, effort, id, c, 'the claims of ' + id + ' at seq ' + c.seq + ' in ' + effort, out)
    if (dispatch) e.claims.push({ node: id, seq: c.seq, file: c.said, dispatch })
  }

  const ledger = readLog(root, effort, 'ledger').entries
  for (const folder of [...new Set(ledger.filter((l) => l.kind === 'reviewed' && typeof l.folder === 'string').map((l) => l.folder))].sort()) {
    const { state, hash } = approvalState(root, effort, folder)
    if (!hash || state === 'approved' || state === 'prepared') continue
    const latest = ledger.filter((l) => l.kind === 'reviewed' && l.folder === folder && l.hash === hash)
      .reduce((best, l) => (!best || l.seq > best.seq ? l : best), null)
    if (latest && latest.complete === true) e.reviewed.push({ folder, hash, seq: latest.seq })
  }

  for (const [id, n] of tree.nodes) {
    const status = tree.status.get(id).status
    if (n.kind !== 'leaf' || status === 'merged' || status === 'approved') continue
    const fixes = latestFixes(executions, id)
    if (!fixes || fixes.round < dispatchedRound(tree.events, id)) continue
    for (const [thread, findings] of findingsByThread(tree.nodes, n, list(readJson(fixes.file)))) {
      const sent = tree.events.some((m) => m.kind === 'message' && m.node === id && m.thread === thread && m.msg === 'findings' && m.execution === '')
      if (!sent) e.messages.push({ node: id, thread, findings_n: findings.length, file: fixes.file, round: fixes.round })
    }
  }

  for (const x of executions) {
    for (const name of readdirSync(x.dir).filter((n) => !KEPT.has(n)).sort()) {
      const why = LEFT[name] || (name.startsWith('stale-') ? '4.x stale brief' : 'unknown to 5.0')
      out.left.push({ path: posix(join(x.dir, name)), why })
    }
  }
  const reports = join(effortStateDir(root, effort), 'reports')
  if (existsSync(reports)) out.left.push({ path: posix(reports), why: '4.x reports and progress files' })
  return e
}

/** Each id's latest `judged` line still in its 4.x shape that judges the item's latest revision. */
function judgedPlan(root) {
  const items = new Map()
  const judged = new Map()
  for (const x of readProjectLog(root, 'items').entries) {
    if (x.kind === 'item' && x.item && typeof x.item.id === 'string') items.set(x.item.id, Math.max(items.get(x.item.id) || 0, x.seq))
    else if (x.kind === 'judged' && typeof x.id === 'string' && (!judged.has(x.id) || x.seq > judged.get(x.id).seq)) judged.set(x.id, x)
  }
  return [...judged.values()]
    .filter((j) => Object.hasOwn(j, 'verdict') && j.seq > (items.get(j.id) || 0))
    .map((j) => ({ id: j.id, seq: j.seq }))
    .sort((a, b) => a.seq - b.seq)
}

/** What the store needs, without writing anything. */
export function plan(repo) {
  const root = posix(resolve(repo))
  const out = { root, efforts: [], judged: judgedPlan(root), refused: [], left: [] }
  for (const effort of entriesOf(agenticsRoot(root), true).filter((x) => safeSlug(x) === x).sort()) {
    const busy = busyWhy(root, effort)
    if (busy) out.refused.push({ what: 'effort ' + effort, why: busy })
    else out.efforts.push(effortPlan(root, effort, out))
  }
  return out
}

/** Perform what the plan lists; `applied` is the number of records appended. */
export function apply(p) {
  let applied = 0
  const add = (out) => {
    if (!out.ok) throw new Error('the ledger refused a migrated record: ' + out.error)
    applied += out.seqs.length
  }
  for (const e of p.efforts) {
    const tree = readTree(p.root, e.effort)
    const bySeq = new Map(tree.events.map((x) => [x.seq, x]))
    for (const { stamp } of e.executions) {
      add(append(p.root, e.effort, 'state:' + stamp, [
        { kind: 'closed', status: 'migrated' },
        { kind: 'ended', result: { status: 'migrated', file: '', complete: false } },
      ]))
    }
    for (const s of e.stops) {
      const { seq: _seq, ...old } = bySeq.get(s.seq)
      storeSaid(p.root, e.effort, old, s)
      add(append(p.root, e.effort, 'events', { ...old, said: s.dispatch }))
    }
    for (const c of e.claims) {
      const { seq: _seq, ...old } = bySeq.get(c.seq)
      if (c.dispatch) storeSaid(p.root, e.effort, old, c)
      add(append(p.root, e.effort, 'events', {
        ...old, ...(c.dispatch ? { said: c.dispatch } : {}), claims: old.claims.map(({ verdict, ...rest }) => ({ ...rest, ruling: verdict })),
      }))
    }
    // The marker keeps the review's ambiguities and the sections that name them, and rules no section
    // clean: the gate's open ambiguities stay as the review left them.
    const reviews = new Map(readLog(p.root, e.effort, 'ledger').entries.map((x) => [x.seq, x]))
    for (const r of e.reviewed) {
      const review = reviews.get(r.seq)
      add(append(p.root, e.effort, 'ledger', {
        kind: 'reviewed', folder: r.folder, hash: r.hash, complete: false, remaining: [MARKER],
        ambiguities: list(review.ambiguities), clean: [], sections: objectOf(review.sections),
      }))
    }
    for (const m of e.messages) {
      const findings = findingsByThread(tree.nodes, tree.nodes.get(m.node), list(readJson(m.file))).get(m.thread) || []
      add(append(p.root, e.effort, 'events', {
        kind: 'message', node: m.node, thread: m.thread, from: 'code', msg: 'findings', payload: { findings }, round: m.round, execution: '',
      }))
    }
  }
  const items = new Map(readProjectLog(p.root, 'items').entries.map((x) => [x.seq, x]))
  for (const j of p.judged) {
    const { seq: _seq, verdict, ...old } = items.get(j.seq)
    add(appendProject(p.root, 'items', { ...old, ruling: verdict }))
  }
  return { applied }
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  const argv = process.argv.slice(2)
  const repo = argv.find((a) => !a.startsWith('--')) || '.'
  const p = plan(repo)
  const applied = argv.includes('--yes') ? apply(p).applied : 0
  console.log(JSON.stringify({ applied, ...p }, null, 1))
}
