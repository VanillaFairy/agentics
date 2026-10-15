// lib/citations.mjs — the evidence a written artefact cites, resolved once for every reader.
//
// Design: docs/DESIGN.md#what-a-probe-costs.
//
// Why this exists, measured rather than assumed. One probe of a 120-line document against this
// repository ran 17 agents and billed 36.5M tokens to return ~538k of evidence — 68×
// amplification. The cost is TURN COUNT, not payload: every turn re-sends the accumulated
// context, so an agent running 40 turns against a context growing toward 80k pays roughly 3.2M
// in cache reads, and sixteen of those is the whole bill. It is superlinear — the most
// expensive analyst ran 62 turns for 4.36M, the cheapest 34 for 1.30M. Nobody ingested a large
// file: `Read` returned about 26k tokens per agent across the entire run. Sixteen analysts each
// spent roughly 26 exploration calls independently LOCATING the same evidence.
//
// The survey solves this shape: its plan names shared ground once, it is searched once, and every
// judge receives what it found. This module is that pattern for a document: an artefact cites its
// evidence by path and line, so one pass resolves that surface and every analyst receives the
// excerpts alongside its charge.
//
// Why a script and not a scout. Extracting `path:line` from text and reading those lines is
// deterministic, and standing requirement 6 says a deterministic thing is a script. A scout
// would buy a resume-to-exhaustion search to do it. The one thing a script cannot do is follow
// a citation that is WRONG — and that is not a loss, because an unresolvable citation in a
// document about to be built from is itself a finding, and it is reported as one rather than
// silently walked past.
//
// This resolves what the document POINTS AT. It is not the repository, and an analyst still
// reads whatever its axis needs — the excerpts are a starting point that removes the twenty-six
// calls everyone was paying to find the same lines.
//
// The same reader serves the survey's Assemble-context step (docs/DESIGN.md#survey). There the locations
// are not cited by a document but reported by scouts in their returns. Both forms render what they
// read as text the program puts in each reader's prompt, or writes as a context file under
// `.agentics/.state/context/`, so no model retypes the excerpts
// (docs/DESIGN.md#p2--code-does-what-is-deterministic-models-only-judge).

import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { fnv1a } from './plan-digest.mjs'
import { REFUSAL_REASON, refusedWhat } from './search/ledger.mjs'
import { contextDir, mkdirState } from './store.mjs'

/**
 * A citation candidate: a path-shaped token, optionally with a line or a line range.
 *
 * The extension must END in a letter, which is what keeps a version string ("1.13.0") and a
 * decimal out of the candidate list without a dictionary of known extensions. Backticks,
 * brackets and trailing punctuation are not in the character class, so a citation written as
 * `` `lib/kb.mjs:61` `` or "(lib/kb.mjs:61)." comes out clean.
 */
// The lookbehind is load-bearing rather than tidy. Without it the scan simply STARTS LATER
// inside a path it will not accept whole: `../../secrets.env:3` matches from `secrets.env`, the
// climb is chopped off, and what was a rejected traversal silently becomes a citation of a
// different file inside the repository.
const CITATION =
  /(?<![A-Za-z0-9_./\\-])([A-Za-z0-9_][A-Za-z0-9_./\\-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?::(\d+)(?:\s*-\s*(\d+))?)?/g

const posix = (p) => String(p == null ? '' : p).split('\\').join('/')
const segments = (p) => posix(p).split('/').filter((s) => s !== '' && s !== '.')

/** Pure. A repo-relative path this file will read, or null. Same discipline as lib/kb.mjs. */
export function safePath(value) {
  if (typeof value !== 'string') return null
  const p = posix(value).trim().replace(/^\.\//, '').replace(/\/+$/, '')
  if (p === '' || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null
  if (segments(p).some((s) => s === '..')) return null
  return segments(p).join('/')
}

/**
 * Pure. Every distinct citation in the text, in the order they first appear.
 *
 * Distinct by path AND line: a document that cites `lib/kb.mjs:61` twice asks for one excerpt,
 * while one that cites `:61` and `:717` asks for two.
 */
export function citationsIn(text) {
  const found = new Map()
  const source = String(text || '')

  CITATION.lastIndex = 0
  let match
  while ((match = CITATION.exec(source))) {
    const path = safePath(match[1])
    if (!path) continue

    const from = match[2] ? Number(match[2]) : 0
    const to = match[3] ? Number(match[3]) : from
    const key = path + ':' + from + '-' + to
    if (!found.has(key)) found.set(key, { raw: match[0], path, from, to })
  }

  return [...found.values()]
}

/**
 * Pure. Overlapping windows in one file, merged into the fewest ranges that cover them all.
 *
 * A document citing `:61`, `:64` and `:70` with ten lines of context either side asks for three
 * windows that are very nearly the same window. Merging them is what keeps the payload
 * proportional to the ground the document is about rather than to how often it points at it.
 */
export function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to)
  const out = []

  for (const range of sorted) {
    const last = out[out.length - 1]
    if (last && range.from <= last.to + 1) last.to = Math.max(last.to, range.to)
    else out.push({ from: range.from, to: range.to })
  }
  return out
}

/** The file's lines, or null when it is not a readable file inside the repository. */
function readLines(repo, path) {
  try {
    const full = join(repo, ...segments(path))
    return statSync(full).isFile() ? readFileSync(full, 'utf8').split('\n') : null
  } catch {
    return null
  }
}

/**
 * Pure. The merged windows around the wanted lines, each with its numbered text. Lines past the
 * end are the caller's to report; they are not windows.
 */
function excerptsOf(lines, wanted, pad) {
  return mergeRanges(wanted
    .filter((c) => c.from <= lines.length)
    .map((c) => ({
      from: Math.max(1, c.from - pad),
      to: Math.min(lines.length, (c.to || c.from) + pad),
    })))
    .map((w) => ({
      from: w.from,
      to: w.to,
      text: lines.slice(w.from - 1, w.to)
        .map((line, i) => String(w.from + i).padStart(6) + '\t' + line).join('\n'),
    }))
}

/**
 * Resolve one artefact's citations against one repository.
 *
 * Three outcomes per citation, and they are deliberately three rather than two:
 *   resolved     the file is there and the lines were read
 *   out_of_range the file is there and the line is not — the document points past its end
 *   missing      no such file
 *
 * The last two are what a script buys that a model reading the document would not: a citation
 * that resolves to nothing is evidence about the DOCUMENT, and it travels in the payload so an
 * analyst can rule on it.
 */
export function resolveCitations(repo, artifactPath, context) {
  const pad = Number.isInteger(context) && context >= 0 ? context : 10

  let text = ''
  let readError = ''
  try {
    text = readFileSync(artifactPath, 'utf8')
  } catch (err) {
    readError = 'the artefact ' + posix(artifactPath) + ' could not be read: ' + err.message
  }

  const cited = readError ? [] : citationsIn(text)
  const byPath = new Map()
  for (const c of cited) {
    if (!byPath.has(c.path)) byPath.set(c.path, [])
    byPath.get(c.path).push(c)
  }

  const files = []
  const unresolved = []

  for (const [path, list] of byPath) {
    const lines = readLines(repo, path)

    if (lines === null) {
      // Only a path-SHAPED citation is worth reporting as broken. A bare `node.js` in prose is
      // not a claim about this repository, and reporting it as a dead citation would bury the
      // ones that are.
      if (path.includes('/')) {
        unresolved.push({
          path, why: 'missing',
          detail: 'the document cites ' + path + ' and no such file exists in this repository',
        })
      }
      continue
    }

    const wanted = list.filter((c) => c.from > 0)
    const beyond = wanted.filter((c) => c.from > lines.length)
    for (const c of beyond) {
      unresolved.push({
        path, why: 'out_of_range',
        detail: 'the document cites ' + path + ':' + c.from + ' and the file has ' +
          lines.length + ' line(s)',
      })
    }

    files.push({
      path,
      lines: lines.length,
      cited_at: list.map((c) => c.from > 0 ? (c.to > c.from ? c.from + '-' + c.to : String(c.from)) : '(no line)'),
      excerpts: excerptsOf(lines, wanted, pad),
    })
  }

  const excerpts = files.reduce((n, f) => n + f.excerpts.length, 0)

  return {
    artifact: posix(artifactPath),
    repo: posix(repo),
    read_error: readError,
    files: files.sort((a, b) => a.path < b.path ? -1 : 1),
    unresolved,
    counts: { cited: cited.length, files: files.length, excerpts, unresolved: unresolved.length },
    // How long the artefact is, so a prober's fan-out can be earned by the size of what it has
    // to hold rather than by the number of axes. Zero when it could not be read.
    artifact_lines: text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0),
  }
}

// ------------------------------------------------------------------ scout locations

/**
 * A scout's reported path as a repo-relative one, or null when it points outside the repository.
 * Scouts report absolute paths as often as relative ones, so an absolute path under the
 * repository is taken back to relative; one anywhere else is not this reader's to open.
 */
function locationPath(repo, value) {
  const raw = posix(value).trim()
  if (raw === '') return null
  if (isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    const rel = posix(relative(resolve(repo), resolve(raw)))
    if (rel === '' || rel.startsWith('../') || rel === '..' || isAbsolute(rel)) return null
    return safePath(rel)
  }
  return safePath(raw)
}

/**
 * Resolve scout-reported locations against one repository: read each file once, merge every
 * window that overlaps, and return the excerpts.
 *
 * Why merged and not per location: a survey's topics land on the same files — a shared
 * configuration, one subsystem several topics touch — and one window per hit would hand the
 * judging analyst the same lines as often as scouts found them. The payload stays proportional to
 * the ground, not to how many scouts pointed at it.
 *
 * What cannot be read is reported rather than dropped, per location, because the analyst judging
 * the excerpts must know which of the scouts' findings it never saw:
 *   missing       no such file
 *   out_of_range  the file is there and the line is not
 *   outside       the path leaves the repository (or is not a path at all)
 *
 * @param {string} repo
 * @param {Array<{path: string, line: number}>} locations
 * @param {number} [context]  lines either side of each location, 10 by default
 * @returns {{repo, files: Array<{path, lines, excerpts: Array<{from, to, text}>}>,
 *            unresolved: Array<{path, why, detail}>, counts}}
 */
export function resolveLocations(repo, locations, context) {
  const pad = Number.isInteger(context) && context >= 0 ? context : 10
  const list = Array.isArray(locations) ? locations : []

  const byPath = new Map()
  const unresolved = []
  const seen = new Set()

  for (const loc of list) {
    const reported = loc && typeof loc.path === 'string' ? loc.path : ''
    const path = locationPath(repo, reported)
    if (!path) {
      unresolved.push({
        path: posix(reported), line: Number.isInteger(loc && loc.line) ? loc.line : 0, why: 'outside',
        detail: 'the location ' + JSON.stringify(posix(reported)) + ' is not a path inside this ' +
          'repository, so it was not read',
      })
      continue
    }
    // A location with no usable line is still a file somebody pointed at: its head is read.
    const line = Number.isInteger(loc.line) && loc.line > 0 ? loc.line : 1
    const key = path + ':' + line
    if (seen.has(key)) continue
    seen.add(key)
    if (!byPath.has(path)) byPath.set(path, [])
    byPath.get(path).push({ from: line, to: line })
  }

  const files = []
  for (const [path, wanted] of byPath) {
    const lines = readLines(repo, path)
    if (lines === null) {
      for (const c of wanted) {
        unresolved.push({ path, line: c.from, why: 'missing', detail: 'a scout reported ' + path + ' and no such file exists' })
      }
      continue
    }
    for (const c of wanted.filter((w) => w.from > lines.length)) {
      unresolved.push({
        path, line: c.from, why: 'out_of_range',
        detail: 'a scout reported ' + path + ':' + c.from + ' and the file has ' + lines.length + ' line(s)',
      })
    }
    const excerpts = excerptsOf(lines, wanted, pad)
    if (excerpts.length > 0) files.push({ path, lines: lines.length, excerpts })
  }

  files.sort((a, b) => (a.path < b.path ? -1 : 1))
  const windows = files.reduce((n, f) => n + f.excerpts.length, 0)
  const bytes = files.reduce((n, f) => n + f.excerpts.reduce((m, e) => m + e.text.length, 0), 0)

  return {
    repo: posix(repo),
    files,
    unresolved,
    counts: { locations: list.length, files: files.length, excerpts: windows, bytes, unresolved: unresolved.length },
  }
}

/// ------------------------------------------------------------------ scout reports

// ------------------------------------------------------------------ context files

// One part is what one Read returns whole: the Read tool refuses a file over its token limit and
// stops at 2000 lines, so context is cut into parts well inside both.
const PART_BYTES = 40000
const PART_LINES = 800
const CONTEXT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Pure. Resolved locations as a reader reads them: merged windows by file, then what was not read. */
function renderLocations(resolved) {
  const blocks = resolved.files.map((f) => `--- ${f.path} (${f.lines} line(s))\n` +
    f.excerpts.map((e) => e.text).join('\n     …\n'))
  if (resolved.unresolved.length > 0) {
    blocks.push('--- NOT EXCERPTED — the script could not read these; read each yourself in a line ' +
      'range around it, and a location that does not exist is itself worth a line in risks:\n' +
      resolved.unresolved.map((u) => `  ${u.path}:${u.line} — ${u.why}: ${u.detail}`).join('\n'))
  }
  return blocks.join('\n\n') + '\n'
}

/// ------------------------------------------------------------------ search results

/** Pure. A standing refusal as a reader reads it. */
const refusalLine = (r) => 'turn ' + r.turn + ' ' + r.item.kind + ' ' + refusedWhat(r.item) + ' — ' + r.class + ': ' + REFUSAL_REASON[r.class]

/** Pure. One ask of a search as a reader reads it: its end, its hits, its dismissals, what it never reached, what it was refused. */
function renderAsk(name, key, a, refused = []) {
  const head = '=== ' + name + ':' + key + ' — ' + (a.end ? a.end + ' (' + a.label + '): ' + a.why : 'still open')
  const hits = (a.hits || []).map((h) => '  ' + h.key + (h.line > 0 ? ':' + h.line : '') + ' — ' + h.note)
  const dismissed = (a.dismissed || []).map((d) => (d.key !== undefined
    ? '  ' + d.key + ' — ' + d.why + (d.read_to_end ? ' (read to the end)' : ' (not read to its end)')
    : '  ' + (d.glob !== undefined ? 'glob ' + d.glob : 'call ' + d.call) + ' — ' + d.why))
  const unreached = (a.unreached || []).map((f) => '  ' + f.kind + ' ' + f.key + (f.detail ? ' — ' + f.detail : ''))
  const list = (lines) => (lines.length ? lines.join('\n') : '  (none)')
  return [head, 'HITS:', list(hits), 'DISMISSED:', list(dismissed), 'NOT REACHED:', list(unreached),
    ...(refused.length ? ['REFUSED:', ...refused.map((r) => '  ' + refusalLine(r))] : [])].join('\n')
}

/** A search's findings as a reader reads them: per ask its end and label, its hits with notes,
 *  its dismissals, its unreached, the refusals standing against it (a citation no call showed); then
 *  the lines the hits point at, read once from tree.root, overlapping windows merged. `asks` narrows
 *  to some asks; `kind` to asks whose key starts kind+':' or equals kind. */
export function searchExcerpts(result, { asks = null, kind = '' } = {}) {
  const all = (result && result.asks) || {}
  const keys = Object.keys(all).filter((k) => (!asks || asks.includes(k)) && (!kind || k === kind || k.startsWith(kind + ':')))
  const locations = keys.flatMap((k) => (all[k].hits || []).filter((h) => Number.isInteger(h.line) && h.line > 0).map((h) => ({ path: h.key, line: h.line })))
  const resolved = resolveLocations(posix(result.tree.root), locations)
  const { files, excerpts, unresolved } = resolved.counts
  const standing = (result && result.refusals) || []
  const body = keys.length ? keys.map((k) => renderAsk(result.name, k, all[k], standing.filter((r) => r.asks.includes(k)))).join('\n\n') : '(no ask of this search was selected)'
  const nameless = !asks && !kind ? standing.filter((r) => r.asks.length === 0) : []
  const refused = nameless.length ? '\n\n=== ' + result.name + ' — refused, naming no open ask\n' + nameless.map((r) => '  ' + refusalLine(r)).join('\n') : ''
  return {
    text: body + refused + (locations.length
      ? '\n\nEXCERPTS — every hit above with a line, read once by a script, overlapping windows merged. Do not open the ' +
        'source files again to find these lines.\n\n' + renderLocations(resolved)
      : ''),
    counts: { locations: locations.length, files, excerpts, unresolved },
    unresolved: resolved.unresolved.map(({ path, line, why }) => ({ path, line, why })),
  }
}

/** Pure. The text cut at line boundaries into parts no larger than one Read. */
export function splitParts(text, maxBytes = PART_BYTES, maxLines = PART_LINES) {
  const parts = []
  let current = []
  let bytes = 0
  for (const line of text.split('\n')) {
    const size = Buffer.byteLength(line, 'utf8') + 1
    if (current.length > 0 && (bytes + size > maxBytes || current.length >= maxLines)) {
      parts.push(current.join('\n'))
      current = []
      bytes = 0
    }
    current.push(line)
    bytes += size
  }
  if (current.length > 0) parts.push(current.join('\n'))
  return parts
}

/** Files a week old in `dir` are removed whenever something new is written there; nothing else deletes them. */
export function pruneWeekOld(dir, now = Date.now()) {
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const full = join(dir, name)
    try {
      if (now - statSync(full).mtimeMs > CONTEXT_TTL_MS) rmSync(full, { force: true })
    } catch {
      // Another run pruned it first.
    }
  }
}

/**
 * Write rendered context and name the one file a reader opens. Files are named by the digest of
 * their text, so a retried call rewrites the same files rather than adding new ones. Text longer
 * than one Read is cut into parts, and `path` is then an index naming them in order.
 */
export function writeContext(repo, text, now = Date.now()) {
  const dir = resolve(contextDir(repo))
  mkdirState(dir)
  pruneWeekOld(dir, now)

  const digest = fnv1a(text)
  const parts = splitParts(text).map((part, i) => {
    const path = posix(join(dir, `${digest}-${i + 1}.md`))
    writeFileSync(path, part, 'utf8')
    return path
  })
  if (parts.length === 1) return { path: parts[0], digest, parts }
  const index = posix(join(dir, `${digest}-index.md`))
  writeFileSync(index, `This context is ${parts.length} files. Read each of them whole, in this order:\n` +
    parts.map((p) => '  ' + p).join('\n') + '\n', 'utf8')
  return { path: index, digest, parts }
}

/** A context writeContext wrote, whole: a single part, or every part its index names, in order. '' when gone. */
export function readContext(path) {
  try {
    const text = readFileSync(path, 'utf8')
    if (!posix(path).endsWith('-index.md')) return text
    return text.split('\n').slice(1).map((line) => line.trim()).filter(Boolean).map((part) => readFileSync(part, 'utf8')).join('\n')
  } catch {
    return ''
  }
}
