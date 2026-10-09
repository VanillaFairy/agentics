// tools/rules/no-self-verdict.mjs — L3: no model sets its own verdict, and only a judge rules.
//
// Design: docs/DESIGN.md#l3--separate-judges. Two checks over the return schemas in
// lib/schemas.mjs, each textual over the source:
//
//   - A verdict-named boolean (`approved: { type: 'boolean' }`) invites a prompt to ask a model to
//     set it, and the exit of a review loop moves from computed code into a model's
//     self-assessment. The verdict names are banned by exact key; `build_ok` and `suite_pass`
//     name observed facts and stay legal. A banned key whose `{ type: 'boolean' }` sits behind a
//     nested object, or behind a name such as `bool`, is not seen.
//   - Ruling fields. An entry `<name>: { kind: 'producer' | 'searcher' | 'judge', schema: … }` of a
//     producer or a searcher names no ruling field (`ruling`, `rulings`, `units`, `verdict`) and
//     calls no `unit(…)` at any depth: a producer declares, it never rules (L3). A judge's schema
//     requires, among its own fields, a `units` or `rulings` array, or one `ruling`, so code can
//     count every unit nobody ruled on as open. A field a spread (`...coverage`) brings in is not
//     seen.

/** Stable rule id. MUST equal the filename without extension. */
export const id = 'no-self-verdict'

/** RegExp tested against the POSIX-style repo-relative path. */
export const applies = /^lib\/schemas\.mjs$/

const BANNED_KEYS = [
  'approved', 'approve', 'passed', 'ok', 'accepted', 'lgtm', 'complete', 'success', 'valid',
]

// Whitespace-flexible, single- or double-quoted `type` value. `[^}]*` spans newlines, so a schema
// written one property per line still matches; the `{ type: 'boolean'` tail keeps it off prose.
const PATTERN = new RegExp(
  `\\b(${BANNED_KEYS.join('|')})\\s*:\\s*\\{[^}]*type\\s*:\\s*['"]boolean['"]`,
  'g'
)

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

/** Pure. The index of the bracket that closes the one at `at`, or the end. */
function closer(code, at) {
  let depth = 0
  for (let i = at; i < code.length; i++) {
    if (OPEN.includes(code[i])) depth++
    else if (CLOSE.includes(code[i]) && --depth === 0) return i
  }
  return code.length
}

const lineOf = (code, at) => code.slice(0, at).split('\n').length

/** The fields that carry a ruling, and the helper that builds a per-unit one. */
const RULING_FIELDS = ['ruling', 'rulings', 'units', 'verdict']

/** Pure. The keys at depth one of the object opening at `open`, each with its offset and what follows its colon. */
function keysOf(code, open) {
  const end = closer(code, open)
  const keys = []
  let depth = 0
  for (let i = open; i <= end; i++) {
    if (OPEN.includes(code[i])) depth++
    else if (CLOSE.includes(code[i])) depth--
    else if (depth === 1) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(code.slice(i))
      if (m && !/[\w$.]/.test(code[i - 1])) {
        keys.push({ name: m[1], at: i, value: code.slice(i + m[0].length).trimStart() })
        i += m[0].length - 1
      }
    }
  }
  return { keys, end }
}

/**
 * Pure. The ruling-field findings in a schema table: an entry `<name>: { kind: '<kind>', schema: … }`.
 * A producer's or a searcher's schema names no ruling field and builds no `unit(…)` at any depth;
 * a judge's requires `units` or `rulings`, an array, or a single `ruling`, among its own fields.
 */
function rulingFindings(source) {
  const code = blankStringsAndComments(source)
  const out = []
  for (const m of source.matchAll(/(?<![\w$.])([a-z_][a-z0-9_]*)\s*:\s*\{\s*kind\s*:\s*'(producer|searcher|judge)'/g)) {
    const [, name, kind] = m
    if (code.slice(m.index, m.index + name.length) !== name) continue // inside a comment or a string
    const open = m.index + m[0].indexOf('{')
    const end = closer(code, open)
    const entry = code.slice(open, end + 1)
    if (kind !== 'judge') {
      for (const k of entry.matchAll(new RegExp('(?<![\\w$.])(' + RULING_FIELDS.join('|') + ')\\s*:|(?<![\\w$.])unit\\s*\\(', 'g'))) {
        out.push({
          line: lineOf(code, open + k.index),
          message: 'the ' + kind + ' schema ' + name + (k[1] ? ' carries the ruling field ' + k[1] : ' builds a per-unit ruling') +
            ' — only a judge rules, and never on its own work (L3)',
        })
      }
      continue
    }
    const at = entry.search(/\bschema\s*:/)
    const first = at === -1 ? -1 : entry.indexOf('{', at)
    let { keys, end: propsEnd } = first === -1 ? { keys: [], end: -1 } : keysOf(entry, first)
    // `obj(properties, required)` and `long(…)` require every field unless a list follows; a JSON
    // Schema object, `{type, properties, required}`, requires only those its `required` names.
    let listAt = first !== -1 && /^\s*,\s*\[/.test(entry.slice(propsEnd + 1)) ? entry.indexOf('[', propsEnd) : -1
    let all = listAt === -1
    const nested = keys.find((k) => k.name === 'properties' && k.value.startsWith('{'))
    if (nested) {
      const listed = keys.find((k) => k.name === 'required' && k.value.startsWith('['))
      listAt = listed ? entry.indexOf('[', listed.at) : -1
      all = false
      keys = keysOf(entry, entry.indexOf('{', nested.at)).keys
    }
    const list = listAt === -1 ? '' : source.slice(open + listAt, open + closer(entry, listAt) + 1)
    const isRequired = (field) => all || new RegExp("['\"]" + field + "['\"]").test(list)
    const isArray = (k) => /^:\s*(arr\s*\(|\{\s*type\s*:\s*['"]array['"])/.test(source.slice(open + k.at + k.name.length).trimStart())
    const rules = keys.some((k) => ((['units', 'rulings'].includes(k.name) && isArray(k)) || k.name === 'ruling') && isRequired(k.name))
    if (!rules) {
      out.push({
        line: lineOf(code, m.index),
        message: 'the judge schema ' + name + ' requires no per-unit rulings — a judge returns a required `units` or ' +
          '`rulings` array, or one `ruling`, so code can count what nobody ruled on (L3)',
      })
    }
  }
  return out
}

/**
 * Pure. No filesystem, no other rules, no globals.
 * @param {string} source   full file text
 * @returns {Array<{line: number, message: string}>} empty when clean
 */
export function check(source) {
  const violations = []
  for (const match of source.matchAll(PATTERN)) {
    violations.push({
      line: source.slice(0, match.index).split('\n').length,
      message:
        `schema declares self-reported verdict boolean '${match[1]}' — return findings/facts ` +
        `and derive the verdict in JS (IL3)`,
    })
  }
  return [...violations, ...rulingFindings(source)]
}
