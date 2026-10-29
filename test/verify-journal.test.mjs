// test/verify-journal.test.mjs — lib/verify.mjs, against real repositories: the CLI's transport
// and the journal line. See test/verify-series.test.mjs for the whole family.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { verify, parseArgs } from '../lib/verify.mjs'
import { readLog } from '../lib/ledger.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'
import {
  BRANCH, BUILD, EFFORT, EXECUTION, NODE, options, order, repository, rev, SUITE, TEST_ONE,
} from './harness/verify-fixture.mjs'

const CLI = fileURLToPath(new URL('../lib/verify.mjs', import.meta.url))

// ---------------------------------------------------------------- the transport

test('the CLI prints one line whose digest covers the payload it carries', (t) => {
  const { worktree, base, head } = order(t)

  const run = spawnSync(process.execPath, [CLI,
    '--worktree', worktree, '--base', base, '--head', head,
    '--expects', 'src/widget.mjs', '--expects', 'test/widget.test.mjs',
    '--build', BUILD, '--typecheck-absent', '--suite', SUITE, '--test-one', TEST_ONE,
  ], { encoding: 'utf8' })

  assert.equal(run.status, 0, 'a payload was printed, which is what this tool produces')
  assert.equal(run.stdout.trim().split('\n').length, 1, 'ONE line, for a courier to paste')

  const parsed = JSON.parse(run.stdout)
  assert.equal(fnv1a(canonical(parsed.payload)), parsed.payload_digest)

  const tampered = { ...parsed.payload, suite: 'absent' }
  assert.notEqual(fnv1a(canonical(tampered)), parsed.payload_digest,
    'a payload that drifted by one field digests differently, which is the whole point')

  const dir = repository(t)
  const refused = spawnSync(process.execPath, [CLI, '--worktree', dir, '--base', rev(dir, 'HEAD'),
    '--head', rev(dir, 'HEAD'), '--build', BUILD, '--typecheck-absent', '--suite', SUITE], { encoding: 'utf8' })
  assert.equal(refused.status, 0,
    'a refusal is a measurement outcome, and a non-zero exit would read as the tool failing')
  const typed = JSON.parse(refused.stdout)
  assert.equal(typed.payload.error.kind, 'main_worktree', 'a typed error still travels under a digest')
  assert.equal(fnv1a(canonical(typed.payload)), typed.payload_digest)
})

// ---------------------------------------------------------------- the journal

test('the observation is journalled by the process that observed it, through the ledger', (t) => {
  const { dir, worktree, base, head } = order(t)

  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', base, '--head', head,
    '--expects', 'src/widget.mjs', '--expects', 'test/widget.test.mjs',
    '--build', BUILD, '--typecheck-absent', '--suite', SUITE, '--test-one', TEST_ONE,
    '--repo', dir, '--effort', EFFORT, '--execution', EXECUTION, '--node', NODE, '--branch', BRANCH,
  ]))
  assert.equal(payload.journal.written, true)

  const { entries, malformed } = readLog(dir, EFFORT, 'journal:' + EXECUTION)
  assert.equal(malformed, 0)
  assert.equal(entries.length, 1)
  const [line] = entries
  assert.equal(line.kind, 'verify-observed')
  assert.ok(Number.isInteger(line.seq) && line.seq >= 1, 'the ledger minted the seq; nobody supplied one')
  assert.equal(line.node, NODE)
  assert.equal(line.branch, BRANCH)
  assert.equal(line.head_sha, head)
  assert.equal(line.build, 'passed')
  assert.equal(line.typecheck, 'absent')
  assert.equal(line.suite, 'passed')
  assert.deepEqual(line.discriminator, payload.discriminator)
  assert.deepEqual(line.checks, [])
  assert.deepEqual(Object.keys(line).sort(), [
    'approved_failing', 'base_sha', 'baseline_failing', 'branch', 'build', 'checks', 'discriminator', 'failing_tests',
    'head_sha', 'key', 'kind', 'mutations', 'node', 'producer', 'seq', 'series_findings', 'static_on_base', 'stop_reason', 'suite', 'suite_scope', 'tests_rewritten', 'typecheck',
    'worktree',
  ], 'a resume re-derives the verdict from this line alone, so it carries every field ' +
     'lib/verdict.mjs reads — `typecheck`, `mutations` and `checks` included')
})

test('verify() journals in-process, and each append mints the next seq', (t) => {
  const { dir, worktree, base, head } = order(t)
  const opts = options({ worktree, base, head, extra: [
    '--repo', dir, '--effort', EFFORT, '--execution', EXECUTION, '--node', NODE, '--branch', BRANCH,
  ] })

  const first = verify({ ...opts, rigor: 'trivial' })
  const second = verify({ ...opts, rigor: 'trivial' })

  assert.deepEqual(first.journal, { written: true, error: '' })
  assert.deepEqual(second.journal, { written: true, error: '' })
  const seqs = readLog(dir, EFFORT, 'journal:' + EXECUTION).entries.map((e) => e.seq)
  assert.equal(seqs.length, 2)
  assert.ok(seqs[1] > seqs[0], 'one monotonic counter per effort, minted under its lock')
})

test('without somewhere to write, nothing is journalled and the payload says so by null', (t) => {
  const { worktree, base, head } = order(t)
  const payload = verify(options({ worktree, base, head, extra: ['--rigor', 'trivial'] }))
  assert.equal(payload.journal, null)
})

test('a refused append is reported on the payload rather than thrown', (t) => {
  const { dir, worktree, base, head } = order(t)
  const payload = verify(options({ worktree, base, head, extra: [
    '--rigor', 'trivial', '--repo', dir, '--effort', 'bad--slug', '--execution', EXECUTION, '--node', NODE,
  ] }))
  assert.equal(payload.journal.written, false)
  assert.match(payload.journal.error, /not an effort name/)
  assert.equal(payload.stop_reason, 'completed', 'the measurement itself is unaffected')
})
