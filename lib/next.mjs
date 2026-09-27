// lib/next.mjs — compute-next-action: the one command to run next for an effort, derived on every
// call from its specs, the ledger, the node log, the events and its executions. Nothing is stored.
//
// Design: docs/DESIGN.md#progress.
//
// Why a fixed walk. A fresh session must print the Next line the last one printed, so the line is
// the first match of seven rules in a fixed order, and a tie goes to the first folder depth-first
// in sorted folder-id order, never to whatever a session touched last.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { approvalState } from './approval.mjs'
import { executionsOf } from './effort.mjs'
import { readLog } from './ledger.mjs'
import { parseSpec } from './spec.mjs'
import { efforts, executionSummary } from './status.mjs'
import { ROOT_ID, envelope, flagOf, folderDir, parentOf, posix, safeSlug, specPath } from './store.mjs'
import { readTree } from './tree.mjs'

const segments = (id) => (id === ROOT_ID ? [] : id.split('/'))

/** Pure. Depth-first order over folder or node ids: a parent before its children, siblings by name. */
function depthFirst(a, b) {
  const x = segments(a)
  const y = segments(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return x.length - y.length
}

/** How a command names a folder: the effort for its root, otherwise the folder id. */
const nameOf = (effort, id) => (id === ROOT_ID ? effort : id)

/** The root folder and every folder below it that holds a spec, depth-first. */
function foldersOf(repo, effort) {
  const out = []
  const walk = (id) => {
    const path = specPath(repo, effort, id)
    const exists = existsSync(path)
    if (exists || id === ROOT_ID) {
      out.push({ id, path: posix(path), exists, spec: parseSpec(exists ? readFileSync(path, 'utf8') : '', { file: posix(path) }) })
    }
    let names = []
    try {
      names = readdirSync(folderDir(repo, effort, id), { withFileTypes: true })
        .filter((e) => e.isDirectory() && safeSlug(e.name) === e.name).map((e) => e.name).sort()
    } catch {
      names = []
    }
    for (const name of names) walk(id === ROOT_ID ? name : id + '/' + name)
  }
  walk(ROOT_ID)
  return out
}

/** Who writes a folder's spec: 'you', 'planner' (its sub-effort says so, or it is a promoted task) or 'skipped' (deferred, dropped). */
function authorOf(byId, id) {
  if (id === ROOT_ID) return 'you'
  const parent = byId.get(parentOf(id))
  const name = id.slice(id.lastIndexOf('/') + 1)
  const entry = parent ? parent.spec.entries.find((e) => e.name === name) : null
  if (!entry) return 'you'
  if (entry.kind === 'sub-effort') return entry.author
  return entry.kind === 'task' ? 'planner' : 'skipped'
}

/** Whether id's own parent entry, and every ancestor's, still names it a sub-effort or task: a
 * deferred or dropped entry compiles to nothing and retires its subtree, so nothing under it is
 * live even when its own spec is still approved on disk. */
function isLive(byId, id) {
  for (let at = id; at !== null; at = parentOf(at)) if (authorOf(byId, at) === 'skipped') return false
  return true
}

/** The next action for one effort: the first rule of spec §5.7 that matches, and up to two alternatives. */
export function nextAction(repo, effort) {
  const folders = foldersOf(repo, effort)
  const byId = new Map(folders.map((f) => [f.id, f]))
  for (const f of folders) {
    f.author = authorOf(byId, f.id)
    const approval = approvalState(repo, effort, f.id)
    f.state = approval.state
    f.hash = approval.hash
  }
  const tree = readTree(repo, effort)
  const ledger = readLog(repo, effort, 'ledger').entries
  /** The folder's latest `reviewed` line by seq, or null. */
  const lastReview = (id) => ledger.filter((l) => l.kind === 'reviewed' && l.folder === id)
    .reduce((best, l) => (!best || (l.seq || 0) > (best.seq || 0) ? l : best), null)
  const found = []
  const add = (rule, key, folder, command, why) => found.push({ rule, key, folder, command, why })
  const design = (id) => '/agentics:design ' + nameOf(effort, id)
  const develop = (id) => '/agentics:develop ' + nameOf(effort, id)
  const owner = (id) => {
    for (let at = id; at !== null; at = parentOf(at)) if (byId.has(at) && byId.get(at).exists) return byId.get(at)
    return byId.get(ROOT_ID)
  }

  // 1. an open execution
  const open = executionsOf(repo, effort).map((stamp) => executionSummary(repo, effort, stamp)).filter((x) => !x.closed)
    .sort((a, b) => depthFirst(a.root, b.root) || (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0))
  for (const x of open) add(1, x.root, x.root, develop(x.root), 'execution ' + x.stamp + ' of ' + nameOf(effort, x.root) + ' is still open: resume it')

  // 2. a parked or escalated node, on its own event (a composite that only sums its children is skipped)
  for (const [id, s] of tree.status) {
    if (!['parked', 'escalated'].includes(s.status) || !s.last || s.last.kind !== s.status) continue
    const reason = s.status === 'parked' ? s.last.return || 'parked' : s.last.reason || 'escalated'
    const said = s.status === 'parked' ? s.last.question : s.last.detail
    const spec = owner(id)
    const why = id + ' is ' + s.status + ' (' + reason + ')' + (said ? ': ' + said : '') + '; the spec to edit is ' + spec.path
    if (reason === 'needs_design') add(2, id, id, design(id), why)
    else add(2, id, spec.id, develop(spec.id), why)
  }

  // 3 and 4. specs the user writes: a blocking question, a partial review of the text on disk, not
  // approved, edited since approval
  for (const f of folders) {
    if (f.author !== 'you') continue
    const blocking = f.spec.questions.find((q) => q.grade === 'blocking')
    const review = lastReview(f.id)
    const partial = review && review.complete === false && review.hash === f.hash && (f.state === 'none' || f.state === 'edited')
    if (blocking) add(3, f.id, f.id, design(f.id), nameOf(effort, f.id) + ' has a blocking question: ' + blocking.text)
    else if (partial) {
      add(3, f.id, f.id, design(f.id), nameOf(effort, f.id) + '\'s review was partial: re-run it on the axes it left unexamined, ' +
        (review.remaining || []).join(', '))
    } else if (f.state === 'none') add(3, f.id, f.id, design(f.id), nameOf(effort, f.id) + (f.exists ? ' is not approved yet' : ' has no spec yet'))
    else if (f.state === 'edited') add(4, f.id, f.id, design(f.id), nameOf(effort, f.id) + ' was edited since its approval: review the change')
  }

  // 5. an approved plan names a sub-effort of yours that has no spec yet
  for (const f of folders) {
    if (f.state !== 'approved' && f.state !== 'prepared') continue
    if (!isLive(byId, f.id)) continue
    for (const e of f.spec.entries) {
      if (e.kind !== 'sub-effort' || e.author !== 'you') continue
      const id = f.id === ROOT_ID ? e.name : f.id + '/' + e.name
      if (!byId.has(id)) add(5, id, id, design(id), nameOf(effort, f.id) + ' plans ' + e.name + ', which has no spec yet')
    }
  }

  // 6. approved or prepared, and nothing at or below it dispatched
  const dispatched = tree.events.filter((e) => e.kind === 'dispatched').map((e) => String(e.node || ''))
  const within = (folder, node) => folder === ROOT_ID || node === folder || node.startsWith(folder + '/')
  for (const f of folders) {
    if (f.state !== 'approved' && f.state !== 'prepared') continue
    if (!isLive(byId, f.id)) continue
    if (dispatched.some((node) => within(f.id, node))) continue
    add(6, f.id, f.id, develop(f.id), nameOf(effort, f.id) + ' is ' + f.state + ' and nothing under it has run: build it')
  }

  // 7. the root integrated
  const root = tree.status.get(ROOT_ID)
  if (root && root.status === 'integrated') add(7, ROOT_ID, ROOT_ID, develop(ROOT_ID), 'the root is integrated: read the landing view, then land it')

  found.sort((a, b) => a.rule - b.rule || depthFirst(a.key, b.key))
  if (found.length === 0) {
    const landed = root && root.status === 'landed'
    return { effort, folder: ROOT_ID, rule: 0, command: '', why: landed ? effort + ' has landed: nothing is left to do' : 'nothing to do in ' + effort, alternatives: [] }
  }
  const [first] = found
  const alternatives = []
  for (const c of found.slice(1)) {
    if (alternatives.length === 2) break
    if (c.command === first.command || alternatives.some((a) => a.command === c.command)) continue
    alternatives.push({ command: c.command, why: c.why })
  }
  return { effort, folder: first.folder, rule: first.rule, command: first.command, why: first.why, alternatives }
}

/** Every effort, where its root stands, and its Next line. */
export function nextForAll(repo) {
  return efforts(repo).efforts.map((e) => ({ effort: e.effort, about: e.about, root_status: e.root_status, next: nextAction(repo, e.effort) }))
}

/** Every folder of every effort, named as commands name it: what `/agentics:design <words>` matches against. */
export function listFolders(repo) {
  const out = []
  for (const effort of efforts(repo).efforts.map((e) => e.effort).sort()) {
    for (const f of foldersOf(repo, effort)) {
      out.push({ effort, folder: f.id, name: nameOf(effort, f.id), title: f.spec.title, path: f.path, state: approvalState(repo, effort, f.id).state })
    }
  }
  return out
}

// ------------------------------------------------------------------ CLI

const line = (c) => (c.command || 'nothing to do') + ' — ' + c.why

/** Pure. One effort's Next line as a person reads it. */
function renderNext(n) {
  return ['Next: ' + line(n), ...n.alternatives.map((a) => '  or: ' + line(a))].join('\n')
}

function renderAll({ efforts: list }) {
  if (list.length === 0) return 'No efforts yet.'
  return list.map((e) => e.effort + ' (' + e.root_status + ')' + (e.about ? ' — ' + e.about : '') + '\n  ' +
    renderNext(e.next).split('\n').join('\n  ')).join('\n')
}

function renderFolders({ folders }) {
  if (folders.length === 0) return 'No folders yet.'
  return folders.map((f) => f.name + '  [' + f.effort + ', ' + f.state + ']  ' + f.title).join('\n')
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  try {
    const argv = process.argv.slice(2)
    const repo = flagOf(argv, 'repo') || '.'
    const effort = flagOf(argv, 'effort')
    const json = argv.includes('--json')
    const print = (payload, render) => console.log(json ? JSON.stringify(envelope(payload)) : render(payload))
    if (argv[0] === 'folders') print({ folders: listFolders(repo) }, renderFolders)
    else if (effort) {
      if (!safeSlug(effort)) throw new Error('--effort must name an effort, not ' + JSON.stringify(effort))
      print(nextAction(repo, effort), renderNext)
    } else print({ efforts: nextForAll(repo) }, renderAll)
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
