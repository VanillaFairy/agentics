// tools/rules/coverage-block.mjs — enforces IL2.
//
// "A partial result must never be indistinguishable from a whole one." The coverage block
// is the only thing that tells them apart, so a workflow that returns
// nothing, or returns a result without one, hands its caller an answer that looks complete
// no matter how much evidence was dropped on the way.
//
// Most of a workflow script is prompt text, and prompt text is full of braces, the word
// return, and ${} interpolations — all of which read as code to a naive scan. So strings and
// comments are blanked out first, and everything below runs on what is left. Everything:
// blanking the source and then reading any part of the ORIGINAL back out un-hides exactly
// what the blanking was for, and inside a returned object that turns a sentence of prose
// into a coverage block.
//
// Three findings:
//   V1 (line 0)     nothing is returned at all — undefined reaches the caller
//   V2 (line 0)     something is returned, but no returned object carries a coverage key
//   V3 (that line)  a bare `return` — an early exit with no result and no coverage
//
// The block's field list is { complete, dropped, incomplete, failed_channels, unreached,
// resumable }, plus `from_kb` — the provenance of anything a result recalled
// from the project knowledge base rather than searched for today. It is deliberately NOT demanded
// here, and this rule's behaviour is unchanged by it: absence must read as "nothing came from
// cache", so a workflow that never touches the base is correct to omit it, and a rule insisting on
// an empty array would turn the safe default into a lint failure. What a change to that field list
// must cite is docs/DESIGN.md#coverage-block, and the question it must answer is: does this
// field let a reader tell a partial result from a whole one? A field that does not is
// decoration on the one structure IL2 rests on.
//
// Both spellings of the key count: `coverage:` and ES shorthand `coverage`, the latter in
// every position it can occupy — first key, last key, somewhere in the middle, with or
// without a trailing comma, on one line or written out one key per line. The first
// real workflow written against this rule had to rename a parameter to work around the
// shorthand form being rejected, which is the linter being wrong rather than the workflow.
//
// Deliberately NOT flagged, because catching them needs a real parser and this repo has no
// dependencies. All four are left to human review:
//   - `return { ...base }`            -> a coverage key that arrives only through a spread
//                                        lives in another object the rule cannot follow
//   - `if (!x) return`                -> an inline bare return shares its line with code
//   - `const r = {...}; return r`     -> no object literal at the return, so V1 fires
//   - a helper's `return {...}`       -> telling script scope from function scope needs a
//                                        parser, so the rule asks that AT LEAST ONE returned
//                                        object carries coverage, not that every one does
//
// One known false positive, same root cause: the blanker has no notion of a regex literal,
// so an unpaired quote inside one (`/can't/`) opens a string that swallows the rest of the
// file and the real return with it. Telling a regex literal from division is exactly the job
// of the parser we do not have. No workflow in this plugin uses one today; if that changes,
// hoist the pattern into `new RegExp('...')`.

export const id = 'coverage-block'

export const applies = /\.workflow\.js$/

export function check(source) {
  const code = blankStringsAndComments(source)
  const violations = []

  // V1 first: with no `return {` anywhere there is no object to look inside, so V2 would
  // fire vacuously on top of it and report the same defect twice.
  if (!/\breturn\s*\{/.test(code)) {
    violations.push({
      line: 0,
      message:
        `This workflow never returns a result object, so its caller receives undefined — ` +
        `indistinguishable from a crash, and from a complete answer. IL2: a ` +
        `partial result must never be indistinguishable from a whole one.`,
    })
  } else {
    const verdict = coverageVerdict(code)

    if (verdict === 'none') {
      violations.push({
        line: 0,
        message:
          `No returned object carries a "coverage" key. IL2: a partial result must ` +
          `never be indistinguishable from a whole one, and the coverage block is the only ` +
          `thing that tells them apart. Return coverage: { complete, dropped, incomplete, ` +
          `failed_channels, unreached, resumable }.`,
      })
    } else if (verdict === 'vacuous') {
      violations.push({
        line: 0,
        message:
          `Every returned "coverage" is an empty object literal or null — a key with ` +
          `nothing behind it satisfies the letter of the rule while carrying none of ` +
          `{ complete, dropped, incomplete, failed_channels, unreached, resumable }. ` +
          `IL2: an empty coverage block is a partial result wearing the label.`,
      })
    }
  }

  // Trimmed, not compared: the repo ships LF (.gitattributes), but a source string may
  // still arrive CRLF from an unnormalized tree, and the trim keeps both spellings equal.
  code.split('\n').forEach((text, index) => {
    if (!/^return\s*;?$/.test(text.trim())) return
    violations.push({
      line: index + 1,
      message:
        `Bare "return": this path exits with no result and no coverage block, so the ` +
        `caller cannot tell an early abort from a finished answer. IL2 — return a ` +
        `result whose coverage block says what was not reached.`,
    })
  })

  return violations
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
 * by regex, and judging it belongs to the scenario harness, which executes the workflow
 * and reads the real block (self-audit: this rule checks for a key, the harness checks
 * for a block; each does the half it can actually decide).
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
