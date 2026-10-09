// test/fast/liveness.test.mjs — GP2: nothing outlives its consumer.
//
// Design: docs/DESIGN.md#self-checks. An element nobody can justify costs as much as a missed
// check and is harder to see, and a mechanism whose consumer went away keeps being paid for —
// read on every turn, written on every run, maintained on every change. So for every record kind,
// lint rule and library export, this finds a producer and a consumer in the source:
// written-never-read and read-never-written fail.
//
// The checks are textual on purpose: the question is "does anything in the shipped source refer
// to this", and a reference is text. Each one says what it counts as a consumer.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EVENT_KINDS } from '../../lib/ledger.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const rel = (full) => relative(ROOT, full).split(sep).join('/')

function files(dir, pattern, out = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    const full = join(ROOT, dir, name)
    if (statSync(full).isDirectory()) files(rel(full), pattern, out)
    else if (pattern.test(name)) out.push(full)
  }
  return out
}

const read = (full) => readFileSync(full, 'utf8')
const lib = files('lib', /\.mjs$/)
const skills = files('skills', /\.md$/)
const tools = files('tools', /\.mjs$/)
const tests = files('test', /\.mjs$/)
const shipped = [...lib, ...skills, ...tools]

/**
 * Every record kind is written by the shipped source (`kind: '<k>'` in a writer, or `.append('<k>'`
 * through a log port) and read by it (the quoted kind anywhere else in lib/, the declaration list
 * aside).
 */
test('every record kind is written somewhere and read somewhere', () => {
  const problems = []
  const check = (ok, why) => { if (!ok) problems.push(why) }
  const STATE = ['batch-started', 'batch', 'checkpoint', 'closed', 'breach_reverted']
  const JOURNAL = ['verify-observed', 'merge-observed', 'series-done', 'authored']
  const RUN = ['run', 'returned', 'host_stop', 'thread_renewed', 'checkout_changed', 'step', 'ended', 'fault']
  const sources = lib.filter((f) => !f.endsWith(join('lib', 'ledger.mjs')))
  const texts = sources.map((f) => [rel(f), read(f)])
  for (const kind of [...EVENT_KINDS, ...STATE, ...JOURNAL, ...RUN]) {
    const write = new RegExp("kind: '" + kind + "'|\\.append\\('" + kind + "'")
    const quoted = new RegExp("'" + kind + "'", 'g')
    const writers = texts.filter(([, t]) => write.test(t)).map(([f]) => f)
    const readers = texts.filter(([, t]) => (t.match(quoted) || []).length > (t.match(new RegExp(write.source, 'g')) || []).length).map(([f]) => f)
    check(writers.length > 0, 'record kind ' + kind + ' is read and never written')
    check(readers.length > 0, 'record kind ' + kind + ' is written (' + writers.join(', ') + ') and never read')
  }
  assert.deepEqual(problems, [])
})

test('every lint rule has its test', () => {
  const problems = []
  const check = (ok, why) => { if (!ok) problems.push(why) }
  const names = new Set(tests.map((f) => f.split(sep).pop()))
  for (const full of files('tools/rules', /\.mjs$/)) {
    const id = full.split(sep).pop().replace(/\.mjs$/, '')
    check([...names].some((n) => n.startsWith(id)), 'tools/rules/' + id + '.mjs has no test/' + id + '*.test.mjs')
  }
  assert.deepEqual(problems, [])
})

test('every library export is used outside the file that defines it', () => {
  const problems = []
  const check = (ok, why) => { if (!ok) problems.push(why) }
  const everything = [...shipped, ...tests].map((f) => [f, read(f)])
  for (const full of lib) {
    const source = read(full)
    for (const [, name] of source.matchAll(/^export (?:async )?(?:function|const|class) ([A-Za-z0-9_]+)/gm)) {
      const used = everything.some(([f, t]) => f !== full && new RegExp('\\b' + name + '\\b').test(t))
      check(used, rel(full) + ' exports `' + name + '` and nothing uses it')
    }
  }
  assert.deepEqual(problems, [])
})
