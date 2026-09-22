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
// `vfa-survey` already solved this shape — its planner names shared ground once, it is searched
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

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { canonical, fnv1a } from './plan-digest.mjs'

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
    const full = join(repo, ...segments(path))
    let lines = null
    try {
      if (statSync(full).isFile()) lines = readFileSync(full, 'utf8').split('\n')
    } catch {
      lines = null
    }

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

    const windows = mergeRanges(wanted
      .filter((c) => c.from <= lines.length)
      .map((c) => ({
        from: Math.max(1, c.from - pad),
        to: Math.min(lines.length, (c.to || c.from) + pad),
      })))

    files.push({
      path,
      lines: lines.length,
      cited_at: list.map((c) => c.from > 0 ? (c.to > c.from ? c.from + '-' + c.to : String(c.from)) : '(no line)'),
      excerpts: windows.map((w) => ({
        from: w.from,
        to: w.to,
        text: lines.slice(w.from - 1, w.to)
          .map((line, i) => String(w.from + i).padStart(6) + '\t' + line).join('\n'),
      })),
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

// ------------------------------------------------------------------ the CLI

const flag = (argv, name) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : ''
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  try {
    const [repoArg, artifact] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
    if (!repoArg || !artifact) {
      throw new Error('usage: citations.mjs <repo> <artefact path> [--context <lines>]')
    }
    if (!existsSync(repoArg)) throw new Error('no repository at ' + posix(repoArg))

    const context = flag(process.argv, 'context')
    const payload = resolveCitations(posix(repoArg), posix(artifact),
      context === '' ? 10 : Number(context))

    console.log(JSON.stringify({ payload, payload_digest: fnv1a(canonical(payload)) }))
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
