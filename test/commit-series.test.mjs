// test/commit-series.test.mjs — pins `parseLog` (the delimited `git log`
// reader) and `analyzeSeries` (the mechanical checks a verifier runs before any expensive
// reviewer round). The commit series is the review artifact, so these two functions decide
// what the reviewer is even asked to look at. A false negative here buys an Opus round on
// work that should have been bounced; a false positive bounces work that was fine.
//
// The fixture shape is not invented. It was read off the real command with `od -c`:
//
//   \x01<40-hex sha>\x02<subject>\n
//   \n                                <- git's blank line before the name-only list
//   <path>\n
//   <path>\n
//   \x01<sha>\x02<subject>\n          <- next record starts immediately
//
// and a commit with no name-only output (a merge) emits ONLY the header line and its
// newline — no blank line, no paths — with the next \x01 following directly.
//
// WHAT THIS FILE DELIBERATELY DOES NOT PIN. These are the places that really do leave more
// than one honest reading open, so nothing below asserts a choice:
//
//   * Finding ORDER — neither within a commit nor across commits is specified, and
//     consumers must not depend on it. Every
//     whole-result assertion below goes through `idsOf()`, which sorts. Nothing here
//     requires findings in the order the contract happens to list the checks.
//   * Message WORDING. The tests ask that a message exists, is not blank, and — where a
//     human reading the verifier's report needs it — that it names the file it is about.
//     Never the sentence itself.
//   * The CLI wrapper. Only `parseLog` and `analyzeSeries` are unit-tested.
//
// SETTLED READINGS, each pinned in its own test:
//
//   * A commit breaching on several files emits ONE FINDING PER OFFENDING FILE, each
//     naming its own file (case 8).
//   * `squash!` IS a wip subject. The regex is
//     /^(wip\b|fixup!|squash!|temp\b|tmp\b)/i — see the note above case 10.
//   * An empty locus `[]` permits NOTHING: every file touched is a breach.
//   * Locus comparison is case-SENSITIVE, and a locus entry never stands for a directory
//     prefix.
//   * `empty-commit` does NOT suppress the subject checks on the same commit (case 14).
//   * `parseLog` returns paths and subjects VERBATIM. Separator normalisation belongs to
//     `analyzeSeries` at comparison time, so a parseLog fixture may now contain a
//     backslash and is expected to keep it.
//   * A file-path line is any line that is not exactly `''`, with NO trimming — a
//     whitespace-only line is a path.
//   * `and-subject` matching is case-SENSITIVE.
//   * `subject-length` counts UTF-16 code units, i.e. plain JS `String.length`
//     (case 12).
//
// One of those pins behaviour accepted with eyes open rather than behaviour anyone would
// call obviously right: case-sensitive locus comparison is a known hazard on Windows and
// macOS, accepted as exactly that. It is pinned so that changing it means reopening the
// decision, not quietly "fixing" a test.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLog, analyzeSeries, baseMerges } from '../lib/commit-series.mjs'

const SHA_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const SHA_B = 'b2c3d4e5f60718293a4b5c6d7e8f90123456789a'
const SHA_C = 'c3d4e5f60718293a4b5c6d7e8f90123456789ab1'
const SHA_D = 'd4e5f60718293a4b5c6d7e8f90123456789ab1c2'
const SHA_E = 'e5f60718293a4b5c6d7e8f90123456789ab1c2d3'

/** One record in the exact shape observed from the real command (see header). */
const record = (sha, subject, files) =>
  files.length === 0
    ? `\x01${sha}\x02${subject}\n`
    : `\x01${sha}\x02${subject}\n\n${files.join('\n')}\n`

const commit = (sha, subject, files) => ({ sha, subject, files })

/**
 * Findings reduced to their identifying fields and sorted, so a whole-result assertion
 * says nothing about order. Order is not in the contract.
 */
const idsOf = (findings) =>
  findings.map((f) => `${f.sha} ${f.check} ${f.blocking}`).sort()

/** The single finding with this check id — fails loudly if there is not exactly one. */
function only(findings, check) {
  const hits = findings.filter((f) => f.check === check)
  assert.equal(hits.length, 1, `expected exactly one ${check}, got ${hits.length}`)
  return hits[0]
}

/** A realistic subject of exactly n characters, self-checked so the count is not a guess. */
function subjectOfLength(n) {
  const s = 'refactor the commit series parser to read more cleanly '.repeat(4).slice(0, n)
  assert.equal(s.length, n, 'fixture builder produced the wrong length')
  return s
}

const LOCUS = ['lib/commit-series.mjs', 'test/commit-series.test.mjs']

// =========================================================================================
// parseLog
// =========================================================================================

// --- case 1: the canonical two-commit log ------------------------------------------------

const TWO_COMMITS =
  `\x01${SHA_A}\x02add the commit series parser\n` +
  '\n' +
  'lib/commit-series.mjs\n' +
  `\x01${SHA_B}\x02cover the locus checks\n` +
  '\n' +
  'test/commit-series.test.mjs\n' +
  'lib/commit-series.mjs\n'

test('a two-commit log parses to two records, oldest first, split on the delimiters', () => {
  assert.deepEqual(parseLog(TWO_COMMITS), [
    {
      sha: SHA_A,
      subject: 'add the commit series parser',
      trailers: '',
      files: ['lib/commit-series.mjs'],
    },
    {
      sha: SHA_B,
      subject: 'cover the locus checks',
      trailers: '',
      files: ['test/commit-series.test.mjs', 'lib/commit-series.mjs'],
    },
  ])
})

test('the leading delimiter does not produce a phantom empty record', () => {
  // Real output begins with \x01, so a bare text.split('\x01') hands back an empty first
  // chunk. One commit in must mean one record out.
  const out = parseLog(record(SHA_A, 'add the parser', ['lib/commit-series.mjs']))

  assert.deepEqual(out.map((c) => c.sha), [SHA_A])
})

test("git's blank line before the name list is not read as a file path", () => {
  const out = parseLog(record(SHA_A, 'add the parser', ['lib/commit-series.mjs']))

  assert.deepEqual(out[0].files, ['lib/commit-series.mjs'])
})

// --- case 2: nothing in, nothing out -----------------------------------------------------

test('an empty string parses to no records', () => {
  assert.deepEqual(parseLog(''), [])
})

// --- case 3: a commit with no file lines -------------------------------------------------

test('a commit with no file lines gets an empty files array', () => {
  // This is the real merge-commit shape: header line, newline, then straight to the next
  // \x01. A parser that assumes a blank line is always there swallows the record after it.
  const text = record(SHA_A, 'merge: T01', []) +
    record(SHA_B, 'cover the locus checks', ['test/commit-series.test.mjs'])

  assert.deepEqual(parseLog(text), [
    { sha: SHA_A, subject: 'merge: T01', trailers: '', files: [] },
    {
      sha: SHA_B,
      subject: 'cover the locus checks',
      trailers: '',
      files: ['test/commit-series.test.mjs'],
    },
  ])
})

// --- case 4: subjects survive verbatim ---------------------------------------------------

test('special characters in a subject survive verbatim', () => {
  const subject = 'fix(cli): don\'t drop "«unicode»" — (parens), 100% ✅'
  const out = parseLog(record(SHA_A, subject, ['lib/commit-series.mjs']))

  assert.equal(out[0].subject, subject)
})

test('a subject is split from the sha on \\x02, not on the first space', () => {
  const out = parseLog(record(SHA_A, 'add the parser', ['lib/commit-series.mjs']))

  assert.equal(out[0].sha, SHA_A)
})

// --- case 5: whitespace tolerance --------------------------------------------------------

test('extra blank lines and trailing newlines parse identically to the canonical form', () => {
  const padded =
    `\x01${SHA_A}\x02add the commit series parser\n` +
    '\n' +
    '\n' +
    'lib/commit-series.mjs\n' +
    '\n' +
    `\x01${SHA_B}\x02cover the locus checks\n` +
    '\n' +
    'test/commit-series.test.mjs\n' +
    'lib/commit-series.mjs\n' +
    '\n' +
    '\n'

  assert.deepEqual(parseLog(padded), parseLog(TWO_COMMITS))
})

// --- parser invariants -------------------------------------------------------------------

test('a file path containing a space stays one path', () => {
  // The contract says the whole non-empty line is the path. Splitting a file line on
  // whitespace shreds every path git legitimately emits with a space in it.
  const out = parseLog(record(SHA_A, 'add the fixtures', ['docs/release notes.md']))

  assert.deepEqual(out[0].files, ['docs/release notes.md'])
})

test('parseLog is pure — the same text parses the same way whatever ran before it', () => {
  const first = parseLog(TWO_COMMITS)
  parseLog('')
  parseLog(record(SHA_C, 'merge: T02', []))

  assert.deepEqual(parseLog(TWO_COMMITS), first)
})

// --- parseLog returns what git gave it, unedited -----------------------------------------

test('a backslash path comes back with its backslashes, and so does the subject', () => {
  // parseLog is a pure parser, and separator normalisation belongs to
  // analyzeSeries at comparison time. A parser that helpfully rewrites `\` to `/` is
  // invisible to every analyzeSeries test in this file, because those normalise anyway —
  // this is the only place the difference shows.
  const out = parseLog(record(SHA_A, 'add lib\\commit-series.mjs', ['lib\\commit-series.mjs']))

  assert.deepEqual(out, [
    {
      sha: SHA_A,
      subject: 'add lib\\commit-series.mjs',
      trailers: '',
      files: ['lib\\commit-series.mjs'],
    },
  ])
})

// --- what counts as a file-path line -----------------------------------------------------

test('an all-whitespace line is a file path, and it keeps its whitespace', () => {
  // A file-path line is any line where `line !== ''`. No trimming, in either
  // direction — the empty line git puts before the name list is dropped, a whitespace-only
  // line is not. Real git never emits one, so this is defensive; it is worth pinning
  // because a parser that trims would also quietly rewrite the paths that legitimately
  // carry leading or trailing spaces, and nothing downstream could tell.
  const text = `\x01${SHA_A}\x02add the parser\n\n   \nlib/commit-series.mjs\n`

  assert.deepEqual(parseLog(text)[0].files, ['   ', 'lib/commit-series.mjs'])
})

// =========================================================================================
// analyzeSeries
// =========================================================================================

// --- case 13: the clean case, first ------------------------------------------------------

test('a clean two-commit series inside its locus produces no findings', () => {
  // A checker that flags everything passes every "it flags X" test below. This is the one
  // that stops it.
  const commits = [
    commit(SHA_A, 'add the commit series parser', ['lib/commit-series.mjs']),
    commit(SHA_B, 'cover the locus checks', [
      'test/commit-series.test.mjs',
      'lib/commit-series.mjs',
    ]),
  ]

  assert.deepEqual(analyzeSeries(commits, LOCUS), [])
})

// --- case 6: empty series ----------------------------------------------------------------

test('zero commits is one blocking empty-series finding with an empty sha', () => {
  const found = analyzeSeries([], LOCUS)

  assert.deepEqual(idsOf(found), [' empty-series true'])
})

test('the empty-series finding carries a message of its own', () => {
  const found = analyzeSeries([], LOCUS)

  assert.equal(typeof found[0].message, 'string')
  assert.ok(found[0].message.trim().length > 0, 'empty-series message was blank')
})

// --- case 7: empty commit ----------------------------------------------------------------

test('a commit that touches no files is a blocking empty-commit finding', () => {
  const found = analyzeSeries([commit(SHA_A, 'add the parser', [])], LOCUS)

  assert.deepEqual(idsOf(found), [`${SHA_A} empty-commit true`])
})

test('a series holding one real commit is not an empty series', () => {
  // empty-series is about the SERIES; empty-commit is about a COMMIT. Conflating them
  // makes a one-empty-commit series report both.
  const found = analyzeSeries([commit(SHA_A, 'add the parser', [])], LOCUS)

  assert.deepEqual(found.filter((f) => f.check === 'empty-series'), [])
})

// --- case 8: locus breach ----------------------------------------------------------------

test('a commit touching a file outside the locus is a blocking locus-breach', () => {
  const commits = [
    commit(SHA_A, 'add the parser', ['lib/commit-series.mjs', 'docs/notes.md']),
  ]

  assert.deepEqual(idsOf(analyzeSeries(commits, LOCUS)), [`${SHA_A} locus-breach true`])
})

test('the locus-breach message names the offending file', () => {
  // The verifier copies this message into its report verbatim; a message that says only
  // "outside the locus" makes a human open the diff to learn anything.
  const commits = [
    commit(SHA_A, 'add the parser', ['lib/commit-series.mjs', 'docs/notes.md']),
  ]
  const found = only(analyzeSeries(commits, LOCUS), 'locus-breach')

  assert.ok(
    found.message.includes('docs/notes.md'),
    `message did not name the file: ${JSON.stringify(found.message)}`,
  )
})

/** The multi-file breach fixture, shared by the two tests below so they cannot drift. */
const BREACHES_TWICE = [
  commit(SHA_A, 'add the parser', [
    'lib/commit-series.mjs',
    'docs/notes.md',
    'bin/cli.mjs',
  ]),
]

test('a commit breaching on two files gives one locus-breach finding per file', () => {
  // Every other breach fixture in this file touches exactly one file outside the locus, so
  // an implementation that folds a multi-file breach into a single combined finding — or
  // that stops at the first offender it meets — sails past all of them.
  assert.deepEqual(idsOf(analyzeSeries(BREACHES_TWICE, LOCUS)), [
    `${SHA_A} locus-breach true`,
    `${SHA_A} locus-breach true`,
  ])
})

test('each of those findings names its own offending file, one file per message', () => {
  // A per-file finding is only worth having if its message says which file it is about.
  // Sorted before comparing: which finding comes back first is not contract.
  const offenders = ['bin/cli.mjs', 'docs/notes.md'] // already in sort order

  const named = analyzeSeries(BREACHES_TWICE, LOCUS)
    .filter((f) => f.check === 'locus-breach')
    .map((f) => {
      const hits = offenders.filter((p) => f.message.includes(p))
      assert.equal(
        hits.length,
        1,
        `each message should name exactly one offender: ${JSON.stringify(f.message)}`,
      )
      return hits[0]
    })

  assert.deepEqual(named.sort(), offenders)
})

test('a path that merely starts with a locus entry is still outside the locus', () => {
  // `lib/commit-series.mjs.bak` is not `lib/commit-series.mjs` under any reading, and it
  // is what a `locus.some(l => file.startsWith(l))` implementation waves through.
  const commits = [commit(SHA_A, 'add the parser', ['lib/commit-series.mjs.bak'])]

  assert.deepEqual(idsOf(analyzeSeries(commits, LOCUS)), [`${SHA_A} locus-breach true`])
})

test('a locus entry that merely starts with the touched path does not cover it', () => {
  // The mirror of the test above, against `locus.some(l => l.startsWith(file))`.
  const commits = [commit(SHA_A, 'add the parser', ['lib/commit-series'])]

  assert.deepEqual(idsOf(analyzeSeries(commits, LOCUS)), [`${SHA_A} locus-breach true`])
})

// --- an empty locus permits nothing ------------------------------------------------------

/** Two ordinary in-tree files, judged against a locus that declares nothing at all. */
const EMPTY_LOCUS_COMMITS = [
  commit(SHA_A, 'add the parser', ['lib/a.mjs', 'lib/b.mjs']),
]

test('with an empty locus every file a commit touches is a breach', () => {
  // The locus enumerates every file an order may touch, so `[]` permits nothing.
  // The other reading — `[]` means "no constraint" — silently disables the one fence this
  // check exists to provide, and every other analyzeSeries fixture in this file hands over
  // a non-empty locus, so nothing else here would notice.
  assert.deepEqual(idsOf(analyzeSeries(EMPTY_LOCUS_COMMITS, [])), [
    `${SHA_A} locus-breach true`,
    `${SHA_A} locus-breach true`,
  ])
})

test('each of those two breaches names one of the two files', () => {
  const offenders = ['lib/a.mjs', 'lib/b.mjs'] // already in sort order

  const named = analyzeSeries(EMPTY_LOCUS_COMMITS, [])
    .map((f) => {
      const hits = offenders.filter((p) => f.message.includes(p))
      assert.equal(
        hits.length,
        1,
        `each message should name exactly one offender: ${JSON.stringify(f.message)}`,
      )
      return hits[0]
    })

  assert.deepEqual(named.sort(), offenders)
})

test('no commits and an empty locus is still just the empty-series finding', () => {
  // The two empty inputs are different questions and must stay distinct: an empty SERIES
  // is one finding about the series, an empty LOCUS is a fence that nothing can pass.
  assert.deepEqual(idsOf(analyzeSeries([], [])), [' empty-series true'])
})

// --- locus comparison is case-sensitive --------------------------------------------------

test('a path that differs from its locus entry only in case is outside the locus', () => {
  // Exact string equality: no casefolding anywhere.
  //
  // This pins a hazard accepted KNOWINGLY, not a behaviour anyone thinks is ideal. On
  // Windows and macOS `LIB/Commit-Series.mjs` and `lib/commit-series.mjs` are the same file
  // on disk, a known hazard accepted deliberately — changing it means changing the
  // independence contract itself. The test
  // exists so that a later reader who finds the behaviour surprising has to reopen the
  // decision rather than quietly relax a comparison.
  const commits = [commit(SHA_A, 'add the parser', ['LIB/Commit-Series.mjs'])]

  assert.deepEqual(idsOf(analyzeSeries(commits, ['lib/commit-series.mjs'])), [
    `${SHA_A} locus-breach true`,
  ])
})

// --- case 9: separator normalisation -----------------------------------------------------

test('a commit path written with backslashes matches a POSIX locus entry', () => {
  const commits = [commit(SHA_A, 'add the parser', ['lib\\commit-series.mjs'])]

  assert.deepEqual(analyzeSeries(commits, LOCUS), [])
})

test('a locus entry written with backslashes matches a POSIX commit path', () => {
  // The comparison normalises; neither side is trusted to arrive clean.
  const commits = [commit(SHA_A, 'add the parser', ['lib/commit-series.mjs'])]

  assert.deepEqual(analyzeSeries(commits, ['lib\\commit-series.mjs']), [])
})

// --- case 10: wip subjects ---------------------------------------------------------------
//
// WHERE THE WORD BOUNDARY SITS, because it is the reason these tests look the way they do.
// A trailing boundary — /^(wip|fixup!|squash!|temp|tmp)\b/i — cannot match 'fixup! x':
// `\b` after the `!` needs a word character next, and a space is not one. Same for
// 'squash! rework the parser'. So the boundary sits inside the alternatives that actually
// need it:
//
//     /^(wip\b|fixup!|squash!|temp\b|tmp\b)/i
//
// So the `!` forms flag, `squash!` included, and both are pinned below. Deleting `\b`
// outright is wrong the other way: it would flag 'wipe stale
// cache' and 'template rendering', which the tests below require to stay clean.

test('WIP, fixup! and tmp subjects are each a blocking wip-subject finding', () => {
  const commits = [
    commit(SHA_A, 'WIP: stuff', ['lib/commit-series.mjs']),
    commit(SHA_B, 'fixup! x', ['lib/commit-series.mjs']),
    commit(SHA_C, 'tmp thing', ['lib/commit-series.mjs']),
  ]

  assert.deepEqual(idsOf(analyzeSeries(commits, LOCUS)), [
    `${SHA_A} wip-subject true`,
    `${SHA_B} wip-subject true`,
    `${SHA_C} wip-subject true`,
  ])
})

test('the wip prefixes are matched without regard to case', () => {
  const commits = [commit(SHA_A, 'Temp file cleanup', ['lib/commit-series.mjs'])]

  assert.deepEqual(idsOf(analyzeSeries(commits, LOCUS)), [`${SHA_A} wip-subject true`])
})

test('a subject that merely begins with those letters is not a wip subject', () => {
  // The `\b` in the contract regex is load-bearing: "wipe" and "template" are ordinary
  // words, and a startsWith('wip') / startsWith('temp') check bounces both.
  const commits = [
    commit(SHA_A, 'wipe stale cache entries', ['lib/commit-series.mjs']),
    commit(SHA_B, 'template rendering for the report', ['lib/commit-series.mjs']),
  ]

  assert.deepEqual(analyzeSeries(commits, LOCUS), [])
})

test('a squash! subject is a blocking wip-subject finding', () => {
  // The worked example. `squash!` is in the alternation exactly like
  // `fixup!`, and nothing else in this subject could trip a check.
  const commits = [commit(SHA_A, 'squash! rework the parser', ['lib/commit-series.mjs'])]

  assert.deepEqual(idsOf(analyzeSeries(commits, LOCUS)), [`${SHA_A} wip-subject true`])
})

test('the bare squash! prefix is what matches, not the words following it', () => {
  // Stripped to the prefix and one throwaway word, so the alternative itself is the only
  // thing that can be doing the matching.
  const commits = [commit(SHA_A, 'squash! x', ['lib/commit-series.mjs'])]

  assert.deepEqual(idsOf(analyzeSeries(commits, LOCUS)), [`${SHA_A} wip-subject true`])
})

// --- case 10b: checkpoint commits ----------------------------------------------------------
//
// A checkpoint is the deliberate stop: a coder that notices it is running long commits its
// work in progress rather than leaving a dirty tree nothing vouches for. It is a legitimate
// artifact right up until the series is measured, and at that moment it is the opposite of
// one — its author committed it to say "unfinished". So its PRESENCE at verification time is
// what is blocking, not its creation, and the continuation coder dissolves it by squashing it
// into its next commit.
//
// Two marks, either sufficient. The trailer is load-bearing (it survives a reworded subject,
// which is what lets the resume ladder trust it); the subject prefix is the readable one.

test('a checkpoint subject is a blocking finding at verification time', () => {
  const commits = [
    commit(SHA_A, 'feat: the parser', ['lib/commit-series.mjs']),
    commit(SHA_B, 'checkpoint: half of the locus checks', ['lib/commit-series.mjs']),
  ]

  assert.deepEqual(idsOf(analyzeSeries(commits, LOCUS)),
    [`${SHA_B} checkpoint-commit true`])
})

test('the trailer alone is enough — a reworded subject does not hide a checkpoint', () => {
  // The case the trailer exists for. A continuation coder that renamed the subject and
  // stopped short of actually squashing would otherwise present an unfinished series as a
  // finished one, which is the single failure mode this plugin exists to prevent.
  const commits = [
    { sha: SHA_A, subject: 'feat: most of the parser', trailers: 'W3', files: ['lib/commit-series.mjs'] },
  ]

  assert.deepEqual(idsOf(analyzeSeries(commits, LOCUS)), [`${SHA_A} checkpoint-commit true`])
})

test('the checkpoint prefix is matched without regard to case', () => {
  const commits = [commit(SHA_A, 'Checkpoint: stopping here', ['lib/commit-series.mjs'])]

  assert.deepEqual(idsOf(analyzeSeries(commits, LOCUS)), [`${SHA_A} checkpoint-commit true`])
})

test('a dissolved series carries no checkpoint and no finding', () => {
  // What the continuation coder is supposed to leave behind: ordinary commits, empty trailer
  // fields, nothing to dissolve.
  const commits = [
    { sha: SHA_A, subject: 'feat: the parser', trailers: '', files: ['lib/commit-series.mjs'] },
    { sha: SHA_B, subject: 'test: cover the locus checks', trailers: '', files: ['test/commit-series.test.mjs'] },
  ]

  assert.deepEqual(analyzeSeries(commits, LOCUS), [])
})

test('a subject merely mentioning a checkpoint is not one', () => {
  // The prefix is anchored for the same reason the wip alternatives carry `\b`: ordinary
  // prose about checkpoints is ordinary work.
  const commits = [commit(SHA_A, 'feat: checkpoint the parser state', ['lib/commit-series.mjs'])]

  assert.deepEqual(analyzeSeries(commits, LOCUS), [])
})

test('the checkpoint finding names the commit a human has to go and look at', () => {
  const commits = [commit(SHA_A, 'checkpoint: stopped mid-series', ['lib/commit-series.mjs'])]

  const found = only(analyzeSeries(commits, LOCUS), 'checkpoint-commit')
  assert.ok(found.message.includes(SHA_A))
  assert.ok(found.message.includes('checkpoint: stopped mid-series'))
})

test('the trailer field rides the parsed record, and an absent one is empty', () => {
  // parseLog's own half of the contract: the third field is optional, so a two-field header
  // written by an older caller parses exactly as it always did.
  const withTrailer = parseLog(`\x01${SHA_A}\x02checkpoint: half done\x02W3\n\nlib/a.mjs\n`)
  const without = parseLog(`\x01${SHA_B}\x02feat: done\x02\n\nlib/a.mjs\n`)
  const legacy = parseLog(`\x01${SHA_C}\x02feat: done\n\nlib/a.mjs\n`)

  assert.equal(withTrailer[0].trailers, 'W3')
  assert.equal(withTrailer[0].subject, 'checkpoint: half done')
  assert.equal(without[0].trailers, '')
  assert.equal(legacy[0].trailers, '')
  assert.equal(legacy[0].subject, 'feat: done')
})

test('a wip word further along the subject line does not make it a wip subject', () => {
  // The `^` is as load-bearing as the `\b`, and in a different direction: these five
  // subjects each contain a wip token that WOULD match on its own, in a position where the
  // commit is plainly finished work. An unanchored regex flags all five, and every other
  // fixture in this section puts its token first, so nothing else would catch it.
  const commits = [
    commit(SHA_A, 'chore: unwip parser', ['lib/commit-series.mjs']),
    commit(SHA_B, 'fix: remove the tmp dir', ['lib/commit-series.mjs']),
    commit(SHA_C, 'docs: describe the temp file', ['lib/commit-series.mjs']),
    commit(SHA_D, 'refactor: drop fixup! handling', ['lib/commit-series.mjs']),
    commit(SHA_E, 'add squash! detection', ['lib/commit-series.mjs']),
  ]

  assert.deepEqual(analyzeSeries(commits, LOCUS), [])
})

// --- case 11: the AND test ---------------------------------------------------------------

test('a subject joining two concerns with " and " is an advisory and-subject finding', () => {
  const commits = [commit(SHA_A, 'fix parser and update docs', ['lib/commit-series.mjs'])]

  assert.deepEqual(idsOf(analyzeSeries(commits, LOCUS)), [`${SHA_A} and-subject false`])
})

test('the letters "and" inside a word do not trip the AND test', () => {
  // The subject must CONTAIN ' and ' — spaces included. A bare /and/ turns
  // "command" and "sandbox" into findings and trains the coder to ignore this check.
  const commits = [
    commit(SHA_A, 'update the command handler', ['lib/commit-series.mjs']),
    commit(SHA_B, 'add sandbox support', ['lib/commit-series.mjs']),
  ]

  assert.deepEqual(analyzeSeries(commits, LOCUS), [])
})

test('a capitalised " And " does not trip the AND test', () => {
  // Case-SENSITIVE, the literal reading of "contains ' and '". The check is
  // advisory and crude on purpose, and a missed `And` costs nothing — which is precisely
  // why nothing else would notice if the match quietly went case-insensitive. The lowercase
  // half of this pair is the first test in this section.
  const commits = [commit(SHA_A, 'Fix parser And update docs', ['lib/commit-series.mjs'])]

  assert.deepEqual(analyzeSeries(commits, LOCUS), [])
})

// --- case 12: subject length -------------------------------------------------------------

test('an 80-character subject is an advisory subject-length finding', () => {
  const commits = [commit(SHA_A, subjectOfLength(80), ['lib/commit-series.mjs'])]

  assert.deepEqual(idsOf(analyzeSeries(commits, LOCUS)), [`${SHA_A} subject-length false`])
})

test('a subject of exactly 72 characters is not longer than 72 characters', () => {
  // The rule is "subject longer than 72 characters". 72 is not longer than 72. This is the
  // test a >= 72 implementation fails.
  const commits = [commit(SHA_A, subjectOfLength(72), ['lib/commit-series.mjs'])]

  assert.deepEqual(analyzeSeries(commits, LOCUS), [])
})

test('a subject of 73 characters is over the line', () => {
  const commits = [commit(SHA_A, subjectOfLength(73), ['lib/commit-series.mjs'])]

  assert.deepEqual(idsOf(analyzeSeries(commits, LOCUS)), [`${SHA_A} subject-length false`])
})

/** U+1D11E MUSICAL SYMBOL G CLEF: one code point, two UTF-16 code units. */
const CLEF = '\u{1D11E}'

test('36 astral characters are 72 code units, and 72 is not over the line', () => {
  const subject = CLEF.repeat(36)
  assert.equal(subject.length, 72, 'fixture must be exactly 72 code units')

  const commits = [commit(SHA_A, subject, ['lib/commit-series.mjs'])]

  assert.deepEqual(analyzeSeries(commits, LOCUS), [])
})

test('37 astral characters are 74 code units and flag, though only 37 code points', () => {
  // The limit counts JS String.length, i.e. UTF-16 code units. Every other
  // length fixture in this file is plain ASCII, where code points and code units agree, so
  // a `[...subject].length` implementation sails past all of them — it counts 37 here and
  // waves the subject through. This is the one fixture where the two readings diverge.
  const subject = CLEF.repeat(37)
  assert.equal(subject.length, 74, 'fixture must be exactly 74 code units')
  assert.equal([...subject].length, 37, 'fixture must be only 37 code points')

  const commits = [commit(SHA_A, subject, ['lib/commit-series.mjs'])]

  assert.deepEqual(idsOf(analyzeSeries(commits, LOCUS)), [`${SHA_A} subject-length false`])
})

// --- case 14: findings compose -----------------------------------------------------------

test('one commit can carry a blocking and a separate finding at once', () => {
  const commits = [commit(SHA_A, 'WIP: rewire the parser', ['docs/notes.md'])]

  assert.deepEqual(idsOf(analyzeSeries(commits, LOCUS)), [
    `${SHA_A} locus-breach true`,
    `${SHA_A} wip-subject true`,
  ])
})

test('two advisory checks can fire on the same subject', () => {
  // Rules out "at most one finding per commit" just as firmly as the test above, but for
  // the two checks that are easiest to write as an if/else-if chain over the subject.
  const subject = 'rework the parser and rewire the CLI so the series checks read more cleanly'
  assert.ok(subject.length > 72, 'fixture must exceed the subject-length limit')
  assert.ok(subject.includes(' and '), 'fixture must trip the AND test')

  const found = analyzeSeries([commit(SHA_A, subject, ['lib/commit-series.mjs'])], LOCUS)

  assert.deepEqual(idsOf(found), [
    `${SHA_A} and-subject false`,
    `${SHA_A} subject-length false`,
  ])
})

test('an empty commit with a WIP subject reports both checks, not just the first', () => {
  // The other empty-commit fixture in this file carries a clean subject, so an implementation
  // that emits `empty-commit` and then moves straight on to the next commit passes it. The
  // checks are independent of one another and compose; a commit can be both empty and badly
  // titled, and the author needs to be told both things at once.
  const found = analyzeSeries([commit(SHA_A, 'WIP: nothing yet', [])], LOCUS)

  assert.deepEqual(idsOf(found), [
    `${SHA_A} empty-commit true`,
    `${SHA_A} wip-subject true`,
  ])
})

test('a later commit is analysed too, not just the first', () => {
  const commits = [
    commit(SHA_A, 'add the commit series parser', ['lib/commit-series.mjs']),
    commit(SHA_B, 'WIP: keep going', ['lib/commit-series.mjs']),
    commit(SHA_C, 'wire up the CLI', ['bin/cli.mjs']),
  ]

  assert.deepEqual(idsOf(analyzeSeries(commits, LOCUS)), [
    `${SHA_B} wip-subject true`,
    `${SHA_C} locus-breach true`,
  ])
})

// --- invariants of the finding itself ----------------------------------------------------

test('every finding carries exactly the four fields the verifier schema allows', () => {
  // The verifier schema's series_findings is additionalProperties:false over {sha, check,
  // message, blocking}, and the verifier copies findings in verbatim. An extra key fails the run.
  const found = [
    ...analyzeSeries([], LOCUS),
    ...analyzeSeries(
      [
        commit(SHA_A, 'WIP: rewire the parser', ['docs/notes.md']),
        commit(SHA_B, subjectOfLength(80), ['lib/commit-series.mjs']),
      ],
      LOCUS,
    ),
  ]

  assert.ok(found.length >= 4, 'fixture should have produced several findings')
  for (const f of found) {
    assert.deepEqual(Object.keys(f).sort(), ['blocking', 'check', 'message', 'sha'])
    assert.equal(typeof f.sha, 'string')
    assert.equal(typeof f.check, 'string')
    assert.equal(typeof f.blocking, 'boolean')
    assert.equal(typeof f.message, 'string')
    assert.ok(f.message.trim().length > 0, `blank message on ${f.check}`)
  }
})

test('all six check ids produce a finding, and every one has just those four fields', () => {
  // The test above reaches four of the six ids: `empty-commit` and `and-subject` never
  // fire on its fixture, so an implementation that attaches a fifth key to either of them
  // passes it. The verifier schema's series_findings is additionalProperties:false and the
  // verifier copies findings in verbatim, so that fifth key fails a real run — which makes
  // "every id, not just the convenient ones" the thing worth asserting.
  const found = [
    ...analyzeSeries([], LOCUS), // empty-series
    ...analyzeSeries(
      [
        commit(SHA_A, 'WIP: rewire the parser', []), // empty-commit + wip-subject
        commit(SHA_B, 'fix parser and update docs', ['docs/notes.md']), // and-subject + locus-breach
        commit(SHA_C, subjectOfLength(80), ['lib/commit-series.mjs']), // subject-length
      ],
      LOCUS,
    ),
  ]

  assert.deepEqual([...new Set(found.map((f) => f.check))].sort(), [
    'and-subject',
    'empty-commit',
    'empty-series',
    'locus-breach',
    'subject-length',
    'wip-subject',
  ])
  for (const f of found) {
    assert.deepEqual(
      Object.keys(f).sort(),
      ['blocking', 'check', 'message', 'sha'],
      `wrong key set on ${f.check}: ${JSON.stringify(Object.keys(f))}`,
    )
  }
})

test('analyzeSeries does not mutate the commits or the locus it was handed', () => {
  // It is declared pure, and the caller reuses both arrays afterwards.
  const commits = [
    commit(SHA_B, 'WIP: keep going', ['lib/commit-series.mjs']),
    commit(SHA_A, 'add the parser', ['docs\\notes.md']),
  ]
  const locus = [...LOCUS]
  const commitsBefore = structuredClone(commits)
  const locusBefore = structuredClone(locus)

  analyzeSeries(commits, locus)

  assert.deepEqual(commits, commitsBefore)
  assert.deepEqual(locus, locusBefore)
})

test('analyzeSeries is pure — the same series gives the same answer whatever ran before', () => {
  const commits = [commit(SHA_A, 'WIP: rewire the parser', ['docs/notes.md'])]
  const first = analyzeSeries(commits, LOCUS)

  analyzeSeries([], LOCUS)
  analyzeSeries([commit(SHA_B, 'add the parser', ['lib/commit-series.mjs'])], LOCUS)

  assert.deepEqual(analyzeSeries(commits, LOCUS), first)
})

// =========================================================================================
// CRLF line endings
// =========================================================================================
//
// A single trailing \r is stripped from each line before the line is interpreted, so
// CRLF text parses identically to LF. Emptiness is judged AFTER that strip, which is what
// makes a line of "\r" empty rather than a file path.
//
// This is fixed rather than filed alongside the case-sensitivity
// hazard, and the second test is the reason. On CRLF input a completely clean, fully
// in-locus series comes back with four blocking locus-breach findings: every path keeps its
// \r so none of them matches its locus entry, and git's blank separator line becomes a file
// literally named "\r". Correct work would be bounced at the verifier gate with evidence
// that reads exactly like a real breach. Case-sensitivity fails by MISSING a coupling,
// which is visible; this fails by INVENTING findings against work that was fine, which is
// not. Reachability is honestly defensive — git does not CRLF-translate log output through
// a pipe — but `parseLog` is exported and pure, and a parser that fabricates findings on a
// plausible input shape is worth the one line.

/** The same text a CRLF-flavoured source would hand over: every \n becomes \r\n. */
const crlf = (text) => text.replace(/\n/g, '\r\n')

test('a CRLF record parses exactly like the same record with LF endings', () => {
  const out = parseLog(crlf(record(SHA_A, 'add the parser', ['lib/commit-series.mjs'])))

  assert.deepEqual(out, [
    { sha: SHA_A, subject: 'add the parser', trailers: '', files: ['lib/commit-series.mjs'] },
  ])
})

test('a clean CRLF series inside its locus produces no findings', () => {
  // The end-to-end version of the test above, and the one that shows the damage: this is
  // ordinary, well-behaved work, and today it comes back with four blocking findings.
  const text = crlf(
    record(SHA_A, 'add the commit series parser', ['lib/commit-series.mjs']) +
      record(SHA_B, 'cover the locus checks', ['test/commit-series.test.mjs']),
  )

  assert.deepEqual(analyzeSeries(parseLog(text), LOCUS), [])
})

test('a merge whose later parents the base holds is a refresh; one that brings in outside work is not', () => {
  // rev-list --parents <base>..HEAD: SHA_A and SHA_C are the leaf's, SHA_B merged the parent
  // (SHA_D, in the base) in, SHA_E merged SHA_C, which the range holds.
  const text = crlf([
    SHA_E + ' ' + SHA_B + ' ' + SHA_C,
    SHA_C + ' ' + SHA_D,
    SHA_B + ' ' + SHA_A + ' ' + SHA_D,
    SHA_A + ' ' + SHA_D,
  ].join('\n') + '\n')

  assert.deepEqual([...baseMerges(text)], [SHA_B])
  assert.deepEqual([...baseMerges('')], [])
})
