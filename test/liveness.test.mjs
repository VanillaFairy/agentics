// test/liveness.test.mjs — GP2: nothing outlives its consumer.
//
// Design: docs/DESIGN.md#self-checks. An element nobody can justify costs as much as a missed
// check and is harder to see, and a mechanism whose consumer went away keeps being paid for —
// read on every turn, written on every run, maintained on every change. So for every agent,
// record kind, schema field, lint rule and library export, this finds a producer and a consumer
// in the source: defined-never-dispatched, written-never-read and read-never-written fail.
//
// The checks are textual on purpose: the question is "does anything in the shipped source refer
// to this", and a reference is text. Each one says what it counts as a consumer.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EVENT_KINDS } from '../lib/ledger.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
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
const workflows = files('workflows', /\.workflow\.js$/)
const skills = files('skills', /\.md$/)
const agents = files('agents', /\.md$/)
const tools = files('tools', /\.mjs$/)
const tests = files('test', /\.mjs$/)
const shipped = [...lib, ...workflows, ...skills, ...agents, ...tools]

test('every agent is dispatched by a workflow or a skill', () => {
  const problems = []
  const check = (ok, why) => { if (!ok) problems.push(why) }
  const dispatchers = [...workflows, ...skills].map(read).join('\n')
  for (const full of agents) {
    const name = full.split(sep).pop().replace(/\.md$/, '')
    check(dispatchers.includes("'agentics:" + name + "'") || dispatchers.includes('agentics:' + name),
      'agents/' + name + '.md is defined and never dispatched')
  }
  assert.deepEqual(problems, [])
})

/**
 * Every record kind is written by the shipped source (`kind: '<k>'` in a writer) and read by it
 * (the quoted kind anywhere else in lib/ or a workflow, the declaration list aside).
 */
test('every record kind is written somewhere and read somewhere', () => {
  const problems = []
  const check = (ok, why) => { if (!ok) problems.push(why) }
  const STATE = ['dispatch', 'batch', 'checkpoint', 'closed']
  const JOURNAL = ['verify-observed', 'merge-observed', 'series-done']
  const sources = [...lib, ...workflows].filter((f) => !f.endsWith(join('lib', 'ledger.mjs')))
  const texts = sources.map((f) => [rel(f), read(f)])
  for (const kind of [...EVENT_KINDS, ...STATE, ...JOURNAL]) {
    const write = new RegExp("kind: '" + kind + "'")
    const quoted = new RegExp("'" + kind + "'", 'g')
    const writers = texts.filter(([, t]) => write.test(t)).map(([f]) => f)
    const readers = texts.filter(([, t]) => (t.match(quoted) || []).length > (t.match(new RegExp(write.source, 'g')) || []).length).map(([f]) => f)
    check(writers.length > 0, 'record kind ' + kind + ' is read and never written')
    check(readers.length > 0, 'record kind ' + kind + ' is written (' + writers.join(', ') + ') and never read')
  }
  assert.deepEqual(problems, [])
})

/** Source with comments and string contents blanked, lengths preserved. */
function blank(source) {
  let out = ''
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') { out += ' '; i++ }
      out += '\n'
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) { out += source[i] === '\n' ? '\n' : ' '; i++ }
      out += '  '
      i++
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      out += c
      for (i++; i < source.length && source[i] !== c; i++) {
        if (source[i] === '\\') { out += '  '; i++; continue }
        out += source[i] === '\n' ? '\n' : ' '
      }
      out += c
      continue
    }
    out += c
  }
  return out
}

/** The index just past the brace that closes the one opening at `at`. */
function closing(code, at) {
  let depth = 0
  for (let i = at; i < code.length; i++) {
    if (code[i] === '{' || code[i] === '[') depth++
    else if (code[i] === '}' || code[i] === ']') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return code.length
}

/**
 * The top-level fields of every root schema a workflow declares (`const NAME = { type: 'object',
 * … properties: { … } }`): the fields an agent returns to the script. Nested fields ride inside
 * their parent, whose consumer is whoever reads the parent.
 */
function schemaFields(source) {
  const code = blank(source)
  const out = new Set()
  for (const m of code.matchAll(/const [A-Z_]+ = \{/g)) {
    const start = m.index + m[0].length - 1
    const end = closing(code, start)
    const body = code.slice(start, end)
    if (!/type:\s*'\s*'/.test(body.replace(/'object'/g, "' '")) && !/properties:/.test(body)) continue
    const at = (() => {
      let depth = 0
      for (let i = 0; i < body.length; i++) {
        if (body[i] === '{' || body[i] === '[') depth++
        else if (body[i] === '}' || body[i] === ']') depth--
        else if (depth === 1 && body.startsWith('properties:', i)) return i
      }
      return -1
    })()
    if (at === -1) continue
    const open = body.indexOf('{', at)
    const block = body.slice(open, closing(body, open))
    let depth = 0
    for (const k of block.matchAll(/[{}\[\]]|([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
      if (k[0] === '{' || k[0] === '[') depth++
      else if (k[0] === '}' || k[0] === ']') depth--
      else if (depth === 1 && k[1]) out.add(k[1])
    }
  }
  return out
}

test('every field a workflow asks an agent for is read by that workflow', () => {
  const problems = []
  const check = (ok, why) => { if (!ok) problems.push(why) }
  for (const full of workflows) {
    const source = read(full)
    for (const field of schemaFields(source)) {
      const readBack = new RegExp('\\.' + field + '\\b|\\[\'' + field + '\'\\]|\\{[^}]*\\b' + field + '\\b[^}]*\\}\\s*=')
      check(readBack.test(source), rel(full) + ' asks for `' + field + '` and never reads it')
    }
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
