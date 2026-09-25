// lib/programme.mjs — the layer above a run. Reads a programme's authored graph and its
// append-only event log, and derives where every slice stands. Nothing about progress is
// stored; everything is recomputed on every call.
//
// Design: docs/DESIGN.md#programmes.
//
// Why this exists. `design` produces one document and hands `develop` one ratified change, so
// a system whose honest decomposition is several deliverable slices has no shape: it becomes
// one oversized run, or staging written in prose that nothing reads and nothing keeps true.
// In the field that prose was a hand-maintained table whose stage said `pending` while the
// stage was in flight — a stored claim outliving the thing it described, which is the exact
// failure `lib/run-status.mjs` opens by refusing, reproduced one level up.
//
// So the split here is the same one, at the higher grain:
//
//   programme.json   AUTHORED facts. Slices, containment, dependencies, contracts. Never
//                    progress. Written by a `plan` session with the user, and its existence
//                    IS that session's authorization — nothing stored claims an approval.
//   state.jsonl      EVENTS. Append-only, four types, each recording an act that happened.
//                    An event cannot go stale; a status can.
//
// The present is a function over those two plus what the filesystem says right now, and it is
// computed here. Everything in the pure core takes its filesystem facts as arguments — marker
// completeness, run rows, events — so the arithmetic is testable over hand-built fixtures
// without building a repository per case. The reader below is the only part that touches disk.
//
// Two `landed`s, and they are different scopes on purpose. A RUN lands when its integration
// head reaches its own `base_ref` branch — for a slice run, the programme branch. A SLICE
// lands when the programme branch reaches the user's branch, which happens once, for all of
// them, at the end. A run that landed is finished as a run and has reached the user not at all.

import { readFileSync, readdirSync, writeFileSync, appendFileSync, mkdirSync, existsSync, watch } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { readRuns } from './run-status.mjs'

/** Where a programme's event log lives, inside the target repository. */
export const PROGRAMMES_DIR = '.claude/agentics/programmes'

/** Where design trees live. A programme's identifier is its directory name, entire. */
export const DESIGNS_DIR = 'docs/agentics/designs'

/** The branch a programme accumulates on, and the worktree that stays on it. */
export const branchOf = (name) => 'agentics/programme-' + name
export const worktreeOf = (name) => '.claude/worktrees/programme-' + name

// ============================================================ the authored graph
//
// Conservative by design: absent means "not a programme", and malformed fails the whole load
// with a named diagnostic. There is no repair path, and that is deliberate — a graph this
// layer patched into shape is a graph the user did not author, and every later decision would
// rest on it while the file on disk said something else.

const reject = (error) => ({ error })

/** Normalize a deps entry. A bare string is `{id, reason: ''}`; an object may carry a reason. */
function depEntry(value) {
  if (typeof value === 'string') return { id: value, reason: '' }
  if (value && typeof value === 'object' && typeof value.id === 'string') {
    return { id: value.id, reason: typeof value.reason === 'string' ? value.reason : '' }
  }
  return null
}

/**
 * Pure. Parse and validate a programme graph.
 *
 * @param {unknown} value  parsed JSON
 * @returns {{plan: object}|{error: string}}
 *
 * The rejection set is enumerated and closed. Each entry is a way the file can be internally
 * inconsistent in a manner nothing downstream would notice: a `consumes` naming a contract the
 * consumer does not depend on schedules work against something that has not been built, and
 * the failure surfaces as a coder confused by a repository missing what its context describes.
 */
export function parseProgramme(value) {
  // 1. the shape itself
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.nodes)) {
    return reject('programme.json is not a JSON object with a nodes array')
  }

  // 11. advance — checked early so a typo is reported as itself rather than as a graph defect
  const advance = value.advance === undefined ? 'gated' : value.advance
  if (advance !== 'gated' && advance !== 'standing') {
    return reject('advance is ' + JSON.stringify(value.advance) +
      ', which is neither "gated" nor "standing". It is explicit and never inferred: a ' +
      'programme that advances by itself is a different thing from one that stops at every ' +
      'slice, and guessing which was meant is not this loader\'s call.')
  }

  // 2. ids
  const byId = new Map()
  for (const node of value.nodes) {
    if (!node || typeof node !== 'object' || typeof node.id !== 'string' || !node.id.trim()) {
      return reject('a node has no non-empty string id, so nothing can refer to it')
    }
    if (byId.has(node.id)) {
      return reject('duplicate node id ' + JSON.stringify(node.id) +
        ' — every reference to it would be ambiguous')
    }
    byId.set(node.id, node)
  }

  // 3. kinds
  for (const node of value.nodes) {
    if (node.kind !== 'group' && node.kind !== 'slice') {
      return reject(node.id + ': kind is ' + JSON.stringify(node.kind) +
        ', which is neither "group" nor "slice"')
    }
  }

  // 4. containment — parents are groups, and '' is the implicit root
  for (const node of value.nodes) {
    const parent = node.parent === undefined ? '' : node.parent
    if (typeof parent !== 'string') return reject(node.id + ': parent is not a string')
    if (parent === '') continue

    const owner = byId.get(parent)
    if (!owner) {
      return reject(node.id + ': parent ' + JSON.stringify(parent) + ' names no node')
    }
    if (owner.kind !== 'group') {
      return reject(node.id + ': parent ' + parent + ' is a slice, and parents are groups. ' +
        'Containment and dependency are separate relations here — a slice\'s parent is not ' +
        'its prerequisite, and collapsing the two would schedule work by where it is filed.')
    }
  }

  // 5. containment cycles
  const containmentCycle = findCycle(value.nodes.map((n) => n.id),
    (id) => { const p = byId.get(id).parent; return p ? [p] : [] })
  if (containmentCycle) {
    return reject('containment cycle: ' + containmentCycle.join(' -> '))
  }

  // 6. dependencies name slices that exist
  const deps = new Map()
  for (const node of value.nodes) {
    const entries = []
    for (const raw of node.deps || []) {
      const entry = depEntry(raw)
      if (!entry) return reject(node.id + ': a deps entry is neither a string nor {id, reason}')

      const target = byId.get(entry.id)
      if (!target) {
        return reject(node.id + ': deps names ' + JSON.stringify(entry.id) + ', which is no node')
      }
      if (target.kind !== 'slice') {
        return reject(node.id + ': deps names the group ' + entry.id +
          ' — dependency is a relation between slices, which are the things that get built')
      }
      entries.push(entry)
    }
    deps.set(node.id, entries)
  }

  // 7. dependency cycles
  const depCycle = findCycle(value.nodes.filter((n) => n.kind === 'slice').map((n) => n.id),
    (id) => deps.get(id).map((d) => d.id))
  if (depCycle) return reject('dependency cycle: ' + depCycle.join(' -> '))

  // 8. contracts are named once, and a name without paths checks nothing
  const providerOf = new Map()
  for (const node of value.nodes) {
    for (const entry of node.provides || []) {
      if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) {
        return reject(node.id + ': a provides entry has no non-empty name')
      }
      if (!Array.isArray(entry.paths) || entry.paths.length === 0) {
        return reject(node.id + ': the contract ' + entry.name + ' declares no paths. Names ' +
          'are the design\'s vocabulary; paths are the mechanical half, and every drift check ' +
          'in this layer is a path-set intersection rather than a reading of prose.')
      }
      if (providerOf.has(entry.name)) {
        return reject('the contract ' + JSON.stringify(entry.name) + ' is provided by both ' +
          providerOf.get(entry.name) + ' and ' + node.id + '; a consumer could mean either')
      }
      providerOf.set(entry.name, node.id)
    }
  }

  // 9. a consumer depends on whoever provides what it consumes
  const closure = transitiveDeps(value.nodes, deps)

  for (const node of value.nodes) {
    for (const name of node.consumes || []) {
      const provider = providerOf.get(name)
      if (!provider) {
        return reject(node.id + ': consumes ' + JSON.stringify(name) + ', which no slice provides')
      }
      if (!closure.get(node.id).has(provider)) {
        return reject(node.id + ': consumes ' + name + ', provided by ' + provider +
          ', which it does not depend on. Consuming from a slice you do not depend on is the ' +
          'mis-declaration this file exists to catch: the schedule would build the consumer ' +
          'before the thing it consumes exists.')
      }
    }
  }

  // 10. an ordering that is not artifact-shaped must say why it exists
  for (const node of value.nodes) {
    for (const dep of deps.get(node.id)) {
      const carries = (node.consumes || []).some((name) => providerOf.get(name) === dep.id)
      if (carries || dep.reason.trim()) continue

      return reject(node.id + ': depends on ' + dep.id + ' but consumes nothing it provides, ' +
        'and gives no reason. Real orderings that are not artifact-shaped exist — pedagogy, ' +
        'risk sequencing — and they are legal with a reason attached. Without one this is ' +
        'either a missing consumes or an ordering nobody can revisit.')
    }
  }

  return {
    plan: {
      advance,
      nodes: value.nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        parent: node.parent === undefined ? '' : node.parent,
        delivers: typeof node.delivers === 'string' ? node.delivers : '',
        deps: deps.get(node.id),
        provides: (node.provides || []).map((p) => ({ name: p.name, paths: p.paths.slice() })),
        consumes: (node.consumes || []).slice(),
      })),
    },
  }
}

/** Pure. The first cycle reachable in a directed graph, as a readable path, or null. */
function findCycle(ids, edgesOf) {
  const state = new Map(ids.map((id) => [id, 0]))   // 0 unseen, 1 on stack, 2 done
  const stack = []

  const walk = (id) => {
    if (state.get(id) === 2) return null
    if (state.get(id) === 1) return stack.slice(stack.indexOf(id)).concat([id])

    state.set(id, 1)
    stack.push(id)
    for (const next of edgesOf(id)) {
      if (!state.has(next)) continue
      const found = walk(next)
      if (found) return found
    }
    stack.pop()
    state.set(id, 2)
    return null
  }

  for (const id of ids) {
    const found = walk(id)
    if (found) return found
  }
  return null
}

/** Pure. Every slice each node reaches through deps, transitively. Assumes no cycle. */
function transitiveDeps(nodes, deps) {
  const closure = new Map()

  const walk = (id, seen) => {
    for (const dep of deps.get(id) || []) {
      if (seen.has(dep.id)) continue
      seen.add(dep.id)
      walk(dep.id, seen)
    }
    return seen
  }

  for (const node of nodes) closure.set(node.id, walk(node.id, new Set()))
  return closure
}

// ============================================================ the event log
//
// Four types, and each records an ACT rather than a status. That is the whole licence for a
// stored file here: the plugin's line is store events, never statuses, because an event cannot
// become untrue while a claim about the present goes stale the moment the present moves.
//
// No git ancestry detection exists anywhere in this layer. Squash, rebase and rename all break
// ancestry, and a layer that reads history to decide whether something happened will one day
// decide wrongly and confidently. Acts are recorded by the actor at the moment of the act.

export const EVENT_TYPES = ['opened', 'delivered', 'accepted', 'merged-to-base']

/**
 * Pure. Parse an event log.
 *
 * Fails closed on the first bad line, and the whole programme goes `unknown` as a result. A
 * malformed line names no slice, so its blast radius is undecidable — freezing everything is
 * the only reading that cannot dispatch over a fact nobody could read. The repair is a human
 * fixing one line in a text file.
 *
 * @param {string} text  the file's contents; '' for a programme with no events yet
 * @returns {{events: object[]}|{error: string}}
 */
export function parseEvents(text) {
  const events = []
  const lines = String(text || '').split('\n')

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue

    let parsed
    try {
      parsed = JSON.parse(lines[i])
    } catch (err) {
      return reject('state.jsonl line ' + (i + 1) + ' is not JSON: ' + err.message)
    }

    if (!parsed || typeof parsed !== 'object' || !EVENT_TYPES.includes(parsed.event)) {
      return reject('state.jsonl line ' + (i + 1) + ' has event ' +
        JSON.stringify(parsed && parsed.event) + ', which is not one of ' +
        EVENT_TYPES.join(', '))
    }

    events.push(parsed)
  }

  return { events }
}

/**
 * Pure. Whether an event may be appended, given what is already there.
 *
 * The append verbs are the ONLY way a line reaches this file — no skill composes one by hand.
 * At run level every event passes through a schema, and this is that discipline kept one level
 * up: a hand-written line is a line nobody validated, in the one file the whole layer trusts.
 *
 * @returns {string|null} the refusal, or null when the append is legal
 */
export function appendCheck(events, entry) {
  if (!EVENT_TYPES.includes(entry.event)) {
    return 'unknown event type ' + JSON.stringify(entry.event)
  }

  if (entry.event === 'opened') {
    if (events.some((e) => e.event === 'opened')) {
      return 'this programme was already opened; the branch is cut once and the event anchors ' +
        'the landing-time drift observation to that moment'
    }
    if (!entry.base_branch || !entry.base_sha) return 'opened needs base_branch and base_sha'
    return null
  }

  if (entry.event === 'delivered') {
    if (!entry.slice) return 'delivered names no slice'
    if (events.some((e) => e.event === 'delivered' && e.slice === entry.slice)) {
      return entry.slice + ' is already delivered. A second delivery would make the first ' +
        'unreachable while both sat in the log; re-open it through a plan revision instead.'
    }
    // External work — a pre-programme run, human-authored code, another tool's output — is
    // the brownfield door and the general door for work entering a programme between slices.
    // It carries no coverage, so the user's explicit voucher is the only thing standing behind
    // it, and it is required rather than optional.
    if (!entry.run && !String(entry.ruling || '').trim()) {
      return 'an external delivery (no run) needs a ruling: it carries no coverage block, so ' +
        'the user\'s voucher is the entire evidence for it'
    }
    return null
  }

  if (entry.event === 'accepted') {
    if (!entry.slice) return 'accepted names no slice'
    if (!String(entry.by || '').trim()) return 'accepted needs `by` — a ruling has an author'
    if (!String(entry.ruling || '').trim()) return 'accepted needs a ruling'
    if (!events.some((e) => e.event === 'delivered' && e.slice === entry.slice)) {
      return 'nothing has been delivered for ' + entry.slice + ', so there are no gaps to rule on'
    }
    return null
  }

  if (!entry.sha || !entry.base_branch) return 'merged-to-base needs sha and base_branch'
  return null
}

// ============================================================ derivation
//
// Everything below is total over its inputs. A state nobody mapped is a slice rendered as
// blank, and blank beside a slice somebody is waiting on reads as "fine".

/**
 * Pure. Does this slice satisfy its dependents?
 *
 * Delivery alone is not enough. A run reports its own coverage, and a slice delivered with
 * gaps still open is a slice whose dependents would build on something incomplete without
 * anyone having said that was acceptable. So the gate is delivery AND either the run reported
 * complete coverage, or the user has ruled on every gap it named.
 *
 * The empty-unreached-but-incomplete case needs its own answer, and it is `accepted` with an
 * empty gap list: a run that says `complete: false` while naming nothing is the hardest case
 * to notice and the easiest to wave through, and incompleteness is never waived in silence.
 */
export function isSatisfied(sliceId, events) {
  const delivered = events.find((e) => e.event === 'delivered' && e.slice === sliceId)
  if (!delivered) return false

  // External deliveries are satisfied by construction: the recorded voucher IS the ruling, and
  // there is no coverage block to compare it against.
  if (!delivered.run) return true

  const coverage = delivered.coverage || null
  if (coverage && coverage.complete === true) return true

  const accepted = events.filter((e) => e.event === 'accepted' && e.slice === sliceId)
  if (accepted.length === 0) return false

  const ruled = new Set(accepted.flatMap((e) => e.gaps || []))
  const unreached = (coverage && coverage.unreached) || []

  return unreached.every((gap) => ruled.has(gap))
}

/** Pure. Gaps the run named and nobody has ruled on. */
export function openGaps(sliceId, events) {
  const delivered = events.find((e) => e.event === 'delivered' && e.slice === sliceId)
  if (!delivered || !delivered.run) return []

  const unreached = (delivered.coverage && delivered.coverage.unreached) || []
  const ruled = new Set(events
    .filter((e) => e.event === 'accepted' && e.slice === sliceId)
    .flatMap((e) => e.gaps || []))

  return unreached.filter((gap) => !ruled.has(gap))
}

/** Pure. A status word never travels without what makes it less than it sounds. */
export function labelOf(status, qualifiers) {
  return qualifiers.length > 0 ? status + ' (' + qualifiers.join('; ') + ')' : status
}

/** Run statuses that mean the run is still going. `unreadable` is neither, and is handled apart. */
const RUNNING = new Set(['planned', 'in-flight'])
const FINISHED = new Set(['integrated', 'landed'])

/**
 * Pure. Where every slice stands, and whether the programme is done.
 *
 * @param {object} facts
 * @param {string} facts.name       the programme directory name, entire
 * @param {object} facts.plan       a parsed programme graph
 * @param {object[]} facts.events   the parsed event log
 * @param {object} facts.designed   sliceId -> boolean, from marker completeness on disk
 * @param {object[]} facts.runs     every run row in both run directories
 * @param {string} facts.degraded   '' when the state file read cleanly, the diagnostic otherwise.
 *                                  Also set here when a run in this programme's own worktree
 *                                  cannot be read — see the classification loop.
 * @param {string[]} facts.known    every programme name in the repository, for classification
 */
export function deriveProgramme({ name, plan, events, designed = {}, runs = [], degraded = '',
                                  known = [] }) {
  const slices = plan.nodes.filter((n) => n.kind === 'slice')
  const sliceIds = new Set(slices.map((s) => s.id))
  const knownProgrammes = new Set(known.length > 0 ? known : [name])

  // Runs classify three ways, and the three are kept apart because they are different facts.
  //
  //   tags naming this programme and a node it has   -> attributed
  //   tags naming nothing that exists                -> unattributed, shown in its own section
  //   no tags at all                                 -> not this layer's business (`runs` has them)
  //
  // A run tagged for a DIFFERENT programme that does exist is attributed — just not here — so
  // it is neither shown nor counted as a loose end. What must never happen is a tagged run
  // being dropped, or being guessed into a slice because its tag was nearly right.
  const attributed = new Map(slices.map((s) => [s.id, []]))
  const unattributed = []

  // A run whose plan.json cannot be parsed comes back with EVERY field blank, tags included —
  // `run-status` has nothing to fill them from. So it used to fall out of the loop below on
  // the first line, and the "an attributed run cannot be read" branch further down was
  // unreachable by construction: attribution needs a readable plan, unreadability means there
  // isn't one. A session killed mid-write therefore turned "in-flight, never re-plan" into a
  // buildable slice, and the layer dispatched a fresh run over work that may already have
  // merged — the double-buy this whole state exists to prevent.
  //
  // Provenance is what survives the tear. A row in this programme's own worktree is this
  // programme's, and an unreadable one names no slice, so its blast radius is undecidable and
  // the whole programme goes unknown. Fail closed: a human reads one file.
  const unreadableInTree = []

  for (const row of runs) {
    if (row.status === 'unreadable' && row.in_programme_tree) {
      unreadableInTree.push(row)
    } else if (!row.programme && !row.slice) {
      // Untagged and readable: not this layer's business — the `runs` skill has it.
      continue
    } else if (row.programme === name && sliceIds.has(row.slice)) {
      attributed.get(row.slice).push(row)
    } else if (!knownProgrammes.has(row.programme) || row.programme === name) {
      unattributed.push(row)
    }
  }

  if (unreadableInTree.length > 0 && !degraded) {
    degraded = `${unreadableInTree.length} run(s) in this programme's worktree cannot be ` +
      `read (${unreadableInTree.map((r) => r.runstamp).join(', ')}), and an unreadable run ` +
      `names no slice — so which slice it was building is undecidable and no slice here can ` +
      `be called safe to dispatch`
  }

  const mergedSlices = new Set(events
    .filter((e) => e.event === 'merged-to-base')
    .flatMap((e) => e.slices || []))

  const satisfied = new Set(slices.map((s) => s.id).filter((id) => isSatisfied(id, events)))

  const derived = slices.map((slice) => {
    const rows = attributed.get(slice.id)
    const delivered = events.find((e) => e.event === 'delivered' && e.slice === slice.id) || null
    const gaps = openGaps(slice.id, events)
    const depsMissing = slice.deps.map((d) => d.id).filter((id) => !satisfied.has(id))
    const isDesigned = designed[slice.id] === true
    const qualifiers = []

    let status
    if (degraded) {
      status = 'unknown'
      qualifiers.push('the event log could not be read')
    } else if (rows.some((r) => r.status === 'unreadable')) {
      status = 'unknown'
      qualifiers.push('an attributed run cannot be read, so what it did is unmeasured')
    } else if (mergedSlices.has(slice.id)) {
      status = 'landed'
    } else if (delivered) {
      status = 'delivered'
      if (gaps.length > 0) qualifiers.push(gaps.length + ' gap' + (gaps.length === 1 ? '' : 's') + ' open')
    } else if (rows.some((r) => FINISHED.has(r.status))) {
      // The run finished and the between-slice acts did not. Its own state file says the work
      // is integrated; this programme's log has never heard of it. Distinguished from
      // `in-flight` because the remedy is different: nothing needs building, something needs
      // finishing.
      status = 'delivery-pending'
    } else if (rows.some((r) => RUNNING.has(r.status))) {
      status = 'in-flight'
    } else if (!isDesigned) {
      status = depsMissing.length === 0 ? 'awaiting-design' : 'pending'
    } else {
      status = depsMissing.length === 0 ? 'ready' : 'blocked'
    }

    if (depsMissing.length > 0 && (status === 'blocked' || status === 'pending')) {
      qualifiers.push('waiting on ' + depsMissing.join(', '))
    }

    return {
      id: slice.id,
      parent: slice.parent,
      delivers: slice.delivers,
      status,
      label: labelOf(status, qualifiers),
      designed: isDesigned,
      satisfied: satisfied.has(slice.id),
      deps: slice.deps.map((d) => d.id),
      deps_missing: depsMissing,
      gaps,
      runs: rows.map((r) => ({ runstamp: r.runstamp, status: r.status, label: r.label })),
      merged_sha: delivered ? (delivered.merged_sha || '') : '',
    }
  })

  const byId = new Map(derived.map((s) => [s.id, s]))

  // The frontier is what could be worked on now: deps all satisfied, nothing delivered yet.
  const frontier = derived
    .filter((s) => s.deps_missing.length === 0 && s.status !== 'delivered' &&
      s.status !== 'landed' && s.status !== 'unknown')
    .map((s) => s.id)

  // Programme-complete is a DIFFERENT predicate from an empty frontier, and conflating them is
  // how a programme with an unruled gap and nothing dispatchable reads as finished. An empty
  // frontier says "nothing can start"; complete says "everything arrived and nothing is open".
  const blockers = []
  for (const slice of derived) {
    if (slice.status === 'landed') continue
    if (slice.status === 'delivered' && slice.gaps.length === 0) continue
    blockers.push(slice.id + ': ' + slice.label)
  }

  return {
    name,
    advance: plan.advance,
    degraded,
    slices: derived,
    groups: foldGroups(plan, byId),
    frontier,
    complete: blockers.length === 0 && derived.length > 0,
    blockers,
    unattributed,
    opened: events.find((e) => e.event === 'opened') || null,
  }
}

/**
 * Pure. Each group reports how many of its slices arrived, recursively.
 *
 * A group is not a slice and has no status of its own; a count is the only honest thing it can
 * say. Printing a status word on a group would invent one.
 */
function foldGroups(plan, byId) {
  const groups = plan.nodes.filter((n) => n.kind === 'group')
  const childrenOf = (id) => plan.nodes.filter((n) => n.parent === id)

  const count = (id) => {
    let delivered = 0
    let total = 0

    for (const child of childrenOf(id)) {
      if (child.kind === 'slice') {
        const slice = byId.get(child.id)
        total += 1
        if (slice.status === 'delivered' || slice.status === 'landed') delivered += 1
      } else {
        const inner = count(child.id)
        delivered += inner.delivered
        total += inner.total
      }
    }

    return { delivered, total }
  }

  return groups.map((group) => {
    const { delivered, total } = count(group.id)
    return { id: group.id, parent: group.parent, delivered, total,
             label: delivered + '/' + total + ' delivered' }
  })
}

// ============================================================ drift
//
// After a slice lands, the question is whether it moved anything a PENDING slice was designed
// against. Mechanical first, judged second: the intersection is computed here and the ruling —
// unaffected, re-design, re-slice — is the user's.
//
// Prefix-grained, and that is a stated limit rather than an oversight. `provides.paths` are
// directory prefixes, so this catches a contract's files moving, being deleted, or gaining
// neighbours; it cannot see a semantic change inside a file it never names. The user rules on
// every flag regardless, so the check errs toward showing rather than filtering.

const under = (file, prefix) => {
  const path = String(file).split('\\').join('/')
  const root = String(prefix).split('\\').join('/')
  return path === root || path.startsWith(root.endsWith('/') ? root : root + '/')
}

/**
 * Pure. Which pending slices a set of moved files touches, through the contracts they consume.
 *
 * @param {object} plan     a parsed programme graph
 * @param {object} derived  the derived view, for who is pending and who is designed
 * @param {string[]} moved  repo-relative paths, raw from git
 * @returns {{flagged: object[], unexamined: string[], moved: number}}
 *
 * `unexamined` is the half that makes this honest. An undesigned slice declares nothing to
 * intersect, so it is NAMED rather than silently passed: "no flag" and "nothing to check
 * against" are different answers, and reporting the second as the first is how a programme
 * reassures a user about a slice nobody looked at.
 */
export function driftCheck(plan, derived, moved) {
  const pathsOf = new Map()
  for (const node of plan.nodes) {
    for (const contract of node.provides) pathsOf.set(contract.name, contract.paths)
  }

  const byId = new Map(plan.nodes.map((n) => [n.id, n]))
  const pending = derived.slices.filter((s) =>
    s.status !== 'delivered' && s.status !== 'landed' && s.status !== 'in-flight')

  const flagged = []
  const unexamined = []

  for (const slice of pending) {
    if (!slice.designed) { unexamined.push(slice.id); continue }

    for (const name of byId.get(slice.id).consumes) {
      const hits = moved.filter((file) =>
        (pathsOf.get(name) || []).some((prefix) => under(file, prefix)))

      if (hits.length > 0) flagged.push({ slice: slice.id, contract: name, paths: hits })
    }
  }

  return { flagged, unexamined, moved: moved.length }
}

// ============================================================ design documents
//
// The machine-readable half of a design document. Everything downstream that consumes one does
// it through these markers rather than by reading prose: the change is EXTRACTED, never
// composed, and the notes payload is concatenated byte for byte. No model sits between a
// ratified document and the planner's prompt.

const SECTION_OPEN = /<!--\s*agentics:section\s+([a-z0-9-]+)\s*-->/g
const SECTION_CLOSE = /<!--\s*\/agentics:section\s*-->/g

/** Pure. Every marked section in a document, by name. Later copies of a name win. */
export function sectionsOf(text) {
  const found = new Map()
  const source = String(text || '')

  SECTION_OPEN.lastIndex = 0
  let open
  while ((open = SECTION_OPEN.exec(source))) {
    SECTION_CLOSE.lastIndex = SECTION_OPEN.lastIndex
    const close = SECTION_CLOSE.exec(source)
    if (!close) break

    found.set(open[1], source.slice(SECTION_OPEN.lastIndex, close.index).trim())
    SECTION_OPEN.lastIndex = close.index
  }

  return found
}

/** What a leaf must carry to be a finished design, and what a root must. */
export const LEAF_SECTIONS = ['change', 'decisions', 'settled-evidence']
export const ROOT_SECTIONS = ['settled-evidence']

/**
 * The one OPTIONAL marker, and the reason it is not in the list above.
 *
 * `LEAF_SECTIONS` is not a menu of markers — it is the completeness predicate. `missingSections`
 * computes it on every read and it decides whether a slice is `designed` or goes back to
 * `awaiting-design`, so a fourth name added there would re-derive every design document already
 * on disk as unfinished, retroactively, on the next read of the programme. A document without
 * this section is complete and always was: absent means "this design did not name its ground",
 * which is a fact about the design rather than a defect in it.
 *
 * `ground` is the paths a design session established the change lives in. It feeds `develop`'s
 * `ground` input, which is CHECKED: the workflow reads a knowledge-base chain over those paths
 * and collapses the survey only if every one carries a fresh entry, so a wrong value refuses the
 * collapse and says which path and why — it costs a survey nobody needed to skip.
 *
 * It is emphatically NOT `locus`. That input is DECLARED: it puts the run on the fix lane, drops
 * survey and decomposition outright, and fences what the coder may touch, so a wrong value
 * misroutes the whole run. The fix lane's locus stays a caller declaration made in the develop
 * session and is never fed from a document.
 */
export const GROUND_SECTION = 'ground'

/**
 * Pure. Which required sections a document does not carry.
 *
 * This is the completeness signal for a leaf, and it is why a session that dies mid-design
 * needs no recovery ceremony: what it leaves behind is a document that does not yet parse as
 * finished, which routes straight back to `awaiting-design`.
 */
export const missingSections = (text, required) => {
  const found = sectionsOf(text)
  return required.filter((name) => !found.has(name) || found.get(name) === '')
}

/**
 * Pure. The `notes` payload for one slice's run: byte-for-byte concatenation, never a summary.
 *
 * @returns {{notes: string}|{error: string}}
 *
 * A missing marker fails LOUDLY and by name. The alternative — quietly emitting what was
 * there — makes an empty payload indistinguishable from a design that genuinely settled
 * nothing, and the run then re-litigates questions somebody already answered while reporting
 * that it inherited settled evidence.
 */
export function assembleNotes({ slice, rootText, leafText, deps }) {
  const rootMissing = missingSections(rootText, ROOT_SECTIONS)
  if (rootMissing.length > 0) {
    return reject('the root design is missing its ' + rootMissing.join(', ') + ' section(s)')
  }

  const leafMissing = missingSections(leafText, LEAF_SECTIONS)
  if (leafMissing.length > 0) {
    return reject('the leaf design for ' + slice + ' is missing its ' +
      leafMissing.join(', ') + ' section(s), so it is not a finished design')
  }

  const root = sectionsOf(rootText)
  const leaf = sectionsOf(leafText)

  const predecessors = deps.length === 0
    ? 'This slice has no predecessors.'
    : deps.map((d) => '- ' + d.id + ' delivered at ' + (d.merged_sha || '(no sha recorded)') +
        (d.delivers ? ' — ' + d.delivers : '')).join('\n')

  // This function names the sections it emits one at a time, so a marker written into a document
  // and not named HERE is inert — present in the file, absent from every consumer.
  const ground = (leaf.get(GROUND_SECTION) || '').trim()

  return {
    notes: [
      'SETTLED EVIDENCE FROM THE ROOT DESIGN:',
      root.get('settled-evidence'),
      '',
      'DECISIONS FOR THIS SLICE:',
      leaf.get('decisions'),
      '',
      'SETTLED EVIDENCE FOR THIS SLICE:',
      leaf.get('settled-evidence'),
      ...(ground ? ['', 'GROUND THIS SLICE WAS DESIGNED IN:', ground] : []),
      '',
      'PREDECESSOR SLICES ALREADY ON THE PROGRAMME BRANCH — their work is in the tree you are',
      'surveying, and their contracts are the ones this slice was designed against:',
      predecessors,
    ].join('\n'),
  }
}

// ============================================================ rendering
//
// One renderer, two consumers: stdout (once, or re-run under --watch) and the on-disk mirror.
// Deterministic and never composed by a model — a progress view a model writes is a progress
// view that can be wrong in a way nothing detects.

const INDENT = '  '

/** Pure. The hierarchical tree, frontier first. */
export function renderTree(derived) {
  const lines = []
  const groupById = new Map(derived.groups.map((g) => [g.id, g]))
  const childrenOf = (parent) => [
    ...derived.groups.filter((g) => g.parent === parent),
    ...derived.slices.filter((s) => s.parent === parent),
  ]

  lines.push(derived.name + '   [' + derived.advance + ']' +
    (derived.degraded ? '   UNKNOWN — ' + derived.degraded : ''))

  const walk = (parent, depth) => {
    for (const child of childrenOf(parent)) {
      const pad = INDENT.repeat(depth + 1)
      if (groupById.has(child.id)) {
        lines.push(pad + child.id + '   ' + child.label)
        walk(child.id, depth + 1)
      } else {
        lines.push(pad + child.id.padEnd(16) + child.label +
          (child.delivers ? '   — ' + child.delivers : ''))
        for (const gap of child.gaps) lines.push(pad + INDENT + 'gap: ' + gap)
        for (const run of child.runs) {
          lines.push(pad + INDENT + 'run ' + run.runstamp + ': ' + run.label)
        }
      }
    }
  }

  walk('', 0)

  lines.push('')
  lines.push('frontier: ' + (derived.frontier.length > 0 ? derived.frontier.join(', ') : '(empty)'))
  lines.push(derived.complete
    ? 'programme-complete: every slice arrived and nothing is open.'
    : 'not complete: ' + derived.blockers.length + ' slice(s) outstanding.')

  for (const blocker of derived.blockers) lines.push(INDENT + blocker)

  if (derived.unattributed.length > 0) {
    lines.push('')
    lines.push('UNATTRIBUTED RUNS — tagged for a programme or slice this graph does not carry.')
    lines.push('They are shown rather than dropped, and never guessed into a slice:')
    for (const row of derived.unattributed) {
      lines.push(INDENT + row.runstamp + '  [' + row.programme + '/' + row.slice + ']  ' +
        row.label + '  ' + row.change)
    }
  }

  return lines.join('\n') + '\n'
}

/** Pure. The generated graph section spliced into plan.md. Prose explains; this restates. */
export function graphView(derived) {
  const lines = ['```', renderTree(derived).trimEnd(), '```']
  return lines.join('\n')
}

const VIEW_OPEN = '<!-- agentics:graph -->'
const VIEW_CLOSE = '<!-- /agentics:graph -->'

/**
 * Pure. Replace the generated section of a plan.md, or append one when it has none.
 *
 * The markers are what keep the authored half and the generated half apart. Without them a
 * regeneration would either overwrite the reasons a human wrote or be appended forever.
 */
export function spliceView(planMd, view) {
  const body = VIEW_OPEN + '\n' + view + '\n' + VIEW_CLOSE
  const text = String(planMd || '')
  const start = text.indexOf(VIEW_OPEN)
  const end = text.indexOf(VIEW_CLOSE)

  if (start === -1 || end === -1 || end < start) {
    return text.trimEnd() + '\n\n## The graph, generated\n\n' + body + '\n'
  }

  return text.slice(0, start) + body + text.slice(end + VIEW_CLOSE.length)
}

// ============================================================ the reader
//
// Everything below touches the filesystem. Kept apart from the core above so the arithmetic
// can be tested over fixtures without building a repository per case.

/**
 * Where this programme's design tree actually lives. The programme worktree when it exists,
 * because leaf documents and plan revisions are committed on the programme branch and reach
 * the user's checkout only at landing; the repository root otherwise.
 */
export function designRoot(root, name) {
  const inWorktree = join(root, worktreeOf(name))
  return existsSync(join(inWorktree, DESIGNS_DIR, name)) ? inWorktree : root
}

const designDir = (root, name) => join(designRoot(root, name), DESIGNS_DIR, name)

const readOr = (path, fallback) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return fallback
  }
}

/** Every programme in a repository: a design directory carrying a programme.json. */
export function listProgrammes(root) {
  const names = new Set()

  for (const base of [root, join(root, '.claude', 'worktrees')]) {
    const designs = base === root ? [join(root, DESIGNS_DIR)] : worktreeDesignDirs(base)

    for (const dir of designs) {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (existsSync(join(dir, entry.name, 'programme.json'))) names.add(entry.name)
      }
    }
  }

  return [...names].sort()
}

/** The `docs/agentics/designs` directory inside each programme worktree, if any exist. */
function worktreeDesignDirs(worktrees) {
  try {
    return readdirSync(worktrees, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('programme-'))
      .map((e) => join(worktrees, e.name, DESIGNS_DIR))
  } catch {
    return []
  }
}

export const stateFileOf = (root, name) => join(root, PROGRAMMES_DIR, name, 'state.jsonl')
export const mirrorFileOf = (root, name) => join(root, PROGRAMMES_DIR, name, 'progress.md')

/**
 * Read everything one programme needs and derive it.
 *
 * Run rows come from BOTH run directories — the repository's own and the programme
 * worktree's — because a slice run is dispatched with `roots` set to the worktree and writes
 * its run directory there. Reading only the repository's would report every slice run of the
 * programme as missing.
 *
 * The parsed graph travels back beside the derived view because two consumers need it and the
 * derived view deliberately does not carry it: `driftCheck` reads `consumes` and `provides`,
 * which are authored facts, and re-parsing the file to get at them would be a second reading
 * that could disagree with the first.
 *
 * @returns {{derived: object, plan: object}|{error: string}}
 */
export function loadProgramme(root, name) {
  const dir = designDir(root, name)

  let raw
  try {
    raw = JSON.parse(readFileSync(join(dir, 'programme.json'), 'utf8'))
  } catch (err) {
    return reject(name + ': programme.json could not be read: ' + err.message)
  }

  const parsed = parseProgramme(raw)
  if (parsed.error) return reject(name + ': ' + parsed.error)

  // A state file that exists but will not read is a different fact from one that is not there
  // yet, and only the first freezes the programme. An absent file is simply a programme with
  // no events.
  const statePath = stateFileOf(root, name)
  let degraded = ''
  let events = []

  if (existsSync(statePath)) {
    let text
    try {
      text = readFileSync(statePath, 'utf8')
    } catch (err) {
      degraded = 'state.jsonl exists but could not be read: ' + err.message
    }

    if (!degraded) {
      const log = parseEvents(text)
      if (log.error) degraded = log.error
      else events = log.events
    }
  }

  const designed = {}
  for (const node of parsed.plan.nodes) {
    if (node.kind !== 'slice') continue
    const leaf = readOr(join(dir, 'slices', node.id + '.md'), '')
    designed[node.id] = leaf !== '' && missingSections(leaf, LEAF_SECTIONS).length === 0
  }

  // Provenance, stamped here because only this function knows where each row came from. A run
  // sitting in the programme's OWN worktree belongs to this programme by construction — the
  // layer put it there — and that is the only thing still true about a run whose plan.json is
  // torn: the tags that would attribute it are exactly what became unreadable.
  const runs = readRuns(root)
    .concat(readRuns(join(root, worktreeOf(name))).map((r) => ({ ...r, in_programme_tree: true })))

  return {
    plan: parsed.plan,
    derived: deriveProgramme({
      name, plan: parsed.plan, events, designed, runs, degraded, known: listProgrammes(root),
    }),
  }
}

/** Write the on-disk mirror. Regenerated by the renderer, never composed, never hand-edited. */
export function writeMirror(root, name, derived, stamp) {
  const path = mirrorFileOf(root, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path,
    '<!-- generated by lib/programme.mjs at ' + stamp + ' — do not edit; every append rewrites it -->\n\n' +
    '```\n' + renderTree(derived).trimEnd() + '\n```\n', 'utf8')
  return path
}

/** Append one validated event. The append verbs are the only way a line reaches this file. */
export function appendEvent(root, name, entry) {
  const path = stateFileOf(root, name)
  const existing = existsSync(path) ? parseEvents(readFileSync(path, 'utf8')) : { events: [] }

  if (existing.error) return reject('refusing to append to a log that does not read: ' + existing.error)

  const refusal = appendCheck(existing.events, entry)
  if (refusal) return reject(refusal)

  mkdirSync(dirname(path), { recursive: true })

  // Append the one new line rather than rewriting every line that was already there. The
  // rewrite was doing its work at the single moment this layer records progress, so an
  // interruption mid-write took the whole delivery history with it — days of merged slices —
  // where an interrupted append costs one torn line, which `parseEvents` already fails closed
  // on and a human can genuinely repair.
  const line = JSON.stringify(entry) + '\n'
  if (existsSync(path)) appendFileSync(path, line, 'utf8')
  else writeFileSync(path, line, 'utf8')

  return { appended: entry, path }
}

// ============================================================ the CLI

/** Pure. Flags as a map; a repeated flag keeps its last value, a bare flag is `true`. */
export function parseArgs(argv) {
  const flags = {}
  const positional = []

  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { positional.push(argv[i]); continue }

    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) flags[key] = true
    else { flags[key] = next; i++ }
  }

  return { flags, positional }
}

/** Pure. Which gaps a ruling covers, resolved against what the delivery actually named. */
export function resolveGaps(spec, unreached) {
  if (spec === 'all') return { gaps: unreached.slice() }
  if (spec === 'none') return { gaps: [] }

  const gaps = []
  for (const part of String(spec).split(',')) {
    const index = Number(part.trim())
    if (!Number.isInteger(index) || index < 0 || index >= unreached.length) {
      return reject('--gaps names index ' + part.trim() + ', and the delivery reported ' +
        unreached.length + ' gap(s). The CLI copies gap text exact-string from the delivery, ' +
        'so an index is the only thing a caller may supply.')
    }
    gaps.push(unreached[index])
  }
  return { gaps }
}

const fail = (message) => { console.log(JSON.stringify({ error: message })); process.exit(1) }

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  const { flags, positional } = parseArgs(process.argv.slice(2))
  const root = positional[0] || process.cwd()

  // Standalone section extraction, before any programme is looked for.
  //
  // A single-change design is one document with the same markers a programme leaf carries,
  // and its `change` section is what gets handed to develop. That hand-off was a session
  // reading the document and typing the string into an argument — and the string is a KEY:
  // develop's existing_run guard and its resume change guard both compare it exactly. A
  // rewrapped line or a normalized dash between two sessions is a different change as far as
  // those guards can tell, so the duplicate they exist to catch sails straight through and
  // the same work is planned and implemented twice.
  //
  // Bytes never ride a model. This prints the section verbatim, from the file.
  if (typeof flags.section === 'string' && typeof flags.file === 'string') {
    const text = readOr(flags.file, '')
    if (text === '') fail('could not read ' + flags.file)

    const section = sectionsOf(text).get(flags.section)
    if (section === undefined) {
      fail(flags.file + ' carries no <!-- agentics:section ' + flags.section + ' --> marker, so it ' +
        'is not a finished design and there is nothing to hand to develop')
    }

    console.log(section)
    process.exit(0)
  }

  const names = listProgrammes(root)
  let name = typeof flags.programme === 'string' ? flags.programme : ''

  if (!name) {
    if (names.length === 0) fail('no programme.json exists under ' + DESIGNS_DIR)
    if (names.length > 1) {
      // Not an error: several programmes is a normal state, and choosing between them is the
      // user's call rather than this tool's.
      console.log(JSON.stringify({ programmes: names }))
      process.exit(0)
    }
    name = names[0]
  }

  const load = () => {
    const result = loadProgramme(root, name)
    if (result.error) fail(result.error)
    return result
  }

  // --- the append verbs -------------------------------------------------------------------

  const appendVerb = EVENT_TYPES.find((type) =>
    flags['append-' + (type === 'merged-to-base' ? 'merged' : type)])

  if (appendVerb) {
    const { derived } = load()
    let entry

    if (appendVerb === 'opened') {
      entry = { event: 'opened', base_branch: flags['base-branch'], base_sha: flags['base-sha'] }
    } else if (appendVerb === 'delivered') {
      // A delivery names a run, and that run has to have actually finished. The skill says so,
      // and this plugin's own existing_run rationale says why prose is not enough: a skill
      // instruction guards only the callers that read it. Recording a checkpointed or still
      // in-flight run as delivered poisons the log permanently — `delivered` is terminal for
      // this slice, so the real delivery can never be appended afterwards.
      //
      // The run rows are already loaded, so this costs a lookup. `--run ''` stays open: that
      // is the declared route for brownfield work with no run behind it, and it carries a
      // required --ruling of its own.
      // Only a run this programme can actually SEE is judged. A runstamp with no row behind it
      // is not evidence of a problem — it may have been archived after it delivered, or live
      // in a tree this call cannot read — and refusing it would block a legitimate late
      // delivery. What is refused is the run standing right here, visibly unfinished.
      if (typeof flags.run === 'string' && flags.run !== '') {
        const named = derived.slices.flatMap((s) => s.runs || [])
          .concat(derived.unattributed || [])
          .find((r) => r.runstamp === flags.run)

        if (named && !FINISHED.has(named.status)) {
          fail('--append-delivered names run ' + flags.run + ', whose status is "' +
            named.status + '". A delivery is terminal for this slice: recorded now, the real ' +
            'delivery can never be appended. Finish or resume the run first.')
        }
      }

      // The coverage block is copied WHOLE from the run's own result — never recomputed and
      // never summarized. An earlier draft of this layer named a `gaps` field that does not
      // exist in that block; copying the block ends the selection problem outright.
      let coverage = null
      if (typeof flags.coverage === 'string') {
        try {
          coverage = JSON.parse(readFileSync(flags.coverage, 'utf8'))
        } catch (err) {
          fail('--coverage ' + flags.coverage + ' could not be read as JSON: ' + err.message)
        }
      }

      entry = { event: 'delivered', slice: flags.slice, run: flags.run || '',
                merged_sha: flags['merged-sha'] || '' }
      if (coverage) entry.coverage = coverage
      if (typeof flags.ruling === 'string') entry.ruling = flags.ruling
    } else if (appendVerb === 'accepted') {
      const delivered = (loadEvents(root, name) || [])
        .find((e) => e.event === 'delivered' && e.slice === flags.slice)
      const unreached = (delivered && delivered.coverage && delivered.coverage.unreached) || []
      const resolved = resolveGaps(flags.gaps === undefined ? 'none' : flags.gaps, unreached)
      if (resolved.error) fail(resolved.error)

      entry = { event: 'accepted', slice: flags.slice, gaps: resolved.gaps,
                ruling: flags.ruling, by: flags.by }
    } else {
      // Which slices the merge carried is DERIVED rather than typed: everything delivered and
      // not yet merged is exactly what was on the branch, and a hand-typed list is a list that
      // can disagree with the tree.
      const already = new Set((loadEvents(root, name) || [])
        .filter((e) => e.event === 'merged-to-base').flatMap((e) => e.slices || []))
      const slices = derived.slices
        .filter((s) => s.status === 'delivered' && !already.has(s.id)).map((s) => s.id)

      entry = { event: 'merged-to-base', sha: flags.sha, base_branch: flags['base-branch'],
                slices }
    }

    const written = appendEvent(root, name, entry)
    if (written.error) fail(written.error)

    const after = load().derived
    writeMirror(root, name, after, new Date().toISOString())
    console.log(JSON.stringify({ appended: entry, frontier: after.frontier,
                                complete: after.complete }))
    process.exit(0)
  }

  // --- reads ------------------------------------------------------------------------------

  if (typeof flags.drift === 'string') {
    // git is asked here rather than by the caller, for the same reason `run-status.mjs` asks
    // it: the intersection has to be computed over what git actually printed, and a diff that
    // passed through a model's summary is not a diff.
    const worktree = join(root, worktreeOf(name))
    const diff = spawnSync('git', ['-C', worktree, 'diff', '--name-only', flags.drift + '..HEAD'],
      { encoding: 'utf8' })

    if (diff.error || diff.status !== 0) {
      fail('git diff --name-only ' + flags.drift + '..HEAD failed in ' + worktree + ': ' +
        ((diff.stderr || '').trim() || (diff.error && diff.error.message) || 'unknown'))
    }

    const { plan, derived } = load()
    const moved = diff.stdout.split('\n').map((l) => l.trim()).filter(Boolean)

    console.log(JSON.stringify(driftCheck(plan, derived, moved)))
    process.exit(0)
  }

  // The slice's change string, printed byte-exact from the marked section.
  //
  // It was being read by a session and retyped into develop's `change` argument, and that
  // argument is a KEY: the existing_run guard and the resume change guard both compare it
  // exactly. A rewrapped line or a normalized dash between two sessions is a different change
  // as far as those guards can tell, so the duplicate they exist to catch sails through and
  // the same slice is planned twice. Bytes never ride a model — this is that law applied to
  // the one string the layer's own guards are keyed on.
  if (typeof flags.change === 'string') {
    const { derived } = load()
    const slice = derived.slices.find((s) => s.id === flags.change)
    if (!slice) fail('this programme has no slice named ' + flags.change)

    const leaf = readOr(join(designDir(root, name), 'slices', slice.id + '.md'), '')
    const section = sectionsOf(leaf).get('change')

    if (!section) {
      fail('the leaf for ' + slice.id + ' carries no <!-- agentics:change --> section, so it is ' +
        'not a finished design and there is no change string to hand to develop')
    }

    console.log(section)
    process.exit(0)
  }

  if (typeof flags.notes === 'string') {
    const { derived } = load()
    const dir = designDir(root, name)
    const slice = derived.slices.find((s) => s.id === flags.notes)
    if (!slice) fail('this programme has no slice named ' + flags.notes)

    const byId = new Map(derived.slices.map((s) => [s.id, s]))
    const deps = slice.deps.map((id) => byId.get(id))
      .map((dep) => ({ id: dep.id, merged_sha: dep.merged_sha, delivers: dep.delivers }))

    const assembled = assembleNotes({
      slice: slice.id,
      rootText: readOr(join(dir, 'system.md'), ''),
      leafText: readOr(join(dir, 'slices', slice.id + '.md'), ''),
      deps,
    })
    if (assembled.error) fail(assembled.error)

    console.log(assembled.notes)
    process.exit(0)
  }

  const render = () => {
    const { derived } = load()
    const text = renderTree(derived)

    if (flags['write-view']) {
      const planPath = join(designDir(root, name), 'plan.md')
      writeFileSync(planPath, spliceView(readOr(planPath, '# plan\n'), graphView(derived)), 'utf8')
    }
    if (typeof flags.out === 'string') writeFileSync(flags.out, text, 'utf8')
    if (flags.json) console.log(JSON.stringify(derived))
    else console.log(text)

    return derived
  }

  render()

  if (flags.watch) {
    // The state file and BOTH run directories: a slice run writes its state under the
    // programme worktree, and watching only the repository's would show a live run as idle.
    const targets = [
      join(root, PROGRAMMES_DIR, name),
      join(root, '.claude', 'agentics', 'runs'),
      join(root, worktreeOf(name), '.claude', 'agentics', 'runs'),
    ]

    let pending = null
    const bump = () => {
      clearTimeout(pending)
      pending = setTimeout(() => { try { render() } catch { /* a half-written file; the next event re-renders */ } }, 250)
    }

    for (const target of targets) {
      try {
        watch(target, { recursive: true }, bump)
      } catch { /* a directory that does not exist yet is not an error; it may never exist */ }
    }
  } else {
    process.exit(0)
  }
}

/** The events on disk, or null when they cannot be read. Used only by the append verbs. */
function loadEvents(root, name) {
  const path = stateFileOf(root, name)
  if (!existsSync(path)) return []
  const parsed = parseEvents(readFileSync(path, 'utf8'))
  return parsed.error ? null : parsed.events
}
