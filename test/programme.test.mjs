// test/programme.test.mjs — the arithmetic of lib/programme.mjs.
//
// Everything here exercises the pure core, so there is no repository fixture: every
// filesystem fact — marker completeness, run rows, events — is an argument. That is the whole
// reason the core takes them as arguments.
//
// The cases worth writing are the ones where a wrong answer is worse than no answer. A
// programme graph that loads with a `consumes` naming a slice it does not depend on schedules
// work against something that does not exist yet, and the failure surfaces two stages later
// as a confused coder. A slice reported `delivered` while a gap nobody ruled on sits open lets
// its dependents build on incomplete work. An empty frontier read as "finished" reports a
// programme complete while a slice is stuck.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseProgramme, parseEvents, appendCheck, isSatisfied, openGaps, labelOf,
  deriveProgramme, driftCheck, sectionsOf, missingSections, assembleNotes, renderTree,
  spliceView, parseArgs, resolveGaps, LEAF_SECTIONS, ROOT_SECTIONS, GROUND_SECTION,
} from '../lib/programme.mjs'

// A two-slice programme under one group: walk provides what hug consumes.
const GRAPH = () => ({
  advance: 'gated',
  nodes: [
    { id: 'world', kind: 'group', parent: '' },
    { id: 'walk', kind: 'slice', parent: 'world', delivers: 'a walkable meadow',
      deps: [], provides: [{ name: 'NavigationGrid', paths: ['src/core/navigation/'] }],
      consumes: [] },
    { id: 'hug', kind: 'slice', parent: 'world', delivers: 'the first need met',
      deps: ['walk'], provides: [{ name: 'NeedLifecycle', paths: ['src/core/needs/'] }],
      consumes: ['NavigationGrid'] },
  ],
})

const planOf = (over) => {
  const parsed = parseProgramme(over ? over(GRAPH()) : GRAPH())
  assert.ok(parsed.plan, 'fixture did not parse: ' + parsed.error)
  return parsed.plan
}

const coverage = (over = {}) => ({
  complete: true, dropped: [], incomplete: [], failed_channels: [], unreached: [],
  resumable: { runId: 'r', remaining: [] }, ...over,
})

const deliveredEvent = (slice, over = {}) => ({
  event: 'delivered', slice, run: '20260817-091412', merged_sha: '4f2a91c',
  coverage: coverage(), ...over,
})

const row = (over = {}) => ({
  runstamp: '20260817-091412', change: 'walk', programme: 'eva', slice: 'walk',
  status: 'in-flight', label: 'in-flight', ...over,
})

const derive = (over = {}) => deriveProgramme({
  name: 'eva', plan: planOf(), events: [], designed: {}, runs: [], degraded: '', ...over,
})

const sliceIn = (derived, id) => derived.slices.find((s) => s.id === id)

// ============================================================ the loader
//
// Eleven rejections, enumerated and closed. Every one of them is a way the file can be
// internally inconsistent in a manner nothing downstream would notice.

test('a well-formed graph loads, and defaults advance to gated', () => {
  const parsed = parseProgramme(GRAPH())

  assert.equal(parsed.error, undefined)
  assert.equal(parsed.plan.advance, 'gated')
  assert.equal(parsed.plan.nodes.length, 3)
})

test('R1: something that is not an object with a nodes array is not a programme', () => {
  assert.match(parseProgramme(null).error, /nodes array/)
  assert.match(parseProgramme([]).error, /nodes array/)
  assert.match(parseProgramme({}).error, /nodes array/)
  assert.match(parseProgramme('x').error, /nodes array/)
})

test('R2: a node with no id, and a duplicate id', () => {
  assert.match(parseProgramme({ nodes: [{ kind: 'slice' }] }).error, /non-empty string id/)
  assert.match(parseProgramme({ nodes: [{ id: '  ', kind: 'slice' }] }).error, /non-empty string id/)
  assert.match(parseProgramme({
    nodes: [{ id: 'a', kind: 'slice' }, { id: 'a', kind: 'slice' }],
  }).error, /duplicate node id/)
})

test('R3: a kind outside group and slice', () => {
  assert.match(parseProgramme({ nodes: [{ id: 'a', kind: 'phase' }] }).error, /neither "group" nor "slice"/)
  assert.match(parseProgramme({ nodes: [{ id: 'a' }] }).error, /neither "group" nor "slice"/)
})

test('R4: a parent naming no node, or naming a slice', () => {
  assert.match(parseProgramme({
    nodes: [{ id: 'a', kind: 'slice', parent: 'ghost' }],
  }).error, /names no node/)

  assert.match(parseProgramme({
    nodes: [{ id: 'a', kind: 'slice' }, { id: 'b', kind: 'slice', parent: 'a' }],
  }).error, /parents are groups/)
})

test('R4: the empty parent is the implicit root and always legal', () => {
  assert.ok(parseProgramme({ nodes: [{ id: 'a', kind: 'slice', parent: '' }] }).plan)
  assert.ok(parseProgramme({ nodes: [{ id: 'a', kind: 'slice' }] }).plan)
})

test('R5: a containment cycle', () => {
  assert.match(parseProgramme({
    nodes: [{ id: 'a', kind: 'group', parent: 'b' }, { id: 'b', kind: 'group', parent: 'a' }],
  }).error, /containment cycle/)
})

test('R6: a dep naming no node, or naming a group', () => {
  assert.match(parseProgramme({
    nodes: [{ id: 'a', kind: 'slice', deps: ['ghost'] }],
  }).error, /which is no node/)

  assert.match(parseProgramme({
    nodes: [{ id: 'g', kind: 'group' }, { id: 'a', kind: 'slice', deps: ['g'] }],
  }).error, /deps names the group/)
})

test('R7: a dependency cycle among slices', () => {
  assert.match(parseProgramme({
    nodes: [
      { id: 'a', kind: 'slice', deps: [{ id: 'b', reason: 'x' }] },
      { id: 'b', kind: 'slice', deps: [{ id: 'a', reason: 'x' }] },
    ],
  }).error, /dependency cycle/)
})

test('R8: a contract with no name, no paths, or a name used twice', () => {
  assert.match(parseProgramme({
    nodes: [{ id: 'a', kind: 'slice', provides: [{ paths: ['src/'] }] }],
  }).error, /no non-empty name/)

  assert.match(parseProgramme({
    nodes: [{ id: 'a', kind: 'slice', provides: [{ name: 'Grid', paths: [] }] }],
  }).error, /declares no paths/)

  assert.match(parseProgramme({
    nodes: [
      { id: 'a', kind: 'slice', provides: [{ name: 'Grid', paths: ['src/a/'] }] },
      { id: 'b', kind: 'slice', provides: [{ name: 'Grid', paths: ['src/b/'] }] },
    ],
  }).error, /provided by both/)
})

test('R9: consuming a contract from a slice you do not depend on', () => {
  assert.match(parseProgramme({
    nodes: [
      { id: 'a', kind: 'slice', provides: [{ name: 'Grid', paths: ['src/a/'] }] },
      { id: 'b', kind: 'slice', deps: [], consumes: ['Grid'] },
    ],
  }).error, /which it does not depend on/)
})

test('R9: a contract nobody provides', () => {
  assert.match(parseProgramme({
    nodes: [{ id: 'a', kind: 'slice', consumes: ['Ghost'] }],
  }).error, /which no slice provides/)
})

test('R9: a transitive dependency satisfies a consumes', () => {
  const parsed = parseProgramme({
    nodes: [
      { id: 'a', kind: 'slice', provides: [{ name: 'Grid', paths: ['src/a/'] }] },
      { id: 'b', kind: 'slice', deps: ['a'], consumes: ['Grid'],
        provides: [{ name: 'Move', paths: ['src/b/'] }] },
      { id: 'c', kind: 'slice', deps: ['b'], consumes: ['Grid', 'Move'] },
    ],
  })

  assert.equal(parsed.error, undefined)
})

test('R10: an ordering that carries no contract needs a reason', () => {
  assert.match(parseProgramme({
    nodes: [{ id: 'a', kind: 'slice' }, { id: 'b', kind: 'slice', deps: ['a'] }],
  }).error, /gives no reason/)

  // Pedagogy and risk sequencing are real orderings. They are legal, said out loud.
  assert.ok(parseProgramme({
    nodes: [
      { id: 'a', kind: 'slice' },
      { id: 'b', kind: 'slice', deps: [{ id: 'a', reason: 'the user learns the meadow first' }] },
    ],
  }).plan)
})

test('R11: advance outside gated and standing', () => {
  assert.match(parseProgramme({ advance: 'auto', nodes: [] }).error, /neither "gated" nor "standing"/)
  assert.equal(parseProgramme({ advance: 'standing', nodes: [] }).plan.advance, 'standing')
})

test('the loader repairs nothing — it returns one error and no partial graph', () => {
  const parsed = parseProgramme({ nodes: [{ id: 'a', kind: 'phase' }] })

  assert.equal(parsed.plan, undefined,
    'a graph this layer patched into shape is a graph the user did not author')
})

// ============================================================ the event log

test('an absent log is a programme with no events, not a failure', () => {
  assert.deepEqual(parseEvents('').events, [])
})

test('a line that is not JSON freezes the whole log', () => {
  const parsed = parseEvents('{"event":"opened"}\nnot json\n')

  assert.match(parsed.error, /line 2 is not JSON/)
  assert.equal(parsed.events, undefined,
    'a malformed line names no slice, so its blast radius is undecidable')
})

test('an unrecognised event type is a parse failure too', () => {
  assert.match(parseEvents('{"event":"gap-closed","slice":"walk"}').error, /which is not one of/)
})

test('blank lines are skipped rather than reported', () => {
  assert.equal(parseEvents('\n{"event":"opened"}\n\n').events.length, 1)
})

// --- the append verbs -----------------------------------------------------------------

test('a programme is opened once', () => {
  const opened = { event: 'opened', base_branch: 'main', base_sha: '1e6c65d' }

  assert.equal(appendCheck([], opened), null)
  assert.match(appendCheck([opened], opened), /already opened/)
})

test('a second delivery for one slice is refused', () => {
  const first = deliveredEvent('walk')

  assert.equal(appendCheck([], first), null)
  assert.match(appendCheck([first], deliveredEvent('walk')), /already delivered/)
  assert.equal(appendCheck([first], deliveredEvent('hug')), null)
})

test('an external delivery needs the ruling that is its entire evidence', () => {
  const external = { event: 'delivered', slice: 'walk', run: '', merged_sha: 'abc' }

  assert.match(appendCheck([], external), /needs a ruling/)
  assert.equal(appendCheck([], { ...external, ruling: 'built by hand last month' }), null)
})

test('an acceptance needs an author, a ruling, and something delivered to rule on', () => {
  const delivered = deliveredEvent('walk', { coverage: coverage({ complete: false }) })
  const accepted = { event: 'accepted', slice: 'walk', gaps: [], ruling: 'ok', by: 'user' }

  assert.match(appendCheck([], accepted), /nothing has been delivered/)
  assert.equal(appendCheck([delivered], accepted), null)
  assert.match(appendCheck([delivered], { ...accepted, by: '' }), /a ruling has an author/)
  assert.match(appendCheck([delivered], { ...accepted, ruling: '' }), /needs a ruling/)
})

test('an unknown event type never reaches the file', () => {
  assert.match(appendCheck([], { event: 'gap-closed' }), /unknown event type/)
})

// ============================================================ satisfied
//
// The dependency gate. Delivery alone is not it: a slice delivered with gaps nobody ruled on
// is a slice whose dependents would build on incomplete work with no one having said that was
// acceptable.

test('nothing delivered satisfies nothing', () => {
  assert.equal(isSatisfied('walk', []), false)
})

test('a delivery with complete coverage satisfies', () => {
  assert.equal(isSatisfied('walk', [deliveredEvent('walk')]), true)
})

test('a delivery with an open gap does not satisfy until the gap is ruled on', () => {
  const events = [deliveredEvent('walk', {
    coverage: coverage({ complete: false, unreached: ['W6: PWA manifest deferred'] }),
  })]

  assert.equal(isSatisfied('walk', events), false)
  assert.deepEqual(openGaps('walk', events), ['W6: PWA manifest deferred'])

  const ruled = events.concat([{ event: 'accepted', slice: 'walk',
    gaps: ['W6: PWA manifest deferred'], ruling: 'ok until stage 4', by: 'user' }])

  assert.equal(isSatisfied('walk', ruled), true)
  assert.deepEqual(openGaps('walk', ruled), [])
})

test('one gap ruled on out of two still leaves the slice unsatisfied', () => {
  const events = [
    deliveredEvent('walk', { coverage: coverage({ complete: false, unreached: ['a', 'b'] }) }),
    { event: 'accepted', slice: 'walk', gaps: ['a'], ruling: 'fine', by: 'user' },
  ]

  assert.equal(isSatisfied('walk', events), false)
  assert.deepEqual(openGaps('walk', events), ['b'])
})

test('incomplete coverage naming no gap still needs a ruling', () => {
  // The hardest case to notice and the easiest to wave through: a run that says it is not
  // complete while naming nothing. Incompleteness is never waived in silence.
  const events = [deliveredEvent('walk', { coverage: coverage({ complete: false }) })]

  assert.equal(isSatisfied('walk', events), false)

  const ruled = events.concat([{ event: 'accepted', slice: 'walk', gaps: [],
    ruling: 'nothing outstanding that matters', by: 'user' }])

  assert.equal(isSatisfied('walk', ruled), true)
})

test('an external delivery is satisfied by construction — the voucher is the ruling', () => {
  const events = [{ event: 'delivered', slice: 'walk', run: '', merged_sha: 'abc',
                    ruling: 'this was built by hand before the programme existed' }]

  assert.equal(isSatisfied('walk', events), true)
  assert.deepEqual(openGaps('walk', events), [])
})

// ============================================================ status totality
//
// Every state in the table is reachable, and no combination of inputs falls through to a
// blank. A slice rendered blank beside one somebody is waiting on reads as "fine".

test('pending: no leaf, and deps not satisfied', () => {
  assert.equal(sliceIn(derive(), 'hug').status, 'pending')
})

test('awaiting-design: deps satisfied, no leaf', () => {
  const derived = derive({ events: [deliveredEvent('walk')], designed: { walk: true } })

  assert.equal(sliceIn(derived, 'hug').status, 'awaiting-design')
})

test('blocked: leaf designed, deps not satisfied', () => {
  const derived = derive({ designed: { walk: true, hug: true } })

  assert.equal(sliceIn(derived, 'hug').status, 'blocked')
  assert.match(sliceIn(derived, 'hug').label, /waiting on walk/)
})

test('ready: leaf designed, deps satisfied, nothing in flight', () => {
  assert.equal(sliceIn(derive({ designed: { walk: true } }), 'walk').status, 'ready')
})

test('in-flight: an attributed run is still going', () => {
  const derived = derive({
    designed: { walk: true }, runs: [row({ status: 'in-flight' })],
  })

  assert.equal(sliceIn(derived, 'walk').status, 'in-flight')
})

test('in-flight: a planned run counts too — the work is dispatched, not finished', () => {
  const derived = derive({ designed: { walk: true }, runs: [row({ status: 'planned' })] })

  assert.equal(sliceIn(derived, 'walk').status, 'in-flight')
})

test('delivery-pending: the run finished and the between-slice acts did not', () => {
  // Distinguished from in-flight because the remedy differs: nothing needs building, and
  // something needs finishing.
  for (const status of ['integrated', 'landed']) {
    const derived = derive({ designed: { walk: true }, runs: [row({ status })] })
    assert.equal(sliceIn(derived, 'walk').status, 'delivery-pending', status)
  }
})

test('delivered: an event names it, and gaps qualify the word', () => {
  const clean = derive({ events: [deliveredEvent('walk')] })
  assert.equal(sliceIn(clean, 'walk').status, 'delivered')
  assert.equal(sliceIn(clean, 'walk').label, 'delivered')

  const open = derive({
    events: [deliveredEvent('walk', {
      coverage: coverage({ complete: false, unreached: ['a', 'b'] }),
    })],
  })
  assert.equal(sliceIn(open, 'walk').status, 'delivered')
  assert.match(sliceIn(open, 'walk').label, /2 gaps open/)
})

test('landed: a merged-to-base event includes it', () => {
  const derived = derive({
    events: [deliveredEvent('walk'),
      { event: 'merged-to-base', sha: 'e07f4a2', base_branch: 'main', slices: ['walk'] }],
  })

  assert.equal(sliceIn(derived, 'walk').status, 'landed')
})

test('unknown: an attributed run cannot be read', () => {
  const derived = derive({
    designed: { walk: true }, runs: [row({ status: 'unreadable', label: 'unreadable' })],
  })

  assert.equal(sliceIn(derived, 'walk').status, 'unknown')
  assert.match(sliceIn(derived, 'walk').label, /unmeasured/)
})

// The fixture above carries tags, and a genuinely unreadable run cannot: `run-status` reads
// the tags OUT of plan.json, so the file that failed to parse is the file the tags live in.
// Every real unreadable row arrives blank, which used to drop it on the untagged line and
// leave the branch above unreachable — a torn plan.json read as "no run here at all", and the
// slice as ready to dispatch over work that may already have merged.
test('unknown: an unreadable run in the programme worktree freezes the programme', () => {
  const torn = {
    runstamp: '20260817-091412', change: '', programme: '', slice: '',
    status: 'unreadable', label: 'unreadable', in_programme_tree: true,
  }
  const derived = derive({ designed: { walk: true }, runs: [torn] })

  assert.ok(derived.slices.every((s) => s.status === 'unknown'),
    'an unreadable run names no slice, so its blast radius is undecidable')
  assert.match(derived.degraded, /cannot be read/)
  assert.match(derived.degraded, /20260817-091412/)
  assert.equal(derived.complete, false)
})

test('an unreadable run OUTSIDE the programme worktree is not this layer/s business', () => {
  const foreign = {
    runstamp: '20260817-091412', change: '', programme: '', slice: '',
    status: 'unreadable', label: 'unreadable',
  }
  const derived = derive({ designed: { walk: true }, runs: [foreign] })

  assert.equal(derived.degraded, '',
    'a torn run in the user/s own runs dir belongs to the `runs` skill, not to a programme')
  assert.equal(sliceIn(derived, 'walk').status, 'ready')
})

test('unknown: a degraded event log freezes every slice', () => {
  const derived = derive({ degraded: 'state.jsonl line 4 is not JSON' })

  assert.ok(derived.slices.every((s) => s.status === 'unknown'),
    'a malformed line names no slice, so freezing everything is the only safe reading')
  assert.equal(derived.complete, false)
})

test('an unknown slice never satisfies its dependents', () => {
  const derived = derive({ degraded: 'unreadable' })

  assert.equal(sliceIn(derived, 'hug').satisfied, false)
})

test('every slice gets a status word, whatever the inputs', () => {
  const KNOWN = new Set(['pending', 'awaiting-design', 'blocked', 'ready', 'in-flight',
    'delivery-pending', 'delivered', 'landed', 'unknown'])

  for (const designed of [{}, { walk: true }, { walk: true, hug: true }]) {
    for (const events of [[], [deliveredEvent('walk')], [deliveredEvent('hug')]]) {
      for (const runs of [[], [row()], [row({ status: 'integrated' })], [row({ status: 'unreadable' })]]) {
        for (const slice of derive({ designed, events, runs }).slices) {
          assert.ok(KNOWN.has(slice.status),
            'unmapped: ' + slice.id + ' -> ' + JSON.stringify(slice.status))
        }
      }
    }
  }
})

// ============================================================ attribution

test('a run tagged for a slice this graph does not carry is unattributed, never dropped', () => {
  const derived = derive({ runs: [row({ slice: 'nap' })] })

  assert.equal(derived.unattributed.length, 1)
  assert.ok(derived.slices.every((s) => s.runs.length === 0),
    'a nearly-right tag is never guessed into a slice')
})

test('a run tagged for a programme that does not exist is unattributed', () => {
  const derived = derive({ runs: [row({ programme: 'ghost' })], known: ['eva'] })

  assert.equal(derived.unattributed.length, 1)
})

test('a run tagged for another programme that DOES exist is simply not shown here', () => {
  const derived = derive({ runs: [row({ programme: 'other', slice: 'x' })], known: ['eva', 'other'] })

  assert.equal(derived.unattributed.length, 0, 'it is attributed — just not to this programme')
})

test('an untagged run is not this layer\'s business at all', () => {
  const derived = derive({ runs: [row({ programme: '', slice: '' })] })

  assert.equal(derived.unattributed.length, 0)
})

// ============================================================ frontier vs complete
//
// Two different predicates, and conflating them is how a programme with an unruled gap and
// nothing dispatchable reads as finished.

test('the frontier is what could be worked on now', () => {
  assert.deepEqual(derive().frontier, ['walk'])
  assert.deepEqual(derive({ events: [deliveredEvent('walk')] }).frontier, ['hug'])
})

test('a delivered slice leaves the frontier', () => {
  const derived = derive({ events: [deliveredEvent('walk'), deliveredEvent('hug')] })

  assert.deepEqual(derived.frontier, [])
  assert.equal(derived.complete, true)
})

test('an empty frontier is not completeness', () => {
  // walk delivered with a gap nobody ruled on: hug cannot start, and nothing is finished.
  const derived = derive({
    events: [deliveredEvent('walk', {
      coverage: coverage({ complete: false, unreached: ['the PWA manifest was deferred'] }),
    })],
  })

  assert.deepEqual(derived.frontier, [], 'hug is blocked behind an unsatisfied dependency')
  assert.equal(derived.complete, false)
  assert.ok(derived.blockers.some((b) => /hug/.test(b)))
  assert.ok(derived.blockers.some((b) => /walk/.test(b)))
})

test('a delivery-pending slice keeps a programme incomplete', () => {
  const derived = derive({
    events: [deliveredEvent('walk')],
    designed: { walk: true, hug: true },
    runs: [row({ slice: 'hug', status: 'integrated' })],
  })

  assert.equal(derived.complete, false)
  assert.ok(derived.blockers.some((b) => /delivery-pending/.test(b)))
})

test('an empty programme is not complete — there is nothing that arrived', () => {
  const derived = deriveProgramme({
    name: 'eva', plan: parseProgramme({ nodes: [] }).plan, events: [],
  })

  assert.equal(derived.complete, false)
})

// ============================================================ the group fold

test('a group folds its children into a count, and claims no status of its own', () => {
  const derived = derive({ events: [deliveredEvent('walk')] })
  const world = derived.groups.find((g) => g.id === 'world')

  assert.equal(world.label, '1/2 delivered')
  assert.equal(world.status, undefined, 'a count is the only honest thing a group can say')
})

test('a nested group folds through', () => {
  const plan = planOf((g) => ({
    ...g,
    nodes: g.nodes.concat([
      { id: 'inner', kind: 'group', parent: 'world' },
      { id: 'nap', kind: 'slice', parent: 'inner', deps: [], provides: [], consumes: [] },
    ]),
  }))

  const derived = deriveProgramme({ name: 'eva', plan, events: [deliveredEvent('walk')] })

  assert.equal(derived.groups.find((g) => g.id === 'world').label, '1/3 delivered')
  assert.equal(derived.groups.find((g) => g.id === 'inner').label, '0/1 delivered')
})

test('labelOf never lets a status word travel alone when it is qualified', () => {
  assert.equal(labelOf('delivered', []), 'delivered')
  assert.equal(labelOf('delivered', ['2 gaps open']), 'delivered (2 gaps open)')
  assert.equal(labelOf('blocked', ['waiting on walk', 'x']), 'blocked (waiting on walk; x)')
})

// ============================================================ delivery survives archiving

test('delivery is event-sourced, so an archived run does not undo it', () => {
  // The run rows are gone entirely — archived, or the directory moved. The slice is still
  // delivered, because delivery is a recorded act rather than a reading of run artifacts.
  const derived = derive({ events: [deliveredEvent('walk')], runs: [] })

  assert.equal(sliceIn(derived, 'walk').status, 'delivered')
  assert.equal(sliceIn(derived, 'walk').satisfied, true)
})

// ============================================================ design documents

const LEAF = [
  '# walk',
  '<!-- agentics:section change -->',
  'Make the meadow walkable on the tablet.',
  '<!-- /agentics:section -->',
  '<!-- agentics:section decisions -->',
  'Tap to move, because the user ruled against a joystick.',
  '<!-- /agentics:section -->',
  '<!-- agentics:section settled-evidence -->',
  'Godot 4.5; the build command is `just build`.',
  '<!-- /agentics:section -->',
].join('\n')

const ROOT = [
  '# system',
  '<!-- agentics:section settled-evidence -->',
  'The tablet is the only target.',
  '<!-- /agentics:section -->',
].join('\n')

test('sections are extracted by marker, never inferred from headings', () => {
  const found = sectionsOf(LEAF)

  assert.equal(found.get('change'), 'Make the meadow walkable on the tablet.')
  assert.equal(found.size, 3)
})

test('a document with no markers yields nothing rather than a guess', () => {
  assert.equal(sectionsOf('# walk\n\nsome prose').size, 0)
})

test('an unclosed marker ends the scan instead of swallowing the rest of the file', () => {
  const found = sectionsOf('<!-- agentics:section change -->\nno close marker here')

  assert.equal(found.size, 0)
})

test('marker completeness is the design-finished signal', () => {
  assert.deepEqual(missingSections(LEAF, LEAF_SECTIONS), [])
  assert.deepEqual(missingSections(ROOT, ROOT_SECTIONS), [])
  assert.deepEqual(missingSections('', LEAF_SECTIONS), LEAF_SECTIONS)
})

test('an empty marked section counts as missing — a marker over nothing says finished', () => {
  const hollow = LEAF.replace('Make the meadow walkable on the tablet.', '')

  assert.deepEqual(missingSections(hollow, LEAF_SECTIONS), ['change'])
})

test('notes concatenate the marked sections byte for byte', () => {
  const assembled = assembleNotes({
    slice: 'walk', rootText: ROOT, leafText: LEAF,
    deps: [{ id: 'intro', merged_sha: '4f2a91c', delivers: 'the title screen' }],
  })

  assert.equal(assembled.error, undefined)
  assert.ok(assembled.notes.includes('The tablet is the only target.'))
  assert.ok(assembled.notes.includes('Tap to move, because the user ruled against a joystick.'))
  assert.ok(assembled.notes.includes('Godot 4.5; the build command is `just build`.'))
  assert.ok(assembled.notes.includes('intro delivered at 4f2a91c'))
})

test('a missing marker fails loudly and by name', () => {
  const noDecisions = LEAF.replace('<!-- agentics:section decisions -->', '<!-- agentics:section other -->')

  const assembled = assembleNotes({ slice: 'walk', rootText: ROOT, leafText: noDecisions, deps: [] })

  assert.match(assembled.error, /decisions/)
  assert.equal(assembled.notes, undefined,
    'an empty payload is indistinguishable from a design that settled nothing')
})

test('a missing root marker fails too, naming the root', () => {
  const assembled = assembleNotes({ slice: 'walk', rootText: '# system', leafText: LEAF, deps: [] })

  assert.match(assembled.error, /root design/)
})

test('a slice with no predecessors says so rather than emitting an empty list', () => {
  const assembled = assembleNotes({ slice: 'walk', rootText: ROOT, leafText: LEAF, deps: [] })

  assert.match(assembled.notes, /no predecessors/)
})

// ------------------------------------------------------------ the optional ground section
//
// The trap this pins is retroactive: `LEAF_SECTIONS` is the completeness
// predicate, so a fourth name added there re-derives every design already on disk as unfinished
// on the next read of the programme.

test('the ground marker is emitted when present', () => {
  const withGround = LEAF + '\n<!-- agentics:section ground -->\nsrc/game/ui, src/game/input\n<!-- /agentics:section -->\n'

  const assembled = assembleNotes({ slice: 'walk', rootText: ROOT, leafText: withGround, deps: [] })

  assert.match(assembled.notes, /GROUND THIS SLICE WAS DESIGNED IN:/)
  assert.ok(assembled.notes.includes('src/game/ui, src/game/input'))
})

test('a design with no ground section is finished, and always was', () => {
  assert.equal(LEAF_SECTIONS.includes(GROUND_SECTION), false,
    'adding it to the completeness predicate unfinishes every design already on disk')
  assert.deepEqual(missingSections(LEAF, LEAF_SECTIONS), [])

  const assembled = assembleNotes({ slice: 'walk', rootText: ROOT, leafText: LEAF, deps: [] })
  assert.equal(assembled.error, undefined)
  assert.doesNotMatch(assembled.notes, /GROUND THIS SLICE/)
})

test('an empty ground section emits nothing rather than an empty heading', () => {
  const hollow = LEAF + '\n<!-- agentics:section ground -->\n   \n<!-- /agentics:section -->\n'

  assert.doesNotMatch(
    assembleNotes({ slice: 'walk', rootText: ROOT, leafText: hollow, deps: [] }).notes,
    /GROUND THIS SLICE/)
})

// ============================================================ rendering

test('the tree carries every slice, the frontier, and what blocks completion', () => {
  const text = renderTree(derive({ events: [deliveredEvent('walk')] }))

  assert.match(text, /world\s+1\/2 delivered/)
  assert.match(text, /walk\s+delivered/)
  assert.match(text, /frontier: hug/)
  assert.match(text, /not complete/)
})

test('unattributed runs are rendered in their own section rather than dropped', () => {
  const text = renderTree(derive({ runs: [row({ slice: 'nap' })] }))

  assert.match(text, /UNATTRIBUTED RUNS/)
  assert.match(text, /20260817-091412/)
})

test('a degraded programme says so at the top', () => {
  assert.match(renderTree(derive({ degraded: 'line 4 is not JSON' })), /UNKNOWN — line 4/)
})

test('the view splices between markers, leaving the authored prose alone', () => {
  const before = '# plan\n\nWhy this decomposition.\n\n<!-- agentics:graph -->\nold\n<!-- /agentics:graph -->\n\ntail\n'
  const after = spliceView(before, 'new')

  assert.ok(after.includes('Why this decomposition.'))
  assert.ok(after.includes('new'))
  assert.ok(!after.includes('old'))
  assert.ok(after.includes('tail'))
})

test('a plan.md with no markers gets the section appended once, then spliced', () => {
  const first = spliceView('# plan\n\nWhy.\n', 'v1')
  const second = spliceView(first, 'v2')

  assert.ok(first.includes('v1'))
  assert.ok(second.includes('v2'))
  assert.ok(!second.includes('v1'))
  assert.equal(second.split('agentics:graph').length, 3, 'appended once, never repeatedly')
})

// ============================================================ CLI argument arithmetic

test('parseArgs separates the repo root from the flags', () => {
  const { flags, positional } = parseArgs(['C:/repo', '--programme', 'eva', '--watch'])

  assert.deepEqual(positional, ['C:/repo'])
  assert.equal(flags.programme, 'eva')
  assert.equal(flags.watch, true)
})

test('gaps are resolved by index against what the delivery actually named', () => {
  const unreached = ['gap a', 'gap b', 'gap c']

  assert.deepEqual(resolveGaps('all', unreached), { gaps: unreached })
  assert.deepEqual(resolveGaps('none', unreached), { gaps: [] })
  assert.deepEqual(resolveGaps('0,2', unreached), { gaps: ['gap a', 'gap c'] })
})

test('an index outside the delivery is refused rather than wedged', () => {
  // The CLI copies gap text exact-string from the delivery. The user rules, the CLI copies,
  // and matching is therefore string equality with no judgement anywhere in it.
  assert.match(resolveGaps('7', ['gap a']).error, /names index 7/)
  assert.match(resolveGaps('x', ['gap a']).error, /names index x/)
})

// ============================================================ drift
//
// After a slice lands, the question is whether it moved anything a pending slice was designed
// against. Mechanical first, judged second — and the "judged" half is always the user's.

const driftPlan = () => planOf((g) => ({
  ...g,
  nodes: g.nodes.concat([{
    id: 'nap', kind: 'slice', parent: 'world', delivers: 'sleeping',
    deps: ['hug'], provides: [], consumes: ['NeedLifecycle'],
  }]),
}))

const driftDerived = (designed) => deriveProgramme({
  name: 'eva', plan: driftPlan(), events: [deliveredEvent('walk')], designed,
})

test('a moved file under a consumed contract flags the consumer', () => {
  const plan = driftPlan()
  const found = driftCheck(plan, driftDerived({ walk: true, hug: true, nap: true }),
    ['src/core/navigation/grid.gd', 'README.md'])

  assert.deepEqual(found.flagged, [
    { slice: 'hug', contract: 'NavigationGrid', paths: ['src/core/navigation/grid.gd'] },
  ])
  assert.equal(found.moved, 2)
})

test('a path that merely starts with the same characters is not under the prefix', () => {
  const plan = driftPlan()
  const found = driftCheck(plan, driftDerived({ walk: true, hug: true, nap: true }),
    ['src/core/navigation-old/grid.gd'])

  assert.deepEqual(found.flagged, [])
})

test('an undesigned pending slice is named as unexamined, never passed silently', () => {
  // "No flag" and "nothing to check against" are different answers, and reporting the second
  // as the first reassures a user about a slice nobody looked at.
  const plan = driftPlan()
  const found = driftCheck(plan, driftDerived({ walk: true, hug: true }),
    ['src/core/needs/lifecycle.gd'])

  assert.deepEqual(found.unexamined, ['nap'])
  assert.deepEqual(found.flagged, [])
})

test('a delivered slice is not a drift suspect — its files moving is somebody building on it', () => {
  const plan = driftPlan()
  const derived = deriveProgramme({
    name: 'eva', plan, events: [deliveredEvent('walk'), deliveredEvent('hug')],
    designed: { walk: true, hug: true, nap: true },
  })

  const found = driftCheck(plan, derived, ['src/core/navigation/grid.gd'])

  assert.deepEqual(found.flagged, [])
})

test('drift reports every consumed contract a slice has, not only the first', () => {
  const plan = planOf((g) => ({
    ...g,
    nodes: g.nodes.map((n) => (n.id === 'walk'
      ? { ...n, provides: n.provides.concat([{ name: 'TapToMove', paths: ['src/game/interaction/'] }]) }
      : n.id === 'hug' ? { ...n, consumes: ['NavigationGrid', 'TapToMove'] } : n)),
  }))

  const derived = deriveProgramme({
    name: 'eva', plan, events: [deliveredEvent('walk')], designed: { walk: true, hug: true },
  })

  const found = driftCheck(plan, derived,
    ['src/core/navigation/grid.gd', 'src/game/interaction/tap.gd'])

  assert.deepEqual(found.flagged.map((f) => f.contract), ['NavigationGrid', 'TapToMove'])
})

test('backslashes on either side are normalised before the comparison', () => {
  const plan = driftPlan()
  const found = driftCheck(plan, driftDerived({ walk: true, hug: true, nap: true }),
    ['src\\core\\navigation\\grid.gd'])

  assert.equal(found.flagged.length, 1)
})
