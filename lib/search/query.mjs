// lib/search/query.mjs — the one query dialect: a pattern as a navigator or a judge writes it, made
// into what `git grep -E` runs, or refused with the reason.
//
// Design: docs/DESIGN.md#evidence.
//
// git's -E is POSIX: it reads `\d` as a plain `d`, so a query written in JavaScript's dialect
// matches nothing and an absence resting on it reads as proven. Whatever has a POSIX form is
// transpiled; whatever has none is refused, never passed through.

import { AGENTICS_DIR } from '../store.mjs'

/** The shorthand classes outside a bracket expression, as whole POSIX bracket expressions. */
const OUTSIDE = { d: '[[:digit:]]', D: '[^[:digit:]]', s: '[[:space:]]', S: '[^[:space:]]', w: '[[:alnum:]_]', W: '[^[:alnum:]_]' }
/** The shorthand classes inside one, as the classes they add to it. \D \S \W have no such form. */
const INSIDE = { d: '[:digit:]', s: '[:space:]', w: '[:alnum:]_' }
const QUANTIFIERS = new Set(['*', '+', '?', '}'])
const LETTER = /[A-Za-z]/
const MODES = { files: '-l', lines: '-n', count: '-c' }

const refused = (detail) => ({ ok: false, refusal: 'unsupported_syntax', detail })

/** Pure. A regex in the shared dialect as git -E reads it, or the refusal of its first unsupported token. */
function transpile(pattern) {
  let out = ''
  let bracket = false   // inside [...]
  let opened = 0        // where the bracket's members start: a ']' there is a member, not its end
  let quantified = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    const next = pattern[i + 1]
    if (c === '\\' && next !== undefined) {
      if (LETTER.test(next)) {
        const table = bracket ? INSIDE : OUTSIDE
        if (!Object.hasOwn(table, next)) return refused('\\' + next + (bracket ? ' inside brackets' : ''))
        out += table[next]
      } else {
        out += c + next
      }
      i++
      quantified = false
      continue
    }
    if (bracket) {
      if (c === '[' && next === ':') {
        const end = pattern.indexOf(':]', i + 2)
        if (end > 0) { out += pattern.slice(i, end + 2); i = end + 1; continue }
      }
      if (c === ']' && i > opened) bracket = false
      out += c
      continue
    }
    if (c === '[') {
      bracket = true
      opened = i + 1 + (next === '^' ? 1 : 0)
      out += c
      if (next === '^') { out += next; i++ }
      quantified = false
      continue
    }
    if (c === '(' && next === '?') return refused('(?')
    if (c === '?' && quantified) return refused('a lazy quantifier ' + pattern[i - 1] + '?')
    quantified = QUANTIFIERS.has(c)
    out += c
  }
  return { ok: true, pattern: out }
}

/** Pure. A repository-relative path as a pathspec: `**` makes it a glob, anything else is literal. */
const pathspecOf = (p) => (p.includes('**') ? ':(glob)' : ':(literal)') + p

/** Pure. One query in the shared dialect: what git runs, its flags, pathspecs and identity; or why it cannot run. */
export function queryOf({ pattern, fixed = false, ignore_case = false, paths = [] }) {
  const given = String(pattern)
  if (given.includes('\0') || paths.some((p) => String(p).includes('\0'))) return refused('a NUL byte')
  const made = fixed ? { ok: true, pattern: given } : transpile(given)
  if (!made.ok) return made
  return {
    ok: true,
    pattern: made.pattern,
    flags: [fixed ? '-F' : '-E', ...(ignore_case ? ['-i'] : [])],
    pathspecs: [...(paths.length ? paths.map(pathspecOf) : ['.']), ':(exclude)' + AGENTICS_DIR],
    key: JSON.stringify({ pattern: given, fixed, ignore_case, paths: [...paths].sort() }),
  }
}

/** Pure. The git arguments after `git -C <root>` that run `query` in one output mode; `text` keeps binary files' matches. */
export function grepArgv(query, mode, { text = false } = {}) {
  if (!Object.hasOwn(MODES, mode)) throw new Error('no grep output mode ' + JSON.stringify(mode))
  return ['grep', MODES[mode], '-z', text ? '--text' : '-I', '--untracked', ...query.flags, '-e', query.pattern, '--', ...query.pathspecs]
}
