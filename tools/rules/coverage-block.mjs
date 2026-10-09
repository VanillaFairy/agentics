// tools/rules/coverage-block.mjs — enforces L1 over the programs.
//
// "A partial result must never be indistinguishable from a whole one." The coverage block is the
// only thing that tells them apart, so a program whose result carries none hands its caller an
// answer that looks complete no matter how much was dropped on the way.
//
// A program (lib/programs/*.mjs, less the shared common.mjs and converge.mjs) builds its result in
// a module-local `function resultOf`, so the rule asks for that function and for a substantive
// coverage key in an object it returns (docs/DESIGN.md#coverage-block). A helper's bare `return`
// is not flagged: a module's helper may end bare.
//
// Strings and comments are blanked first, and everything below runs on what is left: reading any
// part of the original back out un-hides what the blanking was for, and inside a returned object
// that turns a sentence of prose into a coverage block.
//
// The block's field list is { complete, dropped, incomplete, failed_channels, unreached,
// resumable }, plus `from_kb`, which is deliberately not demanded: its absence reads as "nothing
// came from cache". A change to that field list cites docs/DESIGN.md#coverage-block.
//
// Both spellings of the key count: `coverage:` and ES shorthand `coverage`, in every position a
// key can occupy, on one line or one key per line.
//
// Deliberately NOT flagged, because catching them needs a parser and this repository has no
// dependencies: a coverage key that arrives only through a spread (`return { ...base }`), and a
// value that is an identifier, whose fields a regex cannot see. The blanker has no notion of a
// regex literal, so an unpaired quote inside one (`/can't/`) opens a string that swallows the rest
// of the file; hoist such a pattern into `new RegExp('...')`.

export const id = 'coverage-block'

export const applies = /^lib\/programs\/(?!(?:common|converge)\.mjs$)[^/]+\.mjs$/

export function check(source) {
  return checkProgram(source)
}

/** A program's findings: no `function resultOf`, or a resultOf that returns no substantive coverage key. */
function checkProgram(source) {
  const code = blankStringsAndComments(source)
  const head = /\bfunction\s+resultOf\s*\(/.exec(code)
  if (!head) {
    return [{
      line: 0,
      message:
        `This program defines no function resultOf, so nothing builds its result's coverage ` +
        `block. L1: a program result shows exactly how complete it is — build every result in ` +
        `resultOf and return coverage: coverageOf({ ... }) from it.`,
    }]
  }
  const open = code.indexOf('{', endOfParams(code, head.index + head[0].length - 1))
  const verdict = open < 0 ? 'none' : coverageVerdict(code.slice(open, endOfObject(code, open)))
  if (verdict === 'ok') return []
  return [{
    line: code.slice(0, head.index).split('\n').length,
    message: verdict === 'none'
      ? `resultOf returns no object carrying a "coverage" key. L1: a partial result must never ` +
        `read as a whole one — return coverage: coverageOf({ ... }) from resultOf.`
      : `Every "coverage" resultOf returns is an empty object literal or null. L1: an empty ` +
        `coverage block is a partial result wearing the label.`,
  }]
}

/** Index just past the `)` closing the parameter list that opens at `open`, or end of source. */
function endOfParams(code, open) {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++
    else if (code[i] === ')' && --depth === 0) return i + 1
  }
  return code.length
}

/**
 * `coverage` sitting where a key can sit: straight after the object's `{`, or after a comma,
 * with nothing but whitespace in between. From there it is a key either way it is written —
 * `coverage:` with a colon, or ES shorthand, where the next thing along is the comma or the
 * brace that ends the property.
 *
 * That leading `{` or `,` is doing two jobs. It keeps `has_coverage` out in both spellings,
 * since the character before the word is an underscore rather than a delimiter. And it keeps
 * out a `coverage` that is a VALUE rather than a key — in `{ hits: coverage }` a colon sits
 * in front of the word, so the object is not carrying a coverage block by that name.
 *
 * Allowing whitespace to span newlines is what makes the multi-line shorthand work; matching
 * only `coverage\s*\}` would accept `{ question, coverage }` and reject `{ coverage, hits }`
 * and every object written out one key per line.
 */
const COVERAGE_KEY = /[{,]\s*coverage\s*(?::|(?=[,}]))/

/**
 * 'ok' when at least one returned object literal carries a substantive `coverage` key;
 * 'vacuous' when every carrier's value is decidably empty; 'none' when no return carries
 * the key at all.
 *
 * All of this runs on the BLANKED source. The span of each object is brace-matched there, so
 * a stray brace in a prompt cannot close the object early, and the key is looked for in that
 * same blanked span, where a `coverage` living inside a string or a comment has become
 * spaces. Measuring the span on one text and reading it out of the other is what once let a
 * sentence of prose inside the returned object pass as the coverage block.
 */
function coverageVerdict(code) {
  let sawKey = false
  let sawSubstantive = false

  for (const match of code.matchAll(/\breturn\s*\{/g)) {
    const open = match.index + match[0].length - 1
    const span = code.slice(open, endOfObject(code, open))
    if (!COVERAGE_KEY.test(span)) continue
    sawKey = true
    if (!vacuousCoverageValue(span)) sawSubstantive = true
  }

  if (sawSubstantive) return 'ok'
  return sawKey ? 'vacuous' : 'none'
}

/**
 * True when the coverage key's value is DECIDABLY empty: a literal `{}` with nothing but
 * whitespace inside, or a literal `null`. A value that is an identifier or ES shorthand is
 * not vacuous by this test — whether that object carries the six fields is not decidable
 * by regex, and judging it belongs to the program tests, which run the program and read the
 * real block (this rule checks for a key, the tests check the block; each does the half it can
 * decide).
 */
function vacuousCoverageValue(span) {
  const colon = /[{,]\s*coverage\s*:\s*/.exec(span)
  if (!colon) return false

  const at = colon.index + colon[0].length
  if (/^null\b/.test(span.slice(at, at + 5))) return true
  if (span[at] === '{') {
    const inner = span.slice(at + 1, endOfObject(span, at) - 1)
    return inner.trim() === ''
  }
  return false
}

/** Index just past the `}` closing the object that opens at `open`, or end of source. */
function endOfObject(code, open) {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}' && --depth === 0) return i + 1
  }
  return code.length
}

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
