// lib/plan-digest.mjs — the content-bearing tripwire for a plan that travels through a model.
//
// Design: docs/DESIGN.md#plan-envelope-and-work-orders.
//
// A run's plan is written to disk by the planner and read back by a loader agent on resume.
// Between those two points it passes through a model, so every field in it is at risk of a
// paraphrase: a reworded `context`, a dropped `acceptance` entry, a rewritten `locus`. A
// count-and-ids manifest sees none of that, and a wrong locus does not surface as "the plan
// was corrupted" — it surfaces downstream as a blocking locus breach, blamed on an honest
// coder.
//
// So the manifest is per-order and digest-bearing. The planner runs this CLI when it writes
// the plan; `agentics-develop` recomputes the same digest in-script over whatever the loader
// returned and halts loudly on the first mismatch, naming the order.
//
// The digest must therefore be computable in TWO places: here, with a module loader, and
// inside a workflow script, which has neither imports nor `node:crypto`. That rules out any
// hash from the standard library and rules in FNV-1a, which is thirty characters of integer
// arithmetic and identical wherever it is written. It is not a cryptographic hash and is not
// used as one: the threat model is an honest model paraphrasing a field, not an adversary
// crafting a collision.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** The order fields the digest covers — the WORK_ORDERS work_orders item, exactly. */
const ORDER_FIELDS = ['id', 'title', 'locus', 'acceptance', 'context', 'deps', 'contract']

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

/**
 * Pure. The digest of one work order over its seven contract fields.
 *
 * Restricted to ORDER_FIELDS rather than digesting the object whole: a field the schema does
 * not define carries nothing the pipeline reads, and letting one shift the digest would turn
 * a harmless extra key into a halt.
 * @param {object} order
 * @returns {string}
 */
export function digestOrder(order) {
  const picked = {}
  for (const field of ORDER_FIELDS) picked[field] = order[field]

  // `role` joins the digest ONLY when it is something other than the default. A role decides
  // how an order is verified — a red order's tests are required to fail — so a role altered
  // in transit has to stop the run. But it must join conditionally, because manifests already
  // on disk were computed before roles existed: digesting an explicit 'none' differently from
  // an absent field would make every plan parked before this version halt on a mismatch it
  // did not have, and a false halt is indistinguishable from a real corruption.
  if (order.role && order.role !== 'none') picked.role = order.role

  // `reads` gets the same conditional treatment for the same reason: an order that declares
  // no read dependencies and one written before the field existed are the same order, and a
  // plan parked before this version must keep matching the manifest stored beside it.
  if ((order.reads || []).length > 0) picked.reads = order.reads

  return fnv1a(canonical(picked))
}

/**
 * Pure. The per-order manifest stored beside a plan.
 * @param {Array<object>} workOrders
 * @returns {Array<{id: string, locus_n: number, acceptance_n: number, digest: string}>}
 *
 * `locus_n` and `acceptance_n` are redundant with the digest and kept anyway: when a digest
 * mismatch fires, they say at a glance whether the plan lost entries or had them reworded,
 * and a halt that names the shape of the damage is worth more than one that names only its
 * existence.
 */
export function manifestOf(workOrders) {
  return workOrders.map((order) => ({
    id: order.id,
    locus_n: (order.locus || []).length,
    acceptance_n: (order.acceptance || []).length,
    digest: digestOrder(order),
  }))
}

// The CLI, guarded the same way the plugin's other libs are. `import.meta.main` is undefined
// before Node 24.2; the argv comparison keeps the CLI alive there — a silently no-op CLI
// would hand the planner empty stdout to paste into a file it then cannot validate.
//
// Read-only, like `independence.mjs` and `commit-series.mjs`: it prints, and the planner
// writes. That also makes it the plan file's validator — it JSON.parses what the planner
// just wrote, so `{"error": ...}` on stdout means the write itself was malformed.
const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  try {
    const { work_orders } = JSON.parse(readFileSync(process.argv[2], 'utf8'))

    if (!Array.isArray(work_orders)) {
      throw new TypeError('plan-digest: the input file has no work_orders array')
    }

    console.log(JSON.stringify({ manifest: manifestOf(work_orders) }))
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
