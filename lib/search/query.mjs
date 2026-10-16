// lib/search/query.mjs — the one query dialect: a pattern as a navigator or a judge writes it, made
// into what `git grep -E` runs, or refused with the reason.
//
// Design: docs/DESIGN.md#searches and docs/DESIGN.md#items-and-anchors.
//
// git's -E is POSIX: it reads `\d` as a plain `d`, so a query written in JavaScript's dialect
// matches nothing and an absence resting on it reads as proven. Whatever has a POSIX form is
// transpiled; whatever has none is refused, never passed through.
//
// The same module owns the one glob dialect and the one fence: pathKey, globOf, fenced.

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

/** The dialect in one sentence, embedded in the files, grep and dismissal descriptions. */
export const GLOB_RULES = 'Globs: * matches within one path segment, ** matches whole segments across directories, ? matches one character; every other character, brackets included, is literal.'

/** Pure. A repo-relative posix key: backslashes to '/', leading './' segments and trailing '/' dropped; '' becomes '.'. */
export function pathKey(p) {
  return String(p).replace(/\\/g, '/').replace(/^(?:\.\/+)+/, '').replace(/\/+$/, '') || '.'
}

/** Pure. Whether a key lies in a fenced directory: the store or the worktrees, or under either. */
export function fenced(key) {
  return key === AGENTICS_DIR || key.startsWith(AGENTICS_DIR + '/') || key === '.claude/worktrees' || key.startsWith('.claude/worktrees/')
}

/** Pure. Whether a path part holds a wildcard. */
export const isGlob = (part) => /[*?]/.test(part)

/** Pure. One glob segment as a RegExp source: `*` stays in the segment, `?` is one character, the rest is literal. */
const segmentRe = (seg) => seg.replace(/\*+|\?|[.+^${}()|[\]\\]/g, (c) => (c === '?' ? '[^/]' : c[0] === '*' ? '[^/]*' : '\\' + c))

/**
 * Pure. The search glob dialect: `*` within a segment, `**` a whole segment crossing directories, `?` one
 * character, everything else literal (brackets, braces, backslash included). `re` matches whole keys;
 * `base` is the longest leading run of segments without a wildcard ('.' when none); `total`: the glob is
 * exactly `<base>/**` (or `**`).
 */
export function globOf(glob) {
  const given = String(glob)
  const segments = given.split('/')
  let re = ''
  segments.forEach((seg, i) => {
    const last = i === segments.length - 1
    if (seg === '**') re += last ? '.*' : '(?:[^/]+/)*'
    else re += segmentRe(seg) + (last ? '' : '/')
  })
  const run = segments.findIndex(isGlob)
  const base = (run < 0 ? segments : segments.slice(0, run)).join('/') || '.'
  return { re: new RegExp('^' + re + '$', 'u'), base, total: given === (base === '.' ? '**' : base + '/**') }
}

/** Pure. Whether a key lies in one path part: a glob part matches whole keys, any other is a file or a directory. */
export function within(key, part) {
  const p = pathKey(part)
  if (p === '.') return true
  return isGlob(p) ? globOf(p).re.test(key) : key === p || key.startsWith(p + '/')
}

/** Pure. A path part as the literal pathspec that enumerates it: a glob part through its base. */
const pathspecOf = (p) => ':(literal)' + (isGlob(p) ? globOf(p).base : p)

/** Pure. One query in the shared dialect: what git runs, its flags, pathspecs and identity; or why it cannot run. */
export function queryOf({ pattern, fixed = false, ignore_case = false, paths = [] }) {
  const given = String(pattern)
  if (given.includes('\0') || paths.some((p) => String(p).includes('\0'))) return refused('a NUL byte')
  const made = fixed ? { ok: true, pattern: given } : transpile(given)
  if (!made.ok) return made
  const parts = paths.map(pathKey)
  return {
    ok: true,
    pattern: made.pattern,
    flags: [fixed ? '-F' : '-E', ...(ignore_case ? ['-i'] : [])],
    pathspecs: [...(parts.length ? new Set(parts.map(pathspecOf)) : ['.']), ':(exclude)' + AGENTICS_DIR],
    filters: parts.some(isGlob) ? parts.filter(isGlob).map((p) => globOf(p).re) : null,
    key: JSON.stringify({ pattern: given, fixed, ignore_case, paths: [...paths].sort() }),
  }
}

/** Pure. The git arguments after `git -C <root>` that run `query` in one output mode; `text` keeps binary files' matches. */
export function grepArgv(query, mode, { text = false } = {}) {
  if (!Object.hasOwn(MODES, mode)) throw new Error('no grep output mode ' + JSON.stringify(mode))
  return ['grep', MODES[mode], '-z', text ? '--text' : '-I', '--untracked', ...query.flags, '-e', query.pattern, '--', ...query.pathspecs]
}

// ------------------------------------------------------------------ web keys

const paramName = (part) => {
  const name = part.split('=')[0]
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}
const TRACKING = (part) => /^utm_/i.test(paramName(part)) || /^(gclid|fbclid)$/i.test(paramName(part))

/** Pure. A web key: scheme and host lowercased; default port, fragment, trailing '/' and tracking parameters dropped. */
export function canonicalUrl(url) {
  const raw = String(url ?? '').trim()
  let u
  try {
    u = new URL(raw)
  } catch {
    return raw
  }
  const query = u.search.replace(/^\?/, '').split('&').filter((part) => part !== '' && !TRACKING(part))
  const path = u.pathname.replace(/\/+$/, '')
  return u.protocol + '//' + u.host + path + (query.length ? '?' + query.join('&') : '')
}

/** Pure. A candidate's key: its canonical source URL, else its name lowercased, owner or @scope dropped, punctuation collapsed. */
export function candidateKey({ name = '', source_url = '' } = {}) {
  if (String(source_url).trim() !== '') return canonicalUrl(source_url)
  return String(name).trim().toLowerCase().replace(/^@?[^/\s]+\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
