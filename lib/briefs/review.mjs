// lib/briefs/review.mjs — the prompt the review program hands its one reviewer.
//
// Design: docs/DESIGN.md#the-simple-task.

/**
 * Pure. The reviewer's brief: the change by its two shas and the commands that read it, every unit
 * to rule by name, the criteria that are the user's, the prior round's open findings, and the
 * repository's guidance.
 *
 * @param {{base: string, sha: string, criteria: {unit: string, text: string}[], files: string[], human: string[], prior: object[], guidance: string}} at
 */
export function reviewBrief({ base, sha, criteria = [], files = [], human = [], prior = [], guidance = '' }) {
  const lines = [
    '# Review an inline change', '',
    'The change runs from ' + base + ' to ' + sha + ', a snapshot of the user\'s working tree committed on their HEAD.',
    'Your working folder is checked out at ' + sha + '. Read the change with:', '',
    '    git log --reverse -p ' + base + '..' + sha,
    '    git diff ' + base + ' ' + sha, '',
    '## The units you rule', '',
    'Rule every unit below in `units`, under exactly its name.', '',
    ...criteria.map((c) => '- ' + c.unit + ' — ' + c.text),
    ...files.map((f) => '- file:' + f + ' — the change to this file'), '',
  ]
  if (human.length) {
    lines.push('## Criteria that are not yours', '', 'These are the user\'s to check. Rule none of them:', '', ...human.map((h) => '- ' + h), '')
  }
  if (prior.length) {
    lines.push('## Prior blockers', '',
      'Rule each in `fix_rulings` as fixed, not_fixed or regressed, with evidence; one not fixed is a finding this round too, under its id:', '',
      ...prior.map((f) => '- [' + f.id + '] (' + f.severity + ') ' + f.claim + (f.evidence ? '\n  evidence: ' + f.evidence : '') +
        (f.failure_scenario ? '\n  goes wrong when: ' + f.failure_scenario : '')), '')
  }
  if (guidance) lines.push(guidance, '')
  return lines.join('\n')
}
