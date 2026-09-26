// lib/effort.mjs — an effort's identity and its evidence: the survey and probe returns a phase
// recorded, verbatim, and the one computed question asked of them — does the newest survey still
// stand? It also creates sub-effort folders and renames them among their siblings.
//
// Design: docs/DESIGN.md#storage, docs/DESIGN.md#survey.
//
// Why this exists. A change moves through design, survey, probe and one or more executions, and
// the design pass and the develop pass are usually separate sessions. Whatever the first one
// learned that did not reach a node or a design document would be gone before the second opened,
// so a phase's return is written under the effort, by the session that ran the phase, exactly as
// it was returned: `evidence/<stamp>-<kind>.json`. Nothing is summarised and no field is added.
//
// What this is NOT. A stored return is durable scratch, not evidence: it proves nothing by being
// here. ONE thing here can stand in for a later survey, and only by arithmetic: a survey recorded
// with its ANCHOR — the commit it was taken at and the ground its topics searched, written beside
// it as `<stamp>-survey.anchor`, never into it — that `standingSurvey` finds untouched. No commit
// since the anchor reaches that ground, no uncommitted edit sits on it, and the survey itself
// reported complete coverage. Whether the change's SHAPE is settled stays the caller's judgment;
// this answers only whether the ground moved. A survey recorded without an anchor never stands.
//
// What moved out. Runs and designs used to be pointers appended to a links file. A design is now
// a node's `design_doc`, and executions live in the effort's `.state/executions/<stamp>/`, so both
// are read from where they are rather than from a second record that could disagree with it.
// Names, stamps and path discipline are `lib/store.mjs`'s, so an effort is spelled one way.

import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

import { approvalState } from './approval.mjs'
import { append, readLog } from './ledger.mjs'
import { canonical, fnv1a } from './plan-digest.mjs'
import { hashSpec, parseSpec } from './spec.mjs'
import {
  AGENTICS_DIR, ROOT_ID, STAMP, effortDir, effortStateDir, effortsRoot, executionsRoot, envelope, flagOf, folderDir,
  git, mainCheckout, nodeIdProblem, parentOf, posix, safePath, safeSlug, specPath, stampNow, mkdirState,
} from './store.mjs'
import { liveNodes } from './tree.mjs'

export { safeSlug, stampNow }

/** The identity file inside one effort, and the directory its phase returns land in. */
const IDENTITY_FILE = 'effort.json'
const EVIDENCE_DIR = 'evidence'

/** The phase returns an effort stores. */
export const KINDS = ['survey', 'probe']

const ANCHOR_EXT = '.anchor'

/** `<stamp>[-<n>]-<kind>.json` — the collision counter sits between the stamp and the kind. */
const EVIDENCE_FILE = /^(\d{8}-\d{6})(?:-(\d+))?-(survey|probe)\.json$/

/**
 * Pure. A first proposal for an effort's name: at most four words of `about`, kebab-case,
 * undated. The user confirms or changes it, and `openEffort` validates what they chose. Words are
 * joined by single dashes, so the result never carries the `--` that `safeSlug` refuses.
 */
export function slugFor(about) {
  const name = String(about || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .slice(0, 4)
    .join('-')
    .slice(0, 120)
    .replace(/-+$/, '')
  return name || 'effort'
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const unusable = (slug) => 'the effort name ' + JSON.stringify(slug) + ' is not usable — lower-case ' +
  'letters, digits and single dashes, one segment'

// ------------------------------------------------------------------ opening

/**
 * Open an effort, or report the one that is already open under that name.
 *
 * Idempotent by construction: the identity file is written once and never rewritten, so a second
 * phase opening the same effort adopts what the first recorded instead of restating it in its own
 * words. A phase that disagrees about what the effort is FOR is describing a different effort.
 */
export function openEffort(repo, { slug, about, roots, now }) {
  const name = safeSlug(slug)
  if (!name) return { ok: false, error: unusable(slug) }

  const dir = effortDir(repo, name)
  const state = effortStateDir(repo, name)
  const identity = join(state, IDENTITY_FILE)

  if (existsSync(identity)) {
    const held = readJson(identity) || {}
    return {
      ok: true, effort: name, path: posix(dir), created: false,
      about: typeof held.about === 'string' ? held.about : '',
      notes: 'this effort was already open; its identity is what the phase that opened it recorded',
    }
  }

  const record = {
    about: String(about || '').trim(),
    roots: (Array.isArray(roots) ? roots : String(roots || '').split(/[,;\n]/))
      .map((r) => posix(r).trim()).filter(Boolean),
    opened_at: (now instanceof Date ? now : new Date()).toISOString(),
  }

  try {
    mkdirState(state)
    writeFileSync(identity, JSON.stringify(record, null, 2) + '\n', 'utf8')
  } catch (err) {
    return { ok: false, error: 'the effort could not be opened: ' + err.message }
  }

  return { ok: true, effort: name, path: posix(dir), created: true, about: record.about }
}

// ------------------------------------------------------------------ folders

const refusal = (error) => ({ ok: false, error })
const lastSegment = (id) => id.split('/').pop()
const flat = (id) => id.split('/').join('.')
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** What is wrong with a sub-effort folder id, or ''. The root is the effort, never a sub-effort. */
function folderIdProblem(id) {
  if (id === ROOT_ID) return 'the root folder is the effort itself; name a sub-effort folder'
  const bad = nodeIdProblem(id)
  if (bad) return bad
  return String(id).split('/').every((s) => safeSlug(s) === s) ? '' : 'folder names follow the segment rule: ' + JSON.stringify(id)
}

/** The spec every new folder starts from: the title and the six sections, each empty. */
const skeleton = (title) => [
  '# ' + title, '',
  '## Intent', '',
  '## Decisions', '', '| id | decision | why |', '|---|---|---|', '',
  '## Design', '',
  '## Plan', '',
  '## Open questions', '',
  '## Evidence', '',
].join('\n')

/**
 * Create a sub-effort's folder with a skeleton spec. Its parent must already hold a spec, and an
 * existing spec is never overwritten: the design session resumes it instead.
 */
export function createSubEffortFolder(repo, effort, folderId, { title = '' } = {}) {
  const name = safeSlug(effort)
  if (!name) return refusal(unusable(effort))
  const bad = folderIdProblem(folderId)
  if (bad) return refusal(bad)
  if (!existsSync(specPath(repo, name, parentOf(folderId)))) {
    return refusal('the parent folder ' + parentOf(folderId) + ' has no SPEC.md — its spec comes first')
  }
  const path = specPath(repo, name, folderId)
  if (existsSync(path)) return refusal(posix(path) + ' already exists — resume it instead')
  try {
    mkdirState(folderDir(repo, name, folderId))
    writeFileSync(path, skeleton(String(title || '').trim() || lastSegment(folderId)), { encoding: 'utf8', flag: 'wx' })
  } catch (err) {
    return refusal('the folder could not be created: ' + err.message)
  }
  return { ok: true, folder: folderId, path: posix(path) }
}

/** Every folder at or below `from` that holds a spec, parents first. Dot directories are never folders. */
function specFolders(repo, effort, from) {
  const out = []
  const walk = (id) => {
    if (existsSync(specPath(repo, effort, id))) out.push(id)
    let entries = []
    try {
      entries = readdirSync(folderDir(repo, effort, id), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.isDirectory() && safeSlug(e.name) === e.name) walk(id === ROOT_ID ? e.name : id + '/' + e.name)
    }
  }
  walk(from)
  return out
}

/** A spec's text with LF endings and no BOM, and how to put its own endings and BOM back. */
function specText(path) {
  const raw = readFileSync(path, 'utf8')
  const bom = raw.startsWith('﻿') ? '﻿' : ''
  const crlf = raw.includes('\r\n')
  return { text: raw.slice(bom.length).replace(/\r\n/g, '\n'), back: (t) => bom + (crlf ? t.replace(/\n/g, '\r\n') : t) }
}

/**
 * Pure. One spec's text after `fromId` is renamed `toId`: every decision id carrying the old
 * prefix, the entry's name in its parent's plan (`parentHere`), and every `after` naming it — a
 * bare sibling name in the parent's plan, or a `/`-path at or below it anywhere.
 */
function renamedText(text, fromId, toId, parentHere) {
  const ids = new RegExp('(?<![A-Za-z0-9.-])' + escapeRe(flat(fromId)) + '\\.((?:[a-z0-9-]+\\.)*D[1-9][0-9]*)(?![A-Za-z0-9])', 'g')
  const fromName = lastSegment(fromId)
  const toName = lastSegment(toId)
  const lines = text.replace(ids, flat(toId) + '.$1').split('\n')

  const spec = parseSpec(lines.join('\n'))
  const plan = spec.sections.Plan ? spec.sections.Plan.line : 0
  const next = Math.min(lines.length + 1, ...Object.values(spec.sections).map((s) => s.line).filter((l) => l > plan))
  const renameAfter = (v) => {
    if (parentHere && v === fromName) return toName
    if (v === '/' + fromId) return '/' + toId
    return v.startsWith('/' + fromId + '/') ? '/' + toId + v.slice(fromId.length + 1) : v
  }
  let fenced = false
  for (let i = plan; plan > 0 && i < next - 1; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced
    if (fenced || !(/^- \*\*/.test(lines[i]) || /^\s+·/.test(lines[i]))) continue
    if (parentHere) lines[i] = lines[i].replace(new RegExp('^- \\*\\*' + escapeRe(fromName) + '\\*\\* — '), '- **' + toName + '** — ')
    lines[i] = lines[i].replace(/(\bafter:\s*)([^·]*)/, (m, key, value) => {
      const tail = value.match(/\s*$/)[0]
      return key + value.trimEnd().split(',').map((v) => renameAfter(v.trim())).join(', ') + tail
    })
  }
  return lines.join('\n')
}

/**
 * Rename a sub-effort among its siblings: its folder, its entry and every `after` naming it, and
 * every decision id carrying its prefix, in every spec of the effort. Refused once any node at or
 * below it has dispatched or merged work, because executions, branches and worktrees carry the old
 * id. The ledger is append-only: each folder at or below it that was approved or prepared as it
 * stood gets a new line under its new id, a copy of that line for the renamed text. The parent's
 * spec, and any other whose text changed, reads edited and goes back to the user for approval.
 */
export function renameSubEffort(repo, effort, fromId, toId) {
  const name = safeSlug(effort)
  if (!name) return refusal(unusable(effort))
  const bad = folderIdProblem(fromId) || folderIdProblem(toId)
  if (bad) return refusal(bad)
  const parent = parentOf(fromId)
  if (parentOf(toId) !== parent) return refusal('a rename stays among siblings: ' + fromId + ' and ' + toId + ' have different parents')
  if (!existsSync(specPath(repo, name, parent))) return refusal('the parent folder ' + parent + ' has no SPEC.md')
  const siblings = parseSpec(specText(specPath(repo, name, parent)).text).entries
  if (!siblings.some((e) => e.name === lastSegment(fromId) && (e.kind === 'sub-effort' || e.kind === 'task'))) {
    return refusal('no sub-effort or task entry of ' + parent + ' is named ' + lastSegment(fromId))
  }
  if (siblings.some((e) => e.name === lastSegment(toId)) || existsSync(folderDir(repo, name, toId))) {
    return refusal(toId + ' already exists')
  }
  const busy = [...new Set(readLog(repo, name, 'events').entries
    .filter((e) => (e.kind === 'dispatched' || e.kind === 'merged') && (e.node === fromId || String(e.node).startsWith(fromId + '/')))
    .map((e) => e.node))]
  if (busy.length) {
    return refusal(fromId + ' has dispatched or merged work at ' + busy.join(', ') + ' — its executions, branches and worktrees carry the old name')
  }

  // Everything is computed before anything is written.
  const moved = specFolders(repo, name, fromId)
  const newId = (id) => toId + id.slice(fromId.length)
  const newDecision = (id) => id.replace(new RegExp('^' + escapeRe(flat(fromId)) + '\\.'), flat(toId) + '.')
  const ledger = readLog(repo, name, 'ledger').entries
  const signed = []
  for (const id of moved) {
    if (!['approved', 'prepared'].includes(approvalState(repo, name, id).state)) continue
    const line = ledger.filter((l) => l.folder === id && (l.kind === 'approved' || l.kind === 'prepared'))
      .reduce((best, l) => (!best || (l.seq || 0) > (best.seq || 0) ? l : best), null)
    if (line) signed.push({ id, line })
  }
  const texts = new Map()
  for (const id of specFolders(repo, name, ROOT_ID)) {
    const { text, back } = specText(specPath(repo, name, id))
    const next = renamedText(text, fromId, toId, id === parent)
    texts.set(moved.includes(id) ? newId(id) : id, { text: next, back, changed: next !== text })
  }

  try {
    if (existsSync(folderDir(repo, name, fromId))) renameSync(folderDir(repo, name, fromId), folderDir(repo, name, toId))
    for (const [id, t] of texts) if (t.changed) writeFileSync(specPath(repo, name, id), t.back(t.text), 'utf8')
  } catch (err) {
    return refusal('the rename stopped part way (' + err.message + '): a half-renamed spec reads edited, never approved')
  }

  const lines = signed.map(({ id, line }) => {
    const { seq, ...copy } = line
    return {
      ...copy, folder: newId(id), hash: hashSpec(texts.get(newId(id)).text), renamed_from: id,
      ...(Array.isArray(copy.decisions) ? { decisions: copy.decisions.map((d) => ({ ...d, id: newDecision(String(d.id)) })) } : {}),
    }
  })
  if (lines.length) {
    const out = append(repo, name, 'ledger', lines)
    if (!out.ok) return refusal('the folders moved, but their approvals were not carried: ' + out.error)
  }
  return {
    ok: true, from: fromId, to: toId,
    rewritten: [...texts].filter(([, t]) => t.changed).map(([id]) => posix(relative(mainCheckout(repo), specPath(repo, name, id)))),
    carried: lines.map((l) => l.folder),
  }
}

// ------------------------------------------------------------------ recording

const gitOut = (repo, args) => {
  const r = git(repo, args)
  return r.ok ? r.stdout.trim() : ''
}

/** The ground a survey return names, as the repo-relative paths git is asked about. */
function groundOf(payload) {
  const raw = Array.isArray(payload && payload.ground) ? payload.ground : []
  const paths = raw.map((p) => {
    const s = posix(p).trim().replace(/^\.\//, '').replace(/\/+$/, '')
    return s === '' || s === '.' ? '.' : safePath(s)
  })
  return paths.includes(null) ? [] : [...new Set(paths)]
}

/**
 * Store one phase's return, verbatim, as `evidence/<stamp>-<kind>.json`.
 *
 * `payload` is written exactly as it arrived: a stored survey is the survey's own result object,
 * so the next pass reads what the last pass returned rather than somebody's account of it. A
 * survey also gets its anchor beside it — HEAD and the ground its topics searched.
 *
 * @returns {{ok: true, effort, kind, stamp, path, digest, anchor?} | {ok: false, error}}
 */
export function recordReturn(repo, slug, kind, payload, now) {
  const name = safeSlug(slug)
  if (!name) return { ok: false, error: unusable(slug) }
  if (!KINDS.includes(kind)) return { ok: false, error: 'kind must be one of ' + KINDS.join(', ') }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'a stored return must be a JSON object — it is the phase\'s own result' }
  }
  if (!existsSync(join(effortStateDir(repo, name), IDENTITY_FILE))) {
    return { ok: false, error: 'no effort named ' + name + ' is open under ' + AGENTICS_DIR +
      ' — open it before recording into it' }
  }

  const dir = join(effortStateDir(repo, name), EVIDENCE_DIR)
  const base = stampNow(now)

  try {
    mkdirState(dir)
    // A second return inside the same second is a real case — a design pass records a survey and
    // a probe back to back, or a survey twice — and overwriting the first would lose the phase
    // this store exists to keep. The counter goes before the kind so every name still ends in it.
    let stamp = base
    let n = 1
    while (existsSync(join(dir, stamp + '-' + kind + '.json'))) stamp = base + '-' + ++n
    const file = join(dir, stamp + '-' + kind + '.json')

    writeFileSync(file, JSON.stringify(payload) + '\n', 'utf8')

    // An anchor with no commit — a repository git cannot read — is written all the same, and
    // `standingSurvey` refuses it by construction.
    let anchor = null
    if (kind === 'survey') {
      anchor = { observed_at: gitOut(repo, ['rev-parse', 'HEAD']), ground: groundOf(payload) }
      writeFileSync(join(dir, stamp + '-survey' + ANCHOR_EXT), JSON.stringify(anchor) + '\n', 'utf8')
    }

    return {
      ok: true, effort: name, kind, stamp, path: posix(file), digest: fnv1a(canonical(payload)),
      ...(anchor ? { anchor } : {}),
    }
  } catch (err) {
    return { ok: false, error: 'the ' + kind + ' could not be recorded: ' + err.message }
  }
}

// ------------------------------------------------------------------ reading

/**
 * Every recorded return of one effort, oldest first. The collision counter orders numerically
 * within a second, so `-10` sorts after `-2`.
 */
export function evidenceOf(repo, slug) {
  const dir = join(effortStateDir(repo, slug), EVIDENCE_DIR)
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .map((file) => ({ file, m: EVIDENCE_FILE.exec(file) }))
    .filter(({ m }) => m)
    .map(({ file, m }) => ({
      kind: m[3],
      stamp: m[1] + (m[2] ? '-' + m[2] : ''),
      path: posix(join(dir, file)),
      order: [m[1], m[2] ? Number(m[2]) : 1],
    }))
    // Kind breaks a tie only so the listing is the same on every filesystem; nothing reads it as
    // an order between a survey and a probe of the same second.
    .sort((a, b) => (a.order[0] < b.order[0] ? -1 : a.order[0] > b.order[0] ? 1
      : a.order[1] - b.order[1] || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)))
    .map(({ kind, stamp, path }) => ({ kind, stamp, path }))
}

/** The stamps of an effort's executions, oldest first — the directories under `executions/`. */
export function executionsOf(repo, slug) {
  try {
    return readdirSync(executionsRoot(repo, slug), { withFileTypes: true })
      .filter((e) => e.isDirectory() && STAMP.test(e.name))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * What one effort holds, DERIVED on every read.
 *
 * Nothing here is a stored status: the evidence is the files in `evidence/`, the executions are
 * the directories in `executions/`, the node count is the live tree in `nodes.jsonl`, and
 * `latest` is whichever stamp of the asked kind sorts last — so an effort whose files were swept
 * by hand reports what is actually there.
 *
 * @param {string} repo
 * @param {string} slug
 * @param {string} [latestKind]  'survey' | 'probe' — include that kind's newest return in full
 */
export function readEffort(repo, slug, latestKind) {
  const name = safeSlug(slug)
  if (!name) return { error: unusable(slug) }

  const dir = effortDir(repo, name)
  const held = readJson(join(effortStateDir(repo, name), IDENTITY_FILE))
  const identity = held
    ? {
        about: typeof held.about === 'string' ? held.about : '',
        roots: Array.isArray(held.roots) ? held.roots : [],
        opened_at: typeof held.opened_at === 'string' ? held.opened_at : '',
      }
    : null

  const evidence = evidenceOf(repo, name)
  const wanted = KINDS.includes(latestKind) ? latestKind : ''
  const pool = evidence.filter((e) => e.kind === wanted)
  const newest = pool.length > 0 ? pool[pool.length - 1] : null
  const latest = newest ? { kind: wanted, stamp: newest.stamp, path: newest.path, payload: readJson(newest.path) } : null

  return {
    effort: name,
    path: posix(dir),
    exists: identity !== null,
    identity,
    evidence,
    latest,
    nodes_n: liveNodes(readLog(repo, name, 'nodes').entries).size,
    executions: executionsOf(repo, name),
    notes: identity === null
      ? 'no effort named ' + name + ' is open under ' + AGENTICS_DIR + ' in this repository'
      : 'DURABLE SCRATCH. Every return here is what an earlier pass returned, unverified — prior ' +
        'context for the next pass, and it proves nothing by being here. The one exception is ' +
        'computed rather than read: `standing` checks whether the newest survey\'s anchored ground ' +
        'is untouched, and only that answer can stand a survey in for a later one.',
  }
}

// ------------------------------------------------------------------ standing

/**
 * Uncommitted paths on the ground, or null when git could not answer. Untracked files are listed
 * one by one: a collapsed `?? .claude/` would otherwise hide whether anything beside this store
 * sits in it.
 */
function dirtyOn(repo, ground) {
  const run = git(repo, ['status', '--porcelain', '-z', '--untracked-files=all',
    '--', ...ground, ':(exclude)' + AGENTICS_DIR])
  if (!run.ok) return null

  const out = []
  const fields = run.stdout.split('\0').filter((f) => f !== '')
  for (let i = 0; i < fields.length; i++) {
    out.push(posix(fields[i].slice(3)))
    // A rename record is followed by its original path as its own field.
    if (/^[RC]/.test(fields[i].slice(0, 2))) out.push(posix(fields[++i] || ''))
  }
  return out.filter(Boolean)
}

/**
 * Whether this effort's newest survey still stands as evidence — computed, never recorded.
 *
 * It stands only when every one of these holds, and the first that fails is named in `why`:
 * a survey is recorded; it carries an anchor with a commit; it names its ground; it reported
 * complete coverage; its commit is still an ancestor of HEAD; no commit since reaches the ground;
 * and no uncommitted edit sits on it.
 */
export function standingSurvey(repo, slug) {
  const name = safeSlug(slug)
  const refuse = (why, extra = {}) => ({
    standing: false, why, effort: name || '', survey_path: '', stamp: '', observed_at: '',
    head: '', ground: [], commits_since: [], dirty: [], ...extra,
  })
  if (!name) return refuse(unusable(slug))

  const surveys = evidenceOf(repo, name).filter((e) => e.kind === 'survey')
  if (surveys.length === 0) return refuse('this effort holds no recorded survey')

  const newest = surveys[surveys.length - 1]
  const at = { stamp: newest.stamp, survey_path: newest.path }

  const anchor = readJson(newest.path.replace(/\.json$/, ANCHOR_EXT))
  if (!anchor || !anchor.observed_at) {
    return refuse('the newest survey carries no anchor commit — recorded where git could not ' +
      'answer — so nothing can say its ground is unmoved', at)
  }

  const ground = Array.isArray(anchor.ground) ? anchor.ground : []
  const anchored = { ...at, observed_at: anchor.observed_at, ground }
  if (ground.length === 0) {
    return refuse('the newest survey names no ground, so there is nothing to check it against', anchored)
  }

  const payload = readJson(newest.path)
  if (!payload || !payload.coverage || payload.coverage.complete !== true) {
    return refuse('the newest survey did not report complete coverage — a partial survey is ' +
      'not evidence enough to skip one', anchored)
  }

  const head = gitOut(repo, ['rev-parse', 'HEAD'])
  const withHead = { ...anchored, head }
  if (!head || !git(repo, ['merge-base', '--is-ancestor', anchor.observed_at, 'HEAD']).ok) {
    return refuse('the survey\'s commit ' + anchor.observed_at + ' is not an ancestor of HEAD — ' +
      'history moved under it, so no log can say what changed since', withHead)
  }

  // The pipeline's own state under .agentics/ is not ground: this very store sits there, and a
  // survey's own recording would otherwise be the edit that un-stands it.
  const since = gitOut(repo, ['log', '--format=%H', anchor.observed_at + '..HEAD', '--', ...ground,
    ':(exclude)' + AGENTICS_DIR])
  const commits = since === '' ? [] : since.split('\n')
  if (commits.length > 0) {
    return refuse(commits.length + ' commit(s) since the survey touch its ground', {
      ...withHead, commits_since: commits,
    })
  }

  const onGround = dirtyOn(repo, ground)
  if (onGround === null) return refuse('git could not report the working tree\'s state', withHead)
  if (onGround.length > 0) {
    return refuse(onGround.length + ' uncommitted edit(s) sit on the survey\'s ground', {
      ...withHead, dirty: onGround,
    })
  }

  return {
    standing: true,
    why: 'no commit since ' + anchor.observed_at + ' and no uncommitted edit reaches the ' +
      'survey\'s ground, and it reported complete coverage',
    effort: name, ...withHead, commits_since: [], dirty: [],
  }
}

/** Every effort in the repository, newest name first — the picker's payload. */
export function listEfforts(repo) {
  let entries
  try {
    entries = readdirSync(effortsRoot(repo), { withFileTypes: true })
  } catch {
    return {
      repo: posix(repo), efforts: [], store_present: false,
      notes: 'no effort store exists at ' + AGENTICS_DIR + ' in this repository; the first phase ' +
        'that opens one creates it',
    }
  }

  const efforts = entries
    .filter((e) => e.isDirectory() && safeSlug(e.name) === e.name)
    .map((e) => {
      const read = readEffort(repo, e.name)
      return {
        effort: e.name,
        about: read.identity ? read.identity.about : '',
        opened_at: read.identity ? read.identity.opened_at : '',
        surveys: read.evidence.filter((x) => x.kind === 'survey').length,
        probes: read.evidence.filter((x) => x.kind === 'probe').length,
        nodes_n: read.nodes_n,
        executions: read.executions,
      }
    })
    .filter((e) => e.opened_at !== '' || e.surveys > 0 || e.probes > 0 || e.nodes_n > 0)
    .sort((a, b) => (a.effort < b.effort ? 1 : -1))

  return {
    repo: posix(repo), efforts, store_present: true,
    notes: 'listed ' + efforts.length + ' effort(s) under ' + AGENTICS_DIR,
  }
}

// ------------------------------------------------------------------ the CLI

/**
 * A phase's return, from a FILE rather than from an argv token: a survey's result is as large as
 * the survey was interesting, and a command line is finite (Windows caps one at 8191 characters).
 */
function payloadFrom(path) {
  if (!path) return { value: null, error: 'no --file was given, so there is no return to record' }
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    return { value: null, error: 'the return file ' + path + ' could not be read: ' + err.message }
  }
  try {
    return { value: JSON.parse(text), error: '' }
  } catch (err) {
    return { value: null, error: 'the return file ' + path + ' is not JSON (' + err.message + ')' }
  }
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  const usage = 'usage:\n' +
    '  effort.mjs slug <about>\n' +
    '  effort.mjs open <repo> <slug> --about <text> [--roots <csv>]\n' +
    '  effort.mjs folder <repo> <effort> <folder> [--title <text>]\n' +
    '  effort.mjs rename <repo> <effort> --from <folder> --to <folder>\n' +
    '  effort.mjs record <repo> <slug> survey|probe --file <path to the return as JSON>\n' +
    '  effort.mjs read <repo> <slug> [--latest survey|probe]\n' +
    '  effort.mjs standing <repo> <slug>\n' +
    '  effort.mjs list <repo>\n' +
    '(<repo> and <slug> may also be given as --repo and --effort)'

  try {
    const argv = process.argv.slice(2)
    const [command] = argv

    // The one command that touches no repository: it proposes a short name from free text, which
    // the session confirms with the user before `open` validates it.
    if (command === 'slug') {
      console.log(JSON.stringify({ ok: true, slug: slugFor(argv.slice(1).filter((a) => !a.startsWith('--')).join(' ')) }))
      process.exit(0)
    }

    // Positionals are what every skill currently types; the flags match the rest of lib/.
    const positional = []
    for (let i = 1; i < argv.length; i++) {
      if (argv[i].startsWith('--')) i++
      else positional.push(argv[i])
    }
    const repo = posix(flagOf(argv, 'repo') || positional.shift() || '')
    const slug = flagOf(argv, 'effort') || positional.shift() || ''
    if (!command || !repo) throw new Error(usage)

    // Writers print the ledger's shape — {"ok":...} — because their caller reads an accepted or
    // refused write. Readers print the envelope, because theirs is a payload that may be carried.
    if (command === 'open') {
      const out = openEffort(repo, { slug, about: flagOf(argv, 'about'), roots: flagOf(argv, 'roots') || repo })
      console.log(JSON.stringify(out))
      process.exit(out.ok ? 0 : 1)
    }

    if (command === 'folder') {
      const out = createSubEffortFolder(repo, slug, flagOf(argv, 'folder') || positional.shift() || '', { title: flagOf(argv, 'title') })
      console.log(JSON.stringify(out))
      process.exit(out.ok ? 0 : 1)
    }

    if (command === 'rename') {
      const out = renameSubEffort(repo, slug, flagOf(argv, 'from'), flagOf(argv, 'to'))
      console.log(JSON.stringify(out))
      process.exit(out.ok ? 0 : 1)
    }

    if (command === 'record') {
      const held = payloadFrom(flagOf(argv, 'file'))
      if (held.error) {
        console.log(JSON.stringify({ ok: false, error: held.error }))
        process.exit(1)
      }
      const out = recordReturn(repo, slug, positional.shift() || flagOf(argv, 'kind'), held.value)
      console.log(JSON.stringify(out))
      process.exit(out.ok ? 0 : 1)
    }

    const payload = command === 'read' ? readEffort(repo, slug, flagOf(argv, 'latest'))
      : command === 'standing' ? standingSurvey(repo, slug)
        : command === 'list' ? listEfforts(repo)
          : null

    if (!payload) throw new Error('unknown command ' + JSON.stringify(command) + '\n' + usage)

    console.log(JSON.stringify(envelope(payload)))
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
