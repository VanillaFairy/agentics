// lib/briefs/respec.mjs — the prompt the rule program hands its ruler: a changed spec, every node the
// change reaches, and every spec those nodes name, whole.
//
// Design: docs/DESIGN.md#a-changed-spec.

/**
 * Pure. The ruler's brief from what `respecBrief` in lib/respec.mjs read: `parts` is `{effort, folder,
 * file, from, hash, diff, changedDecisions[], written[], retired[], own, work[{id, status, change,
 * entry}], clears[{node, status, why, question}], reached[{id, why[], entry, own}], standing[],
 * specs[{path, text}]}`, every path repo-relative. The ruler returns its rulings as its structured
 * output; `guidance`, when given, ends the brief.
 */
export function rulerBrief({
  effort, folder, file, from, hash, diff, changedDecisions = [], written = [], retired = [], own, work = [], clears = [],
  reached = [], standing = [], specs = [], guidance = '',
}) {
  const lines = [
    '# A changed spec: ' + folder + ' of effort ' + effort, '',
    'The spec ' + file + ' was compiled at ' + from + ' and now reads ' + hash + '. Nobody has approved the new text.', '',
    '## The change', '', '~~~~diff', diff, '~~~~', '',
    'Decisions whose text changed: ' + (changedDecisions.join(', ') || 'none') + '.',
    'Nodes that compile to a new revision: ' + (written.join(', ') || 'none') + '. Retired: ' + (retired.join(', ') || 'none') + '.', '',
    '## Nodes to rule', '',
    '### ' + folder, '',
    'The changed spec itself, as it now stands, is ' + own + ' under "The specs" below.',
    'Rule it `affected` when the change contradicts anything else this spec states, leaves an entry of',
    'its plan unable to be built as written, when work already dispatched or merged under it no longer',
    'meets what the spec now says of it, or when a stop listed below is not answered by the new text.', '',
    'Work under it:',
    ...(work.length ? work.map((w) => '- ' + w.id + ' — ' + w.status + ' — its entry ' + w.change + ' — ' + w.entry) : ['(none)']), '',
    'Stops that approving this text clears:',
    ...(clears.length ? clears.map((x) => '- ' + x.node + ' — ' + x.status + ' (' + x.why + ')' + (x.question ? ': ' + x.question : '')) : ['(none)']), '',
  ]
  for (const node of reached) {
    lines.push('### ' + node.id, '', 'Reached because it ' + node.why.join('; it ') + '.',
      'Its plan entry: ' + (node.entry || '(none)') + (node.own ? '. Its own spec: ' + node.own : '') +
        '. Each spec it names is under "The specs" below: weigh what it says of the changed spec.',
      'Rule it `affected` when something it takes from the changed spec, as it uses it, no longer holds.', '')
  }
  if (standing.length) {
    lines.push('## Not ruled', '', ...standing.map((id) => '- ' + id + ': already waits on the user; its stop stands'), '')
  }
  lines.push('## Rulings', '',
    'Return the rulings as your structured output, in this shape:', '',
    '    {"rulings": [{"node": "<id>", "ruling": "unaffected" | "affected", "why": "<one sentence>", "question": "", "fix": ""}]}', '',
    'One ruling per node under "Nodes to rule", under exactly that id. For `affected`, `question` is the one',
    'question the user must answer, standing on its own. When the new text itself dictates how the node\'s',
    'spec must change and no choice is left open, say that edit in `fix`, exactly enough to make it;',
    'leave `fix` empty whenever a choice is open. A node the brief cannot decide is `affected`.', '')
  lines.push('## The specs', '', ...specs.flatMap((s) => ['### ' + s.path, '', '~~~~markdown', s.text, '~~~~', '']))
  const text = lines.join('\n')
  return guidance ? text + '\n\n' + guidance : text
}
