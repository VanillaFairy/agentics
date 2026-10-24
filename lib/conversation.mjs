// lib/conversation.mjs — messages between agent sessions, carried by code: where each goes, the
// prompt that delivers it, and which are still waiting.
//
// Design: docs/DESIGN.md#conversations.

export const ROUTES = [
  { msg: 'findings', from: 'reviewer', remedy: 'code', to: 'producer', answers: ['fix'] },
  { msg: 'findings', from: 'reviewer', remedy: 'tests', to: 'cycle_test', answers: ['tests_added', 'declined'] },
  { msg: 'surviving_mutations', from: 'code', to: 'cycle_test', answers: ['tests_added', 'declined'] },
  { msg: 'needs_tests', from: 'implementer', to: 'cycle_test', answers: ['tests_added', 'declined'] },
  { msg: 'consolidate', from: 'code', to: 'cycle_test', answers: ['tests_consolidated', 'done'] },
  { msg: 'tests_ready', from: 'code', to: 'green_implementer', answers: ['round'] },
  { msg: 'declined', from: 'test-author', to: 'requester', answers: ['round', 'blocked'] },
  { msg: 'needs_context', from: 'implementer', to: 'planner_or_park', answers: ['spec_edit', 'needs_decision'] },
  { msg: 'needs_context', from: 'test-author', to: 'planner_or_park', answers: ['spec_edit', 'needs_decision'] },
  { msg: 'brief_changed', from: 'code', to: 'thread', answers: ['round'] },
  { msg: 'findings', from: 'probe', to: 'planner', answers: ['dispositions'] },
  { msg: 'problems', from: 'code', to: 'planner', answers: ['spec'] },
  { msg: 'refusals', from: 'code', to: 'thread', answers: ['items', 'dispositions', 'rulings'] },
  { msg: 'cut_off', from: 'code', to: 'thread', answers: ['round'] },
  { msg: 'failures', from: 'code', to: 'producer', answers: ['fix'] },
  { msg: 'rebase', from: 'code', to: 'producer', answers: ['fix'] },
  { msg: 'retried', from: 'code', to: 'thread', answers: ['round'] },
  { msg: 'notes', from: 'code', to: 'thread', answers: ['round'] },
]

/** Pure. A sender whose one message goes two ways names the `remedy`; no remedy means `code`. */
export function routeOf({ msg, from, remedy = '' }) {
  const rows = ROUTES.filter((r) => r.msg === msg && r.from === from)
  const row = rows.length > 1 ? rows.find((r) => r.remedy === (remedy === 'tests' ? 'tests' : 'code')) : rows[0]
  return row ? { to: row.to } : { error: { kind: 'no_route', message: 'no route for ' + msg + ' from ' + from } }
}

const list = (v) => (Array.isArray(v) ? v : [])

/** What refused a `refusals` message's entries, by its `of`. */
const REFUSED_BY = {
  items: 'The evidence store refused these items.',
  dispositions: 'The ledger refused these dispositions.',
  rulings: 'The settle refused these rulings.',
}

const TEMPLATES = {
  findings: (p) => 'These findings were made about your work. Answer each in this round.\n\n' +
    list(p.findings).map((f) => '- [' + f.id + '] (' + f.severity + ') ' + f.claim + (f.evidence ? '\n  evidence: ' + f.evidence : '') +
      (f.failure_scenario ? '\n  goes wrong when: ' + f.failure_scenario : '')).join('\n'),
  surviving_mutations: (p) => 'These mutations survived the cycle\'s tests. Add or tighten tests so each one fails, or redeclare one ' +
    'a test already in the suite catches, naming that test; never weaken or remove a test the cycle approved. Or answer ' +
    'declined, with why.\n\n' +
    list(p.mutations).map((m) => '- ' + m.file + ': ' + JSON.stringify(m.find) + ' → ' + JSON.stringify(m.replace) +
      ' survived; it should fail ' + list(m.expect_failing ?? m.tests).join(', ')).join('\n'),
  needs_tests: (p) => 'The implementation\'s author reports that the cycle\'s tests leave this unpinned:\n\n' + String(p.text) +
    '\n\nAdd tests for what the criteria require, or answer declined, with why. You may not read the implementation\'s code.',
  consolidate: (p) => 'The cycle\'s tests pass and its review is done. This round is your consolidate mode: make them lean ' +
    'and declare the mutations they must still catch. With nothing to consolidate, return done and write nothing.' +
    (list(p.retire).length ? '\n\nJudges named these tests to retire or merge:\n\n' +
      list(p.retire).map((r) => '- ' + r.claim + (r.evidence ? '\n  evidence: ' + r.evidence : '')).join('\n') : '') +
    (list(p.held).length ? '\n\nThe audit\'s breaks, each of which must still fail the tests it names; redeclare one whose test you ' +
      'rename or merge, naming the test that now catches it:\n\n' +
      list(p.held).map((m) => '- ' + m.file + ': ' + JSON.stringify(m.find) + ' → ' + JSON.stringify(m.replace) +
        ', caught by ' + list(m.expect_failing).join(', ')).join('\n') : ''),
  tests_ready: (p) => 'The cycle\'s tests now include: ' + list(p.files).join(', ') + '. Make them pass.',
  declined: (p) => 'Your request was declined: ' + String(p.why),
  needs_context: (p) => 'A producer working on ' + String(p.node) + ' asks:\n\n' + String(p.text) +
    '\n\nAnswer by editing the spec; the edit is checked and reviewed before the producer resumes.',
  brief_changed: (p) => 'Your brief changed while you were away. What changed:\n\n' + String(p.changed) + '\n\nThe brief now:\n\n' + String(p.brief),
  problems: (p) => 'The spec check refused your spec:\n\n' + list(p.problems).map((x) => '- ' + x.file + ':' + x.line + ' ' + x.problem).join('\n'),
  // A message recorded before `of` existed renders too: it is rendered when it is delivered.
  refusals: (p) => (Object.hasOwn(REFUSED_BY, String(p.of)) ? REFUSED_BY[p.of] : 'Parts of your return were refused.') +
    ' Correct each and return them again.\n\n' +
    list(p.refusals).map((r) => '- ' + (r.claim || r.id || '') + ': ' + r.problem).join('\n'),
  failures: (p) => 'Your work failed ' + String(p.source) + '. Fix each failure in this round, as new commits.\n\n' +
    list(p.failures).map((f) => '- ' + f.check + ': ' + f.claim + (f.evidence ? '\n  evidence: ' + f.evidence : '')).join('\n'),
  rebase: (p) => 'Your branch could not merge into its folder: it conflicts with work merged there since it was cut. Your ' +
    'worktree now holds the merge of the folder\'s head in progress, conflicted in:\n\n' + list(p.paths).map((x) => '- ' + x).join('\n') +
    '\n\nResolve each conflict so both changes hold, git add the files and git commit to conclude the merge; then check your ' +
    'work against what merged and finish the round as usual.' + (p.why ? '\n\nThe judge\'s ruling: ' + String(p.why) : ''),
  retried: (p) => 'The user cleared the stop on your work' + (p.reason ? ' (' + String(p.reason) + ')' : '') + '. Carry on from where your series stands.' +
    (list(p.notes).length ? '\n\nWhat the user noted:\n\n' + list(p.notes).map((n) => '- ' + String(n)).join('\n') : ''),
  notes: (p) => 'The user left notes on this work before your session started. Take them into account:\n\n' +
    list(p.notes).map((n) => '- ' + String(n)).join('\n'),
  cut_off: () => 'Your last turn was cut off before it returned. Finish the task your brief set, and return your whole structured output, from the start: any part of it you returned before was not kept.',
}

/** Pure. Whether this version can render a message of kind `msg`. */
export const renders = (msg) => Object.hasOwn(TEMPLATES, msg)

/** Pure. Throws on a message with no template: that is a bug in the caller. */
export function renderMessage({ msg, payload = {} }) {
  if (!renders(msg)) throw new Error('no template for message ' + JSON.stringify(msg))
  return TEMPLATES[msg](payload)
}

/**
 * Pure. The event a migration appends when a version drops message kind: the messages it names
 * (`messages`, their seqs) are no session's to be told again. `execution` is theirs.
 */
export const withdrawnEvent = ({ node, execution, messages, why }) => ({ kind: 'withdrawn', node, execution, messages, why })

/** Pure. The messages recorded to `thread` that no `withdrawn` event names, oldest first. */
export function threadMessages(entries, thread) {
  const withdrawn = new Set(entries.filter((e) => e.kind === 'withdrawn').flatMap((e) => list(e.messages)))
  return entries.filter((e) => e.kind === 'message' && e.thread === thread && !withdrawn.has(e.seq)).sort((a, b) => a.seq - b.seq)
}

/** Pure. The kinds of the messages in `entries`, on any thread, that this version cannot render and no `withdrawn` names. */
export function unrenderable(entries) {
  const threads = new Set(entries.filter((e) => e.kind === 'message').map((e) => e.thread))
  return [...new Set([...threads].flatMap((t) => threadMessages(entries, t)).map((m) => m.msg).filter((msg) => !renders(msg)))]
}

const carriedSeqs = (entries) => new Set(entries.filter((e) => e.kind === 'dispatched').flatMap((e) => list(e.carries)))

/** Pure. Messages recorded to `thread` that no `dispatched` carried, oldest first. */
export function pendingMessages(entries, thread) {
  const carried = carriedSeqs(entries)
  return threadMessages(entries, thread).filter((e) => !carried.has(e.seq)).map((e) => ({ seq: e.seq, msg: e.msg, payload: e.payload }))
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
