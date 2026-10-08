// tools/rules/fast-tier.mjs — a spawning test landing in the tier meant to run in seconds.
//
// test/fast/ is the tier `node tools/suite.mjs --fast` runs: files that start no process, so the
// whole tier finishes in about a second. One test that shells out to git or node there puts the
// tier's cost back, and nothing else would notice. A fast file gets a process in two ways, and
// this rule flags both at the import:
//
//   - it imports child_process itself;
//   - it imports a file from test/ outside test/fast/ (`../harness/x.mjs`, `../foo.test.mjs`),
//     which is where every spawning helper lives. A helper that spawns nothing belongs in
//     test/fast/harness/, where the import is allowed.
//
// Imports of lib/, tools/ and the other node builtins are allowed. Not caught: a lib/ module
// that spawns when called — the rule reads imports, not behaviour.
//
// Strings and comments are blanked before matching, so a test that quotes an import as fixture
// text is not flagged; the specifier is then read back from the source at the quote the blanked
// code shows after a real `from` / `import` / `require(`. The blanker is duplicated from
// no-imports deliberately — rule modules are pure and may not import each other. It has no
// notion of a regex literal, so an unpaired quote inside one swallows real code; hoist such a
// pattern into `new RegExp('...')`.

import { posix } from 'node:path'

export const id = 'fast-tier'

export const applies = /^test\/fast\/.+\.mjs$/

const TIER = 'test/fast/'

// The quote that opens a module specifier: after `from`, after a bare `import`, inside
// `import(` or inside `require(`. `import.meta` and `Array.from(` never match.
const SPECIFIER_OPEN = /(?<![.\w])(?:from|import|import\s*\(|require\s*\()\s*(['"`])/g

export function check(source, filePath) {
  const code = blankStringsAndComments(source)
  const violations = []

  for (const open of code.matchAll(SPECIFIER_OPEN)) {
    const start = open.index + open[0].length
    const end = code.indexOf(open[1], start)
    if (end < 0) continue
    const specifier = source.slice(start, end)
    const message = problemWith(specifier, filePath)
    if (message) violations.push({ line: source.slice(0, start).split('\n').length, message })
  }

  return violations
}

function problemWith(specifier, filePath) {
  if (specifier === 'child_process' || specifier === 'node:child_process') {
    return 'the fast tier spawns nothing — move this file out of test/fast/, or take the ' +
      'process out of it.'
  }
  if (!specifier.startsWith('.')) return null

  const target = posix.join(posix.dirname(filePath), specifier)
  if (target.startsWith('test/') && !target.startsWith(TIER)) {
    return `imports ${specifier}, which is in test/ outside test/fast/ and may spawn — ` +
      'a helper that spawns nothing belongs in test/fast/harness/.'
  }
  return null
}

/**
 * Replace the contents of strings and comments with spaces, preserving length and
 * newlines so line numbers survive. Delimiters are kept.
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
