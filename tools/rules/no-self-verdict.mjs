// tools/rules/no-self-verdict.mjs — IL3 support rule, extended from coverage to review.
//
// A workflow schema that offers a verdict-named boolean (`approved: { type: 'boolean' }`)
// invites a prompt to ask a model to set it — and the moment that happens, the review loop's
// exit condition has quietly migrated from computed JS into a model's self-assessment. This
// rule bans the verdict names outright, everywhere in a workflow file, regardless of which
// schema or which agent it feeds: `tools/lint.mjs` never knows which agent a schema is for,
// and neither does this rule.
//
// The line is verdict names vs. fact names. `build_ok` / `suite_pass` describe an observed
// command exit status — a fact. `approved` / `passed` / `ok` / ... describe a judgment about
// acceptability — a verdict. The ban is by exact key name, which is crude and exactly as
// decidable as this rule needs to be.
//
// Known limits, both from the same root cause: the match is a regex over raw text, not a
// parser, and a parser is deliberately out of scope for a ban this crude.
//   - False positive: a schema-shaped fragment inside a comment or string still matches,
//     because nothing here distinguishes code from prose — e.g.
//     `// Example of what NOT to write: approved: { type: 'boolean' }` gets flagged even
//     though it declares nothing. Telling "real schema" from "text that looks like one"
//     needs a parser.
//   - False negative: a nested object sitting between the banned key and its `type` escapes,
//     because `[^}]*` cannot cross the inner object's closing `}` — e.g.
//     `accepted: { description: { note: 'nested' }, type: 'boolean' }` is not flagged. Brace
//     depth tracking (as `tools/rules/coverage-block.mjs` does for its own object spans)
//     would close this, at the cost of the parser this rule is choosing not to grow.
// Both are accepted: this ban is crude and exactly as decidable as it needs to be, and
// every schema in this plugin is hand-written, not adversarially obfuscated — the failure
// mode this rule exists to catch
// is an honest `approved: { type: 'boolean' }`, which it catches every time.

/** Stable rule id. MUST equal the filename without extension. */
export const id = 'no-self-verdict'

/** RegExp tested against the POSIX-style repo-relative path. */
export const applies = /(\.workflow\.js|^lib\/schemas\.mjs)$/

const BANNED_KEYS = [
  'approved', 'approve', 'passed', 'ok', 'accepted', 'lgtm', 'complete', 'success', 'valid',
]

// Whitespace-flexible, single- or double-quoted `type` value. `[^}]*` deliberately spans
// newlines (it is a negated character class, not `.`), so a schema written one property per
// line still matches. The `{ type: 'boolean'` tail is what keeps this off prose: a sentence
// like "say whether it passed" has no `{ type: 'boolean'` following the word, so it never
// matches even though "passed" itself is a banned key.
const PATTERN = new RegExp(
  `\\b(${BANNED_KEYS.join('|')})\\s*:\\s*\\{[^}]*type\\s*:\\s*['"]boolean['"]`,
  'g'
)

/**
 * Pure. No filesystem, no other rules, no globals.
 * @param {string} source   full file text
 * @param {string} filePath POSIX-style repo-relative path
 * @returns {Violation[]}   empty array when clean
 */
export function check(source, filePath) {
  const violations = []

  for (const match of source.matchAll(PATTERN)) {
    const key = match[1]
    const line = source.slice(0, match.index).split('\n').length
    violations.push({
      line,
      message:
        `schema declares self-reported verdict boolean '${key}' — return findings/facts ` +
        `and derive the verdict in JS (IL3)`,
    })
  }

  return violations
}
