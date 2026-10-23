// lib/briefs/execute.mjs — the prompts the execute program builds: a leaf's reviewer, a folder's
// integration reviewer, the ruler on drift, on a moved base, on contention at a merge and on a leaf's review loop, the planner and the investigator.
//
// Design: docs/DESIGN.md#briefs-and-returns.

import { isYardstick } from '../tree.mjs'
import { PASSING } from '../verdict.mjs'

const bullets = (items) => (items.length ? items.map((i) => '- ' + i).join('\n') : '(none)')

/** Pure. The prompt's lines, closed by the repository's guidance when there is any. */
const closing = (lines, guidance) => [...lines, ...(guidance ? [guidance.trim(), ''] : [])].join('\n')

/** Pure. The commands that read a span. */
const spanLines = ({ base, head }) => ['    git log --reverse -p ' + base + '..' + head, '    git diff ' + base + ' ' + head]

const COMMANDS = ['build', 'typecheck', 'suite', 'suite_fast', 'test_one']

/** Pure. The section that names the existing tests a change rewrote outside what its leaf expects: each a `file:` unit to rule closely. */
const rewrittenLines = (files) => (files.length
  ? ['## Existing tests rewritten', '',
    'The change rewrote these existing test files, outside what its plan expected it to change. Rule each `file:` unit on whether ' +
      'the rewrite keeps what the test pinned: a weakened or removed assertion that let the change pass is critical.', '',
    bullets(files.map((f) => 'file:' + f)), '']
  : [])

/**
 * Pure. A leaf's reviewer's prompt: the span to read, the producer's return with its concerns
 * first, the units to rule, the prior round's open blockers, and the leaf's brief as its producer
 * has it, which names the worktree.
 *
 * @param {{leaf: object, brief: string, span: {base: string, head: string},
 *   producer: {status: string, concerns: string[], text: string}, units: string[],
 *   prior: {id, severity, claim, evidence, failure_scenario, remedy}[], rewritten?: string[]}} at `leaf` is the tree's node;
 *   `brief` is the producer thread's `leafBrief` text; `units` are `reviewUnits`' names; `rewritten` the
 *   measurement's `tests_rewritten`
 * @returns {string}
 */
export function reviewerBrief({ leaf, brief, span, producer, units = [], prior = [], rewritten = [] }) {
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
    String(producer.text || '').trim() || '(none)', '',
    '## The units you rule', '',
    'Rule every unit below in `units`, under exactly its name. `criterion:<n>` is the brief\'s acceptance criterion n, ' +
      'counted from 1; `file:<path>` is the change to that file; `approved-case:<file>#<id>` is a case of the red\'s ' +
      'approved tests that fails at this head: rule whether the case is wrong.', '',
    bullets(units), '',
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

/**
 * Pure. A folder's integration reviewer's prompt: the merged span, the caveat when planned children
 * did not land, the units to rule, the claims to rule, and the folder's spec as the yardstick.
 *
 * @param {{folder: {id: string, title?: string, worktree?: string}, spec: string, units: string[],
 *   span: {base: string, head: string}, caveat?: string, guidance?: string,
 *   outside?: {leaves: {id: string, commits: string[]}[], commits: string[]},
 *   undiscriminated?: {id: string, nets: {file: string, why: string}[]}[], rewritten?: string[]}} at `spec` is the spec's text,
 *   `outside` the work a person did and the user adopted, `undiscriminated` its leaves no test discriminates (`undiscriminated`),
 *   `rewritten` the existing tests its children rewrote outside what they expected
 * @returns {string}
 */
export function integrationBrief({ folder, spec, units = [], span, caveat = '', guidance = '', outside = { leaves: [], commits: [] }, undiscriminated = [], rewritten = [] }) {
  const lines = [
    '# Integration review of folder ' + folder.id + (folder.title ? ' — ' + folder.title : ''), '',
    'Its children have merged' + (folder.worktree ? ' in the worktree ' + folder.worktree : '') + '. Look for defects that exist ' +
      'only with the children together, and for any decision of the spec no child realised.', '',
    '## The span', '',
    'Review the merged change from ' + span.base + ' to ' + span.head + '. Read it with:', '',
    ...spanLines(span), '',
  ]
  if (caveat) {
    lines.push('## Caveat', '', caveat.trim(), '',
      'Every finding you report carries this caveat: the change you review is not the whole folder.', '')
  }
  if (outside.leaves.length || outside.commits.length) {
    lines.push('## Work agentics did not produce', '',
      'A person did this part of the folder by hand, and the user adopted it on their word: no agentics review has judged it. ' +
        'Rule it as strictly as the rest; its criteria are units below.', '',
      ...outside.leaves.map((l) => '- leaf ' + l.id + ': ' + (l.commits.join(', ') || '(no commits named)')),
      ...(outside.commits.length ? ['- commits that belong to no leaf: ' + outside.commits.join(', ')] : []), '')
  }
  if (undiscriminated.length) {
    lines.push('## Leaves with no discriminating test', '',
      'The user ruled every changed test file of these leaves a regression net over behaviour that held at base, so no test ' +
        'of theirs fails without their change: only their criterion checks pin it. Judge whether those checks and the merged code do.', '',
      ...undiscriminated.flatMap((l) => ['- leaf ' + l.id + ':', ...l.nets.map((x) => '  - ' + x.file + ' — ' + x.why)]), '')
  }
  lines.push(
    '## The units you rule', '',
    'Rule every unit below in `units`, under exactly its name.', '',
    bullets(units), '',
    ...rewrittenLines(rewritten),
    '## Claims', '',
    'Give one entry in `claims` for each claim the spec makes — each success criterion of its Intent, each statement of its ' +
      'Design, each criterion of its plan: `{claim, ruling, evidence}`, the ruling one of met, equivalent (the same observable ' +
      'behaviour, only a name, a signature\'s shape or an internal structure differing, and nothing outside the folder relying ' +
      'on it), under, over, deviates, spec_defect or cant_tell. A HUMAN: criterion is the user\'s: leave it out.', '',
    '## The spec, your yardstick', '',
    String(spec).trim(), '',
  )
  return closing(lines, guidance)
}

/**
 * Pure. A folder's integration reviewer's prompt over a spec edited since its last review, the merged
 * work unchanged: the span the last review judged, the edit as a diff, the last review's rulings numbered
 * `claim:<n>`, the units (every claim not ruled a pass, and `change`) and the spec as it now reads.
 *
 * @param {{folder: {id: string, title?: string, worktree?: string}, spec: string, diff: string,
 *   prior: {claim: string, ruling: string}[], span: {base: string, head: string}, guidance?: string}} at `prior` is the
 *   last review's `claims`, in its order
 * @returns {string}
 */
export function integrationRerule({ folder, spec, diff, prior, span, guidance = '' }) {
  const units = [...prior.flatMap((c, i) => (PASSING.includes(c.ruling) ? [] : ['claim:' + (i + 1)])), 'change']
  return closing([
    '# Integration re-rule of folder ' + folder.id + (folder.title ? ' — ' + folder.title : ''), '',
    'Its spec was edited since the last integration review; the merged work did not change' +
      (folder.worktree ? ' (the worktree ' + folder.worktree + ')' : '') + '. Rule only what the edit touches.', '',
    '## The span', '',
    'The head the last review judged is the head now: from ' + span.base + ' to ' + span.head + '. Read it with:', '',
    ...spanLines(span), '',
    '## The edit to the spec', '',
    '~~~~diff', String(diff).trimEnd(), '~~~~', '',
    '## The last review\'s rulings', '',
    bullets(prior.map((c, i) => 'claim:' + (i + 1) + ' [' + c.ruling + '] ' + c.claim)), '',
    '## The units you rule', '',
    'Rule every unit below in `units`, under exactly its name. `claim:<n>` is that claim of the last review, ruled again ' +
      'against the spec as it now reads; `change` is every claim the changed lines make or alter.', '',
    bullets(units), '',
    '## Claims', '',
    'Return in `claims` only the claims you ruled: each unit claim, restated against the current text, and each claim the ' +
      'change makes or alters. `{claim, ruling, evidence}`, the ruling one of met, equivalent, under, over, deviates, ' +
      'spec_defect or cant_tell. Every other claim keeps its last ruling and is not judged again. Report findings only on ' +
      'what the change touches. A HUMAN: criterion is the user\'s: leave it out.', '',
    '## The spec as it now reads, your yardstick', '',
    String(spec).trim(), '',
  ], guidance)
}

/** Pure. One node as the ruler rules it: why it is in question, its plan entry, and the change. */
function entryBlock(id, entry, note, diff) {
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
    '~~~~diff', String(diff || '').trimEnd(), '~~~~', '',
  ].join('\n')
}

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
  const blocks = [...new Set(records.map((r) => r.node))].map((id) => {
    const hits = records.filter((r) => r.node === id)
    const note = 'Work merged into ' + target + ' touched ' +
      hits.map((r) => 'contract ' + r.contract + ' (' + r.files.join(', ') + ')').join(' and ') + ', which it consumes.'
    return { id, text: entryBlock(id, hits[0].entry, note, diffs[id]) }
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
    return { id: n.node, text: entryBlock(n.node, n.entry, note, diffs[n.node]) }
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
  const blocks = [
    entryBlock(unit, entry, 'The unit about to merge.', diff),
    ...(conflict ? ['# What merged into the folder since ' + unit + ' was cut', '', '~~~~diff', String(merged || '').trimEnd(), '~~~~', ''] : []),
    ...others.map((o) => entryBlock(o.id, o.entry,
      'Status: ' + o.status + '. ' + o.facts.map((f) => (f.kind === 'overlap' ? 'Its branch changed ' : 'It expects to change ') + f.paths.join(', ') + '.').join(' '),
      o.diff)),
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
 * Pure. The ruler's prompt on a leaf's review loop: the ruling it gives and the schema it returns,
 * the leaf, and each review round oldest first — the producer round it reviewed, what it left open
 * and the prior blockers it ruled not fixed.
 *
 * @param {{leaf: object, reviews: {review_round: number, round: number, open?: {id: string,
 *   severity: string, claim: string}[], unfixed?: string[]}[]}} at `leaf` is the tree's node;
 *   `reviews` are the leaf's review records of this execution, oldest first
 * @returns {string}
 */
export function convergenceBrief({ leaf, reviews = [] }) {
  return [
    '# Rule whether the review loop of leaf ' + leaf.id + ' — ' + leaf.title + ' — converges', '',
    'Give the convergence ruling and return `ruler_convergence`: `ruling` and `why`.',
    'The loop has run ' + reviews.length + ' review rounds without approval. Each round below is a fresh reviewer\'s, on the producer ' +
      'round it names; what it left open went back to the producer.', '',
    ...reviews.flatMap((r) => [
      '## Review round ' + r.review_round + ' (producer round ' + r.round + ')', '',
      'Left open:',
      bullets((r.open || []).map((f) => '[' + f.id + '] ' + f.severity + ': ' + f.claim)),
      ...((r.unfixed || []).length ? ['', 'Prior blockers it ruled not fixed: ' + r.unfixed.join(', ')] : []), '',
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
    bullets(findings.map((f) => '[' + f.id + '] (' + f.severity + (f.section ? ', ' + f.section : '') + ') ' + f.claim +
      (f.evidence ? '\n  evidence: ' + f.evidence : ''))), '')
  } else {
    lines.push('A producer\'s return reached you: answer it by editing the spec. An answer that would state or change a ' +
      'decision is not yours: return `needs_decision` with the question.',
    'Return `planner_write`: `written` once the spec is edited, or `needs_decision`.', '',
    '## The request', '',
    '- from: ' + request.node, '- status: ' + request.status, '',
    String(request.text || '').trim() || '(none)', '')
  }
  if (String(context).trim()) lines.push('## Evidence on its ground', '', 'A survey of this folder\'s ground gathered:', '', String(context).trim(), '')
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
