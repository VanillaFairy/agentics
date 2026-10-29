// lib/briefs/size.mjs — a brief's parts, and the one check of their size before a brief is sent: a
// part past what one part may hold, or a brief past what its reader may read, is refused, naming the
// part. Nothing is ever cut from a brief or handed as a file to open in its place.
//
// Design: docs/DESIGN.md#the-agent-runner.

import { PART_BYTES } from '../roles.mjs'

/** A part of a brief: `{key, text}`, `key` what a refusal names it by. */

const SEPARATOR = '\n\n'
const bytes = (text) => Buffer.byteLength(text, 'utf8')

/** Pure. A brief's parts, joined as the reader reads them. */
export const joined = (parts) => parts.map((p) => p.text).join(SEPARATOR)

/**
 * Pure. A plain brief's parts: what comes before its first `## ` or `### ` heading, keyed `charge`,
 * then each section from such a heading on, keyed by the heading, the blank lines ending a part being
 * the separator `joined` puts back. A heading inside a `~~~~` or ```` ``` ```` fence is the fenced
 * text's, not the brief's.
 */
export function sectionsOf(text) {
  const parts = []
  let current = { key: 'charge', lines: [] }
  let fence = ''
  for (const line of String(text).split('\n')) {
    const mark = line.match(/^(~~~~|```)/)
    if (mark) fence = fence ? (line.startsWith(fence) ? '' : fence) : mark[1]
    if (!fence && !mark && /^#{2,3} /.test(line)) {
      if (current.lines.length) parts.push(current)
      current = { key: line.replace(/^#+ /, ''), lines: [] }
    }
    current.lines.push(line)
  }
  parts.push(current)
  return parts.map((p) => {
    const lines = [...p.lines]
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    return { key: p.key, text: lines.join('\n') }
  })
}

/**
 * Pure. Why `parts` may not be sent to a reader briefed with at most `room` bytes, or null when they
 * may: `{part, bytes, budget, message}`, the first part past `PART_BYTES`, else, the whole past
 * `room`, its largest part, whose budget is then what the room leaves beside the others.
 */
export function oversizedPart(parts, room) {
  const sized = parts.map((p) => ({ key: p.key, bytes: bytes(p.text) }))
  const refuse = (p, budget, why) => ({
    part: p.key, bytes: p.bytes, budget,
    message: 'the brief\'s part "' + p.key + '" is ' + p.bytes + ' bytes and may hold ' + budget + why,
  })
  const over = sized.find((p) => p.bytes > PART_BYTES)
  if (over) return refuse(over, PART_BYTES, ', what one part of a brief may')
  const whole = bytes(joined(parts))
  if (whole <= room || !sized.length) return null
  const largest = sized.reduce((a, b) => (b.bytes > a.bytes ? b : a))
  return refuse(largest, Math.max(0, room - (whole - largest.bytes)),
    ' beside the rest: the brief is ' + whole + ' bytes and its reader may be briefed with ' + room)
}
