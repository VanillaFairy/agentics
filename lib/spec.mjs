// lib/spec.mjs — a folder's DESIGN.md read as data: its sections, its Decisions rows, its graded
// open questions and its plan entries; the checks that place one spec in its effort; and the hash
// an approval rests on.
//
// Design: docs/DESIGN.md#specs-approval-and-compile.
//
// A spec is prose for the user except three parsed forms, and this file is their only reader. It
// refuses; it never repairs. Every problem names the file and the line, because the person who
// wrote the spec fixes it there. Line endings and a byte-order mark are normalised before hashing
// or parsing, so a checkout that turned LF into CRLF never reads as an edit.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { commandsOf } from './gotchas.mjs'
import { readLog } from './ledger.mjs'
import { canonical, fnv1a } from './plan-digest.mjs'
import { EFFORTS, MODELS } from './roles.mjs'
import {
  ROOT_ID, SPEC_FILE, agenticsRoot, envelope, flagOf, handleArgs, git, mainCheckout, nodeIdProblem, parentOf, posix, safeSlug,
  specCopyPath, specPath,
} from './store.mjs'
import { contractProblems, nodeProblems, normalizeNode, roleFitsRigor } from './tree.mjs'

export const SECTIONS = ['Intent', 'Decisions', 'Design', 'Plan', 'Open questions', 'Evidence']
export const ENTRY_KINDS = ['sub-effort', 'task', 'deferred', 'dropped']
export const ENTRY_KEYS = ['realises', 'after', 'author', 'provides', 'consumes', 'rigor', 'role',
  'expects', 'reads', 'runs', 'ground', 'shared', 'dispatch', 'label', 'cites']
export const GRADES = ['blocking', 'parked', 'lookup', 'compost']

export const LABEL_MAX = 16
const TASK_ONLY = ['rigor', 'role', 'expects', 'reads', 'runs', 'dispatch', 'cites']
const SUB_EFFORT_ONLY = ['author', 'shared']
const LISTS = ['realises', 'after', 'expects', 'reads', 'runs', 'ground', 'shared']
const FENCE = /^\s*(```|~~~)/

const normalise = (text) => String(text ?? '').replace(/^﻿/, '').replace(/\r\n/g, '\n')
const unquote = (s) => s.trim().replace(/^`(.*)`$/, '$1').trim()
const childOf = (folder, name) => (folder === ROOT_ID ? name : folder + '/' + name)

/** Pure. fnv1a over the canonical form of the spec's text, line endings and BOM normalised. */
export const hashSpec = (text) => fnv1a(canonical(normalise(text)))

/**
 * The change from the text compile kept for `folder` under `hash` to the spec as it stands: git's
 * hunks only, its header naming two paths a reader has no use for. `no_copy` when no intact copy is
 * kept, `no_diff` when git shows no change.
 *
 * @returns {{ok: true, copy: string, diff: string}|{ok: false, kind: 'no_copy'|'no_diff'}}
 */
export function keptSpecDiff(repo, effort, folder, hash) {
  const copy = specCopyPath(repo, effort, folder, hash)
  if (!existsSync(copy) || hashSpec(readFileSync(copy, 'utf8')) !== hash) return { ok: false, kind: 'no_copy' }
  const raw = git(dirname(copy), ['diff', '--no-index', '--no-color', '--ignore-cr-at-eol', '-U3', '--', copy, specPath(repo, effort, folder)]).stdout
  if (!raw.includes('\n@@')) return { ok: false, kind: 'no_diff' }
  return { ok: true, copy, diff: raw.slice(raw.indexOf('\n@@') + 1).trimEnd() }
}

/** Split on commas that sit outside parentheses, and with `quoted` outside double quotes too. */
function splitTop(value, { quoted = false } = {}) {
  const out = []
  let depth = 0
  let quote = false
  let cur = ''
  for (const ch of value) {
    if (quoted && ch === '"') quote = !quote
    if (ch === '(' && !quote) depth++
    if (ch === ')' && !quote) depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0 && !quote) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map(unquote).filter(Boolean)
}

/** A table row's cells, with `\|` read as a literal pipe. */
const cellsOf = (line) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  .split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim())
const isSeparator = (line) => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line.trim())

function parseDecisions(rows, at) {
  const out = []
  for (let i = 0; i < rows.length; i++) {
    const { text, line } = rows[i]
    if (!text.trim().startsWith('|') || isSeparator(text)) continue
    if (rows[i + 1] && isSeparator(rows[i + 1].text)) continue // the header row
    const cells = cellsOf(text)
    if (cells.length !== 3) {
      at(line, 'a Decisions row has three cells — | id | decision | why | — this one has ' + cells.length)
      continue
    }
    const [id, decision, why] = cells
    if (!id) at(line, 'a decision has no id')
    if (!decision) at(line, 'decision ' + id + ' has no text')
    if (!why) at(line, 'decision ' + id + ' has no why — a decision carries the user\'s reason')
    if (id && decision && why) out.push({ id, text: decision, why, line })
  }
  return out
}

function parseQuestions(rows, at) {
  const out = []
  for (const { text, line } of rows) {
    if (text.trim() === '') continue
    if (/^\s/.test(text)) {
      if (out.length) out[out.length - 1].text += '\n' + text.trim()
      continue
    }
    if (!text.startsWith('- ')) continue
    const m = /^- \*\*([^*]+?):\*\*\s*(.*)$/.exec(text)
    if (!m) {
      at(line, 'an open question starts with its grade: "- **blocking:** …", "- **parked (reopens at <x>):** …", "- **lookup:** …" or "- **compost:** …"')
      continue
    }
    const label = m[1].trim()
    const parked = /^parked \(reopens at (.+)\)$/.exec(label)
    if (parked) out.push({ grade: 'parked', reopens: parked[1].trim(), text: m[2].trim(), line })
    else if (label === 'parked') at(line, 'a parked question says what reopens it: "- **parked (reopens at <x>):** …"')
    else if (GRADES.includes(label)) out.push({ grade: label, reopens: '', text: m[2].trim(), line })
    else at(line, 'unknown grade "' + label + '" — grades are blocking, parked (reopens at <x>), lookup, compost')
  }
  return out
}

const blank = (name, kind, line, group = '') => ({
  name, kind, line, group, title: '', context: '', realises: [], after: [], author: 'you', provides: [],
  consumes: [], rigor: '', role: '', expects: [], reads: [], runs: [], ground: [], shared: [], dispatch: {},
  label: '', criteria: [], given: [], cites: [], fieldLines: {},
})

function field(entry, part, line, at) {
  const m = /^([a-z-]+):\s*(.*)$/.exec(part.trim())
  if (!m) return at(line, 'a field is "key: value", not "' + part.trim() + '"')
  const [, key, value] = m
  if (key === 'locus') return at(line, 'locus is now expects: run node tools/migrate-expects.mjs once to rewrite every spec')
  if (!ENTRY_KEYS.includes(key)) return at(line, 'unknown key "' + key + '" — keys are ' + ENTRY_KEYS.join(', '))
  if (entry.given.includes(key)) return at(line, 'key "' + key + '" is written twice on ' + entry.name)
  entry.given.push(key)
  entry.fieldLines[key] = line
  if (LISTS.includes(key)) entry[key] = splitTop(value)
  else if (key === 'author') {
    if (value.trim() === 'you' || value.trim() === 'planner') entry.author = value.trim()
    else at(line, 'author is you or planner, not "' + value.trim() + '"')
  } else if (key === 'provides') {
    for (const item of splitTop(value, { quoted: true })) {
      const c = /^([^\s(]+)\s*\(([^)]*)\)(?:\s*"([^"]*)")?$/.exec(item)
      if (c && c[3] !== undefined && !c[3].trim()) at(line, 'the part ' + c[1] + ' declares is a ### or #### heading of the Design, not ""')
      else if (c) entry.provides.push({ name: c[1], paths: splitTop(c[2]), ...(c[3] !== undefined ? { part: c[3].trim() } : {}) })
      else at(line, 'a provided contract is "<name> (<path>, …)", optionally followed by "<part>" — "' + item + '" is not')
    }
  } else if (key === 'cites') {
    for (const item of splitTop(value, { quoted: true })) {
      const q = /^"([^"]*)"$/.exec(item)
      if (item === 'Design') entry.cites.push({ whole: true })
      else if (q && q[1].trim()) entry.cites.push({ part: q[1].trim() })
      else at(line, 'cites names Design, or a "<part>" of it in double quotes, not "' + item + '"')
    }
  } else if (key === 'consumes') entry.consumes = splitTop(value).map((name) => ({ name }))
  else if (key === 'dispatch') {
    for (const item of splitTop(value)) {
      const d = /^(producer|reviewer)=([a-z0-9.-]+)\/([a-z]+)$/.exec(item)
      if (d && !MODELS.includes(d[2])) at(line, 'dispatch names model "' + d[2] + '" — models are ' + MODELS.join(', '))
      else if (d && !EFFORTS.includes(d[3])) at(line, 'dispatch names effort "' + d[3] + '" — efforts are ' + EFFORTS.join(', '))
      else if (d) entry.dispatch[d[1]] = { model: d[2], effort: d[3] }
      else at(line, 'dispatch is "producer=<model>/<effort>, reviewer=<model>/<effort>", not "' + item + '"')
    }
  } else if (key === 'label') {
    const label = unquote(value).trim()
    // A label is what a node's block in the viewer shows, and a longer one does not fit it.
    if (label && label.length <= LABEL_MAX) entry.label = label
    else at(line, 'a label is the work in at most ' + LABEL_MAX + ' characters, not "' + label + '"')
  } else entry[key] = unquote(value) // rigor, role
}

/**
 * Plan entries and groups from the Plan section's own lines. An entry opens on
 * `- **<name>** — <kind>`; its continuation lines carry ` · key: value` fields, `- [ ]` criteria,
 * and prose (the first line is the title, the rest is context). A column-0 line that opens no entry
 * closes whatever is open. A `### <name> — group` heading opens a group: the prose under it, up to
 * its first entry, is its title and context, and every entry after it belongs to it until the next
 * group heading.
 */
function parsePlan(rows, at) {
  const entries = []
  const groups = []
  let current = null
  let context = null
  let group = null
  let groupProse = false

  const close = () => {
    if (current) {
      current.context = context.join('\n').trim()
      if (!current.title) at(current.line, current.name + ' needs a title')
      entries.push(current)
    }
    current = null
    context = null
  }
  const closeGroup = () => {
    if (group) {
      group.context = group.context.join('\n').trim()
      if (!group.title) at(group.line, 'group ' + group.name + ' needs a title')
      groups.push(group)
    }
    group = null
    groupProse = false
  }

  for (const { text, line } of rows) {
    const heading = /^(#{3,})\s+(.*)$/.exec(text)
    if (heading) {
      close()
      closeGroup()
      const g = heading[1] === '###' ? /^(\S+) — group((?:\s*·.*)?)$/.exec(heading[2].trim()) : null
      if (!g) {
        at(line, 'a heading in the Plan opens a group: "### <name> — group"')
        continue
      }
      const holder = blank(g[1], 'group', line)
      for (const part of g[2].split(/\s*·\s*/)) if (part.trim() !== '') field(holder, part, line, at)
      for (const key of holder.given) if (key !== 'after') at(line, key + ' is not a group\'s field — a group carries only after')
      group = { name: g[1], line, title: '', context: [], after: holder.after }
      groupProse = true
      continue
    }

    const opens = /^- \*\*([^*]+)\*\*(.*)$/.exec(text)
    if (opens) {
      close()
      groupProse = false
      const name = opens[1]
      const rest = opens[2]
      if (!rest.startsWith(' — ')) {
        at(line, 'the separator after the name is " — " (em dash between spaces)')
        continue
      }
      const parts = rest.slice(3).split(/\s*·\s*/)
      const kind = parts[0]
      current = blank(name, kind, line, group ? group.name : '')
      context = []
      if (!ENTRY_KINDS.includes(kind)) at(line, 'unknown kind "' + kind + '" — kinds are ' + ENTRY_KINDS.join(', '))
      for (const part of parts.slice(1)) if (part.trim() !== '') field(current, part, line, at)
      continue
    }

    if (text.trim() === '') {
      if (current) context.push('')
      else if (groupProse && group.title) group.context.push('')
      continue
    }

    if (groupProse && !text.trimStart().startsWith('- ')) {
      if (!group.title) group.title = text.trim()
      else group.context.push(text.trim())
      continue
    }

    if (/^\S/.test(text)) {
      if (text.startsWith('- ')) at(line, 'not a plan entry: an entry starts "- **<name>** — <kind>"')
      else close()
      continue
    }

    if (!current) continue

    const trimmed = text.trim()
    if (trimmed.startsWith('·')) {
      for (const part of trimmed.slice(1).split(/\s*·\s*/)) if (part.trim() !== '') field(current, part, line, at)
      continue
    }
    const criterion = /^- \[( |x|X)\]\s+(.*)$/.exec(trimmed)
    if (criterion) {
      if (criterion[1] !== ' ') {
        at(line, 'a criterion is never checked off in a spec — status is derived')
        continue
      }
      const body = criterion[2]
      if (body.startsWith('HUMAN:')) {
        current.criteria.push({ text: body, check: '', line })
        continue
      }
      const checked = /^(.*?)\s+—\s+check:\s+`([^`]+)`\s*$/.exec(body)
      if (checked) {
        current.criteria.push({ text: checked[1], check: checked[2], line })
        continue
      }
      at(line, 'names no check: end it " — check: `<command>`", or start it "HUMAN:"')
      continue
    }
    if (trimmed.startsWith('- [')) {
      at(line, 'a criterion is "- [ ] <text> — check: `<command>`"')
      continue
    }
    if (!current.title) current.title = trimmed
    else context.push(trimmed)
  }
  close()
  closeGroup()
  return { entries, groups }
}

/** Pure. Parse one DESIGN.md. Never throws; problems carry 1-based lines. */
export function parseSpec(text, { file = 'DESIGN.md' } = {}) {
  const problems = []
  const at = (line, problem) => problems.push({ file, line, problem })
  const lines = normalise(text).split('\n')

  let title = ''
  let titleFound = false
  let sawHeading = false
  let fenceOpen = false
  let highestIndex = -1
  let current = null
  let body = []
  const sections = {}
  const sectionRows = { Decisions: [], 'Open questions': [], Plan: [] }

  const closeSection = () => {
    if (current) sections[current].body = body.join('\n').trim()
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNo = i + 1

    if (FENCE.test(line)) {
      fenceOpen = !fenceOpen
      if (current) body.push(line)
      continue
    }
    if (fenceOpen) {
      if (current) body.push(line)
      continue
    }

    const heading = /^## (.*)$/.exec(line)
    if (heading) {
      closeSection()
      sawHeading = true
      const name = heading[1].trim()
      current = null
      body = []
      if (!SECTIONS.includes(name)) {
        at(lineNo, 'an unknown section "' + name + '"')
        continue
      }
      if (sections[name]) {
        at(lineNo, 'a second ' + name + ' section')
        continue
      }
      const idx = SECTIONS.indexOf(name)
      if (idx < highestIndex) at(lineNo, 'the ' + name + ' section is out of order')
      highestIndex = Math.max(highestIndex, idx)
      sections[name] = { line: lineNo, body: '' }
      current = name
      continue
    }

    if (!titleFound && !sawHeading && /^# /.test(line)) {
      title = line.slice(2).trim()
      titleFound = true
      continue
    }

    if (current) {
      body.push(line)
      if (sectionRows[current]) sectionRows[current].push({ text: line, line: lineNo })
    }
  }
  closeSection()

  if (!titleFound) at(1, 'the spec has no title: start it with "# <title>"')
  for (const name of SECTIONS) if (!sections[name]) at(1, 'the spec is missing its ' + name + ' section')

  const decisions = parseDecisions(sectionRows.Decisions, at)
  const questions = parseQuestions(sectionRows['Open questions'], at)
  const { entries, groups } = parsePlan(sectionRows.Plan, at)

  return { file, title, sections, decisions, questions, entries, groups, problems }
}

/**
 * Pure. The problems of one parsed spec in its place in the effort (see docs/DESIGN.md#storage):
 * decision ids and their prefix, what each entry realises and waits for, names, keys per kind,
 * a planner-written spec's lack of decisions, and — when the effort's contracts are known — what
 * each entry consumes.
 */
export function checkSpec(spec, { folderId = ROOT_ID, definedAbove = new Set(), authoredBy = 'you', contracts } = {}) {
  const out = []
  const at = (line, problem) => out.push({ file: spec.file, line, problem })
  const prefix = folderId === ROOT_ID ? '' : folderId.split('/').join('.') + '.'
  const idRule = new RegExp('^' + prefix.replace(/\./g, '\\.') + 'D[1-9][0-9]*$')

  const own = new Set()
  for (const d of spec.decisions) {
    if (!idRule.test(d.id)) at(d.line, 'decision id ' + d.id + ' should be ' + prefix + 'D<n> in this folder')
    if (own.has(d.id)) at(d.line, 'decision ' + d.id + ' is defined twice')
    own.add(d.id)
  }
  if (authoredBy === 'planner' && spec.decisions.length) {
    at(spec.decisions[0].line, 'a planner-written spec states no decisions — a decision is the user\'s (IL4)')
  }

  const groups = spec.groups || []
  const names = new Set()
  for (const e of [...groups, ...spec.entries]) {
    if (safeSlug(e.name) !== e.name) at(e.line, 'the name "' + e.name + '" breaks the segment rule: lower-case letters, digits and single dashes')
    else if (names.has(e.name)) at(e.line, 'a second entry or group named ' + e.name)
    names.add(e.name)
  }
  const provided = new Set(spec.entries.flatMap((e) => e.provides.map((c) => c.name)))
  const checkAfter = (e) => {
    for (const a of e.after) {
      if (a.startsWith('/')) {
        if (a === '/' || nodeIdProblem(a.slice(1))) at(e.line, e.name + ' waits for ' + a + ', which is not a path of folder names')
      } else if (a === e.name || a === e.group) at(e.line, e.name + ' waits for ' + (a === e.name ? 'itself' : 'its own group'))
      else if (!names.has(a)) at(e.line, e.name + ' waits for ' + a + ', which is no entry or group of this plan (a path from the root folder starts with /)')
    }
  }

  for (const g of groups) {
    checkAfter(g)
    for (const a of g.after) {
      if (spec.entries.some((e) => e.name === a && e.group === g.name)) at(g.line, 'group ' + g.name + ' waits for ' + a + ', a task inside it')
    }
    if (!spec.entries.some((e) => e.group === g.name && e.kind === 'task')) at(g.line, 'group ' + g.name + ' holds no task')
  }
  for (const e of spec.entries) {
    for (const id of e.realises) {
      if (!own.has(id) && !definedAbove.has(id)) at(e.line, e.name + ' realises ' + id + ', which neither this spec nor an ancestor defines')
    }
    checkAfter(e)
    if (e.group && e.kind === 'sub-effort') at(e.line, 'a group holds tasks, and ' + e.name + ' is a sub-effort — move it above the first group')
    for (const key of TASK_ONLY) if (e.kind !== 'task' && e.given.includes(key)) at(e.line, key + ' is a task\'s field, and ' + e.name + ' is a ' + e.kind)
    for (const key of SUB_EFFORT_ONLY) if (e.kind !== 'sub-effort' && e.given.includes(key)) at(e.line, key + ' is a sub-effort\'s field, and ' + e.name + ' is a ' + e.kind)
    if (e.kind === 'task' && e.criteria.length === 0) at(e.line, 'task ' + e.name + ' needs at least one criterion')
    if (e.kind !== 'task') for (const c of e.criteria) at(c.line, 'only a task has criteria')
    for (const p of declarationProblems(spec, e)) at(p.line, p.problem)
    if (contracts) {
      for (const c of e.consumes) {
        if (!provided.has(c.name) && !contracts.has(c.name)) at(e.line, e.name + ' consumes ' + c.name + ', which no entry of this effort provides')
      }
    }
  }
  return out
}

/** Pure. A spec's Design body, trimmed; '' when it has none. */
const designBody = (spec) => (spec && spec.sections && spec.sections.Design ? spec.sections.Design.body.trim() : '')

/**
 * Pure. A Design body's parts: each `###` or `####` heading outside a fence, and its text from the
 * heading line to the next heading at its level or above.
 */
function designParts(body) {
  const lines = normalise(body).split('\n')
  const heads = []
  let fence = false
  lines.forEach((line, at) => {
    if (FENCE.test(line)) fence = !fence
    const h = fence ? null : /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) heads.push({ at, level: h[1].length, heading: h[2].trim() })
  })
  return heads.filter((h) => h.level >= 3).map((h) => {
    const next = heads.find((o) => o.at > h.at && o.level <= h.level)
    return { heading: h.heading, text: lines.slice(h.at, next ? next.at : lines.length).join('\n').trim() }
  })
}

const partKey = (s) => String(s).toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim()

/**
 * Pure. The one part of `parts` (`designParts`) a declared `name` resolves to: the part whose heading
 * is the name, else the part whose heading starts with it before a space or a bracket; case, markup
 * and spacing ignored. `{part}`, or `{problem}`: `none` when no heading answers, `many` when more than
 * one does. It never guesses past that.
 */
export function designPart(parts, name) {
  const key = partKey(name)
  const exact = key ? parts.filter((p) => partKey(p.heading) === key) : []
  const found = exact.length || !key ? exact
    : parts.filter((p) => [' ', '(', '['].some((b) => partKey(p.heading).startsWith(key + b)))
  return found.length === 1 ? { part: found[0] } : { problem: found.length ? 'many' : 'none' }
}

/** Pure. Why `name` resolves to no one part of `design`, as the end of a refusal; '' when it resolves. */
function partProblem(design, name) {
  if (!design) return ', and this spec\'s Design is empty'
  const r = designPart(designParts(design), name)
  if (r.part) return ''
  return r.problem === 'many'
    ? ', which more than one ### or #### heading of this spec\'s Design answers to: quote the one you mean whole'
    : ', which no ### or #### heading of this spec\'s Design answers to'
}

/**
 * Pure. What a task's `cites` declares of its spec's Design, resolved: `parts`, the whole Design as
 * one part (heading '') when it cites `Design`, else each quoted part once, in order; `problems`, a
 * sentence for each citation the Design cannot answer. An executor's worktree holds no spec, so its
 * brief carries these parts. Nothing in the entry's prose is read as a citation.
 */
export function citedDesign(spec, entry) {
  const design = designBody(spec)
  const cites = entry.cites || []
  const why = ' — its executor reads no spec but what its brief carries'
  if (cites.some((c) => c.whole)) {
    return design ? { parts: [{ heading: '', text: design }], problems: [] }
      : { parts: [], problems: [entry.name + ' cites this spec\'s Design, which is empty' + why] }
  }
  const all = designParts(design)
  const parts = []
  const problems = []
  for (const c of cites) {
    const r = designPart(all, c.part)
    if (r.part && !parts.includes(r.part)) parts.push(r.part)
    if (!r.part) problems.push(entry.name + ' cites "' + c.part + '"' + partProblem(design, c.part) + why)
  }
  return { parts, problems }
}

/** The spec of a folder as compile last kept it, else as it stands: a `specAt` for `ownerEntry`. */
function keptSpecAt(repo, effort) {
  const compiled = readLog(repo, effort, 'ledger').entries.filter((l) => l.kind === 'compiled')
  return (folder) => {
    const line = compiled.findLast((l) => l.folder === folder)
    try {
      if (line) return parseSpec(readFileSync(specCopyPath(repo, effort, folder, line.hash), 'utf8'), { file: fileOf(repo, effort, folder) })
    } catch {
      // No intact copy kept: the spec as it stands.
    }
    return readSpecAt(repo, effort, folder)
  }
}

/**
 * What the entry that made `id` cites of its spec's Design (`citedDesign`), read from the text
 * compile last kept for that folder, else the spec as it stands: `{file, parts, problems}`, or null
 * when no spec's entry makes `id`.
 */
export function designCitedBy(repo, effort, id) {
  const owner = ownerEntry(id, keptSpecAt(repo, effort))
  if (!owner || !owner.spec || !owner.entry) return null
  return { file: owner.spec.file, ...citedDesign(owner.spec, owner.entry) }
}

/**
 * Pure. The Design part `spec`'s entries declare for contract `name`: '' — the whole Design — when
 * none declares one, or when its providers here declare different parts.
 */
export function declaredPart(spec, name) {
  const parts = new Set(spec.entries.flatMap((e) => e.provides.filter((c) => c.name === name).map((c) => c.part || '')))
  return parts.size === 1 ? [...parts][0] : ''
}

/**
 * Pure. What defines contract `name` in a spec, as one string to compare across two texts of it:
 * every entry that provides it with its paths, and the Design part `part` declares, or the whole
 * Design when `part` is ''. Compile reads both texts under the current declaration. Null when the
 * text holds no one part `part` resolves to, which never equals a text that does.
 */
export function contractDefinition(spec, name, part = '') {
  const providers = spec.entries.flatMap((e) => e.provides.filter((c) => c.name === name).map((c) => ({ entry: e.name, paths: [...c.paths].sort() })))
    .sort((a, b) => (a.entry < b.entry ? -1 : 1))
  const design = designBody(spec)
  if (!part) return JSON.stringify({ providers, text: design })
  const found = designPart(designParts(design), part)
  return found.part ? JSON.stringify({ providers, text: found.part.text }) : null
}

/** Pure. A spec's entries' declarations of its Design that do not resolve: each task's `cites`, and each declared contract part. */
function declarationProblems(spec, entry) {
  const design = designBody(spec)
  const lineOf = (key) => (entry.fieldLines && entry.fieldLines[key]) || entry.line
  const out = entry.kind === 'task' ? citedDesign(spec, entry).problems.map((problem) => ({ line: lineOf('cites'), problem })) : []
  for (const c of entry.provides.filter((x) => x.part)) {
    const why = partProblem(design, c.part)
    if (why) out.push({ line: lineOf('provides'), problem: entry.name + ' provides ' + c.name + ' "' + c.part + '"' + why })
  }
  return out
}

/** Pure. The node id compile gives an entry of `folder`'s plan: under its group when it has one. */
export const entryId = (folder, e) => childOf(folder, e.group ? e.group + '/' + e.name : e.name)

/**
 * Pure. Where the entry that makes `id` lives: `{folder, spec, entry}`. The folder is the parent,
 * or the grandparent when the parent is a group of the grandparent's plan (a group has no spec of
 * its own). `spec` is null when that folder has none; `entry` is null when no entry names `id`.
 * `specAt(folderId)` returns a parsed spec or null.
 */
export function ownerEntry(id, specAt) {
  const parent = parentOf(id)
  if (parent === null) return null
  const name = id.slice(id.lastIndexOf('/') + 1)
  const direct = specAt(parent)
  if (direct) return { folder: parent, spec: direct, entry: direct.entries.find((e) => e.name === name && !e.group) || null }
  const grand = parentOf(parent)
  const up = grand === null ? null : specAt(grand)
  const group = parent.slice(parent.lastIndexOf('/') + 1)
  if (up && (up.groups || []).some((g) => g.name === group)) {
    return { folder: grand, spec: up, entry: up.entries.find((e) => e.name === name && e.group === group) || null }
  }
  return { folder: parent, spec: null, entry: null }
}

/** Pure. The folders above `id` that hold its specs, nearest first, groups skipped. */
function folderAncestorsOf(id, specAt) {
  const out = []
  for (let at = id; at !== ROOT_ID;) {
    at = ownerEntry(at, specAt).folder
    out.push(at)
  }
  return out
}

const readSpecAt = (repo, effort, id) => {
  try {
    return parseSpec(readFileSync(specPath(repo, effort, id), 'utf8'), { file: fileOf(repo, effort, id) })
  } catch {
    return null
  }
}
const fileOf = (repo, effort, id) => posix(relative(mainCheckout(repo), specPath(repo, effort, id)))

// The sections of an ancestor spec a review of a folder below it takes as settled.
const SETTLED = ['Intent', 'Decisions', 'Design']

/** The effort and folder whose spec `artifact` is, under `.agentics/`; null for any other file. */
export function specFolderOf(repo, artifact) {
  const rel = relative(agenticsRoot(repo), resolve(String(artifact || '')))
  const parts = posix(rel).split('/')
  if (rel === '' || isAbsolute(rel) || parts[0] === '..' || parts.length < 2 || parts.at(-1) !== SPEC_FILE) return null
  const [effort, ...dirs] = parts.slice(0, -1)
  const folder = dirs.length ? dirs.join('/') : ROOT_ID
  return safeSlug(effort) && !nodeIdProblem(folder) ? { effort, folder } : null
}

/**
 * The settled context of the folder whose spec `artifact` is: every spec above it, nearest first,
 * each one's `file` and its Intent, Decisions and Design bodies; `unread` names an ancestor folder
 * whose spec could not be read. Null when `artifact` is no folder's spec under `.agentics/`, the
 * root's included, which has no ancestors.
 */
export function settledContext(repo, artifact) {
  const of = specFolderOf(repo, artifact)
  if (!of) return null
  const { effort, folder: folderId } = of
  const specAt = (id) => readSpecAt(repo, effort, id)
  const specs = []
  const unread = []
  for (const up of folderAncestorsOf(folderId, specAt)) {
    const spec = specAt(up)
    if (!spec) unread.push(up)
    else specs.push({ folder: up, file: fileOf(repo, effort, up), ...Object.fromEntries(SETTLED.map((n) => [n.toLowerCase(), spec.sections[n] ? spec.sections[n].body : ''])) })
  }
  return { effort, folder: folderId, specs, unread }
}

/** Every contract the effort's entries provide, by name, each provider as compile would build it
 * (`{id, paths}`), walking every spec reachable from the root. A deferred or dropped entry builds
 * nothing and provides nothing. */
function providersOf(repo, effort) {
  const out = new Map()
  const walk = (folder) => {
    const spec = readSpecAt(repo, effort, folder)
    if (!spec) return
    for (const e of spec.entries) {
      if ((e.kind !== 'sub-effort' && e.kind !== 'task') || safeSlug(e.name) !== e.name || (e.group && !safeSlug(e.group))) continue
      const id = entryId(folder, e)
      for (const c of e.provides) out.set(c.name, [...(out.get(c.name) || []), { id, paths: c.paths }])
      walk(id)
    }
  }
  walk(ROOT_ID)
  return out
}

/** Pure. Compile's effort-wide contract rule (`contractProblems`), as problems at the entries of `spec`. */
function providerProblems(spec, folderId, providers) {
  const lineOf = new Map(spec.entries.map((e) => [entryId(folderId, e), e.line]))
  return [...providers].flatMap(([name, list]) => contractProblems(name, list))
    .filter((p) => lineOf.has(p.id)).map((p) => ({ file: spec.file, line: lineOf.get(p.id), problem: p.problem }))
}

/** A task entry mapped to the leaf node compile would build from it, id and all. Shared with
 * `lib/compile.mjs`, so a draft entry is judged by the same shape compile writes. */
export const leafOf = (id, e) => ({
  id, kind: 'leaf', title: e.title, intent: e.title, context: e.context, decisions: e.realises,
  acceptance: e.criteria.map((c) => ({ text: c.text, check: c.check, decisions: e.realises })),
  rigor: e.rigor, role: e.role, expects: e.expects, reads: e.reads, runs: e.runs, ground: e.ground,
  provides: e.provides, consumes: e.consumes, dispatch: e.dispatch, deps: e.after, label: e.label,
})

/** A sub-effort entry mapped to the design node compile would build from it, id and all. */
export const designOf = (id, e) => ({
  id, kind: 'design', title: e.title, intent: e.title, context: e.context, author: e.author,
  decisions: e.realises, provides: e.provides, consumes: e.consumes, ground: e.ground,
  ground_known: e.ground.length > 0, shared: e.shared, deps: e.after, label: e.label,
})

/** A group of a plan mapped to the group node compile would build from it. */
export const groupOf = (id, g) => ({
  id, kind: 'group', title: g.title, intent: g.title, context: g.context, deps: g.after,
  decisions: [], provides: [], consumes: [],
})

/** Every entry compile would map to a node (a sub-effort or a task; a deferred or dropped entry
 * builds nothing), checked the way compile's node validation would refuse it: a missing or
 * unknown rigor, a role that does not fit its rigor, and the rest of
 * `nodeProblems`. Catching this at the Draft gate means a slip here is an edit, not a re-review. */
function entryNodeProblems(folderId, entries) {
  const out = []
  for (const e of entries) {
    if (e.kind !== 'sub-effort' && e.kind !== 'task') continue
    if (e.group && !safeSlug(e.group)) continue
    const id = entryId(folderId, e)
    const shape = e.kind === 'task' ? leafOf(id, e) : designOf(id, e)
    // consumes and deps are resolved against the rest of the effort only at compile time (a
    // consumed contract's paths come from its provider; a dep is filled in with its neighbour's
    // full id); checkSpec already checks both at the entry level (contracts known, sibling names,
    // self-deps), so they are dropped here rather than judged against their unresolved shape.
    const node = normalizeNode({ ...shape, consumes: [], deps: [] })
    for (const p of nodeProblems(node)) out.push({ line: e.line, problem: p })
    if (node.kind === 'leaf') {
      const fit = roleFitsRigor(node)
      if (fit) out.push({ line: e.line, problem: fit })
    }
  }
  return out
}

/**
 * One folder's spec, parsed and checked in its place: the decisions its ancestors define, who
 * authored it (the parent entry naming the folder: a sub-effort's `author`, or the planner for a
 * promoted task), every contract the effort provides, and every decision it defines realised by
 * one of its entries.
 */
export function checkFolder(repo, effort, folderId) {
  const file = safeSlug(effort) ? fileOf(repo, effort, folderId) : ''
  const out = { folder: folderId, file, exists: false, text: '', hash: '', spec: null, authoredBy: 'you', entry: null, problems: [] }
  const idProblem = folderId === ROOT_ID ? null : nodeIdProblem(folderId)
  if (!safeSlug(effort) || idProblem) {
    out.problems.push({ file, line: 0, problem: idProblem || 'not an effort name: ' + JSON.stringify(effort) })
    return out
  }
  try {
    out.text = readFileSync(specPath(repo, effort, folderId), 'utf8')
  } catch {
    out.problems.push({ file, line: 0, problem: 'there is no ' + file })
    return out
  }
  out.exists = true
  out.hash = hashSpec(out.text)
  out.spec = parseSpec(out.text, { file })

  const specAt = (id) => readSpecAt(repo, effort, id)
  const definedAbove = new Set()
  for (const up of folderAncestorsOf(folderId, specAt)) {
    const above = specAt(up)
    if (!above) out.problems.push({ file, line: 0, problem: 'the ancestor folder ' + up + ' has no readable spec' })
    else for (const d of above.decisions) definedAbove.add(d.id)
  }
  if (folderId !== ROOT_ID) {
    const { entry } = ownerEntry(folderId, specAt)
    if (entry && entry.kind === 'sub-effort') [out.authoredBy, out.entry] = [entry.author, entry]
    else if (entry && entry.kind === 'task') [out.authoredBy, out.entry] = ['planner', entry]
    else out.problems.push({ file, line: 1, problem: 'no sub-effort or task entry of the parent spec names this folder' })
  }

  const providers = providersOf(repo, effort)
  out.problems.push(...out.spec.problems,
    ...checkSpec(out.spec, { folderId, definedAbove, authoredBy: out.authoredBy, contracts: new Set(providers.keys()) }),
    ...providerProblems(out.spec, folderId, providers),
    ...unrealisedProblems(out.spec),
    ...entryNodeProblems(folderId, out.spec.entries).map(({ line, problem }) => ({ file, line, problem })),
    ...runsProblems(repo, effort, out.spec))
  return out
}

/** A project script a text names: `npm run <script>`, and the same through pnpm or yarn. */
const SCRIPT = /\b(?:npm|pnpm|yarn)\s+run\s+([\w:.-]+)/g
/** A recipe an entry may read: a skill or a command of the project's own. */
const RECIPE = /(^|\/)\.claude\/(skills\/[^/]+\/SKILL|commands\/[^/]+)\.md$/

/** The first script a recipe's fenced shell blocks run: the command it is the recipe for. */
function recipeScript(repo, path) {
  let text = ''
  try {
    text = readFileSync(resolve(mainCheckout(repo), path), 'utf8')
  } catch {
    return ''
  }
  let fenced = false
  for (const line of normalise(text).split('\n')) {
    if (FENCE.test(line)) {
      fenced = !fenced
      continue
    }
    const m = fenced ? new RegExp(SCRIPT.source).exec(line) : null
    if (m) return m[1]
  }
  return ''
}

/**
 * The project scripts each task's work names and its `runs` does not list: every `npm run <script>`
 * its title or context names, and the script of each recipe it reads (`recipeScript`), less the
 * effort's established commands and its own criterion checks, which its role runs already. A
 * producer is denied a command `runs` lacks, so the gap is caught where the spec is written.
 */
function runsProblems(repo, effort, spec) {
  const scriptsOf = (text) => [...String(text || '').matchAll(SCRIPT)].map((m) => m[1])
  const commands = commandsOf(repo, effort)
  const given = new Set(['build', 'typecheck', 'suite', 'suite_fast', 'test_one'].flatMap((k) => scriptsOf(commands[k])))
  return spec.entries.filter((e) => e.kind === 'task').flatMap((e) => {
    const listed = new Set([...e.runs.flatMap(scriptsOf), ...e.criteria.flatMap((c) => scriptsOf(c.check)), ...given])
    const named = [
      ...scriptsOf([e.title, e.context].join('\n')).map((s) => ({ s, from: 'its text' })),
      ...e.reads.filter((r) => RECIPE.test(posix(r))).map((r) => ({ s: recipeScript(repo, r), from: r })).filter((x) => x.s),
    ]
    const seen = new Set()
    return named.filter((x) => !listed.has(x.s) && !seen.has(x.s) && seen.add(x.s)).map((x) => ({
      file: spec.file, line: e.line,
      problem: e.name + ' runs `npm run ' + x.s + '` (named in ' + x.from + '), which its runs does not list: add it to runs, or its producer is denied it',
    }))
  })
}

/** The entry kinds that realise what they list: the frontier (a sub-effort, a task, promoted or
 *  not) realises it, and a dropped entry gives it up, which counts as accepted. A deferred entry
 *  realises nothing yet. */
const REALISING = ['sub-effort', 'task', 'dropped']

/** Pure. Every decision the spec defines is realised by one of its own entries, or it is refused at its row. */
function unrealisedProblems(spec) {
  const realised = new Set(spec.entries.filter((e) => REALISING.includes(e.kind)).flatMap((e) => e.realises))
  return spec.decisions.filter((d) => !realised.has(d.id)).map((d) => ({
    file: spec.file, line: d.line,
    problem: 'decision ' + d.id + ' is realised by no entry of this plan — list it under realises on a sub-effort or a task, or on a dropped entry to give it up',
  }))
}

/** The flags this CLI takes, each by its kind: a skill's session passes handles only (`handleArgs`). */
const FLAGS = {
  '--repo': 'path', '--effort': 'handle', '--folder': 'handle',
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  try {
    const argv = process.argv.slice(2)
    const bad = handleArgs(argv, FLAGS, { from: 1 })
    if (bad) {
      console.log(JSON.stringify({ error: bad.message, kind: bad.kind }))
      process.exit(1)
    }
    if (argv[0] !== 'check') throw new Error('usage: spec.mjs check --repo <repo> --effort <effort> --folder <id>')
    const folder = flagOf(argv, 'folder') || ROOT_ID
    const checked = checkFolder(flagOf(argv, 'repo') || '.', flagOf(argv, 'effort'), folder)
    console.log(JSON.stringify(envelope({ folder, problems: checked.problems })))
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
