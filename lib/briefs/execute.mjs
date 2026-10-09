// lib/briefs/execute.mjs — the prompts the execute program builds: a leaf's reviewer, a folder's
// integration reviewer, the ruler on drift, on a moved base and on a leaf's review loop, the planner and the investigator.
//
// Design: docs/DESIGN.md#briefs-and-returns.

import { isYardstick } from '../tree.mjs'

const bullets = (items) => (items.length ? items.map((i) => '- ' + i).join('\n') : '(none)')

/** Pure. The prompt's lines, closed by the repository's guidance when there is any. */
const closing = (lines, guidance) => [...lines, ...(guidance ? [guidance.trim(), ''] : [])].join('\n')

/** Pure. The commands that read a span. */
const spanLines = ({ base, head }) => ['    git log --reverse -p ' + base + '..' + head, '    git diff ' + base + ' ' + head]

const COMMANDS = ['build', 'typecheck', 'suite', 'suite_fast', 'test_one']

/**
 * Pure. A leaf's reviewer's prompt: the span to read, the producer's return with its concerns
 * first, the units to rule, the prior round's open blockers, and the leaf's brief as its producer
 * has it, which names the worktree.
 *
 * @param {{leaf: object, brief: string, span: {base: string, head: string},
 *   producer: {status: string, concerns: string[], text: string}, units: string[],
 *   prior: {id, severity, claim, evidence, failure_scenario, remedy}[]}} at `leaf` is the tree's node;
 *   `brief` is the producer thread's `leafBrief` text; `units` are `reviewUnits`' names
 * @returns {string}
 */
export function reviewerBrief({ leaf, brief, span, producer, units = [], prior = [] }) {
  const concerns = producer.concerns || []
  const lines = [
    '# Review leaf ' + leaf.id + ' — ' + leaf.title, '',
    'You are fresh: nothing from an earlier round reaches you but what this brief holds.',
    ...(isYardstick(leaf)
      ? ['This leaf\'s output is a YARDSTICK (' + (leaf.provides.length ? 'it provides a contract' : 'role ' + leaf.role) +
        '): its majors with a failure scenario block like criticals.']
      : []),
    ...(leaf.role === 'red' ? ['Its tests are what the green is coded against: a test a correct green would fail is critical.'] : []),
    ...(leaf.role === 'green' ? ['The tests were written by another agent before this code and sit outside this locus.'] : []),
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
 *   span: {base: string, head: string}, caveat?: string, guidance?: string}} at `spec` is the spec's text
 * @returns {string}
 */
export function integrationBrief({ folder, spec, units = [], span, caveat = '', guidance = '' }) {
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
  lines.push(
    '## The units you rule', '',
    'Rule every unit below in `units`, under exactly its name.', '',
    bullets(units), '',
    '## Claims', '',
    'Give one entry in `claims` for each claim the spec makes — each success criterion of its Intent, each statement of its ' +
      'Design, each criterion of its plan: `{claim, ruling, evidence}`, the ruling one of met, under, over, deviates, ' +
      'spec_defect or cant_tell. A HUMAN: criterion is the user\'s: leave it out.', '',
    '## The spec, your yardstick', '',
    String(spec).trim(), '',
  )
  return closing(lines, guidance)
}

/** Pure. One node as the ruler rules it: why it is in question, its plan entry, and the change. */
function entryBlock(id, entry, note, diff) {
  return [
    '# ' + id + ' — ' + entry.title, '', note, '',
    '## Plan entry', '',
    'Intent: ' + (String(entry.intent || '').trim() || '(none)'), '',
    'Context: ' + (String(entry.context || '').trim() || '(none)'), '',
    'Acceptance criteria:', bullets((entry.acceptance || []).map((a) => a.text + (a.check ? ' — check: `' + a.check + '`' : ''))), '',
    'Writes:', bullets(entry.locus || []), '',
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
    lines.push('Settle the autonomous review\'s findings below. Give each one disposition: incorporated (you edited the ' +
      'spec\'s Design, Plan or Open questions because of it) or discarded. An ambiguity or a gap can only be incorporated; ' +
      'a note may be discarded. A finding whose fix would state or change a decision is not yours: return ' +
      '`needs_decision` with the question.',
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
