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
// `agentics-survey` already solved this shape — its planner names shared ground once, it is searched
// once, and every analyst receives what it found. The probe never inherited the pattern. This
// script is that pattern for a document: an artefact cites its evidence by path and line, so
// one pass resolves that surface and every analyst receives the excerpts alongside its charge.
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
// are not cited by a document but reported by scouts, `[{path, line}]`, and the workflow mints
// them whole: `excerpts` takes them base64-encoded under a digest, merges overlapping windows once
// for every topic, and prints the excerpts under a digest of their own, so the one analyst that
// judges them never opens a file to find a line a scout already found.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { canonical, fnv1a } from './plan-digest.mjs'
import { decodeArgs, envelope, flagOf } from './store.mjs'

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
    notes: readError
      ? readError + ' — nothing was resolved, so every reader of this payload is where it was ' +
        'before: it must locate the document\'s evidence itself'
      : 'resolved ' + excerpts + ' excerpt(s) across ' + files.length + ' file(s) from ' +
        cited.length + ' citation(s). This is what the document POINTS AT and not the ' +
        'repository: ground the document never cites is not here, and an axis that needs it ' +
        'reads it. ' + (unresolved.length === 0
          ? 'Every citation resolved.'
          : unresolved.length + ' citation(s) resolved to nothing — that is a fact about the ' +
            'document, not a gap in this read.'),
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
 *            unresolved: Array<{path, why, detail}>, counts, notes}}
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
        path: posix(reported), why: 'outside',
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
      unresolved.push({ path, why: 'missing', detail: 'a scout reported ' + path + ' and no such file exists' })
      continue
    }
    for (const c of wanted.filter((w) => w.from > lines.length)) {
      unresolved.push({
        path, why: 'out_of_range',
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
    notes: 'resolved ' + windows + ' merged window(s) across ' + files.length + ' file(s) from ' +
      list.length + ' location(s). ' + (unresolved.length === 0
        ? 'Every location resolved.'
        : unresolved.length + ' location(s) could not be read; their findings reach the judge ' +
          'as locations only.'),
  }
}

// ------------------------------------------------------------------ the CLI

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

// Two forms. `excerpts --repo R (--b64 T | --b64-file P) --digest D [--context N]` resolves
// locations a workflow minted; the positional form resolves a document's own citations.
function excerptsCli(argv) {
  const repo = posix(flagOf(argv, 'repo'))
  if (!repo) throw new Error('usage: citations.mjs excerpts --repo <repo> (--b64 <token> | --b64-file <path>) --digest <digest> [--context <lines>]')
  if (!existsSync(repo)) throw new Error('no repository at ' + repo)

  const { value, problem } = decodeArgs(argv)
  const context = flagOf(argv, 'context')
  const payload = problem
    ? { ok: false, error: problem }
    : !Array.isArray(value)
      ? { ok: false, error: { kind: 'bad_args', message: 'the argument must be an array of {path, line} locations' } }
      : resolveLocations(repo, value, context === '' ? 10 : Number(context))

  console.log(JSON.stringify(envelope(payload)))
}

if (isMain) {
  try {
    if (process.argv[2] === 'excerpts') {
      excerptsCli(process.argv.slice(3))
      process.exit(0)
    }

    const [repoArg, artifact] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
    if (!repoArg || !artifact) {
      throw new Error('usage: citations.mjs <repo> <artefact path> [--context <lines>]')
    }
    if (!existsSync(repoArg)) throw new Error('no repository at ' + posix(repoArg))

    const context = flagOf(process.argv, 'context')
    const payload = resolveCitations(posix(repoArg), posix(artifact),
      context === '' ? 10 : Number(context))

    console.log(JSON.stringify({ payload, payload_digest: fnv1a(canonical(payload)) }))
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
