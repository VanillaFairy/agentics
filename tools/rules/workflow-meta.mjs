// tools/rules/workflow-meta.mjs — pins a workflow's meta literal against three silent failures.
//
// 1. A name that is not the file's own. The name a workflow is addressed by is spelled once,
//    as its file's name — nothing else addresses this workflow. A service step lives outside
//    the registered `workflows/` directory and is launched by path, from a skill or as a nested
//    `workflow({ scriptPath }, args)` call, so it doesn't show in the `/` menu (D6).
// 2. A `phase('X')` call with no matching `meta.phases` entry. `meta.phases` drives the progress
//    display; an unmatched call silently gets its own ungrouped box. Nothing throws — the
//    display is just quietly wrong, and no test run will ever show it.
// 3. A meta literal that is not literal. The runtime reads this block STATICALLY and never
//    evaluates it, so `description: 'a' + 'b'` is valid JavaScript that the runtime refuses —
//    and a refused workflow does not register at all. Nothing anywhere says so; the workflow is
//    simply absent when something tries to invoke it. That is not hypothetical: `attack-document-with-independent-reviewers`'s
//    description was a two-line concatenation, it passed every check in this file, and the
//    installed plugin never had the workflow.
//
// Deliberately NOT flagged: the reverse check, a declared phase with no `phase()` call. That is
// a normal intermediate state while a workflow is being written, and flagging it would fight the
// author instead of helping them.
//
// The declared set is read from the `phases:` array span only, not the whole meta literal, so a
// stray `meta.title` sitting next to `name` declares no phase.
//
// No parser: strings and comments are blanked (below) and the rest is regex plus brace counting.
// V4 is the one check that needs the ORIGINAL text as well — an interpolation lives inside a
// template literal, which is exactly what blanking erases — so the scanner reports the string
// spans alongside the blanked copy.

export const id = 'workflow-meta'

export const applies = /\.workflow\.js$/

/** The exported literal itself. The trailing `{` is where brace matching starts. */
const META_DECL = /export\s+const\s+meta\s*=\s*\{/

/** `phases: [` inside the meta literal. The trailing `[` is where bracket matching starts. */
const PHASES_DECL = /\bphases\s*:\s*\[/

/** A workflow's name is kebab-case words — the shape every long service name (D19) takes. */
const NAME_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/
const NAME_SHAPE_TEXT = 'must be kebab-case words'

// The `d` flag gives each match `.indices`, so the *original* text of a quoted value can be
// sliced out of the source — the blanked copy has turned its contents into spaces. All three are
// used through `matchAll` only, which never mutates their `lastIndex`, so the module stays pure.
const NAME = /\bname\s*:\s*(['"`])([^'"`]*)\1/dg
const TITLE = /\btitle\s*:\s*(['"`])([^'"`]*)\1/dg
const PHASE_CALL = /\bphase\s*\(\s*(['"`])([^'"`]*)\1\s*\)/dg

/**
 * Replace the contents of strings and comments with spaces, preserving length and
 * newlines so line numbers survive. Delimiters are kept so brace scanning still sees
 * balanced structure outside them.
 *
 * `strings` records where each string literal sat, because one check has to read back
 * inside one: a `${...}` interpolation is only visible in the original text, and blanking
 * is what makes every OTHER check safe. Returning both keeps a single scan authoritative
 * about what is and is not inside a string.
 *
 * @returns {{ blanked: string, strings: Array<{quote: string, start: number, end: number}> }}
 */
function scan(source) {
  const out = source.split('')
  const strings = []
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
      strings.push({ quote: c, start: i, end: Math.min(j + 1, n) })
      blank(i + 1, j)
      i = j + 1
      continue
    }

    i++
  }

  return { blanked: out.join(''), strings }
}

/**
 * Index just past the `}` or `]` that closes the one at `openIndex`. Runs on the blanked copy,
 * where no delimiter hides inside a string or comment. An unterminated span ends at end of file.
 */
function spanEnd(blanked, openIndex) {
  const open = blanked[openIndex]
  const close = open === '{' ? '}' : ']'
  let depth = 0

  for (let i = openIndex; i < blanked.length; i++) {
    if (blanked[i] === open) depth++
    else if (blanked[i] === close && --depth === 0) return i + 1
  }
  return blanked.length
}

/** 1-indexed line of a character offset. Correct for LF and CRLF alike. */
const lineOf = (source, index) => source.slice(0, index).split('\n').length

/** Matches of `pattern` in the blanked copy that start inside [start, end). */
const within = (blanked, pattern, start, end) =>
  [...blanked.matchAll(pattern)].filter((m) => m.index >= start && m.index < end)

/** The original text of capture group 2 — the quoted value, before it was blanked. */
const quotedValue = (source, match) => source.slice(...match.indices[2])

export function check(source, filePath) {
  const { blanked, strings } = scan(source)

  const meta = META_DECL.exec(blanked)
  if (!meta) {
    // Nothing to check anything else against: without meta, every phase() call is unmatched by
    // definition, and listing them all would bury the one thing the author has to fix.
    return [{
      line: 0,
      message:
        `No exported meta literal. Every workflow must declare ` +
        `"export const meta = { name, phases }" — the runner reads it to name the workflow and ` +
        `to group the progress display.`,
    }]
  }

  const metaStart = meta.index + meta[0].length - 1
  const metaEnd = spanEnd(blanked, metaStart)

  const registered = String(filePath || '').startsWith('workflows/')
    ? [{
        line: 0,
        message:
          `service steps are launched by path from service-workflows/; a script in the ` +
          `registered workflows/ directory shows in the menu (D6)`,
      }]
    : []

  return [
    ...registered,
    ...checkName(source, blanked, metaStart, metaEnd, filePath),
    ...checkPhases(source, blanked, metaStart, metaEnd),
    ...checkLiteral(source, blanked, strings, metaStart, metaEnd),
  ]
}

/** V2: meta.name is present and is the file's own name; nothing else addresses this workflow. */
function checkName(source, blanked, metaStart, metaEnd, filePath) {
  const [match] = within(blanked, NAME, metaStart, metaEnd)
  const value = match ? quotedValue(source, match) : ''
  const stem = String(filePath || '').split('/').pop().replace(/\.workflow\.js$/, '')

  if (value.trim() === '') {
    return [{ line: 0, message: `meta has no name. Add name: '${stem}' — a workflow's name is its file's name.` }]
  }

  const problems = []
  if (value !== stem) problems.push(`is not its file's name, "${stem}"`)
  if (!NAME_SHAPE.test(value)) problems.push(NAME_SHAPE_TEXT)

  return problems.length === 0 ? [] : [{
    line: lineOf(source, match.index),
    message: `meta.name "${value}" ${problems.join(', and ')}. A workflow is addressed by one name, spelled once.`,
  }]
}

/** V3: every phase() call site names a title declared in meta.phases. */
function checkPhases(source, blanked, metaStart, metaEnd) {
  const declared = new Set(
    declaredTitleMatches(blanked, metaStart, metaEnd).map((m) => quotedValue(source, m)),
  )

  return [...blanked.matchAll(PHASE_CALL)]
    .map((match) => ({ match, title: quotedValue(source, match) }))
    .filter(({ title }) => !declared.has(title))
    .map(({ match, title }) => ({
      line: lineOf(source, match.index),
      message:
        `phase("${title}") has no matching entry in meta.phases, so it gets its own ungrouped ` +
        `box in the progress display instead of joining the run. Add { title: '${title}' } to ` +
        `meta.phases, or correct the spelling.`,
    }))
}

/** Title declarations inside the `phases:` array span. No phases key declares no titles. */
function declaredTitleMatches(blanked, metaStart, metaEnd) {
  const phases = PHASES_DECL.exec(blanked.slice(metaStart, metaEnd))
  if (!phases) return []

  const arrayStart = metaStart + phases.index + phases[0].length - 1
  return within(blanked, TITLE, arrayStart, spanEnd(blanked, arrayStart))
}

// --- V4: the meta literal is literal ---------------------------------------------------
//
// Everything below decides ONE question: could a static reader evaluate this block without
// running JavaScript? Four constructs say no, and each of them is ordinary, useful code that
// a person writes without a second thought — which is why the failure is worth a rule. The
// fifth case, a bare identifier standing where a value belongs, is decidable here for a
// pleasant reason: in an object literal a key is always followed by a colon, so an identifier
// that is not is necessarily a value.

/** Operators and calls that cannot appear in a literal. Order is presentation order. */
const NON_LITERAL = [
  { pattern: /\+/g, what: 'string concatenation (+)' },
  { pattern: /\(/g, what: 'a function call' },
  { pattern: /\.\.\./g, what: 'a spread' },
]

/** Keywords that ARE literals despite matching the identifier shape. */
const LITERAL_WORDS = new Set(['true', 'false', 'null'])

const IDENT = /[A-Za-z_$][\w$]*/g

/** The first non-whitespace character at or after `from`, or '' at end of text. */
function nextNonSpace(text, from) {
  let i = from
  while (i < text.length && /\s/.test(text[i])) i++
  return text[i] || ''
}

const WHY =
  `The runtime reads meta STATICALLY and never evaluates it, so a workflow whose meta it ` +
  `cannot read does not register at all — and nothing anywhere reports that. It is simply ` +
  `absent when something tries to invoke it. Write every value as one literal.`

function checkLiteral(source, blanked, strings, metaStart, metaEnd) {
  const violations = []

  for (const { pattern, what } of NON_LITERAL) {
    for (const match of within(blanked, pattern, metaStart, metaEnd)) {
      violations.push({
        line: lineOf(source, match.index),
        message: `meta is not a pure literal: ${what} inside the meta block. ${WHY}`,
      })
    }
  }

  // Template interpolation. Read from the ORIGINAL text, because blanking has already
  // replaced the `${...}` with spaces — this is the one question the blanked copy cannot
  // answer, and it is the reason `scan` reports where the strings were.
  for (const span of strings) {
    if (span.quote !== '`' || span.start < metaStart || span.start >= metaEnd) continue
    if (!source.slice(span.start, span.end).includes('${')) continue

    violations.push({
      line: lineOf(source, span.start),
      message: `meta is not a pure literal: a template literal interpolates \${...}. ${WHY}`,
    })
  }

  // A bare identifier where a value belongs — `name: NAME`, `phases: PHASES`. Decidable
  // because a key in an object literal is always followed by a colon and a value never is.
  for (const match of within(blanked, IDENT, metaStart, metaEnd)) {
    if (LITERAL_WORDS.has(match[0])) continue
    if (nextNonSpace(blanked, match.index + match[0].length) === ':') continue

    violations.push({
      line: lineOf(source, match.index),
      message:
        `meta is not a pure literal: "${match[0]}" stands where a value belongs, so the ` +
        `value comes from somewhere else in the file. ${WHY}`,
    })
  }

  return violations
}
