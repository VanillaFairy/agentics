// lib/kb.mjs — the project knowledge base: anchored observations on disk, and every judgment
// about them computed on read.
//
// Design: docs/DESIGN.md#knowledge-base.
//
// Why this exists. Every run used to open blind on ground a previous run had already paid to
// see: the survey re-bought repo shape at 400–500k tokens a time, and the run's own `knowledge`
// set — the coders' discovered gotchas — died at the run boundary, so run N+1 started as
// ignorant as run 1. Two consecutive runs in the same subsystem shared 21 of 44 paths.
//
// Why it is not a cache of prose. This plugin's own objection to stored status applies with
// full force here: a status computed cannot be stale, while a status written down outlives the
// thing it described. So the file holds what was SEEN and where — never whether it is still
// true. Freshness is derived on every read, by this file, from git and from the bytes on disk.
//
// Three laws follow, and all three are arithmetic rather than policy:
//
//   Depth is derived.        An entry's place in the tree is LCA(about) — the narrowest
//                            directory containing everything it is about. Nobody files an entry
//                            "under" anything, and an entry whose subject moves is re-filed by
//                            arithmetic rather than by memory.
//   Freshness is derived.    Git first: no commit has touched the subject since the entry was
//                            observed, so nothing can have invalidated it. Otherwise the bytes:
//                            digest each anchored file now and compare.
//   Nothing is written back. The checker never stamps a state onto a line. Same stance as
//                            lib/run-verdict.mjs, for the same reason.
//
// Why freshness is keyed to git. The principle
// is event-invalidated trust, and the tempting event log was this pipeline's own run ledger —
// but the KB outlives runs, and hand commits and triage-routed direct sessions never write a
// ledger line at all. Ledger arithmetic would therefore certify a stale entry fresh. Git is the
// event log every writer of this repository actually appends to, whoever they are.
//
// What the shortcut does NOT see is uncommitted work, so it is not trusted where the tree is
// dirty: one `git status` per invocation names the moved paths, and an entry whose subject sits
// among them goes to the digest check like any other. An unobserved change must never read as
// no change (IRON LAW §2).
//
// ONE anchor class is implemented: the file anchor. Guardians (a pinned test that fails when a
// broad claim dies) and surface globs (for absence entries) are not built yet, and the schema
// is open to them — `anchors` is an array of objects and `kind` already names the four
// kinds. An anchor class this version cannot check never reads as fresh; it demotes the entry to
// a lead and says which class it could not check. That is forward compatibility that fails safe.

import { spawnSync } from 'node:child_process'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { canonical, fnv1a } from './plan-digest.mjs'

/** The tree's root inside the target repository, and the one file name a node is stored in. */
export const KB_DIR = '.claude/agentics/kb'
export const NODE_FILE = 'node.jsonl'

/**
 * The closed kind vocabulary.
 *
 * `absence` is written by the survey, which deposits one when an exhausted search of a
 * named subtree found nothing there. Its subject is a DIRECTORY, so it carries no file anchor and
 * can only ever read fresh by the git-event shortcut — no commit has touched that subtree since
 * the search, therefore the search would still come back empty. That is the honest check for a
 * claim about nothing, and the day the subtree moves the entry goes stale, which is correct.
 * A glob-surface anchor, for an absence whose subject is narrower than a directory, is not
 * built yet.
 *
 * `structural` remains written by nobody, and that is now a decision rather than an omission. Its
 * text would be a model-authored sentence, reworded on every pass, so it would hash differently
 * every time and APPEND a near-duplicate instead of shadowing its predecessor — the base would
 * grow without consolidating and freshness answers would depend on which wording landed last.
 * Only claims a script mints from stable inputs are deposited. Structure-as-paths ("this module
 * is these N files") is mechanically derivable and would hash stably; prose about how a subsystem
 * works is not.
 */
export const KINDS = ['structural', 'gotcha', 'command', 'absence']

/** The commands a `command`-kind entry can carry, matching lib/verify.mjs's flags. */
export const COMMAND_NAMES = ['build', 'typecheck', 'suite', 'test_one']

const posix = (p) => String(p == null ? '' : p).split('\\').join('/')
const segments = (p) => posix(p).split('/').filter((s) => s !== '' && s !== '.')

/**
 * Pure. The narrowest directory containing every path — the entry's node, computed.
 *
 * Segment-wise rather than string-wise: the common string prefix of `src/game` and `src/gamepad`
 * is `src/game`, which would file an entry under a directory it is not about at all.
 * @param {string[]} about
 * @returns {string} a repo-relative POSIX path; '' is the level-0 node
 */
export function lcaOf(about) {
  const lists = (about || []).map(segments)
  if (lists.length === 0) return ''

  let common = lists[0]
  for (const list of lists.slice(1)) {
    let i = 0
    while (i < common.length && i < list.length && common[i] === list[i]) i++
    common = common.slice(0, i)
  }
  return common.join('/')
}

/** Every node from the root down to and including `path` — the chain's skeleton. */
export function chainNodes(path) {
  const parts = segments(path)
  const out = ['']
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join('/'))
  return out
}

const nodeDir = (repo, node) => join(repo, ...KB_DIR.split('/'), ...segments(node))

/**
 * Whether this repository has a knowledge base at all — computed, like every other state here.
 *
 * "No base is installed here" and "the base holds nothing about this path" are different facts
 * and only the first is a setup problem the user can fix once. Without this they arrive at a
 * caller identically, as an empty chain, and a project that has never had a base reads its
 * every refusal as routine staleness: the survey collapse silently cannot fire, and the message
 * saying so looks exactly like the message a working base prints on a bad day.
 */
export const kbPresent = (repo) => existsSync(join(repo, ...KB_DIR.split('/')))
const nodeFile = (repo, node) => join(nodeDir(repo, node), NODE_FILE)

/**
 * Pure. A path this file will accept inside `about` or an anchor, or null.
 *
 * The whole path discipline lives here, because the node an entry lands in is COMPUTED from
 * `about` — nobody names a destination, so there is exactly one place a traversal could enter.
 */
export function safePath(value) {
  if (typeof value !== 'string') return null
  const p = posix(value).trim().replace(/^\.\//, '').replace(/\/+$/, '')
  if (p === '' || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null
  if (segments(p).some((s) => s === '..')) return null
  return segments(p).join('/')
}

/** Pure. The digest a KB payload travels under — the same canonical form the ledger uses. */
export const digestEntry = (value) => fnv1a(canonical(value))

/**
 * Pure. What is wrong with one entry, or null.
 *
 * Thicker than `lib/ledger.mjs`'s transport check, deliberately: a ledger line is read back by
 * one tolerant parser inside one run, while a KB entry is read by every later run of the
 * repository, so a malformed one is a fact that misleads for weeks rather than a record that
 * confuses once. `about` is checked hardest of the lot — it decides where the entry LIVES.
 */
export function entryProblem(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return 'a knowledge-base entry must be a JSON object'
  }
  if (typeof entry.id !== 'string' || entry.id.trim() === '') {
    return 'an entry must carry a non-empty "id" — it is what a re-observation shadows'
  }
  if (typeof entry.claim !== 'string' || entry.claim.trim() === '') {
    return 'entry ' + entry.id + ': "claim" must be non-empty — an entry with no claim says nothing'
  }
  if (!KINDS.includes(entry.kind)) {
    return 'entry ' + entry.id + ': "kind" must be one of ' + KINDS.join(', ')
  }
  if (!Array.isArray(entry.about) || entry.about.length === 0) {
    return 'entry ' + entry.id + ': "about" must be a non-empty array — depth is LCA(about), ' +
      'so an entry about nothing has nowhere to live and nothing to be checked against'
  }
  for (const path of entry.about) {
    if (safePath(path) === null) {
      return 'entry ' + entry.id + ': ' + JSON.stringify(path) + ' is not a repo-relative path'
    }
  }
  if (entry.anchors !== undefined && !Array.isArray(entry.anchors)) {
    return 'entry ' + entry.id + ': "anchors" must be an array when present'
  }
  if (typeof entry.observed_at !== 'string') {
    return 'entry ' + entry.id + ': "observed_at" must be a string — the commit it was seen at'
  }

  // A `command` entry is machine-read: it is the one kind that feeds a verdict's inputs rather
  // than a model's context, so it carries the command itself and not only prose about it.
  if (entry.kind === 'command') {
    const cmd = entry.command
    if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) {
      return 'entry ' + entry.id + ': a command entry must carry a "command" object'
    }
    if (!COMMAND_NAMES.includes(cmd.name)) {
      return 'entry ' + entry.id + ': command.name must be one of ' + COMMAND_NAMES.join(', ')
    }
    const value = typeof cmd.value === 'string' ? cmd.value.trim() : ''
    // A distinction kept durable: a repository that defines no build command
    // and a command nobody has established yet are different facts, and only the first is safe
    // to act on. An empty value with no declaration is the second one, and it is refused.
    if (value === '' && cmd.absent !== true) {
      return 'entry ' + entry.id + ': command.value is empty and command.absent is not true — ' +
        '"nobody established this" is not a fact about the repository'
    }
  }

  return null
}

// ------------------------------------------------------------------ reading the tree

/** One node file's lines, newest-id-wins, with what could not be parsed counted rather than lost. */
export function readNode(repo, node) {
  const file = nodeFile(repo, node)
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { node, entries: [], lines: 0, shadowed: 0, malformed: 0, exists: false }
  }

  const byId = new Map()
  let lines = 0
  let malformed = 0

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    lines++
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      malformed++
      continue
    }
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') {
      malformed++
      continue
    }
    // A Map keeps the position of the first `set` for a key, so a re-observation shadows the
    // older line without jumping to the end of the file's reading order.
    byId.set(entry.id, entry)
  }

  const entries = [...byId.values()]
  return {
    node, entries, lines, malformed, exists: true,
    shadowed: lines - malformed - entries.length,
  }
}

/** Every node in the tree, root first, in path order. */
export function treeNodes(repo) {
  const root = join(repo, ...KB_DIR.split('/'))
  const found = []

  const walk = (dir, node) => {
    let listing
    try {
      listing = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (listing.some((e) => e.isFile() && e.name === NODE_FILE)) found.push(node)
    for (const entry of listing.filter((e) => e.isDirectory()).sort((a, b) => a.name < b.name ? -1 : 1)) {
      walk(join(dir, entry.name), node === '' ? entry.name : node + '/' + entry.name)
    }
  }

  walk(root, '')
  return found
}

// ------------------------------------------------------------------ the checks

// `raw` is the untrimmed stdout, and it matters exactly once: a porcelain status line begins
// with its two status characters, and ` M src/a.js` trimmed loses the first of them — which
// shifts every path by one and quietly reports a repository whose files are all named wrong.
function git(repo, args) {
  const run = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  if (run.error || run.status === null) return { ok: false, out: '', raw: '' }
  return { ok: run.status === 0, out: (run.stdout || '').trim(), raw: run.stdout || '' }
}

/**
 * Paths the working tree has moved but git has not recorded — or null when git could not answer.
 *
 * Read ONCE per invocation and intersected per entry: the event shortcut below is arithmetic
 * over committed history, and an uncommitted edit is not yet an event. Without this, a file
 * edited and not committed would read fresh on a claim its bytes had already broken.
 */
export function dirtyPaths(repo) {
  const res = git(repo, ['status', '--porcelain', '-z'])
  if (!res.ok) return null

  const out = new Set()
  const fields = res.raw.split('\0').filter((f) => f !== '')
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    const status = field.slice(0, 2)
    const path = safePath(field.slice(3))
    if (path) out.add(path)
    // A rename record is followed by its original path as its own NUL-terminated field.
    if (/^[RC]/.test(status) && i + 1 < fields.length) {
      const from = safePath(fields[++i])
      if (from) out.add(from)
    }
  }
  return [...out]
}

/** Two repo-relative paths overlap when either contains the other. */
const overlaps = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/')

/**
 * The git-event arithmetic: has anything touched this entry's subject since it was observed?
 *
 * An empty log is the whole proof. Nothing else has to be read — not the file, not its digest —
 * because no commit reached the ground the claim is about. That is the cheap path, and it is the
 * one that makes a chain read affordable at every dispatch.
 */
function freshByEvent(repo, entry, dirty) {
  if (!entry.observed_at) return false
  if (dirty === null) return false
  if (entry.about.some((a) => dirty.some((d) => overlaps(safePath(a) || '', d)))) return false

  const res = git(repo, ['log', '--format=%H', entry.observed_at + '..HEAD', '--', ...entry.about])
  return res.ok && res.out === ''
}

/** The digest check over this entry's file anchors — the regime for a deep, narrow claim. */
function freshByDigest(repo, entry) {
  const anchors = Array.isArray(entry.anchors) ? entry.anchors : []
  const files = anchors.filter((a) => a && typeof a.path === 'string' && typeof a.digest === 'string')
  const others = anchors.length - files.length

  if (others > 0) {
    return {
      fresh: false,
      reason: others + ' anchor(s) of a class this version cannot check — guardian and surface-glob ' +
        'anchors are not built, and an unchecked anchor never reads as a clean one',
    }
  }
  if (files.length === 0) {
    return { fresh: false, reason: 'the entry carries no anchor, so nothing can attest it' }
  }

  for (const anchor of files) {
    const path = safePath(anchor.path)
    if (!path) return { fresh: false, reason: 'anchor path ' + JSON.stringify(anchor.path) + ' is not usable' }

    let content
    try {
      content = readFileSync(join(repo, ...segments(path)), 'utf8')
    } catch {
      return { fresh: false, reason: 'the anchored file ' + path + ' is gone' }
    }
    if (fnv1a(content) !== anchor.digest) {
      return { fresh: false, reason: 'the anchored file ' + path + ' has moved since it was read' }
    }
  }

  return { fresh: true, reason: 'every anchored file still digests to what was recorded' }
}

/**
 * One entry's state, computed. Never stored, never returned to the file.
 *
 * Order matters and is the honest one. Orphaned first: an entry whose subject has been deleted
 * outright is not a stale claim about live ground, it is a claim about ground that is gone.
 */
export function stateOf(repo, entry, dirty) {
  const alive = entry.about.filter((a) => existsSync(join(repo, ...segments(a))))

  if (alive.length === 0) {
    return { state: 'orphaned', reason: 'every path it is about is gone from the working tree' }
  }
  if (freshByEvent(repo, entry, dirty)) {
    return {
      state: 'fresh',
      reason: 'no commit has touched its subject since ' + entry.observed_at,
    }
  }

  const digest = freshByDigest(repo, entry)
  return { state: digest.fresh ? 'fresh' : 'stale', reason: digest.reason }
}

/**
 * What travels to a consumer. Anchors are deliberately left behind: they are the mechanism, and
 * `state` is the answer they produce. A courier carrying them would carry the largest field in
 * the entry to say something no reader acts on.
 */
function reported(entry, node, verdict) {
  const out = {
    id: entry.id,
    claim: entry.claim,
    kind: entry.kind,
    about: entry.about,
    observed_at: entry.observed_at,
    source: entry.source || null,
    node,
    state: verdict.state,
    reason: verdict.reason,
  }
  if (entry.kind === 'command') out.command = entry.command
  return out
}

const tally = (entries) => ({
  fresh: entries.filter((e) => e.state === 'fresh').length,
  stale: entries.filter((e) => e.state === 'stale').length,
  orphaned: entries.filter((e) => e.state === 'orphaned').length,
})

// ------------------------------------------------------------------ the four read commands

/**
 * Root-to-narrowest chains for the given paths, each entry with its computed state.
 *
 * Bounded by depth, not by how much the repository knows: a consumer working at `src/game/ui`
 * receives the root, `src`, `src/game` and `src/game/ui`, and never the tree below it. The root
 * is always reported even when it holds nothing — "this repository knows nothing repo-wide" is
 * an answer, and an absent level would read as a level nobody looked at.
 */
export function chainFor(repo, paths) {
  const dirty = dirtyPaths(repo)
  const chains = []
  let malformed = 0

  for (const raw of paths.length > 0 ? paths : ['']) {
    const path = safePath(raw) ?? ''
    const nodes = []
    const entries = []

    for (const node of chainNodes(path)) {
      const read = readNode(repo, node)
      malformed += read.malformed
      if (!read.exists && node !== '') continue
      nodes.push(node)
      for (const entry of read.entries) {
        if (entryProblem(entry)) {
          malformed++
          continue
        }
        entries.push(reported(entry, node, stateOf(repo, entry, dirty)))
      }
    }

    chains.push({ path, nodes, entries })
  }

  const all = chains.flatMap((c) => c.entries)
  const present = kbPresent(repo)
  return {
    repo: posix(repo),
    chains,
    counts: tally(all),
    malformed,
    kb_present: present,
    dirty_readable: dirty !== null,
    notes: 'read ' + chains.length + ' chain(s); ' + all.length + ' entr(ies) with a computed state' +
      (present ? '' : '; NO KNOWLEDGE BASE EXISTS at ' + KB_DIR + ' in this repository, so every ' +
        'chain here is empty for that reason and not because the ground is unrecorded') +
      (dirty === null ? '; git could not report working-tree state, so no entry took the event shortcut' : ''),
  }
}

/**
 * The shape of the tree: which nodes hold anything, how much, and of what kind.
 *
 * Deliberately the ONE reader that computes no state. Freshness costs a `git log` per entry, and
 * this command exists to be read before anybody knows which paths matter — by a decomposition
 * deciding what to search. Before that decision the only known paths are the question's roots,
 * whose chain is the level-0 node alone, so handing a planner "the chain at the roots" hands it
 * almost nothing. Handing it the index says where this repository knows anything at all, and the
 * chains are then bought per topic, at the subtree each topic names.
 *
 * Nothing here implies an entry is still true, and the absence of `dirty_readable` is the honest
 * signal that no such question was asked.
 */
export function indexTree(repo) {
  const nodes = []
  let malformed = 0
  let total = 0

  for (const node of treeNodes(repo)) {
    const read = readNode(repo, node)
    malformed += read.malformed

    const kinds = {}
    let entries = 0
    for (const entry of read.entries) {
      if (entryProblem(entry)) {
        malformed++
        continue
      }
      kinds[entry.kind] = (kinds[entry.kind] || 0) + 1
      entries++
    }

    nodes.push({ node, entries, kinds })
    total += entries
  }

  const present = kbPresent(repo)
  return {
    repo: posix(repo),
    nodes,
    counts: { nodes: nodes.length, entries: total },
    malformed,
    kb_present: present,
    notes: (present ? '' : 'NO KNOWLEDGE BASE EXISTS at ' + KB_DIR + ' in this repository. ') +
      'indexed ' + nodes.length + ' node(s); ' + total + ' entr(ies). Paths, counts and ' +
      'kinds only — no entry state is computed here and none is implied. Read a chain for the ' +
      'ground you decide to work on; that is where freshness is worked out.',
  }
}

/** Every node in the tree, with every entry's computed state. The drift report. */
export function verifyTree(repo) {
  const dirty = dirtyPaths(repo)
  const nodes = []
  let malformed = 0

  for (const node of treeNodes(repo)) {
    const read = readNode(repo, node)
    malformed += read.malformed
    const entries = []
    for (const entry of read.entries) {
      const problem = entryProblem(entry)
      if (problem) {
        malformed++
        continue
      }
      entries.push(reported(entry, node, stateOf(repo, entry, dirty)))
    }
    nodes.push({ node, entries, shadowed: read.shadowed })
  }

  const all = nodes.flatMap((n) => n.entries)
  return {
    repo: posix(repo),
    nodes,
    counts: tally(all),
    malformed,
    dirty_readable: dirty !== null,
    notes: 'walked ' + nodes.length + ' node(s); ' + all.length + ' entr(ies)',
  }
}

/**
 * Drop what is shadowed and what is orphaned, node by node.
 *
 * Rewrite rather than append, and the one place in this plugin that rewrites a durable file — so
 * it is written beside the target and renamed over it. A truncating write that dies mid-way loses
 * every line rather than none, which is the damage the append-only discipline exists to prevent.
 *
 * Nothing is digest-checked here because nothing crossed a model: this reads bytes off a disk and
 * writes them back. The digest guards TRANSPORT, and compaction has none.
 */
export function compactTree(repo) {
  const dirty = dirtyPaths(repo)
  const nodes = []

  for (const node of treeNodes(repo)) {
    const read = readNode(repo, node)
    const kept = []
    let orphaned = 0

    for (const entry of read.entries) {
      if (entryProblem(entry)) continue
      if (stateOf(repo, entry, dirty).state === 'orphaned') {
        orphaned++
        continue
      }
      kept.push(entry)
    }

    const file = nodeFile(repo, node)
    const tmp = file + '.compacting'
    writeFileSync(tmp, kept.map((e) => JSON.stringify(e) + '\n').join(''), 'utf8')
    renameSync(tmp, file)

    nodes.push({
      node,
      kept: kept.length,
      dropped_shadowed: read.shadowed,
      dropped_orphaned: orphaned,
      dropped_malformed: read.malformed,
    })
  }

  return {
    repo: posix(repo),
    nodes,
    notes: 'compacted ' + nodes.length + ' node(s)',
  }
}

// ------------------------------------------------------------------ the writer surface

/**
 * The file anchors for an entry, MEASURED here rather than accepted from the caller.
 *
 * A workflow script has no filesystem, so the caller cannot digest anything and must not pretend
 * to: what it supplies is the claim and the subject, and the mechanical half is taken here, in
 * the process standing in the repository. An `about` path that is a directory, or that does not
 * exist yet, contributes no file anchor — a run's own brand-new files are not at the repo root
 * until the human accepts the merge, and an anchor invented for a file nobody read would be the
 * one thing in this file that is not a measurement.
 *
 * Anchors of any other class travel through untouched: guardians are authored,
 * not measured, and this function has no opinion about them.
 */
function anchorsFor(repo, entry) {
  const carried = (Array.isArray(entry.anchors) ? entry.anchors : [])
    .filter((a) => !(a && typeof a.path === 'string' && typeof a.digest === 'string'))

  const measured = []
  for (const raw of entry.about) {
    const path = safePath(raw)
    if (!path) continue
    const full = join(repo, ...segments(path))
    try {
      if (!statSync(full).isFile()) continue
      measured.push({ path, digest: fnv1a(readFileSync(full, 'utf8')) })
    } catch {
      continue
    }
  }

  return measured.concat(carried)
}

/**
 * The sentinel a caller with no git writes instead of a commit sha.
 *
 * `observed_at` is the commit an entry was seen at, and the freshness arithmetic is `git log
 * <observed_at>..HEAD -- <about>` — so a wrong one is not a cosmetic error, it decides whether
 * every later run believes the claim. `agentics-develop` has a real sha to hand (`integration.base_sha`,
 * the commit its own tree was cut from) and passes it. A caller that never cuts a tree — the
 * survey, depositing an absence it just observed — has none: a workflow script has no filesystem
 * and no git, and a model asked for a sha can invent one that orders history confidently and
 * wrongly.
 *
 * So the sentinel says "the commit this repository is on right now", and the measurement is taken
 * HERE, in the process standing in the repository, exactly as the anchors above are.
 */
export const OBSERVED_AT_HEAD = 'HEAD'

const headSha = (repo) => {
  const res = git(repo, ['rev-parse', 'HEAD'])
  return res.ok ? res.out : ''
}

/**
 * Append a batch of entries, each to the node its own `about` computes.
 *
 * All-or-nothing on validation, and per-entry on the write. The batch is minted whole by one
 * caller, so a malformed member means the mint is wrong rather than the transport — refusing the
 * lot puts that in front of somebody. The writes that follow are ordinary appends across several
 * files and are not atomic together; append-only plus newest-id-wins is what makes that harmless,
 * since a half-written batch is fewer facts and never a corrupt one.
 *
 * @param {string} repo   the target repository root
 * @param {object} payload `{ entries: [...] }` as it arrived
 * @param {string} expected the digest the caller minted over that object
 */
export function appendEntries(repo, payload, expected) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.entries)) {
    return { ok: false, error: 'the payload must be an object carrying an "entries" array' }
  }

  const actual = digestEntry(payload)
  if (expected && actual !== expected) {
    return {
      ok: false,
      error: 'digest mismatch: the caller minted ' + expected + ', this payload digests to ' +
        actual + ' — something changed between there and here, so it is refused rather than ' +
        'written. Copy the token again, exactly as it was handed to you.',
    }
  }

  for (const entry of payload.entries) {
    const problem = entryProblem(entry)
    if (problem) return { ok: false, error: problem }
  }

  // Resolved once for the batch, and only when something asks for it. A repository git cannot
  // answer about is refused rather than written with an empty `observed_at`: an entry with no
  // commit behind it can never take the event shortcut, so it would be a fact nobody can ever
  // check, filed as though it could be.
  let head = ''
  if (payload.entries.some((e) => e.observed_at === OBSERVED_AT_HEAD)) {
    head = headSha(repo)
    if (!head) {
      return {
        ok: false,
        error: 'an entry asked for the ' + OBSERVED_AT_HEAD + ' sentinel and git could not say ' +
          'what commit ' + posix(repo) + ' is on, so there is nothing to anchor it to',
      }
    }
  }

  const kbRoot = join(repo, ...KB_DIR.split('/'))
  const written = []

  for (const entry of payload.entries) {
    const about = entry.about.map(safePath)
    const node = lcaOf(about)
    const dir = nodeDir(repo, node)

    // Belt and braces over the path discipline in `safePath`: the destination is computed, so
    // this can only fire if that function ever stops being the single gate.
    if (dir !== kbRoot && !dir.startsWith(kbRoot + '\\') && !dir.startsWith(kbRoot + '/')) {
      return { ok: false, error: 'entry ' + entry.id + ' resolves outside ' + KB_DIR }
    }

    const stored = {
      ...entry,
      about,
      observed_at: entry.observed_at === OBSERVED_AT_HEAD ? head : entry.observed_at,
      anchors: anchorsFor(repo, { ...entry, about }),
    }

    try {
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, NODE_FILE), JSON.stringify(stored) + '\n', 'utf8')
    } catch (err) {
      return { ok: false, error: 'the append failed for ' + entry.id + ': ' + err.message, written }
    }

    written.push({ id: entry.id, node, anchors: stored.anchors.length })
  }

  return { ok: true, written, digest: actual }
}

// ------------------------------------------------------------------ the CLI

/** Everything after `--name`, or '' when the flag is absent. */
const flag = (argv, name) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : ''
}

const decodeB64 = (token) => {
  try {
    return Buffer.from(String(token), 'base64').toString('utf8')
  } catch {
    return ''
  }
}

/**
 * The deposit's own bytes, from a FILE or from an argv token.
 *
 * base64 on one argv slot is this plugin's answer to free text crossing a shell, and it has one
 * ceiling nothing about the encoding can lift: a command line is finite. Windows caps a process's
 * at 8191 characters, and a run's deposit is as large as the run was interesting — ten entries in
 * 20260902-124933 came to an 8.1 KB command that the shell truncated mid-quote. The courier then
 * did what a good courier does and tried a heredoc, then a script file, each of which embedded
 * the same 8 KB in the same one command, so each failed identically.
 *
 * So the token may instead be written to a file and the PATH passed. A path is short whatever the
 * deposit weighs, and reading it is the safe direction — a file's bytes reach this process without
 * crossing a model at all. `--b64` stays for small deposits and for every caller already written
 * against it; when both are given the file wins, because it is the one that cannot have been
 * truncated on the way in.
 */
function depositBytes(argv) {
  const path = flag(argv, 'b64-file')
  if (!path) return { raw: decodeB64(flag(argv, 'b64')), error: '' }

  try {
    return { raw: decodeB64(readFileSync(path, 'utf8').trim()), error: '' }
  } catch (err) {
    return { raw: '', error: 'the deposit file ' + path + ' could not be read: ' + err.message }
  }
}

// Guarded the way this plugin's other libs are. `import.meta.main` is undefined before Node 24.2,
// and a silently no-op CLI would tell every caller its entries were written while nothing reached
// the disk.
const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  try {
    const [command, repoArg, ...rest] = process.argv.slice(2)
    const repo = posix(repoArg || '')

    if (!command || !repo) {
      throw new Error('usage: kb.mjs chain|index|verify|compact <repo> [paths...] | kb.mjs append <repo> --digest <hex> (--b64 <token> | --b64-file <path>)')
    }

    // The writer prints the ledger's shape — {"ok":...} — because its dispatch reads exactly the
    // way `run-state`'s record mode reads. The readers print the run-verdict envelope, because
    // theirs is a payload a courier carries under a digest. Two disciplines, each where it belongs.
    if (command === 'append') {
      const deposit = depositBytes(process.argv)
      if (deposit.error) {
        console.log(JSON.stringify({ ok: false, error: deposit.error }))
        process.exit(1)
      }

      let parsed = null
      try {
        parsed = JSON.parse(deposit.raw)
      } catch (err) {
        console.log(JSON.stringify({
          ok: false,
          error: 'the payload is not JSON (' + err.message + ') — it did not survive transcription',
        }))
        process.exit(1)
      }

      const out = appendEntries(repo, parsed, flag(process.argv, 'digest'))
      console.log(JSON.stringify(out))
      process.exit(out.ok ? 0 : 1)
    }

    const payload = command === 'chain' ? chainFor(repo, rest.filter((a) => !a.startsWith('--')))
      : command === 'index' ? indexTree(repo)
        : command === 'verify' ? verifyTree(repo)
          : command === 'compact' ? compactTree(repo)
            : null

    if (!payload) {
      throw new Error('unknown command ' + JSON.stringify(command) +
        ' — expected chain, index, verify, compact or append')
    }

    console.log(JSON.stringify({ payload, payload_digest: fnv1a(canonical(payload)) }))
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
