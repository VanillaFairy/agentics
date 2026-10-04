// lib/briefs/investigate.mjs — the prompt the investigate program builds: one analyst turning a
// survey's evidence into an ordered task list or a written answer.
//
// Design: docs/DESIGN.md#programs.

const join = (...parts) => parts.filter(Boolean).join('\n\n')

/** Pure. One caveat per gap in the survey's coverage, so the prose names what the evidence lacks. */
function caveatsOf(coverage) {
  return [
    coverage.dropped.length ? 'NOTE: these topics produced no evidence: ' + coverage.dropped.join(', ') +
      '. Name them, and say what they would have answered.' : '',
    coverage.incomplete.length ? 'NOTE: these topics and channels were not searched to exhaustion: ' + coverage.incomplete.join(', ') +
      '. Lead with that limit, do not present the answer as settled, and say what would have to be searched to settle it.' : '',
    coverage.failed_channels.includes('history') ? 'NOTE: the history channel failed. Any claim about when or why something ' +
      'changed is unsupported; say so.' : '',
    coverage.failed_channels.includes('docs') ? 'NOTE: the docs channel failed. Any claim resting on vendor or standards ' +
      'behaviour is unsupported; say so.' : '',
    coverage.unreached.length ? 'NOTE: not reached at all: ' + coverage.unreached.join('; ') + '.' : '',
  ]
}

const TASKS = 'Turn this investigation into an ordered task list. Subjects are imperative and short, activeForm their ' +
  'present continuous. Every description must stand alone: carry the path:line references and enough context to act ' +
  'on without ever seeing this investigation. ref is a local id that only blocked_by uses. Put whatever the evidence ' +
  'cannot establish in gaps, and never invent a task to paper over one.'

const REPORT = 'Write the answer to this question. Lead with the recommendation in one or two sentences; then the ' +
  'reasons that decide it, each tied to a path:line, a commit or a URL; then risks and open questions, only where they ' +
  'change the decision. Do not restate the question, and do not list options you rejected.'

/**
 * Pure. The synthesis brief: the question, the survey's evidence whole, a caveat per coverage gap,
 * and what to return.
 */
export function synthesisBrief({ question, asTasks, evidence, coverage, guidance = '' }) {
  return join(
    asTasks ? 'Mode: turning an investigation into tasks. Return the investigate_tasks schema.'
      : 'Mode: answering an investigation. Return the investigate_report schema.',
    asTasks ? TASKS : REPORT,
    'QUESTION:\n' + question,
    evidence
      ? 'EVIDENCE — what the survey established, whole: every evidence item (one claim each, with its state and what ' +
        'it rests on), the risks its judges named, and what the history and docs channels found:\n\n' + evidence
      : 'EVIDENCE: the survey established nothing, so there is nothing to work from. Say so, and name what would ' +
        'have to be gathered.',
    ...caveatsOf(coverage),
    'You have no search tools: work from the evidence above. What it cannot settle is a gap, never something to go ' +
      'and look up.',
    guidance,
  )
}
