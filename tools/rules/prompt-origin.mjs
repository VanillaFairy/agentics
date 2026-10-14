// tools/rules/prompt-origin.mjs — P2: every prompt comes from the brief modules.
//
// Design: docs/DESIGN.md#self-checks. A prompt is built only by `lib/brief.mjs`, `lib/briefs/` and
// `renderMessage` (`lib/conversation.mjs`), so no command or path for a model to carry reaches one
// from anywhere else. In a program or a boundary, a `brief`, `threadBrief`, `prompt` or `charge` property
// whose value is text made on the spot — a string literal, a template literal, a `+`
// concatenation — is a finding; so is a name the file binds to such text. A call, a member and an
// empty string are not text made on the spot. A conditional's branches and the operands of `||`,
// `??` and `&&` are each judged. The match is textual, over the source with comments and string
// contents blanked, and follows a name one binding deep (every binding of it in the file).
//
// Known limit: an array `[…].join(…)` is not seen. `lib/programs/rule.mjs` (the ruler's brief and
// the guidance) and `lib/programs/common.mjs` (a thread brief and its rendered messages) join the
// outputs of brief modules that way; text made on the spot inside such a join would pass.

export const id = 'prompt-origin'

export const applies = /^lib\/(programs|boundaries)\/.+\.mjs$/

/** The property names whose value is a prompt. */
const KEYS = ['brief', 'threadBrief', 'prompt', 'charge']

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

/** Pure. The expression starting at `at`: up to the first `,`, `;`, or unmatched closing bracket at depth 0. */
function expressionAt(code, at) {
  let depth = 0
  for (let i = at; i < code.length; i++) {
    if (OPEN.includes(code[i])) depth++
    else if (CLOSE.includes(code[i])) { if (--depth < 0) return code.slice(at, i) }
    else if ((code[i] === ',' || code[i] === ';') && depth === 0) return code.slice(at, i)
    else if (code[i] === '\n' && depth === 0 && !/^\s*[?:|&+.]/.test(code.slice(i + 1)) && !/[?:|&+=(,]\s*$/.test(code.slice(at, i))) return code.slice(at, i)
  }
  return code.slice(at)
}

/** Pure. The offsets in `text` where `token` stands at depth 0. */
function topLevel(text, token) {
  const at = []
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    if (OPEN.includes(text[i])) depth++
    else if (CLOSE.includes(text[i])) depth--
    else if (depth === 0 && text.startsWith(token, i)) at.push(i)
  }
  return at
}

/** Pure. The index of the bracket that closes the one at `at`, or -1. */
function closer(text, at) {
  let depth = 0
  for (let i = at; i < text.length; i++) {
    if (OPEN.includes(text[i])) depth++
    else if (CLOSE.includes(text[i]) && --depth === 0) return i
  }
  return -1
}

/** Pure. `text` without the parentheses that wrap all of it. */
function unwrap(text) {
  let t = text.trim()
  while (t.startsWith('(') && closer(t, 0) === t.length - 1) t = t.slice(1, -1).trim()
  return t
}

/** Pure. The operands a value is judged by: a conditional's branches, and the operands of `||`, `??`, `&&`. */
function operandsOf(value) {
  const t = unwrap(value)
  const q = topLevel(t, '?').filter((i) => t[i + 1] !== '.' && t[i + 1] !== '?' && t[i - 1] !== '?')
  if (q.length) {
    const colon = topLevel(t.slice(q[0] + 1), ':')[0]
    if (colon !== undefined) return [...operandsOf(t.slice(q[0] + 1, q[0] + 1 + colon)), ...operandsOf(t.slice(q[0] + 2 + colon))]
  }
  for (const op of ['||', '??', '&&']) {
    const at = topLevel(t, op)
    if (at.length) {
      const parts = []
      let from = 0
      for (const i of at) { parts.push(t.slice(from, i)); from = i + op.length }
      parts.push(t.slice(from))
      return parts.flatMap(operandsOf)
    }
  }
  return [t]
}

/** Pure. Whether one operand is text made on the spot. */
function madeText(operand) {
  if (/^['"]/.test(operand)) return !/^(''|"")$/.test(operand)
  if (operand.startsWith('`')) return true
  return topLevel(operand, '+').some((i) => operand[i + 1] !== '+' && operand[i + 1] !== '=' && operand[i - 1] !== '+' && i > 0)
}

const NAME = /^[A-Za-z_$][\w$]*$/

/** Pure. The expressions `code` binds `name` to: declarations, assignments and defaults. */
function bindingsOf(code, name) {
  const out = []
  for (const m of code.matchAll(new RegExp('(?<![\\w$.])' + name.replace(/\$/g, '\\$') + '\\s*=(?![=>])', 'g'))) {
    out.push(expressionAt(code, m.index + m[0].length))
  }
  return out
}

const lineOf = (code, at) => code.slice(0, at).split('\n').length

/**
 * Pure. No filesystem, no other rules, no globals.
 * @param {string} source full file text
 * @returns {Array<{line: number, message: string}>}
 */
export function check(source) {
  const code = blankStringsAndComments(source)
  const violations = []
  // `key: value`, `key = default` in a pattern, or a shorthand `key` standing for the name.
  const key = new RegExp('(?<=[{,]\\s*)(' + KEYS.join('|') + ')\\s*(:|=(?![=>])|(?=[,}]))', 'g')
  for (const m of code.matchAll(key)) {
    const value = m[2] === '' ? m[1] : expressionAt(code, m.index + m[0].length).trim()
    const judged = operandsOf(value).flatMap((o) => (NAME.test(o) ? bindingsOf(code, o).flatMap(operandsOf) : [o]))
    if (judged.some(madeText)) {
      violations.push({
        line: lineOf(code, m.index),
        message: 'the ' + m[1] + ' here is text made on the spot: P2, a prompt is built only by lib/brief.mjs, ' +
          'lib/briefs/ and renderMessage. Build it there and pass what that call returns',
      })
    }
  }
  return violations
}
