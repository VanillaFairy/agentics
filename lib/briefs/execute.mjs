// lib/briefs/execute.mjs — the prompts the execute program builds: a leaf's reviewer, a folder's
// integration reviewer, the ruler on drift, on a moved base, on contention at a merge and on a leaf's loop, the planner and the investigator.
//
// Design: docs/DESIGN.md#briefs-and-returns.

import { PART_BYTES } from '../roles.mjs'
import { isYardstick } from '../tree.mjs'
import { bounded, boundedDiff } from './size.mjs'

const list = (v) => (Array.isArray(v) ? v : [])
const bullets = (items) => (items.length ? items.map((i) => '- ' + i).join('\n') : '(none)')

/** Pure. The prompt's lines, closed by the repository's guidance when there is any. */
const closing = (lines, guidance) => [...lines, ...(guidance ? [guidance.trim(), ''] : [])].join('\n')

/** Pure. The commands that read a span. */
const spanLines = ({ base, head }) => ['    git log --reverse -p ' + base + '..' + head, '    git diff ' + base + ' ' + head]

const COMMANDS = ['build', 'typecheck', 'suite', 'suite_fast', 'test_one']

/** What code-owned text handed to a reviewer or planner may hold: a producer's account, a survey's context. */
const ACCOUNT_BYTES = Math.floor(PART_BYTES / 4)
const GROUND_BYTES = Math.floor(PART_BYTES / 2)

/** Pure. A text held to `budget` bytes by its leading paragraphs, what it left out declared. */
const boundedText = (text, budget) => bounded(String(text).split('\n\n'), budget,
  (left) => '(left out to fit this brief: its last ' + left.length + ' paragraphs)', '\n\n')

/** What an integration reviewer is told of a drift's `failure_scenario`, which only a drift naming one sends to a fix, and of a spec's defaults. */
const DRIFT_SCENARIO = 'On under, over or deviates, `failure_scenario` names the concrete input, state or consumer that goes ' +
  'wrong because of it; a drift that names none goes to the user at landing and sends no fix round, so never invent one. ' +
  'Every other ruling carries an empty one. A value the spec writes as `default <value>` is no claim: another value is ' +
  'equivalent unless a criterion or a decision fixes it.'

/** Pure. The section that names the existing tests a change rewrote outside what its leaf expects: each a `file:` unit to rule closely. */
const rewrittenLines = (files) => (files.length
  ? ['## Existing tests rewritten', '',
    'The change rewrote these existing test files, outside what its plan expected it to change. Rule each `file:` unit on whether ' +
      'the rewrite keeps what the test pinned: a weakened or removed assertion that let the change pass is critical.', '',
    bullets(files.map((f) => 'file:' + f)), '']
  : [])

/**
 * Pure. A leaf's reviewer's prompt: the span to read, the producer's return with its concerns
 * first, the units to rule and those whose rulings stand (docs/DESIGN.md#review-delta), the prior
 * round's open blockers, and the leaf's brief as its producer has it, which names the worktree.
 *
 * @param {{leaf: object, brief: string, span: {base: string, head: string},
 *   producer: {status: string, concerns: string[], text: string}, units: string[], standing?: string[],
 *   prior: {id, severity, claim, evidence, failure_scenario, remedy}[], rewritten?: string[]}} at `leaf` is the tree's node;
 *   `brief` is the producer thread's `leafBrief` text; `units` and `standing` are the names of the units a review's delta
 *   rules and those whose rulings stand; `rewritten` the measurement's `tests_rewritten` among the files to rule
 * @returns {string}
 */
export function reviewerBrief({ leaf, brief, span, producer, units = [], standing = [], prior = [], rewritten = [] }) {
  const concerns = producer.concerns || []
  const lines = [
    '# Review leaf ' + leaf.id + ' — ' + leaf.title, '',
    'You are fresh: nothing from an earlier round reaches you but what this brief holds.',
    ...(isYardstick(leaf)
      ? ['This leaf\'s output is a YARDSTICK (' + (leaf.provides.length ? 'it provides a contract' : 'role ' + leaf.role) +
        '): its majors with a failure scenario block like criticals.']
      : []),
    ...(leaf.role === 'red' ? ['Its tests are what the green is coded against: a test a correct green would fail is critical.'] : []),
    ...(leaf.role === 'green' ? ['The tests were written by another agent before this code; its producer may not change them.'] : []),
    '',
    '## The span', '',
    'Review the commits from ' + span.base + ' to ' + span.head + ' in the worktree the brief names; a critical you see ' +
      'outside the span is still reported. Read them with:', '',
    ...spanLines(span), '',
    '## The producer\'s return', '',
    'Status: ' + producer.status, '',
    ...(concerns.length ? ['Concerns, which you attack first:', bullets(concerns)] : ['Concerns: (none)']), '',
    'Its account:', '',
    boundedText(String(producer.text || '').trim() || '(none)', ACCOUNT_BYTES), '',
    '## The units you rule', '',
    'Rule every unit below in `units`, under exactly its name. `criterion:<n>` is the brief\'s acceptance criterion n, ' +
      'counted from 1; `file:<path>` is the change to that file; `approved-case:<file>#<id>` is a case of the red\'s ' +
      'approved tests that fails at this head: rule whether the case is wrong.', '',
    bullets(units), '',
    ...(standing.length ? ['## Rulings that stand', '',
      'An earlier reviewer ruled these units, and nothing they stand on has moved since: their rulings stand, so do not rule them again.', '',
      bullets(standing), ''] : []),
    ...rewrittenLines(rewritten),
  ]
  if (prior.length) {
    lines.push('## Prior blockers', '',
      'Rule each in `fix_rulings` as fixed, not_fixed or regressed, with evidence; one not fixed is a finding this round too, under its id:', '',
      ...prior.map((f) => '- [' + f.id + '] (' + f.severity + ') ' + f.claim +
        (f.evidence ? '\n  evidence: ' + f.evidence : '') +
        (f.failure_scenario ? '\n  goes wrong when: ' + f.failure_scenario : '') +
        (f.remedy ? '\n  remedy: ' + f.remedy : '')), '')
  }
  lines.push('## Return', '', 'The reviewer schema. Claim rulings belong to integration reviews: `claims` is [].', '',
    '# The leaf\'s brief, as its producer has it', '', String(brief).trim(), '')
  return lines.join('\n')
}

/** Pure. The leaves no test discriminates (`undiscriminated` in `lib/verdict.mjs`), for an integration reviewer to judge their checks. */
function undiscriminatedLines(leaves) {
  if (!leaves.length) return []
  return ['## Leaves with no discriminating test', '',
    'Every changed test file of these leaves was ruled a regression net over behaviour that held at base, so no test ' +
      'of theirs fails without their change: only their criterion checks pin it. Judge whether those checks and the merged code do.', '',
    ...leaves.flatMap((l) => ['- leaf ' + l.id + ':', ...l.nets.map((x) => '  - ' + x.file + ' — ' + x.why)]), '']
}

/**
 * Pure. A folder's integration reviewer's prompt over a review's delta (docs/DESIGN.md#review-delta):
 * the merged span, and since the review before (`last`, null for a first) what merged and the
 * spec's edit; the caveat when planned children did not land, the work agentics did not produce;
 * the last review's claims numbered `claim:<n>` and the blockers it left open; the user's answers;
 * the units to rule (`delta.rule`) and those whose rulings stand (`delta.stand`); and the folder's
 * spec as the yardstick.
 *
 * @param {{folder: {id: string, title?: string, worktree?: string}, spec: string,
 *   delta: {rule: {unit: string, was: object|null}[], stand: {unit: string}[]}, span: {base: string, head: string},
 *   last?: {head_sha: string, claims: {claim: string, ruling: string}[], open?: {id: string, claim: string, failure_scenario?: string}[]}|null,
 *   diff?: string, answers?: {question: string, answer: string}[], caveat?: string, guidance?: string,
 *   outside?: {leaves: {id: string, commits: string[]}[], commits: string[]},
 *   undiscriminated?: {id: string, nets: {file: string, why: string}[]}[], rewritten?: string[], measured?: object[],
 *   children?: {id: string, path: string, text: string}[], later?: {id: string, title: string, context?: string,
 *   decisions: {id: string, text: string}[]}[]}} at `spec` is the spec's text and `diff` its edit since `spec` was
 *   last ruled ('' for none or none kept), `outside` the work a person did and the user adopted, `undiscriminated`
 *   its leaves no test discriminates (`undiscriminated`), `rewritten` the existing tests its children rewrote outside
 *   what they expected, `children` its sub-efforts' specs and `later` the entries that run after it (`beyondLines`)
 * @returns {string}
 */
export function integrationBrief({
  folder, spec, delta, span, last = null, diff = '', answers = [], caveat = '', guidance = '', outside = { leaves: [], commits: [] },
  undiscriminated = [], rewritten = [], measured = [], children = [], later = [],
}) {
  const units = delta.rule.map((r) => r.unit)
  const specRule = delta.rule.find((r) => r.unit === 'spec')
  const edited = String(diff).trim() !== ''
  const claims = last ? list(last.claims) : []
  const blockers = last ? list(last.open) : []
  const lines = [
    '# Integration review of folder ' + folder.id + (folder.title ? ' — ' + folder.title : ''), '',
    'Its children have merged' + (folder.worktree ? ' in the worktree ' + folder.worktree : '') + '. Look for defects that exist ' +
      'only with the children together, and for any decision of the spec no child realised.' +
      (last ? ' An earlier review of it stands wherever what it ruled has not moved: rule the units below, and report findings ' +
        'only on what moved.' : ''), '',
    '## The span', '',
    'Review the merged change from ' + span.base + ' to ' + span.head + '. Read it with:', '',
    ...spanLines(span), '',
  ]
  if (last && last.head_sha !== span.head) {
    lines.push('## What merged since the last review', '',
      'The last review judged ' + last.head_sha + '. Review what moved since, as it sits in the merged whole:', '',
      ...spanLines({ base: last.head_sha, head: span.head }), '')
  }
  if (caveat) {
    lines.push('## Caveat', '', caveat.trim(), '',
      'Every finding you report carries this caveat: the change you review is not the whole folder.', '')
  }
  if (outside.leaves.length || outside.commits.length) {
    lines.push('## Work agentics did not produce', '',
      'A person did this part of the folder by hand, and the user adopted it on their word: no agentics review has judged it. ' +
        'Rule it as strictly as the rest; its criteria were measured with the rest of the plan (Measured, below).', '',
      ...outside.leaves.map((l) => '- leaf ' + l.id + ': ' + (l.commits.join(', ') || '(no commits named)')),
      ...(outside.commits.length ? ['- commits that belong to no leaf: ' + outside.commits.join(', ')] : []), '')
  }
  lines.push(...undiscriminatedLines(undiscriminated))
  if (edited) lines.push('## The edit to the spec', '', '~~~~diff', String(diff).trimEnd(), '~~~~', '')
  if (claims.length) lines.push('## The last review\'s claims', '', bullets(claims.map((c, i) => 'claim:' + (i + 1) + ' [' + c.ruling + '] ' + c.claim)), '')
  if (blockers.length) {
    lines.push('## Blockers the last review left open', '',
      'Rule each in `fix_rulings` under its id: fixed, not_fixed or regressed. One not fixed is reported again in `findings` under ' +
        'the same id.', '',
      bullets(blockers.map((b) => b.id + ': ' + b.claim + (b.failure_scenario ? ' — fails: ' + b.failure_scenario : ''))), '')
  }
  if (answers.length) {
    lines.push('## The user\'s word on this folder', '',
      'The user answered these. What they chose is settled: a claim or finding that disputes it is not yours to raise.', '',
      ...answers.flatMap((a) => ['- Asked: ' + a.question, '  Answered: ' + a.answer]), '')
  }
  const specClaims = !specRule ? '' : edited ? 'every claim the changed lines make or alter'
    : claims.length ? 'every claim the spec makes that no claim of the last review states'
      : 'every claim the spec makes — each success criterion of its Intent, each statement of its Design, each criterion of its plan'
  const asks = [
    specRule ? 'for `spec`, ' + specClaims + ', its `unit` empty' : '',
    units.some((u) => u.startsWith('claim:')) ? 'for each `claim:<n>`, that claim restated against the current text with ' +
      '`claim:<n>` in `unit` (one you rule in `units` but leave out of `claims` keeps its last ruling, a pass reading cant_tell)' : '',
  ].filter(Boolean)
  lines.push(
    '## The units you rule', '',
    'Rule every unit below in `units`, under exactly its name. `decision:<id>` is that decision of the spec; `file:<path>` the ' +
      'merged change to that file' + (specRule ? '; `spec` is ' + specClaims : '') +
      (units.some((u) => u.startsWith('claim:')) ? '; `claim:<n>` is that claim of the last review, ruled again against the spec ' +
        'as it now reads and the work at this head' : '') + '.', '',
    bullets(units), '',
    ...(delta.stand.length ? ['## Rulings that stand', '',
      'An earlier review ruled these units, and nothing they stand on has moved since: their rulings stand, so do not rule them again.', '',
      bullets(delta.stand.map((s) => s.unit)), ''] : []),
    ...rewrittenLines(rewritten),
    ...measuredLines(measured),
    '## Claims', '',
    'Return in `claims` only the claims you ruled' + (asks.length ? ': ' + asks.join('; ') : ', here none: `claims` is []') + '. Each is `{claim, ruling, evidence, failure_scenario, unit}`, the ruling one of met, equivalent ' +
      '(the same observable behaviour, only a name, a signature\'s shape or an internal structure differing, and nothing outside the ' +
      'folder relying on it), under, over, deviates, spec_defect or cant_tell. ' + DRIFT_SCENARIO +
      (claims.length ? ' Every other claim keeps its last ruling.' : '') + ' A HUMAN: criterion is the user\'s: leave it out.' +
      (measured.length ? ' A plan criterion with a `check:` is the harness\'s: its check was run at this head (Measured, above), so ' +
        'leave it out of the claims you add; a `claim:<n>` that is one is decided by its result under Measured: met when it passed, ' +
        'under when it did not.' : ''), '',
    ...beyondLines(children, later),
    '## The spec, your yardstick', '',
    String(spec).trim(), '',
  )
  return closing(lines, guidance)
}

/**
 * Pure. What an integration reviewer needs from outside the folder's own spec: each sub-effort's spec,
 * the yardstick for what this spec's entry for it claims, each in a fence so the fit hands it whole;
 * and the entries that run after this folder, whose claims are not this folder's to have realised.
 */
function beyondLines(children, later) {
  return [
    ...(children.length ? ['## The specs of its sub-efforts', '',
      'Each sub-effort below is a plan entry of this folder with its own spec. Judge what this spec claims of it against that spec.', '',
      ...children.flatMap((c) => ['### ' + c.id + ' (' + c.path + ')', '', '~~~~markdown', String(c.text).trimEnd(), '~~~~', ''])] : []),
    ...(later.length ? ['## Entries that run after this folder', '',
      'These entries wait on this folder, so none has run. A claim of this spec that one of them realises (its decision or its ' +
        'plan entry says so) is not this folder\'s to have met: leave it out of `claims`, and say in `notes` which claims you ' +
        'left out and whose they are.', '',
      bullets(later.map((e) => e.id + ' — ' + e.title + (e.decisions.length
        ? '; realises ' + e.decisions.map((d) => d.id + (d.text ? ': ' + d.text : '')).join('; ') : '') +
        (e.context ? '\n  ' + e.context : ''))), ''] : []),
  ]
}

/** Pure. The criterion checks the gate ran at the head under review, as observations a reviewer reads and does not rule. */
function measuredLines(measured) {
  if (!measured.length) return []
  return ['## Measured', '',
    'The harness ran every plan criterion\'s `check:` at this head. Each result is an observation: it decides its criterion, ' +
      'and nothing you read can overturn it.', '',
    bullets(measured.map((c) => '`' + c.command + '`: ' + c.status)), '']
}

/** Pure. One node as the ruler rules it: why it is in question, its plan entry, and the change. */
function entryBlock(id, entry, note, diff, budget) {
  return [
    '# ' + id + ' — ' + entry.title, '', note, '',
    '## Plan entry', '',
    'Intent: ' + (String(entry.intent || '').trim() || '(none)'), '',
    'Context: ' + (String(entry.context || '').trim() || '(none)'), '',
    'Acceptance criteria:', bullets((entry.acceptance || []).map((a) => a.text + (a.check ? ' — check: `' + a.check + '`' : ''))), '',
    'Expected to change:', bullets(entry.expects || []), '',
    'Reads:', bullets(entry.reads || []), '',
    'Consumes:', bullets((entry.consumes || []).map((c) => c.name + ': ' + c.paths.join(', '))), '',
    '## Change', '',
    '~~~~diff', boundedDiff(diff, budget), '~~~~', '',
  ].join('\n')
}

/** Pure. What each of `n` changes in one ruler's brief may hold: together, one part's budget. */
const changeBudget = (n) => Math.floor(PART_BYTES / Math.max(1, n))

/** Pure. A premises ruling's prompt over `blocks` ({id, text}, one per node). */
function rulerBrief(title, intro, blocks, guidance) {
  return closing([
    '# ' + title, '', intro, '',
    'Return `ruler_premises`: one entry in `rulings` per unit below, `{node, ruling, why, question}`. Rule `unaffected` ' +
      'when everything the node\'s plan entry assumes, and every criterion it must meet, still holds after the change; ' +
      '`affected` when something it assumes no longer does, with `question` the one question its owner must answer. ' +
      'Each node\'s entry and change below are everything you rule on; a node they cannot decide is `affected`.', '',
    '## The units you rule', '',
    bullets(blocks.map((b) => b.id)), '',
    ...blocks.map((b) => b.text),
  ], guidance)
}

/** Pure. A contract's standing ruling of unaffected, as the ruler of a later change to it reads it. */
function ruledBefore(contract, before) {
  const who = before.by === 'user' ? 'the user ruled it unaffected, over the ruler\'s question' : 'a ruler ruled it unaffected'
  return [
    'Ruled before: at ' + before.head_sha + ' ' + who + ' on contract ' + contract + '. That ruling stands for the change it ' +
      'ruled on: the change below is only what moved in these files since then. Rule on what it adds, not on what was ruled.',
    ...(before.why ? ['The ruler then said: ' + before.why] : []),
    ...(before.question ? ['It asked: ' + before.question] : []),
    ...before.answers.map((a) => 'The user was asked: ' + a.question + '\nThe user answered: ' + a.answer),
  ].join('\n')
}

/**
 * Pure. The ruler's prompt on drift after a merge batch: per node, every contract the batch touched
 * that it consumes, its plan entry and the merged change to those files.
 *
 * @param {{target: string, records: {node: string, contract: string, files: string[], entry: object}[],
 *   diffs: Object<string, string>, guidance?: string}} at `records` are the batch's open drift, one
 *   per node and contract, `entry` the node as the tree holds it; `diffs` maps a node to its diff
 * @returns {string}
 */
export function driftBrief({ target, records = [], diffs = {}, guidance = '' }) {
  const ids = [...new Set(records.map((r) => r.node))]
  const budget = changeBudget(ids.length)
  const blocks = ids.map((id) => {
    const hits = records.filter((r) => r.node === id)
    const note = ['Work merged into ' + target + ' touched ' +
      hits.map((r) => 'contract ' + r.contract + ' (' + r.files.join(', ') + ')').join(' and ') + ', which it consumes.',
    ...hits.filter((r) => r.before).map((r) => ruledBefore(r.contract, r.before))].join('\n\n')
    return { id, text: entryBlock(id, hits[0].entry, note, diffs[id], budget) }
  })
  return rulerBrief('Rule premises after a merge into ' + target,
    'Merged work touched files under contracts that nodes not yet merged consume.', blocks, guidance)
}

/**
 * Pure. The ruler's prompt on a moved base: per node, where the base moved from, the moved files it
 * writes and reads, its plan entry and the change to those files.
 *
 * @param {{nodes: {node: string, anchor: string, writes: string[], reads: string[], entry: object}[],
 *   base_now: string, diffs: Object<string, string>, guidance?: string}} at
 * @returns {string}
 */
export function staleBrief({ nodes = [], base_now, diffs = {}, guidance = '' }) {
  const blocks = nodes.map((n) => {
    const writes = n.writes || []
    const reads = n.reads || []
    const note = 'The base branch moved from ' + n.anchor + ' to ' + base_now + '.' +
      (writes.length ? ' Moved files it writes: ' + writes.join(', ') + '.' : '') +
      (reads.length ? ' Moved files it reads: ' + reads.join(', ') + '.' : '')
    return { id: n.node, text: entryBlock(n.node, n.entry, note, diffs[n.node], changeBudget(nodes.length)) }
  })
  return rulerBrief('Rule premises after the base moved to ' + base_now, 'The base branch moved under nodes not yet merged.', blocks, guidance)
}

/**
 * Pure. The ruler's prompt on contention at a merge (`ruler_contention`): the unit about to merge,
 * its plan entry and its change; per other leaf, why it is in question, its plan entry, its status
 * and its change (or only what it expects); for a conflict, the conflicting paths, the unit's change
 * and what merged into the folder since the unit was cut. The units are the other leaves, or
 * `integration` for a conflict.
 *
 * @param {{trigger: 'contention'|'conflict', unit: string, entry: object, diff: string,
 *   others?: {id: string, entry: object, status: string, facts: {kind: string, paths: string[]}[], diff: string}[],
 *   paths?: string[], merged?: string, guidance?: string}} args
 * @returns {string}
 */
export function contentionBrief({ trigger, unit, entry, diff, others = [], paths = [], merged = '', guidance = '' }) {
  const conflict = trigger === 'conflict'
  const units = conflict ? ['integration'] : others.map((o) => o.id)
  const head = conflict
    ? [
      '# Rule a merge conflict of ' + unit, '',
      'Leaf ' + unit + ' is approved, and merging it into its folder\'s integration branch conflicted in: ' + paths.join(', ') + '.',
      'Rule the one unit `integration`:', '',
      '- `resolve` — the two sides can be reconciled as written: the leaf\'s producer merges the folder\'s head into its branch and resolves the conflict.',
      '- `replan` — the two changes contradict each other\'s plan: `question` says what the plan must decide.',
      '- `cant_rule` — the evidence does not decide it: `why` says what you could not tell.',
    ]
    : [
      '# Rule contention at the merge of ' + unit, '',
      'Leaf ' + unit + ' is approved and about to merge into its folder. Leaves of other folders changed, or expect to change, ' +
        'files it changed, and their work has not merged where the two folders meet. Rule each unit below:', '',
      '- `serialize` — the two must not both stand on the file as it was: this leaf merges only once that leaf\'s work has merged, on top of it.',
      '- `resolve` — the changes stand together as written: this leaf merges now.',
      '- `replan` — the two plans contradict each other: `question` says what the plan must decide.',
      '- `cant_rule` — the evidence does not decide it: `why` says what you could not tell.',
    ]
  const budget = changeBudget(1 + others.length + (conflict ? 1 : 0))
  const blocks = [
    entryBlock(unit, entry, 'The unit about to merge.', diff, budget),
    ...(conflict ? ['# What merged into the folder since ' + unit + ' was cut', '', '~~~~diff', boundedDiff(merged, budget), '~~~~', ''] : []),
    ...others.map((o) => entryBlock(o.id, o.entry,
      'Status: ' + o.status + '. ' + o.facts.map((f) => (f.kind === 'overlap' ? 'Its branch changed ' : 'It expects to change ') + f.paths.join(', ') + '.').join(' '),
      o.diff, budget)),
  ]
  return [
    ...head, '',
    'Return `ruler_contention`: `rulings`, one `{unit, ruling, why, question}` per unit, `why` one sentence naming what in the changes decides it.', '',
    '## The units you rule', '', bullets(units), '',
    blocks.join('\n'),
    guidance,
  ].join('\n')
}

/**
 * Pure. What one send-back told the producers: a review's findings; a `failures` message's failures,
 * each its check and whole claim with what its guard key (`failuresKey`) names failed; else the state
 * its guard keyed. A key entry is `check:claim:names`, so read raw its claim looks cut off at a colon.
 */
const sentBackLines = (m) => {
  if (m.msg === 'findings') return list(m.payload && m.payload.findings).map((f) => '[' + f.id + '] ' + f.severity + ': ' + f.claim)
  const key = String((m.guard && m.guard.key) || '')
  const failures = list(m.payload && m.payload.failures)
  if (m.msg !== 'failures' || failures.length === 0) return key.split(/\n|\|/).filter(Boolean)
  const entries = key.split('|')
  return failures.map((f) => {
    const prefix = f.check + ':' + f.claim + ':'
    const names = (entries.find((e) => e.startsWith(prefix)) || prefix).slice(prefix.length).split('\n').filter(Boolean)
    return '[' + f.check + '] ' + f.claim + (names.length ? ' — failed: ' + names.join(', ') : '')
  })
}

/**
 * Pure. The ruler's prompt on a leaf's loop: the ruling it gives and the schema it returns, the
 * leaf, and each round sent back oldest first — what sent it back, at which head, and what it was
 * told.
 *
 * @param {{leaf: object, loop: {round: number, messages: {msg: string, payload?: object,
 *   guard?: {kind: string, key: string, at: string}}[]}[]}} at `leaf` is the tree's node; `loop`
 *   is its `producerLoop` since it was cleared
 * @returns {string}
 */
export function convergenceBrief({ leaf, loop = [] }) {
  return [
    '# Rule whether the loop of leaf ' + leaf.id + ' — ' + leaf.title + ' — converges', '',
    'Give the convergence ruling and return `ruler_convergence`: `ruling` and `why`.',
    'The leaf\'s producers were sent back ' + loop.length + ' times for more work. Each entry below is the round that answers a ' +
      'send-back and what its producer was told: a review\'s open findings, or what a check, a merge or a mutation run left failing.', '',
    ...loop.flatMap((step) => [
      '## Round ' + step.round, '',
      ...step.messages.flatMap((m) => [
        m.msg + (m.guard ? ' (' + m.guard.kind + (m.guard.at ? ', at ' + String(m.guard.at).slice(0, 8) : '') + ')' : '') + ':',
        bullets(sentBackLines(m)), '',
      ]),
    ]),
  ].join('\n')
}

/**
 * Pure. The planner's prompt: the folder and the spec it writes, the decisions to realise, and per
 * mode its charge — `write` a spec, `settle` the review's findings, `answer` a producer's request —
 * with the evidence a survey of its ground gathered and the spec as it stands.
 *
 * @param {{folder: {id: string, title?: string, intent?: string, spec_path: string, why?: string},
 *   mode: 'write' | 'settle' | 'answer', spec?: string, decisions?: {id: string, text: string}[],
 *   findings?: {id, severity, section, claim, evidence}[], request?: {node: string, status: string, text: string},
 *   guidance?: string, context?: string}} at `spec` is the spec's current text, '' for a new one;
 *   `context` is the text of a survey's context file, '' when none ran
 * @returns {string}
 * @throws on a mode outside the three
 */
export function plannerBrief({ folder, mode, spec = '', decisions = [], findings = [], request = null, guidance = '', context = '' }) {
  if (!['write', 'settle', 'answer'].includes(mode)) throw new Error('plannerBrief: unknown mode ' + JSON.stringify(mode))
  const lines = [
    '# Plan folder ' + folder.id + (folder.title ? ' — ' + folder.title : ''), '',
    'Intent: ' + (String(folder.intent || '').trim() || '(none)'),
    'The spec you write: ' + folder.spec_path,
    ...(folder.why ? ['Why it is planned: ' + folder.why] : []), '',
    'The specs of the folders above yours are the `DESIGN.md` files in the directories above it, up to the effort\'s own ' +
      'folder: settled context.', '',
    '## Decisions to realise', '',
    'Realise each; never state or change one. Never write a Decisions row: a decision you need is a `needs_decision` return.', '',
    bullets(decisions.map((d) => d.id + ': ' + d.text)), '',
    '## Your charge', '',
  ]
  if (mode === 'write') {
    lines.push(String(spec).trim() ? 'Rewrite the spec whole, with Write.' : 'Write the spec, new, with Write.',
      'Return `planner_write`: `written` once it is written, or the user-bound or blocking status.', '')
  } else if (mode === 'settle') {
    lines.push('Settle the autonomous review\'s findings below, each an ambiguity or a gap. Incorporate each one: edit the ' +
      'spec\'s Design, Plan or Open questions because of it, and give it the disposition incorporated. Change nothing the ' +
      'findings do not ask for: every edit is reviewed again. A finding whose fix would state or change a decision is not ' +
      'yours: return `needs_decision` with the question.',
    'Return `planner_settle`: `settled` with one disposition per finding id.', '',
    '## Findings to settle', '',
    findings.length
      ? bullets(findings.map((f) => '[' + f.id + '] (' + f.severity + (f.section ? ', ' + f.section : '') + ') ' + f.claim +
        (f.evidence ? '\n  evidence: ' + f.evidence : '')))
      : 'Each review\'s findings reach you as a message after this brief: settle every finding each one names.', '')
  } else {
    lines.push('A producer\'s return reached you: answer it by editing the spec. An answer that would state or change a ' +
      'decision is not yours: return `needs_decision` with the question.',
    'Return `planner_write`: `written` once the spec is edited, or `needs_decision`.', '',
    '## The request', '',
    '- from: ' + request.node, '- status: ' + request.status, '',
    String(request.text || '').trim() || '(none)', '')
  }
  if (String(context).trim()) lines.push('## Evidence on its ground', '', 'A survey of this folder\'s ground gathered:', '', boundedText(String(context).trim(), GROUND_BYTES), '')
  if (String(spec).trim()) lines.push('## The spec as it stands', '', String(spec).trim(), '')
  return closing(lines, guidance)
}

/**
 * Pure. The investigator's prompt: the worktree to work in, the commands the effort established
 * already, and those still to establish.
 *
 * @param {{worktree: string, known?: object, guidance?: string}} at `known` is `commandsOf`'s
 *   `{build, typecheck, suite, suite_fast, test_one, absent}`, each command a string or absent
 * @returns {string}
 */
export function investigatorBrief({ worktree, known = {}, guidance = '' }) {
  const absent = known.absent || {}
  const has = (n) => typeof known[n] === 'string' && known[n].trim() !== ''
  const done = COMMANDS.filter((n) => has(n) || absent[n] === true)
  return closing([
    '# Establish commands', '',
    'Work in ' + worktree + ', a throwaway worktree of the repository. Establish each command under To establish by ' +
      'running it there; a command you did not run is not established.', '',
    '## Established already', '',
    bullets(done.map((n) => n + ': ' + (has(n) ? '`' + known[n].trim() + '`' : 'established absent'))), '',
    '## To establish', '',
    bullets(COMMANDS.filter((n) => !done.includes(n))), '',
    'Return the investigator schema: a `command` gotcha for each command you established, and `unresolved` naming ' +
      'those you could not.', '',
  ], guidance)
}

