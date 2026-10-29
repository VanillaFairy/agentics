// lib/briefs/respec.mjs — the prompt the rule program hands its ruler: a changed spec, every node the
// change reaches, and every spec those nodes name, whole.
//
// Design: docs/DESIGN.md#a-changed-spec.

import { fenced } from './size.mjs'

/**
 * Pure. The ruler's brief from what `respecBrief` in lib/respec.mjs read: `parts` is `{effort, folder,
 * file, from, hash, diff, changedDecisions[], written[], retired[], own, work[{id, status, change,
 * entry}], clears[{node, status, why, question}], reached[{id, why[], entry, own}], standing[],
 * choices[{unit, why}], answers[{seq, nodes[], answers[{question, answer}]}],
 * specs[{path, text}]}`, every path repo-relative. The ruler returns its rulings as its structured
 * output; `guidance`, when given, ends the brief.
 */
export function rulerBrief({
  effort, folder, file, from, hash, diff, changedDecisions = [], written = [], retired = [], own, work = [], clears = [],
  reached = [], standing = [], choices = [], answers = [], specs = [], guidance = '',
}) {
  const lines = [
    '# A changed spec: ' + folder + ' of effort ' + effort, '',
    'The spec ' + file + ' was compiled at ' + from + ' and now reads ' + hash + '. Nobody has approved the new text.', '',
    '## The change', '', fenced(diff, 'diff'), '',
    'Decisions whose text changed: ' + (changedDecisions.join(', ') || 'none') + '.',
    'Nodes that compile to a new revision: ' + (written.join(', ') || 'none') + '. Retired: ' + (retired.join(', ') || 'none') + '.', '',
    "## The user's answers", '',
    'What the user answered since this spec was last approved, in their own words. A choice they made',
    'here is theirs and settled: it is never put to them again.', '',
    ...(answers.length
      ? answers.flatMap((a) => ['### Answer ' + a.seq + (a.nodes.length ? ' (about ' + a.nodes.join(', ') + ')' : ''), '',
        ...a.answers.flatMap((x) => ['> ' + x.question.split('\n').join('\n> '), '', fenced(x.answer), ''])])
      : ['(none)', '']),
    '## Nodes to rule', '',
    '### ' + folder, '',
    'The changed spec itself, as it now stands, is ' + own + ' under "The specs" below.',
    'Rule it `affected` when the change contradicts anything else this spec states, leaves an entry of',
    'its plan unable to be built as written, when work already dispatched or merged under it no longer',
    'meets what the spec now says of it, or when a stop listed below is not answered by the new text;',
    "`answered` when each of those is settled by the user's answers above.", '',
    'Work under it:',
    ...(work.length ? work.map((w) => '- ' + w.id + ' — ' + w.status + ' — its entry ' + w.change + ' — ' + w.entry) : ['(none)']), '',
    'Stops that approving this text clears:',
    ...(clears.length ? clears.map((x) => '- ' + x.node + ' — ' + x.status + ' (' + x.why + ')' + (x.question ? ': ' + x.question : '')) : ['(none)']), '',
  ]
  for (const node of reached) {
    lines.push('### ' + node.id, '', 'Reached because it ' + node.why.join('; it ') + '.',
      'Its plan entry: ' + (node.entry || '(none)') + (node.own ? '. Its own spec: ' + node.own : '') +
        '. Each spec it names is under "The specs" below: weigh what it says of the changed spec.',
      'Rule it `affected` when something it takes from the changed spec, as it uses it, no longer holds;',
      "`answered` when the user's answers above settle how it stands.", '')
  }
  for (const choice of choices) {
    lines.push('### ' + choice.unit, '', "A choice of the user's: the change " + choice.why + '.',
      'Rule it `answered` when an answer above settles it as the spec now states it, citing those',
      'answers; `affected` when no answer does, or the spec states more than the answers chose.', '')
  }
  if (standing.length) {
    lines.push('## Not ruled', '', ...standing.map((id) => '- ' + id + ': already waits on the user; its stop stands'), '')
  }
  lines.push('## Rulings', '',
    'Return the rulings as your structured output, in this shape:', '',
    '    {"rulings": [{"node": "<id>", "ruling": "unaffected" | "answered" | "affected", "why": "<one sentence>", "question": "", "fix": "", "answers": []}]}', '',
    'One ruling per unit under "Nodes to rule", under exactly that id. `unaffected`: the change moves nothing',
    "it relies on. `answered`: the change moves it, and the user's answers settle exactly how, as the spec",
    'now states it; `answers` lists the seqs of those answers. `affected`: no answer settles it; `question`',
    'is the one question the user must answer, standing on its own, and never one an answer above already',
    "settles. When the new text itself dictates how the node's spec must change and no choice is left open,",
    'say that edit in `fix`, exactly enough to make it; leave `fix` empty whenever a choice is open. A unit',
    'the brief cannot decide is `affected`.', '')
  lines.push('## The specs', '', ...specs.flatMap((s) => ['### ' + s.path, '', fenced(s.text, 'markdown'), '']))
  const text = lines.join('\n')
  return guidance ? text + '\n\n' + guidance : text
}
