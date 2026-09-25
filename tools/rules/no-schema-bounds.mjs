// tools/rules/no-schema-bounds.mjs — IL2 support rule.
//
// Structured outputs do not support minItems/maxItems/minLength/maxLength: they are
// stripped before the request or validated client-side, so they silently do nothing or
// turn a good result into a dropped one. Put every bound in the prompt as behaviour and
// enforce it in JS after the call.

/** Stable rule id. MUST equal the filename without extension. */
export const id = 'no-schema-bounds'

/** RegExp tested against the POSIX-style repo-relative path. */
export const applies = /\.workflow\.js$/

const BANNED = /\b(minItems|maxItems|minLength|maxLength)\s*:/g

/**
 * Pure. No filesystem, no other rules, no globals.
 * @param {string} source   full file text
 * @param {string} filePath POSIX-style repo-relative path
 * @returns {Violation[]}   empty array when clean
 */
export function check(source, filePath) {
  const violations = []

  source.split('\n').forEach((text, index) => {
    for (const match of text.matchAll(BANNED)) {
      violations.push({
        line: index + 1,
        message:
          `"${match[1]}" is not supported by structured outputs — it is stripped or ` +
          `validated client-side, so it silently does nothing or drops a good result. ` +
          `Put the bound in the prompt and enforce it in JS after the call.`,
      })
    }
  })

  return violations
}
