// lib/gotchas.mjs — the one narrow memory an effort keeps: gotchas, the environmental traps an
// agent fell into and got out of, recorded so the next agent does not fall in.
//
// Design: docs/DESIGN.md#gotchas.
//
// Why so narrow. A memory that stores claims about the code goes stale silently and is then read
// as fact. A gotcha is checked the moment it is used — its trigger either happens or it does not —
// so it can be trusted exactly as far as it is cheap to re-test. That is why this file checks the
// qualification rules a script can check (a kind, who needs it, a trigger and an action, the
// command and the output line that showed it, paths that cannot climb) and refuses anything else:
// a gotcha without its evidence is an opinion, and opinions are what goes stale.
//
// Why the id is minted here. The same trap recorded twice must be one file, not two that drift
// apart, so a pitfall's id is a digest of its normalized trigger and a command's id is its name.
// Writing is then idempotent by construction: the second recording overwrites the first.
//
// Why reports carry fenced blocks. An executor has no business retyping a gotcha into a command
// line — an agent's output is where corruption lives — so it writes the block into its report
// file and leaf-close extracts it here, in-process. A malformed block is reported as a problem and
// never thrown: one bad block must not cost the rest of the report.
//
// Why only an investigator's `command` gotchas are read by verification. Build and test commands
// decide what a measurement means; establishing them is judgment given to one role, so a command
// some executor happened to report is guidance for the next executor and never a yardstick.

import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { fnv1a } from './plan-digest.mjs'
import { decodeArgs, effortStateDir, envelope, flagOf, flagsOf, git, posix, safePath, safeSlug, mkdirState } from './store.mjs'

const GOTCHA_KINDS = ['pitfall', 'command']
const COMMAND_NAMES = ['build', 'typecheck', 'suite', 'test_one']

/** Every agent a gotcha may be addressed to — the roster of agents this plugin defines. */
const AGENT_ROLES = ['scout', 'historian', 'doc-researcher', 'analyst', 'planner',
  'implementer', 'test-author', 'auditor', 'reviewer', 'investigator', 'courier']

/** The fenced report blocks an executor may write, by info string. */
const REPORT_BLOCKS = ['agentics-gotchas', 'agentics-gotchas-stale', 'agentics-mutations', 'agentics-commit']

const GOTCHA_ID = /^(g-[0-9a-f]{8}|command-(build|typecheck|suite|test_one))$/

const str = (v) => (typeof v === 'string' ? v : '')
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== ''

/** The directory an effort's gotchas live in. */
export const knowledgeDir = (repo, effort) => join(effortStateDir(repo, effort), 'knowledge')

/** Pure. A trigger as the id sees it: lower-cased, whitespace collapsed, trimmed. */
const normalizeTrigger = (trigger) => str(trigger).toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Pure. A gotcha's id: `command-<name>` for a command, `g-<fnv1a(normalized trigger)>` otherwise.
 * @param {{kind: string, trigger?: string, command?: {name: string}}} g
 * @returns {string}
 */
export function gotchaId(g) {
  if (g && g.kind === 'command') return 'command-' + str(g.command && g.command.name)
  return 'g-' + fnv1a(normalizeTrigger(g && g.trigger))
}

/** Pure. Whether a string is a well-formed gotcha id (and so safe as a file name). */
const isGotchaId = (id) => typeof id === 'string' && GOTCHA_ID.test(id)

/**
 * Pure. What disqualifies a reported gotcha, as one sentence, or null. Checks the qualification
 * rules a script can check; whether it was hit rather than foreseen, and whether it is about the
 * environment rather than the work, stay the reporting agent's judgment.
 * @param {object} g `{kind, roles, paths?, trigger, action, evidence: {command, output}, command?}`
 * @returns {string|null}
 */
export function gotchaProblem(g) {
  if (!g || typeof g !== 'object' || Array.isArray(g)) return 'a gotcha must be a JSON object'
  if (!GOTCHA_KINDS.includes(g.kind)) return 'kind must be one of ' + GOTCHA_KINDS.join(', ') + ', not ' + JSON.stringify(g.kind)
  if (!Array.isArray(g.roles) || g.roles.length === 0) return 'roles must name at least one agent who needs it'
  const stranger = g.roles.find((r) => !AGENT_ROLES.includes(r))
  if (stranger !== undefined) return 'role ' + JSON.stringify(stranger) + ' is not an agent: ' + AGENT_ROLES.join(', ')
  if (!nonEmpty(g.trigger)) return 'trigger is empty — a gotcha is statable as "when <trigger>, do <action>"'
  if (!nonEmpty(g.action)) return 'action is empty — a gotcha is statable as "when <trigger>, do <action>"'
  const ev = g.evidence
  if (!ev || typeof ev !== 'object' || !nonEmpty(ev.command) || !nonEmpty(ev.output)) {
    return 'evidence needs the command that failed and the output line that showed it'
  }
  if (g.paths !== undefined && !Array.isArray(g.paths)) return 'paths must be an array of repo-relative paths'
  for (const p of g.paths || []) {
    if (safePath(p) === null) return 'path ' + JSON.stringify(p) + ' is not a repo-relative path'
  }
  if (g.kind === 'command') {
    const c = g.command
    if (!c || typeof c !== 'object' || !COMMAND_NAMES.includes(c.name)) {
      return 'a command gotcha names its command: ' + COMMAND_NAMES.join(', ')
    }
    if (c.absent !== true && !nonEmpty(c.value)) return 'command ' + c.name + ' has no value and is not marked absent'
  }
  return null
}

// ------------------------------------------------------------------ report blocks

const FENCE = /^```(agentics-[a-z-]+)[ \t]*\n([\s\S]*?)\n?^```[ \t]*$/gm

/**
 * Pure. The fenced blocks of an executor's report, parsed. Never throws: a block that is not JSON,
 * or an item that does not qualify, is named in `problems` and left out, and everything else in
 * the report still counts. Several blocks of one kind are concatenated; a second commit block is a
 * problem and the first one stands.
 * @param {string} text
 * @returns {{gotchas: object[], stale: string[], mutations: object[], commit: string|null, problems: string[]}}
 */
export function extractReportBlocks(text) {
  const out = { gotchas: [], stale: [], mutations: [], commit: null, problems: [] }
  const body = str(text).replace(/\r\n?/g, '\n')
  for (const m of body.matchAll(FENCE)) {
    const [, tag, content] = m
    if (!REPORT_BLOCKS.includes(tag)) continue

    if (tag === 'agentics-commit') {
      const lines = content.split('\n').map((l) => l.trim()).filter((l) => l !== '')
      if (lines.length !== 1) out.problems.push('agentics-commit: expected one subject line, found ' + lines.length)
      else if (out.commit !== null) out.problems.push('agentics-commit: a second commit block — the first one stands')
      else out.commit = lines[0]
      continue
    }

    let items
    try {
      items = JSON.parse(content)
    } catch (err) {
      out.problems.push(tag + ': not JSON (' + err.message + ')')
      continue
    }
    if (!Array.isArray(items)) {
      out.problems.push(tag + ': expected a JSON array')
      continue
    }

    items.forEach((item, i) => {
      const at = tag + '[' + i + ']: '
      if (tag === 'agentics-gotchas') {
        const problem = gotchaProblem(item)
        if (problem) out.problems.push(at + problem)
        else out.gotchas.push(item)
      } else if (tag === 'agentics-gotchas-stale') {
        if (isGotchaId(item)) out.stale.push(item)
        else out.problems.push(at + JSON.stringify(item) + ' is not a gotcha id')
      } else {
        const problem = mutationProblem(item)
        if (problem) out.problems.push(at + problem)
        else out.mutations.push({ file: safePath(item.file), find: item.find, replace: item.replace, expect_failing: item.expect_failing })
      }
    })
  }
  return out
}

/** Pure. What is wrong with one declared mutation, or null. */
function mutationProblem(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'a mutation must be a JSON object'
  if (safePath(m.file) === null) return 'file ' + JSON.stringify(m.file) + ' is not a repo-relative path'
  if (!nonEmpty(m.find)) return 'find is empty — a mutation replaces text that is there'
  if (typeof m.replace !== 'string') return 'replace must be a string'
  if (m.find === m.replace) return 'find and replace are the same text — that mutates nothing'
  if (!Array.isArray(m.expect_failing) || m.expect_failing.some((t) => !nonEmpty(t))) {
    return 'expect_failing must be an array of the tests that fail under it'
  }
  return null
}

// ------------------------------------------------------------------ the files

const indent = (text) => str(text).trim().split('\n').map((l) => '    ' + l).join('\n')

/** Pure. The file text of one gotcha: a one-line JSON frontmatter, then its sentence and evidence. */
function renderGotcha(g, { observed_at = '', source = {} } = {}) {
  const front = {
    id: gotchaId(g),
    kind: g.kind,
    roles: g.roles,
    paths: (g.paths || []).map(safePath),
    observed_at: str(observed_at),
    source: { node: str(source && source.node), role: str(source && source.role) },
    ...(g.kind === 'command'
      ? { command: { name: g.command.name, value: str(g.command.value), absent: g.command.absent === true } }
      : {}),
  }
  return '---\n' + JSON.stringify(front) + '\n---\n' +
    'When ' + g.trigger.trim() + ', do ' + g.action.trim().replace(/\.$/, '') + '.\n\n' +
    'Evidence:\n' + indent('$ ' + g.evidence.command.trim()) + '\n' + indent(g.evidence.output) + '\n'
}

/** Pure. One gotcha file parsed back, or null when it is not one. */
export function parseGotcha(text) {
  const m = /^---\n(.*)\n---\n([\s\S]*)$/.exec(str(text).replace(/\r\n?/g, '\n'))
  if (!m) return null
  let front
  try {
    front = JSON.parse(m[1])
  } catch {
    return null
  }
  if (!front || typeof front !== 'object' || !isGotchaId(front.id) || !GOTCHA_KINDS.includes(front.kind)) return null
  return {
    id: front.id,
    kind: front.kind,
    roles: Array.isArray(front.roles) ? front.roles : [],
    paths: Array.isArray(front.paths) ? front.paths : [],
    observed_at: str(front.observed_at),
    source: front.source && typeof front.source === 'object' ? front.source : {},
    ...(front.command ? { command: front.command } : {}),
    body: m[2].trim(),
  }
}

/**
 * Write one gotcha under its minted id. Idempotent: the same trigger (or command name) overwrites
 * the file it already has. Written to a temporary name and renamed, so a reader never sees half.
 * @returns {{ok: true, id: string, path: string} | {ok: false, error: string}}
 */
export function writeGotcha(repo, effort, g, { observed_at = '', source = {} } = {}) {
  if (!safeSlug(effort)) return { ok: false, error: 'not an effort name: ' + JSON.stringify(effort) }
  const problem = gotchaProblem(g)
  if (problem) return { ok: false, error: problem }
  const id = gotchaId(g)
  const dir = knowledgeDir(repo, effort)
  const path = join(dir, id + '.md')
  mkdirState(dir)
  const tmp = path + '.' + process.pid + '.tmp'
  writeFileSync(tmp, renderGotcha(g, { observed_at, source }), 'utf8')
  renameSync(tmp, path)
  return { ok: true, id, path: posix(path) }
}

/**
 * Delete a gotcha an agent observed no longer holds — deleted, not marked, because a marked
 * gotcha is one more thing a reader has to know to skip.
 * @returns {{ok: boolean, deleted: boolean, error?: string}}
 */
export function deleteGotcha(repo, effort, id) {
  if (!safeSlug(effort)) return { ok: false, deleted: false, error: 'not an effort name: ' + JSON.stringify(effort) }
  if (!isGotchaId(id)) return { ok: false, deleted: false, error: JSON.stringify(id) + ' is not a gotcha id' }
  const path = join(knowledgeDir(repo, effort), id + '.md')
  let deleted = true
  try {
    readFileSync(path)
  } catch {
    deleted = false
  }
  rmSync(path, { force: true })
  return { ok: true, deleted }
}

/**
 * Every gotcha file of an effort, parsed, in id order, and the files that would not parse — so a
 * damaged file is visible rather than silently absent.
 * @returns {{gotchas: object[], malformed: string[]}}
 */
export function readKnowledge(repo, effort) {
  if (!safeSlug(effort)) return { gotchas: [], malformed: [] }
  const dir = knowledgeDir(repo, effort)
  let names
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md')).sort()
  } catch {
    return { gotchas: [], malformed: [] }
  }
  const gotchas = []
  const malformed = []
  for (const name of names) {
    const path = join(dir, name)
    let g = null
    try {
      g = parseGotcha(readFileSync(path, 'utf8'))
    } catch {
      g = null
    }
    if (g && g.id + '.md' === name) gotchas.push({ ...g, path: posix(path) })
    else malformed.push(posix(path))
  }
  return { gotchas, malformed }
}

/** Every well-formed gotcha of an effort, in id order. */
export const listGotchas = (repo, effort) => readKnowledge(repo, effort).gotchas

/**
 * Pure. Whether a gotcha's path prefix overlaps a locus path: either is a string prefix of the
 * other. Plain string prefix rather than segment-aware on purpose — an extra gotcha in a brief
 * costs a few lines, a missed one costs the trap.
 */
export function pathsOverlap(a, b) {
  const x = safePath(a)
  const y = safePath(b)
  if (x === null || y === null) return false
  if (x === '.' || y === '.') return true
  return x.startsWith(y) || y.startsWith(x)
}

/**
 * Pure. The gotchas one dispatch is handed: those whose `roles` include `role` and whose `paths`
 * are empty or overlap `locus`. An absent `role` or `locus` does not filter on it; an empty locus
 * admits only gotchas that name no paths.
 */
function selectGotchas(gotchas, { role, locus } = {}) {
  return gotchas.filter((g) =>
    (!role || g.roles.includes(role)) &&
    (!Array.isArray(locus) || g.paths.length === 0 || g.paths.some((p) => locus.some((l) => pathsOverlap(p, l)))))
}

/** The gotchas one dispatch is handed, read from disk. */
export const gotchasFor = (repo, effort, { role, locus } = {}) => selectGotchas(listGotchas(repo, effort), { role, locus })

/**
 * Pure. The build, typecheck, suite and single-test commands the effort established — read only
 * from `command` gotchas an investigator wrote, because establishing them is that role's judgment.
 */
function commandsFrom(gotchas) {
  const out = { build: '', typecheck: '', suite: '', test_one: '', absent: { build: false, typecheck: false, suite: false } }
  for (const g of gotchas) {
    if (g.kind !== 'command' || !g.command || !g.source || g.source.role !== 'investigator') continue
    const { name, value, absent } = g.command
    if (!COMMAND_NAMES.includes(name)) continue
    if (absent === true) {
      if (name in out.absent) out.absent[name] = true
      out[name] = ''
    } else {
      out[name] = str(value)
      if (name in out.absent) out.absent[name] = false
    }
  }
  return out
}

/** The effort's established commands, read from disk. */
export const commandsOf = (repo, effort) => commandsFrom(listGotchas(repo, effort))

// ------------------------------------------------------------------ CLI

const readStdin = () => {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/** The gotchas an `add` call carries: one object or an array, from --b64/--b64-file, --file or --stdin. */
function itemsFrom(argv) {
  const file = flagOf(argv, 'file')
  let value
  if (file) value = JSON.parse(readFileSync(file, 'utf8'))
  else if (argv.includes('--stdin')) value = JSON.parse(readStdin())
  else {
    const decoded = decodeArgs(argv)
    if (decoded.problem) return { problem: decoded.problem }
    value = decoded.value
  }
  return { items: Array.isArray(value) ? value : [value] }
}

/**
 * `add`, all or nothing: every item must qualify before any is written. `source` and `observed_at`
 * come from the item, else from `--node`/`--role`/`--observed-at`, else the role defaults to
 * `investigator` (this CLI is the investigator's) and the commit to the repository's HEAD.
 */
function add(argv) {
  const repo = flagOf(argv, 'repo') || '.'
  const effort = flagOf(argv, 'effort')
  if (!safeSlug(effort)) return { ok: false, error: { kind: 'bad_effort', message: 'not an effort name: ' + JSON.stringify(effort) } }

  let parsed
  try {
    parsed = itemsFrom(argv)
  } catch (err) {
    return { ok: false, error: { kind: 'args_unreadable', message: 'the gotchas are not JSON: ' + err.message } }
  }
  if (parsed.problem) return { ok: false, error: parsed.problem }

  const problems = parsed.items.map((g, i) => [i, gotchaProblem(g)]).filter(([, p]) => p)
  if (problems.length) {
    return { ok: false, error: { kind: 'not_a_gotcha', message: problems.map(([i, p]) => '[' + i + '] ' + p).join('; ') }, written: [] }
  }

  const head = () => {
    const r = git(repo, ['rev-parse', 'HEAD'])
    return r.ok ? r.stdout.trim() : ''
  }
  const written = []
  for (const g of parsed.items) {
    const source = g.source && typeof g.source === 'object'
      ? g.source
      : { node: flagOf(argv, 'node'), role: flagOf(argv, 'role') || 'investigator' }
    const observed_at = str(g.observed_at) || flagOf(argv, 'observed-at') || head()
    const r = writeGotcha(repo, effort, g, { observed_at, source })
    if (!r.ok) return { ok: false, error: { kind: 'write_failed', message: r.error }, written }
    written.push({ id: r.id, path: r.path })
  }
  return { ok: true, error: null, written }
}

function list(argv) {
  const repo = flagOf(argv, 'repo') || '.'
  const effort = flagOf(argv, 'effort')
  const { gotchas, malformed } = readKnowledge(repo, effort)
  const locus = flagsOf(argv, 'locus')
  const picked = selectGotchas(gotchas, { role: flagOf(argv, 'role'), locus: locus.length ? locus : undefined })
  return { ok: true, error: null, gotchas: picked, malformed }
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  try {
    const argv = process.argv.slice(2)
    const [command] = argv
    let payload
    if (command === 'add') payload = add(argv)
    else if (command === 'list') payload = list(argv)
    else throw new Error('unknown command ' + JSON.stringify(command || '') + ' — expected add or list')
    console.log(JSON.stringify(envelope(payload)))
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
