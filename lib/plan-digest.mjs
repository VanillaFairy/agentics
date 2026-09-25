// lib/plan-digest.mjs — the one serialization and the one digest in this plugin.
//
// Design: docs/DESIGN.md#data-contracts.
//
// Everything that crosses a model travels under a digest its receiver re-checks: boundary
// payloads, the argument tokens the workflow mints, ledger batches, briefs. The digest must be
// computable in TWO places — here, with a module loader, and inside a workflow script, which has
// neither imports nor `node:crypto` — which rules out any hash from the standard library and rules
// in FNV-1a: thirty characters of integer arithmetic, identical wherever it is written. It is not a
// cryptographic hash and is not used as one: the threat model is an honest model paraphrasing or
// mangling a field in transit, not an adversary crafting a collision.

/**
 * Pure. Deterministic serialization: object keys sorted, arrays in order, no whitespace.
 *
 * Key sorting is what makes the digest survive a round trip through a model that re-emits
 * the same object with its keys in another order — a difference that changes nothing about
 * the plan and must not read as corruption. `undefined` becomes `null` so a missing field
 * and an explicitly-null one digest alike; `JSON.stringify(undefined)` returns undefined
 * rather than a string, which would concatenate as the literal text "undefined".
 * @param {unknown} value
 * @returns {string}
 */
export function canonical(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'

  return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
    .join(',') + '}'
}

/**
 * Pure. FNV-1a over the string's UTF-16 code units, as eight lowercase hex digits.
 *
 * Code units rather than bytes: `charCodeAt` needs no encoder, which a workflow script also
 * does not have. `Math.imul` is what keeps the multiply in 32-bit integer space — a plain
 * `*` would go through a double and lose the low bits the hash depends on.
 * @param {string} text
 * @returns {string}
 */
export function fnv1a(text) {
  let hash = 0x811c9dc5

  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }

  return (hash >>> 0).toString(16).padStart(8, '0')
}
