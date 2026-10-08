// tools/suite.mjs — the suite, with a rerun of what failed before anything is called red.
//
//   node tools/suite.mjs [--fast] [--concurrency N] [file...]
//
// Runs `node --test` over the fast tier (--fast), the named files, or everything. A failed run
// is repeated at --test-concurrency=2 over only the files that had a failed test; node re-runs
// only the tests that failed and reads the rest from the state file. A test that fails the first
// run and passes the repeat is a `flake`; one that fails both is `red`. The fast tier runs under
// test/fast/harness/no-spawn.mjs, so a test there that starts a process fails. Exit 0 when
// nothing is red, 1 otherwise, 2 for a bad command line, 130 when interrupted.
//
// Design: docs/DESIGN.md#how-the-plugin-checks-itself

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const REPORTER = new URL('./suite-reporter.mjs', import.meta.url).href

const FAST_TIER = 'test/fast/**/*.test.mjs'
const ALL_TESTS = 'test/**/*.test.mjs'
const NO_SPAWN = new URL('../test/fast/harness/no-spawn.mjs', import.meta.url).href
export const DEFAULT_CONCURRENCY = 8
export const RERUN_CONCURRENCY = 2

const USAGE = 'usage: node tools/suite.mjs [--fast] [--concurrency N] [file...]'

/** @returns {{fast: boolean, concurrency: number, files: string[]} | {error: string}} */
export function parseArgs(argv) {
  const out = { fast: false, concurrency: DEFAULT_CONCURRENCY, files: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--fast') out.fast = true
    else if (arg === '--concurrency' || arg.startsWith('--concurrency=')) {
      const raw = arg === '--concurrency' ? argv[++i] : arg.slice('--concurrency='.length)
      if (!/^[1-9]\d*$/.test(raw ?? '')) return { error: `--concurrency needs a positive integer, got ${JSON.stringify(raw)}` }
      out.concurrency = Number(raw)
    } else if (arg.startsWith('-')) return { error: `unknown option ${arg}` }
    else out.files.push(arg)
  }
  if (out.fast && out.files.length > 0) return { error: '--fast and named files select different things; use one' }
  return out
}

/**
 * What the two runs say about each test that failed the first one.
 * A run is `{code, failed}`: node's exit code and the ids of the tests it reported failed.
 * `ok` follows the repeat's exit code, so a repeat that fails without naming a test is still red.
 */
export function classify(first, second) {
  if (first.code === 0) return { flake: [], red: [], ok: true }
  const again = new Set(second.failed)
  const was = new Set(first.failed)
  return {
    flake: first.failed.filter((id) => !again.has(id)),
    red: [...first.failed.filter((id) => again.has(id)), ...second.failed.filter((id) => !was.has(id))],
    ok: second.code === 0,
  }
}

function readRecords(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

/** The failed tests the reporter wrote, as `file:line:col name` with a repo-relative POSIX file. */
export function readFailures(path, root) {
  return readRecords(path).map(({ name, file, line, column }) => {
    const where = file ? relative(root, file).split(sep).join('/') : '(no file)'
    return `${where}:${line}:${column} ${name}`
  })
}

/**
 * What the repeat loads: the files that had a failed test, so the others are not loaded again
 * with their top-level setup. The first run's selection when nothing names a file to rerun.
 */
export function rerunSelection(path, selection) {
  const records = readRecords(path)
  if (records.length === 0 || records.some((r) => !r.file)) return selection
  return [...new Set(records.map((r) => r.file))]
}

export function nodeArgs({ fast, selection, concurrency, state }) {
  return [
    ...(fast ? ['--import', NO_SPAWN] : []),
    '--test', `--test-concurrency=${concurrency}`, `--test-rerun-failures=${state}`,
    `--test-reporter=${REPORTER}`, '--test-reporter-destination=stdout',
    ...selection,
  ]
}

let running = null
let interrupted = false

/** Kill a child and everything it started: the runner's test files are its children. */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGTERM')
  } catch {
    // The group ended between the check above and the kill: there is nothing left to stop.
  }
}

function stopOnSignals() {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      interrupted = true
      if (running) killTree(running)
    })
  }
}

function runNode(args, failures) {
  if (interrupted) return Promise.resolve(130)
  // The runner sets NODE_TEST_CONTEXT in every test process; a node --test that inherits it
  // runs nothing and exits 0.
  const { NODE_TEST_CONTEXT, ...env } = process.env
  env.AGENTICS_TEST_FAILURES = failures
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform !== 'win32',
    })
    running = child
    child.once('error', fail)
    child.once('close', (code) => { running = null; done(code ?? 1) })
  })
}

async function main(argv) {
  stopOnSignals()
  const parsed = parseArgs(argv)
  if (parsed.error) {
    console.error(`${parsed.error}\n${USAGE}`)
    return 2
  }
  const selection = parsed.fast ? [FAST_TIER] : parsed.files.length > 0 ? parsed.files.map((f) => resolve(process.cwd(), f)) : [ALL_TESTS]
  // One directory per invocation: its state and failure files are nobody else's, and a state
  // left behind could never skip tests that passed on older code.
  const work = mkdtempSync(join(tmpdir(), 'agentics-suite-'))
  const state = join(work, 'state.json')
  const failureFiles = [join(work, 'first.jsonl'), join(work, 'second.jsonl')]
  try {
    const attempt = async (files, concurrency, failures) => {
      const code = await runNode(nodeArgs({ fast: parsed.fast, selection: files, concurrency, state }), failures)
      return { code, failed: readFailures(failures, ROOT) }
    }

    const first = await attempt(selection, parsed.concurrency, failureFiles[0])
    if (interrupted) return 130
    if (first.code === 0) return 0

    console.log(`\n${first.failed.length} failed; running them again at --test-concurrency=${RERUN_CONCURRENCY}\n`)
    const second = await attempt(rerunSelection(failureFiles[0], selection), RERUN_CONCURRENCY, failureFiles[1])
    if (interrupted) return 130

    const verdict = classify(first, second)
    for (const id of verdict.flake) console.log(`flake  ${id}`)
    for (const id of verdict.red) console.log(`red    ${id}`)
    if (!verdict.ok && verdict.red.length === 0) console.log(`red    the rerun exited ${second.code} without naming a failed test`)
    if (verdict.ok && verdict.flake.length === 0) console.log(`flake  the first run exited ${first.code} without naming a failed test`)
    console.log(`${verdict.flake.length} flake, ${verdict.red.length} red`)
    return verdict.ok ? 0 : 1
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

const isMain = import.meta.main ?? (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    console.error(`suite could not run: ${error.message}`)
    process.exitCode = 1
  }
}
