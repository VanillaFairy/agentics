// tools/rules/no-loop-bounds.mjs — L2: a loop in a program or in lib/search ends on a state, never on a count.
//
// Design: docs/DESIGN.md#l2--states-end-work-counts-dont. A loop that stops after N rounds ends
// work on a counter, and what it leaves looks like a finished result. A program that wants to ask
// after N rounds calls `askAfter` (`lib/programs/converge.mjs`), which asks a ruler and never
// decides the answer.
//
// A finding is a loop whose condition, or an `if` inside its body that leaves it (`break`,
// `return`, `throw`), compares a counter the loop increments against a bound: a number, a
// SCREAMING_CASE name, or a name with a part `max`, `limit` or `cap`. A collection's `length` or
// `size` is not a bound, and a `for…of` or `for…in` loop has no counter. The match is textual over
// the source with comments and string contents blanked: a counter that is a property
// (`seen.round++`) is not seen.

export const id = 'no-loop-bounds'

export const applies = /^lib\/(programs\/.+|search\/[^/]+|run)\.mjs$/

/**
 * Replace the contents of strings and comments with spaces, preserving length and
 * newlines so line numbers survive. Delimiters are kept so brace scanning still sees
 * balanced structure outside them.
 */
function blankStringsAndComments(source) {
  const out = source.split('')
  let i = 0
  const n = source.length

  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '
  }

  while (i < n) {
    const c = source[i]
    const next = source[i + 1]

    if (c === '/' && next === '/') {
      let j = i + 2
      while (j < n && source[j] !== '\n') j++
      blank(i, j)
      i = j
      continue
    }

    if (c === '/' && next === '*') {
      let j = i + 2
      while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j++
      blank(i, Math.min(j + 2, n))
      i = j + 2
      continue
    }

    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < n) {
        if (source[j] === '\\') { j += 2; continue }
        if (source[j] === c) break
        j++
      }
      blank(i + 1, j)
      i = j + 1
      continue
    }

    i++
  }

  return out.join('')
}

const OPEN = '([{'
const CLOSE = ')]}'

/** Pure. The index of the bracket that closes the one at `at`, or -1. */
function closer(code, at) {
  let depth = 0
  for (let i = at; i < code.length; i++) {
    if (OPEN.includes(code[i])) depth++
    else if (CLOSE.includes(code[i]) && --depth === 0) return i
  }
  return -1
}

/** Pure. The index of the bracket that opens the one closing at `at`, or -1. */
function opener(code, at) {
  let depth = 0
  for (let i = at; i >= 0; i--) {
    if (CLOSE.includes(code[i])) depth++
    else if (OPEN.includes(code[i]) && --depth === 0) return i
  }
  return -1
}

/** Pure. `text` split on `sep` where no bracket is open. */
function splitTop(text, sep) {
  const parts = []
  let depth = 0
  let from = 0
  for (let i = 0; i < text.length; i++) {
    if (OPEN.includes(text[i])) depth++
    else if (CLOSE.includes(text[i])) depth--
    else if (text[i] === sep && depth === 0) { parts.push(text.slice(from, i)); from = i + 1 }
  }
  parts.push(text.slice(from))
  return parts
}

/** Pure. The span [from, to) of the statement starting at or after `at`: a block, or up to its `;`. */
function statementAt(code, at) {
  let i = at
  while (/\s/.test(code[i] || '')) i++
  if (code[i] === '{') return [i, closer(code, i) + 1]
  let depth = 0
  for (let j = i; j < code.length; j++) {
    if (OPEN.includes(code[j])) depth++
    else if (CLOSE.includes(code[j])) { if (--depth < 0) return [i, j] }
    else if ((code[j] === ';' || code[j] === '\n') && depth === 0) return [i, j + 1]
  }
  return [i, code.length]
}

const NAME = '[A-Za-z_$][\\w$]*'
const COMPARE = '(?:<=|>=|===|!==|==|!=|<|>)'

/** Pure. The names `text` increments or decrements: `n++`, `++n`, `n += k`, `n = n + k`. */
function countersIn(text) {
  const names = new Set()
  for (const m of text.matchAll(new RegExp('(?<![\\w$.])(' + NAME + ')\\s*(?:\\+\\+|--|\\+=|-=)', 'g'))) names.add(m[1])
  for (const m of text.matchAll(new RegExp('(?:\\+\\+|--)\\s*(' + NAME + ')', 'g'))) names.add(m[1])
  for (const m of text.matchAll(new RegExp('(?<![\\w$.])(' + NAME + ')\\s*=\\s*(' + NAME + ')\\s*[+-]', 'g'))) if (m[1] === m[2]) names.add(m[1])
  return names
}

/** Pure. Whether an operand is a bound: a number, a SCREAMING_CASE name, or a name with a max, limit or cap
 * part; a collection's `length` or `size` never is. */
function isBound(operand) {
  if (/^\d/.test(operand)) return true
  const segments = operand.split('.')
  if (['length', 'size'].includes(segments[segments.length - 1])) return false
  return segments.some((s) => /^[A-Z][A-Z0-9_]*$/.test(s) ||
    s.split(/_|(?<=[a-z0-9])(?=[A-Z])/).some((part) => ['max', 'limit', 'cap'].includes(part.toLowerCase())))
}

/** A number or a dotted name, taken whole; a name followed by `(` is a call, not a bound. */
const OPERAND = '(?<![\\w$.])(\\d[\\d_.]*|' + NAME + '(?:\\.' + NAME + ')*)(?![\\w$.]|\\s*\\()'

/** Pure. The counter of `counters` that `text` compares against a bound, or ''. */
function boundedCounter(text, counters) {
  for (const c of counters) {
    const after = new RegExp('(?<![\\w$.])' + c.replace(/\$/g, '\\$') + '\\s*' + COMPARE + '\\s*' + OPERAND, 'g')
    for (const m of text.matchAll(after)) if (isBound(m[1])) return c
    const before = new RegExp(OPERAND + '\\s*' + COMPARE + '\\s*' + c.replace(/\$/g, '\\$') + '(?![\\w$])', 'g')
    for (const m of text.matchAll(before)) if (isBound(m[1])) return c
  }
  return ''
}

const lineOf = (code, at) => code.slice(0, at).split('\n').length

/** Pure. The loops of `code` that have a condition: each one's condition, update, body and body offset. */
function loopsOf(code) {
  const loops = []
  for (const m of code.matchAll(/\b(for|while)\s*\(/g)) {
    const open = m.index + m[0].length - 1
    const close = closer(code, open)
    if (close === -1) continue
    const header = code.slice(open + 1, close)
    if (m[1] === 'for') {
      const parts = splitTop(header, ';')
      if (parts.length !== 3) continue // for…of, for…in
      const [from, to] = statementAt(code, close + 1)
      loops.push({ at: m.index, cond: parts[1], update: parts[2], bodyAt: from, body: code.slice(from, to) })
      continue
    }
    let back = m.index - 1
    while (back >= 0 && /\s/.test(code[back])) back--
    if (code[back] === '}') {
      const start = opener(code, back)
      let d = start - 1
      while (d >= 0 && /\s/.test(code[d])) d--
      if (code.slice(d - 1, d + 1) === 'do' && !/[\w$]/.test(code[d - 2] || '')) {
        loops.push({ at: m.index, cond: header, update: '', bodyAt: start, body: code.slice(start, back + 1) })
        continue
      }
    }
    const [from, to] = statementAt(code, close + 1)
    loops.push({ at: m.index, cond: header, update: '', bodyAt: from, body: code.slice(from, to) })
  }
  return loops
}

/** Pure. The `if`s in `body` whose branch leaves the loop at once: its test and its offset in `body`. */
function exitsOf(body) {
  const exits = []
  for (const m of body.matchAll(/\bif\s*\(/g)) {
    const open = m.index + m[0].length - 1
    const close = closer(body, open)
    if (close === -1) continue
    const [from] = statementAt(body, close + 1)
    const rest = body.slice(from).replace(/^\{\s*/, '')
    if (/^(break|return|throw)\b/.test(rest)) exits.push({ test: body.slice(open + 1, close), at: m.index })
  }
  return exits
}

/** Pure. What a finding says. */
const loopMessage = (counter) =>
  'this loop ends when `' + counter + '` reaches a bound: L2, a loop ends on a state, never on a count. ' +
  'To ask after N rounds, call askAfter (lib/programs/converge.mjs)'

/**
 * Pure. No filesystem, no other rules, no globals.
 * @param {string} source full file text
 * @returns {Array<{line: number, message: string}>}
 */
export function check(source) {
  const code = blankStringsAndComments(source)
  const violations = []
  for (const loop of loopsOf(code)) {
    const counters = new Set([...countersIn(loop.update), ...countersIn(loop.body)])
    if (counters.size === 0) continue
    const inCond = boundedCounter(loop.cond, counters)
    if (inCond) {
      violations.push({ line: lineOf(code, loop.at), message: loopMessage(inCond) })
      continue
    }
    for (const exit of exitsOf(loop.body)) {
      const c = boundedCounter(exit.test, counters)
      if (c) violations.push({ line: lineOf(code, loop.bodyAt + exit.at), message: loopMessage(c) })
    }
  }
  return violations
}
