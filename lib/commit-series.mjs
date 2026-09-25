// lib/commit-series.mjs — the commit series IS the review artifact.
//
// Design: docs/DESIGN.md#coding.
//
// Pure core: `parseLog` reads the delimited `git log` text `LOG_FORMAT` asks for; `analyzeSeries`
// runs the mechanical checks a verifier can decide without judging intent. Both are plain
// data-in/data-out functions —
// no fs, no child_process, no process — so they can be unit-tested directly.
//
// CLI wrapper (import.meta.main only): shells out to `git log`, prints the findings as
// JSON, and turns "any blocking finding" into a process exit code the workflow can check.

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const RECORD_SEP = '\x01'
const FIELD_SEP = '\x02'

const WIP_SUBJECT_RE = /^(wip\b|fixup!|squash!|temp\b|tmp\b)/i
const SUBJECT_LENGTH_LIMIT = 72

/**
 * The two marks a checkpoint commit carries. Either one is enough.
 *
 * A coder that notices it is running long commits its work in progress rather than leaving a
 * dirty tree nothing vouches for — the deliberate stop, which is the only stop a coder gets a
 * turn to act on. That commit is a legitimate artifact right up until the series is measured,
 * and at that moment it is the opposite of one: the series it belongs to is unfinished by its
 * author's own admission.
 *
 * The trailer is the load-bearing mark and the subject is the readable one. A subject can be
 * reworded by the continuation coder as it squashes; a trailer survives that, which is what
 * lets the resume ladder trust it.
 */
const CHECKPOINT_SUBJECT_RE = /^checkpoint:/i

/**
 * The trailer key, exported because `lib/run-verdict.mjs` asks git the same question with a
 * different framing — it reads one branch tip inside a tab-delimited log rather than a whole
 * series inside a record-delimited one. What has to be shared is the key and the predicate
 * below, not the format string built around them.
 */
export const CHECKPOINT_TRAILER = 'agentics-checkpoint'

/**
 * Pure. Whether one commit is a checkpoint.
 * @param {{subject?: string, trailers?: string}} commit
 */
export const isCheckpoint = (commit) =>
  CHECKPOINT_SUBJECT_RE.test(String((commit && commit.subject) || '')) ||
  String((commit && commit.trailers) || '').trim() !== ''

/**
 * The `git log` format this file's CLI reads, and the one any caller reproducing it must use.
 *
 * The third field is the `agentics-checkpoint` trailer's value, empty for every ordinary commit.
 * `separator` keeps it on the header line — git terminates each trailer with a newline
 * otherwise, and a record whose header spilled onto a second line would be read as a file path.
 */
export const LOG_FORMAT =
  '%x01%H%x02%s%x02%(trailers:key=' + CHECKPOINT_TRAILER + ',valueonly,separator=%x2C)'

/** Strip a single trailing \r, so CRLF input parses identically to LF. */
const stripTrailingCR = (line) => (line.endsWith('\r') ? line.slice(0, -1) : line)

/**
 * Pure. Parse the output of:
 *   git log --reverse --format=<LOG_FORMAT> --name-only <base>..HEAD
 * Records are delimited by \x01; within a record, \x02 separates sha from subject, and a
 * second \x02 separates the subject from the `agentics-checkpoint` trailer's value;
 * subsequent non-empty lines up to the next \x01 are the commit's file paths.
 * The trailer field is OPTIONAL: a header with no second \x02 is the two-field format this
 * file read before checkpoints existed, and parses identically with `trailers: ''`.
 * Line endings: a single trailing \r is stripped from each line before it is
 * interpreted, so CRLF input parses identically to LF. Emptiness is judged after
 * that strip — a line of "\r" is empty and is not a file path.
 * @param {string} text
 * @returns {Array<{sha: string, subject: string, trailers: string, files: string[]}>} oldest first
 * @throws {TypeError} on a record with no field separator after the first delimiter — a
 *   healthy `git log --format='%x01%H%x02%s'` run cannot emit one, so its presence means
 *   the stream is corrupt or truncated, and a shortened series must never wear the shape
 *   of a clean one.
 */
export function parseLog(text) {
  const commits = []

  // Real output starts with \x01 — anything before the first delimiter is not a record
  // and is dropped. From the first delimiter on, every chunk must carry a field
  // separator; silently skipping one turned a truncated log into a short series
  // indistinguishable from a whole one.
  const start = text.indexOf(RECORD_SEP)
  const chunks = start === -1
    ? []
    : text.slice(start).split(RECORD_SEP).filter((chunk) => chunk !== '')

  for (const chunk of chunks) {
    const sepIndex = chunk.indexOf(FIELD_SEP)
    if (sepIndex === -1) {
      throw new TypeError(
        'parseLog: malformed record (no field separator) — the git log stream is corrupt or truncated')
    }

    const sha = chunk.slice(0, sepIndex)
    const rest = chunk.slice(sepIndex + FIELD_SEP.length)
    const lines = rest.split('\n').map(stripTrailingCR)
    const trailerIndex = lines[0].indexOf(FIELD_SEP)
    const subject = trailerIndex === -1 ? lines[0] : lines[0].slice(0, trailerIndex)
    const trailers = trailerIndex === -1 ? '' : lines[0].slice(trailerIndex + FIELD_SEP.length)
    const files = lines.slice(1).filter((line) => line !== '')

    commits.push({ sha, subject, trailers, files })
  }

  return commits
}

/** Normalize a path for locus comparison: backslashes to forward slashes. */
const normalizePath = (p) => p.replace(/\\/g, '/')

/**
 * Pure. Mechanical checks over a commit series against a declared locus.
 * @param {Array<{sha, subject, trailers, files}>} commits
 * @param {string[]} locus   repo-relative POSIX paths
 * @returns {Array<{sha: string, check: string, message: string, blocking: boolean}>}
 */
export function analyzeSeries(commits, locus) {
  const findings = []

  if (commits.length === 0) {
    findings.push({
      sha: '',
      check: 'empty-series',
      message: 'the commit series has no commits',
      blocking: true,
    })
    return findings
  }

  const normalizedLocus = new Set(locus.map(normalizePath))

  for (const commit of commits) {
    const { sha, subject, files } = commit

    if (files.length === 0) {
      findings.push({
        sha,
        check: 'empty-commit',
        message: `commit ${sha} touches no files`,
        blocking: true,
      })
    }

    for (const file of files) {
      if (!normalizedLocus.has(normalizePath(file))) {
        findings.push({
          sha,
          check: 'locus-breach',
          message: `commit ${sha} touches ${file}, which is outside the declared locus`,
          blocking: true,
        })
      }
    }

    if (WIP_SUBJECT_RE.test(subject)) {
      findings.push({
        sha,
        check: 'wip-subject',
        message: `commit ${sha} has a work-in-progress subject: ${JSON.stringify(subject)}`,
        blocking: true,
      })
    }

    // A checkpoint is legitimate while it exists and illegitimate the moment the series is
    // measured: its author committed it to say "I stopped here, unfinished". Reaching
    // verification means it was never dissolved, so what is about to be measured is a series
    // its own coder never claimed to have completed — and a green verdict over that is a
    // partial result wearing a whole one's label. The continuation coder squashes it; nothing
    // else in this pipeline may.
    if (isCheckpoint(commit)) {
      findings.push({
        sha,
        check: 'checkpoint-commit',
        message: `commit ${sha} is a checkpoint the series never dissolved: ` +
          `${JSON.stringify(subject)} — the continuation coder squashes a checkpoint tip into ` +
          `its next commit, and until it does the series is unfinished by its author's own word`,
        blocking: true,
      })
    }

    if (subject.includes(' and ')) {
      findings.push({
        sha,
        check: 'and-subject',
        message: `commit ${sha} subject joins two concerns with " and ": ${JSON.stringify(subject)}`,
        blocking: false,
      })
    }

    if (subject.length > SUBJECT_LENGTH_LIMIT) {
      findings.push({
        sha,
        check: 'subject-length',
        message: `commit ${sha} subject is ${subject.length} characters, over the ${SUBJECT_LENGTH_LIMIT}-character guideline`,
        blocking: false,
      })
    }
  }

  return findings
}

// `import.meta.main` is undefined before Node 24.2; the argv comparison keeps the CLI
// alive there — a silently no-op CLI would hand the verifier nothing to copy.
const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  const args = process.argv.slice(2)
  let base = null
  const locus = []

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base') {
      base = args[i + 1]
      i++
    } else if (args[i] === '--locus') {
      locus.push(args[i + 1])
      i++
    }
  }

  let findings
  try {
    const text = execFileSync(
      'git',
      ['log', '--reverse', `--format=${LOG_FORMAT}`, '--name-only', `${base}..HEAD`],
      { cwd: process.cwd(), encoding: 'utf8' },
    )
    const commits = parseLog(text)
    findings = analyzeSeries(commits, locus)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }

  console.log(JSON.stringify({ findings }))
  process.exit(findings.some((f) => f.blocking) ? 1 : 0)
}
