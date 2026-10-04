// lib/conversation.mjs — messages between agent sessions, carried by code: where each goes, the
// prompt that delivers it, and which are still waiting.
//
// Design: docs/DESIGN.md#conversations.

export const ROUTES = [
  { msg: 'findings', from: 'reviewer', remedy: 'code', to: 'producer', answers: ['fix'] },
  { msg: 'findings', from: 'reviewer', remedy: 'tests', to: 'cycle_test', answers: ['tests_added', 'declined'] },
  { msg: 'surviving_mutations', from: 'code', to: 'cycle_test', answers: ['tests_added', 'declined'] },
  { msg: 'needs_tests', from: 'implementer', to: 'cycle_test', answers: ['tests_added', 'declined'] },
  { msg: 'tests_ready', from: 'code', to: 'green_implementer', answers: ['round'] },
  { msg: 'declined', from: 'test-author', to: 'requester', answers: ['round', 'blocked'] },
  { msg: 'needs_context', from: 'implementer', to: 'planner_or_park', answers: ['spec_edit', 'needs_decision'] },
  { msg: 'needs_context', from: 'test-author', to: 'planner_or_park', answers: ['spec_edit', 'needs_decision'] },
  { msg: 'brief_changed', from: 'code', to: 'thread', answers: ['round'] },
  { msg: 'findings', from: 'probe', to: 'planner', answers: ['dispositions'] },
  { msg: 'problems', from: 'code', to: 'planner', answers: ['spec'] },
  { msg: 'refusals', from: 'code', to: 'judge', answers: ['items', 'rulings'] },
  { msg: 'continue_search', from: 'code', to: 'searcher', answers: ['round'] },
  { msg: 'cut_off', from: 'code', to: 'thread', answers: ['round'] },
]

/** Pure. A sender whose one message goes two ways names the `remedy`; no remedy means `code`. */
export function routeOf({ msg, from, remedy = '' }) {
  const rows = ROUTES.filter((r) => r.msg === msg && r.from === from)
  const row = rows.length > 1 ? rows.find((r) => r.remedy === (remedy === 'tests' ? 'tests' : 'code')) : rows[0]
  return row ? { to: row.to } : { error: { kind: 'no_route', message: 'no route for ' + msg + ' from ' + from } }
}

const list = (v) => (Array.isArray(v) ? v : [])

const TEMPLATES = {
  findings: (p) => 'These findings were made about your work. Answer each in this round.\n\n' +
    list(p.findings).map((f) => '- [' + f.id + '] (' + f.severity + ') ' + f.claim + (f.evidence ? '\n  evidence: ' + f.evidence : '') +
      (f.failure_scenario ? '\n  goes wrong when: ' + f.failure_scenario : '')).join('\n'),
  surviving_mutations: (p) => 'These mutations survived the cycle\'s tests. Add or tighten tests so each one fails; never weaken ' +
    'or remove a test the cycle approved. Or answer declined, with why.\n\n' +
    list(p.mutations).map((m) => '- ' + m.file + ': ' + JSON.stringify(m.find) + ' → ' + JSON.stringify(m.replace) +
      ' survived; it should fail ' + list(m.expect_failing ?? m.tests).join(', ')).join('\n'),
  needs_tests: (p) => 'The implementation\'s author reports that the cycle\'s tests leave this unpinned:\n\n' + String(p.text) +
    '\n\nAdd tests for what the criteria require, or answer declined, with why. You may not read the implementation\'s code.',
  tests_ready: (p) => 'The cycle\'s tests now include: ' + list(p.files).join(', ') + '. Make them pass.',
  declined: (p) => 'Your request was declined: ' + String(p.why),
  needs_context: (p) => 'A producer working on ' + String(p.node) + ' asks:\n\n' + String(p.text) +
    '\n\nAnswer by editing the spec; the edit is checked and reviewed before the producer resumes.',
  brief_changed: (p) => 'Your brief changed while you were away. What changed:\n\n' + String(p.changed) + '\n\nThe brief now:\n\n' + String(p.brief),
  problems: (p) => 'The spec check refused your spec:\n\n' + list(p.problems).map((x) => '- ' + x.file + ':' + x.line + ' ' + x.problem).join('\n'),
  refusals: (p) => 'The evidence store refused these items. Correct each and return them again.\n\n' +
    list(p.refusals).map((r) => '- ' + (r.claim || r.id || '') + ': ' + r.problem).join('\n'),
  continue_search: (p) => 'Your search round ended unfinished. Go on: cover what the original request asks that you have not ' +
    'covered yet, report only what you did not report before, and fill every coverage field.' +
    (String(p.not_reached ?? '').trim() ? '\n\nYou named as not reached: ' + String(p.not_reached).trim() : ''),
  cut_off: () => 'Your last turn was cut off before it returned. Finish the task your brief set, and return your whole structured output, from the start: any part of it you returned before was not kept.',
}

/** Pure. Throws on a message with no template: that is a bug in the caller. */
export function renderMessage({ msg, payload = {} }) {
  if (!Object.hasOwn(TEMPLATES, msg)) throw new Error('no template for message ' + JSON.stringify(msg))
  return TEMPLATES[msg](payload)
}

const carriedSeqs = (entries) => new Set(entries.filter((e) => e.kind === 'dispatched').flatMap((e) => list(e.carries)))

/** Pure. Messages recorded to `thread` that no `dispatched` carried, oldest first. */
export function pendingMessages(entries, thread) {
  const carried = carriedSeqs(entries)
  return entries.filter((e) => e.kind === 'message' && e.thread === thread && !carried.has(e.seq))
    .sort((a, b) => a.seq - b.seq).map((e) => ({ seq: e.seq, msg: e.msg, payload: e.payload }))
}

/** Pure. What delivering to `thread` does now. */
export function deliveryPlan(entries, thread) {
  const open = entries.filter((e) => e.kind === 'dispatched' && e.thread === thread && list(e.carries).length > 0)
    .filter((d) => !entries.some((r) => r.kind === 'returned' && r.dispatch === d.dispatch && r.seq > d.seq))
  if (open.length) return { action: 'resume_carrier', dispatch: open[open.length - 1].dispatch }
  const pending = pendingMessages(entries, thread)
  if (pending.length === 0) return { action: 'none' }
  return { action: 'deliver', carries: pending.map((m) => m.seq), prompt: pending.map((m) => renderMessage(m)).join('\n\n---\n\n') }
}
