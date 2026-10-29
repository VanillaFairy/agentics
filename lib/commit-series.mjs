// lib/commit-series.mjs — the commit series IS the review artifact.
//
// Design: docs/DESIGN.md#executors-and-review.
//
// Pure core: `parseLog` reads the delimited `git log` text `LOG_FORMAT` asks for; `analyzeSeries`
// runs the mechanical checks a verifier can decide without judging intent. Both are plain
// data-in/data-out functions —
// no fs, no child_process, no process — so they can be unit-tested directly.
//
// lib/verify.mjs runs `git log` itself and hands its text to `parseLog`.

import { roleAdmits } from './permissions.mjs'
import { TEST_CASE_PATTERNS, textOf } from './store.mjs'

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
 * The trailer key, exported because `lib/resume.mjs` asks git the same question with a
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
 *   git log --reverse --format=<LOG_FORMAT> --name-only --remerge-diff <base>..HEAD
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

/**
 * Pure. The merge commits of `git rev-list --parents <range>`: every commit with a second parent.
 * Read with `--remerge-diff`, a merge lists only what it changed beyond git's own remerge of its
 * parents, so a clean refresh lists nothing and is no empty commit.
 * @param {string} text
 * @returns {Set<string>}
 */
export function mergesOf(text) {
  return new Set(text.split('\n').map(stripTrailingCR).filter((line) => line !== '').map((line) => line.split(' '))
    .filter(([, , ...others]) => others.length > 0).map(([sha]) => sha))
}

/**
 * Pure. Mechanical checks over a commit series, the role rule among them.
 * @param {Array<{sha, subject, trailers, files, merge?}>} commits   `merge`: a merge commit, whose
 *   `files` are its remerge diff
 * @param {{writes?: 'all'|'tests'|'no-tests', fences?: Object<string, string>, netFiles?: string[]|null, resolves?: string[]}} [rule]
 *   `writes`, what the leaf's own role may change (`writesOf` in lib/permissions.mjs); `fences`, a
 *   commit's own rule by sha in place of `writes`: a commit the program made for another producer
 *   (a cycle's test session on a green or an audit); `netFiles`, the series' net diff, base to head,
 *   judged by `writes`. A file a fenced commit touched is judged per commit instead: each fenced
 *   commit by its fence, every other commit by `writes`, because a net diff cannot tell whose change
 *   it holds. Without `netFiles`, every commit is judged by its fence or by `writes`. `resolves`, the
 *   conflicted paths the judge sent the leaf's rebase rounds: each is judged per commit too, and
 *   admitted only in a merge commit's remerge diff — the resolution — every other commit that
 *   touches one being judged by `writes`.
 * @returns {Array<{sha: string, check: string, message: string, blocking: boolean}>}
 */
export function analyzeSeries(commits, { writes = 'all', fences = {}, netFiles = null, resolves = [] } = {}) {
  const resolved = new Set(resolves)
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

  const fencedFiles = new Set(commits.filter((c) => Object.hasOwn(fences, c.sha)).flatMap((c) => c.files))
  const perCommit = (file) => fencedFiles.has(file) || resolved.has(file)

  for (const commit of commits) {
    const { sha, subject, files } = commit

    if (files.length === 0 && !commit.merge) {
      findings.push({
        sha,
        check: 'empty-commit',
        message: `commit ${sha} touches no files`,
        blocking: true,
      })
    }

    const fenced = Object.hasOwn(fences, sha)
    const rule = fenced ? fences[sha] : writes
    const admits = (file) => roleAdmits(rule, file) || (commit.merge && resolved.has(file) && roleAdmits('all', file))
    for (const file of files) {
      if ((fenced || netFiles === null || perCommit(file)) && !admits(file)) {
        findings.push({ sha, check: 'role-breach', message: `commit ${sha} touches ${file}, which its role may not change`, blocking: true })
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

    // A merge's subject is git's, naming the branches it joins: no style of the producer's.
    if (commit.merge) continue

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

  if (netFiles !== null) {
    for (const file of netFiles) {
      if (!perCommit(file) && !roleAdmits(writes, file)) findings.push({ sha: '', check: 'role-breach', message: `the series changes ${file}, which this leaf's role may not change`, blocking: true })
    }
  }

  return findings
}

/**
 * Pure. Test-case declaration lines, trimmed, that `approvedText` holds more times than `headText`:
 * each copy the head lacks is one entry, in the approved text's order.
 */
export function removedTestCases(approvedText, headText) {
  const cases = (text) => textOf(text).split('\n').map((l) => l.trim())
    .filter((l) => TEST_CASE_PATTERNS.some((re) => re.test(l)))
  const left = new Map()
  for (const l of cases(headText)) left.set(l, (left.get(l) || 0) + 1)
  const removed = []
  for (const l of cases(approvedText)) {
    const n = left.get(l) || 0
    if (n > 0) left.set(l, n - 1)
    else removed.push(l)
  }
  return removed
}
