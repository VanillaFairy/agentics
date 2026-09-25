// test/ledger.test.mjs — the writer that refuses what it cannot prove intact.
//
// The incident, 2026-08-20: a recorder was handed an exact `JSON.stringify` line to append and
// un-escaped the Windows paths while typing the Bash command. Five of one run's ten state lines
// landed as invalid JSON — `"worktree":"C:\work\..."`, where `\w` is not a JSON escape — and
// which lines broke depended on which form of the path that dispatch happened to receive. All
// five were `order-approved`, so three orders that had genuinely closed review read as
// unfinished, and a resume would have bought their reviews a second time.
//
// The instruction to copy carefully was already in the prompt and was already being followed.
// Faithful transcription is a capability, not a diligence, so the fix is a writer that can tell:
// the caller mints the line and its digest, and the writer refuses anything that does not match.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendLine, digestEntry, entryProblem, readNotes, readOrder } from '../lib/ledger.mjs'
import { digestOrder } from '../lib/plan-digest.mjs'

const runDir = () => mkdtempSync(join(tmpdir(), 'agentics-ledger-'))

const line = (over = {}) => ({
  kind: 'order-approved', seq: 4, wave: 1, order: 'W2',
  branch: 'agentics/20260826-184728-W2', worktree: 'C:/repo/.claude/worktrees/w2',
  head_sha: 'b'.repeat(40), measured: ['build', 'suite'],
  merged: [], approved_unmerged: [], escalated: [], discovered: [],
  integration_base: '', integration_head: '', ...over,
})

const lines = (dir, file = 'state.jsonl') =>
  readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean)

// --- the digest gate ------------------------------------------------------------------------

test('a line that matches its digest is written', () => {
  const dir = runDir()
  const entry = line()
  const out = appendLine(dir, 'state', JSON.stringify(entry), digestEntry(entry))

  assert.equal(out.ok, true)
  assert.deepEqual(JSON.parse(lines(dir)[0]), entry)
})

test('a line altered in transit is refused, and the refusal names both digests', () => {
  const dir = runDir()
  const entry = line()
  const minted = digestEntry(entry)
  // The courier "helpfully" tidied a path. Same shape, same fields, different record.
  const arrived = JSON.stringify({ ...entry, worktree: 'C:/repo/.claude/worktrees/W2' })

  const out = appendLine(dir, 'state', arrived, minted)

  assert.equal(out.ok, false)
  assert.match(out.error, /digest mismatch/)
  assert.match(out.error, new RegExp(minted))
  assert.throws(() => lines(dir), 'a refused line must not reach the file at all')
})

test('the F35 line — a raw Windows path — never parses, so it never lands', () => {
  const dir = runDir()
  // Verbatim from the field: `\w`, `\e` and `\c` are not valid JSON escapes.
  const mangled = '{"kind":"order-approved","seq":6,"order":"S5-DECOYS",' +
    '"worktree":"C:\\work\\eva-plays-2\\.claude\\worktrees\\wf_84f26958-737-16"}'

  const out = appendLine(dir, 'state', mangled, '')

  assert.equal(out.ok, false)
  assert.match(out.error, /not JSON/)
  assert.throws(() => lines(dir),
    'the whole point: a corrupt line bounces loudly instead of sitting unreadable on disk')
})

test('key order is not corruption — a re-emitted object still matches', () => {
  const dir = runDir()
  const entry = line()
  const minted = digestEntry(entry)
  // A model re-emitting an object may reorder its keys. That changes nothing about the record,
  // and the canonical form is what keeps it from reading as damage.
  const reordered = {}
  for (const k of Object.keys(entry).sort().reverse()) reordered[k] = entry[k]

  assert.equal(appendLine(dir, 'state', JSON.stringify(reordered), minted).ok, true)
})

// --- what the writer insists on -------------------------------------------------------------

// --- the base64 transport -------------------------------------------------------------------
//
// A heredoc is shell syntax, and everything that has actually corrupted this file was shell
// syntax: run 20260829-140744 lost its wave-1 line and every order-escalated line to a mismatch
// the recorder could not get past in three attempts, while every journal line — written by the
// working agents themselves — landed. The digest made that detectable; it could not make the
// retry, typed by the same agent into the same shell, any likelier to succeed.

test('a line handed to the CLI as base64 lands byte-identically', async () => {
  const { execFileSync } = await import('node:child_process')
  const CLI = new URL('../lib/ledger.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

  const dir = runDir()
  // The exact shapes that broke the heredoc: a Windows path and an apostrophe in free text.
  const entry = line({
    worktree: 'C:\\repo\\.claude\\worktrees\\w2',
    discovered: ["the parser doesn't accept a trailing comma"],
  })
  const token = Buffer.from(JSON.stringify(entry), 'utf8').toString('base64')

  const out = JSON.parse(execFileSync(process.execPath,
    [CLI, 'append', dir, '--file', 'state', '--digest', digestEntry(entry), '--b64', token],
    { encoding: 'utf8' }))

  assert.equal(out.ok, true, out.error)
  assert.deepEqual(JSON.parse(lines(dir)[0]), entry,
    'a backslash path and an apostrophe survive a transport with no metacharacters')
})

test('a line too long for a command line is passed as a FILE and lands the same way', async () => {
  // base64 on one argv slot has a ceiling nothing about the encoding can lift: Windows caps a
  // command line at 8191 characters, and a wave line is as large as the wave was interesting.
  // lib/kb.mjs grew this escape hatch after run 20260902-124933 truncated an 8.1 KB deposit;
  // the state ledger had none, and in the same run seven merge records were lost.
  const { execFileSync } = await import('node:child_process')
  const CLI = new URL('../lib/ledger.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

  const dir = runDir()
  const entry = line({ discovered: Array.from({ length: 200 }, (_, i) => 'discovery number ' + i) })
  const tokenPath = join(dir, 'state-line.b64')
  writeFileSync(tokenPath, Buffer.from(JSON.stringify(entry), 'utf8').toString('base64'), 'utf8')

  const out = JSON.parse(execFileSync(process.execPath,
    [CLI, 'append', dir, '--file', 'state', '--digest', digestEntry(entry), '--b64-file', tokenPath],
    { encoding: 'utf8' }))

  assert.equal(out.ok, true, out.error)
  assert.deepEqual(JSON.parse(lines(dir)[0]), entry)
})

test('a file the writer cannot read is refused by name, not read as an empty line', async () => {
  const { execFileSync } = await import('node:child_process')
  const CLI = new URL('../lib/ledger.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

  const dir = runDir()
  let threw = null
  try {
    execFileSync(process.execPath,
      [CLI, 'append', dir, '--file', 'state', '--digest', 'deadbeef',
       '--b64-file', join(dir, 'nothing-here.b64')],
      { encoding: 'utf8' })
  } catch (err) {
    threw = err
  }

  assert.ok(threw, 'an unreadable token file must exit non-zero')
  assert.match(JSON.parse(threw.stdout).error, /nothing-here\.b64/,
    'and say which file, rather than reading an absent one as an empty line')
  assert.throws(() => lines(dir), 'nothing reaches the ledger')
})

test('a base64 token damaged in transit is still refused by the digest', async () => {
  const { execFileSync } = await import('node:child_process')
  const CLI = new URL('../lib/ledger.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

  const dir = runDir()
  const entry = line()
  const minted = digestEntry(entry)
  const good = Buffer.from(JSON.stringify({ ...entry, order: 'W3' }), 'utf8').toString('base64')

  // Encoding removes the shell's ability to damage the line; it does not remove the check.
  let threw = null
  try {
    execFileSync(process.execPath,
      [CLI, 'append', dir, '--file', 'state', '--digest', minted, '--b64', good],
      { encoding: 'utf8' })
  } catch (err) {
    threw = err
  }

  assert.ok(threw, 'a token carrying a different line must exit non-zero')
  assert.match(JSON.parse(threw.stdout).error, /digest mismatch/)
})

test('a line with no kind is refused: every reader indexes on it', () => {
  assert.match(entryProblem({ seq: 1 }), /non-empty "kind"/)
})

test('a line with no seq is refused rather than defaulted to zero', () => {
  // A supplied seq would be this script inventing the run's history. The counter is minted by
  // the caller and copied; a line arriving without one did not arrive intact.
  assert.match(entryProblem({ kind: 'wave' }), /integer "seq"/)
  assert.match(entryProblem({ kind: 'wave', seq: 1.5 }), /integer "seq"/)
})

test('an array is not a ledger line', () => {
  assert.match(entryProblem([{ kind: 'wave', seq: 1 }]), /must be a JSON object/)
})

test('a field this version does not know is carried, not rejected', () => {
  // Deliberately thin. A writer that validated every record kind fully would reject a line
  // written by a newer workflow against an older installed lib — a lost record, which is the
  // damage this file exists to prevent, arriving from the other side.
  const dir = runDir()
  const entry = { ...line(), some_field_from_the_future: { nested: true } }

  assert.equal(appendLine(dir, 'state', JSON.stringify(entry), digestEntry(entry)).ok, true)
  assert.equal(JSON.parse(lines(dir)[0]).some_field_from_the_future.nested, true)
})

// --- append semantics -----------------------------------------------------------------------

test('writes append; an earlier line is never rewritten', () => {
  const dir = runDir()
  for (const seq of [1, 2, 3]) {
    const entry = line({ seq, order: 'W' + seq })
    assert.equal(appendLine(dir, 'state', JSON.stringify(entry), digestEntry(entry)).ok, true)
  }

  // The ORDER of the lines is itself evidence: a later success is read as superseding an
  // earlier failure, so a log reordered is a log that says something else.
  assert.deepEqual(lines(dir).map((l) => JSON.parse(l).order), ['W1', 'W2', 'W3'])
})

test('the journal and the state log are separate files', () => {
  const dir = runDir()
  const s = line()
  const j = { kind: 'verify-observed', seq: 9, order: 'W2', build: 'passed', suite: 'passed' }

  appendLine(dir, 'state', JSON.stringify(s), digestEntry(s))
  appendLine(dir, 'journal', JSON.stringify(j), '')

  assert.equal(lines(dir, 'state.jsonl').length, 1)
  assert.equal(lines(dir, 'journal.jsonl').length, 1)
})

test('a journal line goes in without a digest but still has to parse', () => {
  // An agent's observation is not known until it is observed, so the caller cannot mint a
  // digest for it. Everything else still applies: parse, kind, seq, canonical re-serialization.
  const dir = runDir()

  assert.equal(appendLine(dir, 'journal',
    '{"kind":"merge-observed","seq":3,"order":"W1"}', '').ok, true)
  assert.equal(appendLine(dir, 'journal', '{"kind":"merge-observed",', '').ok, false)
  assert.equal(lines(dir, 'journal.jsonl').length, 1)
})

test('a run directory that is not there is an error, never a silent success', () => {
  const entry = line()
  const out = appendLine(join(tmpdir(), 'agentics-no-such-dir-' + entry.seq), 'state',
    JSON.stringify(entry), digestEntry(entry))

  assert.equal(out.ok, false)
  assert.match(out.error, /append failed/)
})

test('an unknown file name is refused rather than guessed at', () => {
  assert.match(appendLine(runDir(), 'notes', '{}', '').error, /unknown ledger file/)
})

// --- reading one order by reference ---------------------------------------------------------

const planWith = (orders, notes = '') => {
  const dir = runDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plan.json'),
    JSON.stringify({ work_orders: orders, caller_notes: notes }), 'utf8')
  return dir
}

const ORDER = {
  id: 'W2', title: 'do W2', role: 'none', locus: ['src/w2.js'], reads: [],
  acceptance: ['it builds'], context: 'the long context', deps: ['W1'], contract: false,
}

test('an order is returned whole, with the digest recomputed over what was read', () => {
  const dir = planWith([ORDER])
  const out = readOrder(dir, 'W2')

  assert.deepEqual(out.order, ORDER)
  assert.equal(out.digest, digestOrder(ORDER),
    'the pin: its consumer compares this against the digest the verdict carried')
})

test('a miss names the ids that are there and never returns a nearest match', () => {
  // A near-miss id is how one order's context lands under another order's name.
  const out = readOrder(planWith([ORDER]), 'W3')

  assert.equal(out.order, undefined)
  assert.match(out.error, /no work order with id "W3"/)
  assert.deepEqual(out.ids, ['W2'])
})

test('the caller notes come back whole, and their absence is an empty string', () => {
  assert.equal(readNotes(planWith([ORDER], 'settled evidence')).caller_notes, 'settled evidence')
  assert.equal(readNotes(planWith([ORDER])).caller_notes, '')
})

test('an unreadable plan is an error rather than an empty order', () => {
  assert.match(readOrder(join(tmpdir(), 'agentics-absent'), 'W2').error, /plan\.json could not be read/)
  assert.match(readNotes(join(tmpdir(), 'agentics-absent')).error, /plan\.json could not be read/)
})
