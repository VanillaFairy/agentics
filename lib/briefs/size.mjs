// lib/briefs/size.mjs — a brief's parts, who owns each, and the one check of their size before a brief
// is sent: a part past what one part may hold, or a brief past what its reader may read, is refused,
// naming the part and its owner. Nothing is ever cut from a brief or handed as a file to open in its
// place.
//
// Design: docs/DESIGN.md#the-agent-runner.

import { PART_BYTES } from '../roles.mjs'

/** A part of a brief: `{key, text, section?, file?}`, `key` what a refusal names it by. */

const SEPARATOR = '\n\n'
const bytes = (text) => Buffer.byteLength(text, 'utf8')

/**
 * Who can make a part of a brief smaller, by the `## ` section it sits under (`sectionsOf`) or a
 * shaped part's key. `work`: the leaf's own work, its task and what its entry cites, which its
 * planner splits or the user re-specs; a folder's spec. `user`: text only the user changes, where
 * `files` makes each `### <path>` under the section one file. Any other part is code's: code builds it
 * and bounds it as it builds it, so a refusal naming one is a defect of its builder. `embeds` keeps a
 * section open over the `## ` headings of the text it holds.
 */
const OWNERS = {
  Task: { owner: 'work' },
  'Acceptance criteria': { owner: 'work' },
  'Decisions realised': { owner: 'work' },
  'Expected files and reads': { owner: 'work' },
  'Spec Design': { owner: 'work', embeds: true },
  Consumes: { owner: 'work', embeds: true },
  'Effort files': { owner: 'work', embeds: true },
  Evidence: { owner: 'code' },
  Gotchas: { owner: 'code', embeds: true },
  Measures: { owner: 'work' },
  Commands: { owner: 'work' },
  Worktree: { owner: 'work' },
  'The spec as it stands': { owner: 'work', embeds: true },
  'The spec, your yardstick': { owner: 'work', embeds: true },
  'The spec as it now reads, your yardstick': { owner: 'work', embeds: true },
  'Plan entry': { owner: 'work' },
  'Repository guidance': { owner: 'user', files: true },
  'The change': { owner: 'user' },
  "The user's answers": { owner: 'user' },
  'The edit to the spec': { owner: 'user' },
  "The user's word on this folder": { owner: 'user' },
  'The specs of its sub-efforts': { owner: 'user', files: true },
  'The specs': { owner: 'user', files: true },
  artefact: { owner: 'user' },
}

/** Pure. Who can make `part` smaller: `work`, `user` or `code` (`OWNERS`). */
export const ownerOf = (part) => (OWNERS[part.section ?? part.key] || { owner: 'code' }).owner

/** Pure. Whether `heading` is a section `OWNERS` names. */
export const owned = (heading) => Object.hasOwn(OWNERS, heading)

const NL = String.fromCharCode(10)

/** What a declaration of a bound's drop may take of the bound. */
const DECLARATION_BYTES = 1024

/** Pure. `text`'s leading lines that fit `budget` bytes. */
function headOf(text, budget) {
  const kept = []
  let used = 0
  for (const line of String(text).split(NL)) {
    if (used + bytes(line) + 1 > budget) break
    kept.push(line)
    used += bytes(line) + 1
  }
  return kept.join(NL)
}

/**
 * Pure. What code builds of a part it owns, held to `budget` bytes: `items`, most valuable first,
 * joined by `joiner` while they fit, and when some do not, the first that does not cut to its leading
 * lines if none fit whole, then `declare(left)`, the line that says what was left out (L1). Nothing
 * built this way is refused.
 */
export function bounded(items, budget, declare, joiner = NL) {
  const room = Math.max(0, budget - DECLARATION_BYTES)
  const kept = []
  let used = 0
  for (const item of items) {
    const size = bytes(item) + (kept.length ? bytes(joiner) : 0)
    if (used + size > room) break
    kept.push(item)
    used += size
  }
  const left = items.slice(kept.length)
  if (!left.length) return kept.join(joiner)
  const head = kept.length ? '' : headOf(left[0], room)
  return [...kept, ...(head ? [head] : []), declare(left)].join(joiner)
}

/** Pure. A diff held to `budget` bytes: whole files in order while they fit, each file it left out named. */
export function boundedDiff(diff, budget) {
  const files = String(diff || '').trimEnd().split(/(?=^diff --git )/m).map((f) => f.trimEnd()).filter(Boolean)
  const name = (f) => (f.match(/^diff --git a\/(\S+)/) || [])[1] || '(a change without a file header)'
  return bounded(files, budget, (left) => '(left out to fit this brief: the change to ' + left.map(name).join(', ') + ', ' +
    left.reduce((n, f) => n + bytes(f), 0) + ' bytes; rule as though you could not see it)')
}

/** Pure. A brief's parts, joined as the reader reads them. */
export const joined = (parts) => parts.map((p) => p.text).join(SEPARATOR)

/**
 * Pure. `text` in a `~` fence longer than any run of tildes at the start of its lines: `sectionsOf`
 * keeps it one part, whatever headings it holds.
 */
export function fenced(text, info = '') {
  const longest = Math.max(3, ...(String(text).match(/^~+/gm) || []).map((run) => run.length))
  const fence = '~'.repeat(longest + 1)
  return fence + info + '\n' + text + '\n' + fence
}

/**
 * Pure. A plain brief's parts: what comes before its first `## ` or `### ` heading, keyed `charge`,
 * then each section from such a heading on, keyed by the heading, the blank lines ending a part being
 * the separator `joined` puts back. A heading inside a `~` or `` ` `` fence is the fenced text's, not
 * the brief's. Each part's `section` is the `## ` heading it sits under, kept open by an `embeds`
 * section over headings `OWNERS` does not name; a `### ` part under a `files` section is that `file`.
 */
export function sectionsOf(text) {
  const parts = []
  let current = { key: 'charge', section: 'charge', lines: [] }
  let section = 'charge'
  let fence = ''
  for (const line of String(text).split('\n')) {
    const mark = line.match(/^(~{4,}|`{3,})/)
    if (mark) fence = fence ? (line.startsWith(fence) ? '' : fence) : mark[1]
    if (!fence && !mark && /^#{2,3} /.test(line)) {
      if (current.lines.length) parts.push(current)
      const key = line.replace(/^#+ /, '')
      if (line.startsWith('## ') && (OWNERS[key] || !(OWNERS[section] && OWNERS[section].embeds))) section = key
      const files = line.startsWith('### ') && key !== section && OWNERS[section] && OWNERS[section].files
      current = { key, section, ...(files ? { file: key } : {}), lines: [] }
    }
    current.lines.push(line)
  }
  parts.push(current)
  return parts.map(({ lines: all, ...part }) => {
    const lines = [...all]
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    return { ...part, text: lines.join('\n') }
  })
}

/**
 * Pure. Why `parts` may not be sent to a reader briefed with at most `room` bytes, or null when they
 * may: `{part, owner, file, bytes, budget, whole, message}`, the first part past `PART_BYTES`, else,
 * the whole past `room` (`whole`), its largest part, whose budget is then what the room leaves beside
 * the others.
 * `owner` is who can make the part smaller (`ownerOf`); `file` the file it is, or ''.
 */
export function oversizedPart(parts, room) {
  const sized = parts.map((p) => ({ key: p.key, owner: ownerOf(p), file: p.file || '', bytes: bytes(p.text) }))
  const refuse = (p, budget, why, whole = false) => ({
    part: p.key, owner: p.owner, file: p.file, bytes: p.bytes, budget, whole,
    message: 'the brief\'s part "' + p.key + '"' + (p.file && p.file !== p.key ? ' (' + p.file + ')' : '') + ' is ' + p.bytes +
      ' bytes and may hold ' + budget + why,
  })
  const over = sized.find((p) => p.bytes > PART_BYTES)
  if (over) return refuse(over, PART_BYTES, ', what one part of a brief may')
  const whole = bytes(joined(parts))
  if (whole <= room || !sized.length) return null
  const largest = sized.reduce((a, b) => (b.bytes > a.bytes ? b : a))
  return refuse(largest, Math.max(0, room - (whole - largest.bytes)),
    ' beside the rest: the brief is ' + whole + ' bytes and its reader may be briefed with ' + room, true)
}
