// lib/approval.mjs — approval as a ledger line holding the spec's hash, and a folder's approval
// state derived from the spec on disk and those lines.
//
// Design: docs/DESIGN.md#specs-approval-and-compile.
//
// Why a hash. "The user approved it" has to survive the user editing the spec afterwards: an
// approval names the exact text it approved, and a spec whose text moved on is edited since
// approval, which compile leaves out. The state is computed on every read, never stored (GP5).
// Line endings and a byte-order mark are not text: `hashSpec` normalises both.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { append, readLog } from './ledger.mjs'
import { checkFolder, hashSpec } from './spec.mjs'
import { ROOT_ID, envelope, flagOf, nodeIdProblem, safeSlug, specPath } from './store.mjs'

const OUTCOMES = ['incorporated', 'discarded']
const DISPOSERS = ['user', 'planner']

/** What is wrong with the effort or folder named, or ''. */
function nameProblem(effort, folderId) {
  if (!safeSlug(effort)) return 'not an effort name: ' + JSON.stringify(effort)
  if (folderId !== ROOT_ID && nodeIdProblem(folderId)) return nodeIdProblem(folderId)
  return ''
}

const refuse = (error) => ({ ok: false, error })

function write(repo, effort, line) {
  const out = append(repo, effort, 'ledger', line)
  return out.ok ? { ok: true, seq: out.seqs[0] } : refuse(out.error)
}

/** The folder's spec, checked, or the reason it cannot be recorded. */
function checked(repo, effort, folderId) {
  const c = checkFolder(repo, effort, folderId)
  if (!c.exists) return { error: 'there is no spec at ' + c.file }
  if (c.problems.length) {
    return { error: 'the spec has problems: ' + c.problems.map((p) => p.file + ':' + p.line + ' ' + p.problem).join('; ') }
  }
  return { c }
}

/**
 * Record the user's approval of the folder's spec as it stands. Only after they approve in so many
 * words. A spec with an open blocking question has not passed the Grill, so it is not approvable.
 */
export function recordApproval(repo, effort, folderId) {
  const bad = nameProblem(effort, folderId)
  if (bad) return refuse(bad)
  const { c, error } = checked(repo, effort, folderId)
  if (error) return refuse(error)
  const blocking = c.spec.questions.filter((q) => q.grade === 'blocking')
  if (blocking.length) {
    return refuse('the spec has an open blocking question, so it cannot be approved: ' +
      blocking.map((q) => c.file + ':' + q.line + ' ' + q.text).join('; '))
  }
  const decisions = c.spec.decisions.map(({ id, text }) => ({ id, text }))
  const out = write(repo, effort, { kind: 'approved', folder: folderId, hash: c.hash, decisions, by: 'user' })
  return out.ok ? { ...out, hash: c.hash } : out
}

/** Record that a planner-written spec passed its autonomous review, naming the review's raw return. */
export function recordPreparation(repo, effort, folderId, { review = '' } = {}) {
  const bad = nameProblem(effort, folderId)
  if (bad) return refuse(bad)
  if (typeof review !== 'string' || review.trim() === '') return refuse('a preparation names the review return it passed')
  const { c, error } = checked(repo, effort, folderId)
  if (error) return refuse(error)
  if (c.authoredBy !== 'planner') return refuse('only a planner-written spec is prepared; ' + folderId + ' is the user\'s, so it is approved')
  const out = write(repo, effort, { kind: 'prepared', folder: folderId, hash: c.hash, review: review.trim(), by: 'planner' })
  return out.ok ? { ...out, hash: c.hash } : out
}

export function recordCompiled(repo, effort, folderId, hash) {
  const bad = nameProblem(effort, folderId)
  if (bad) return refuse(bad)
  return write(repo, effort, { kind: 'compiled', folder: folderId, hash: String(hash || '') })
}

export function recordDisposition(repo, effort, folderId, { finding = '', outcome = '', by = '' } = {}) {
  const bad = nameProblem(effort, folderId)
  if (bad) return refuse(bad)
  if (typeof finding !== 'string' || finding.trim() === '') return refuse('a disposition names its finding')
  if (!OUTCOMES.includes(outcome)) return refuse('a finding is incorporated or discarded, not ' + JSON.stringify(outcome))
  if (!DISPOSERS.includes(by)) return refuse('a finding is settled by the user or the planner, not ' + JSON.stringify(by))
  return write(repo, effort, { kind: 'disposition', folder: folderId, finding: finding.trim(), outcome, by })
}

export function recordReviewSkipped(repo, effort, folderId, reason) {
  const bad = nameProblem(effort, folderId)
  if (bad) return refuse(bad)
  if (typeof reason !== 'string' || reason.trim() === '') return refuse('a skipped review says why it was not earned')
  let hash = ''
  try {
    hash = hashSpec(readFileSync(specPath(repo, effort, folderId), 'utf8'))
  } catch {
    return refuse('there is no spec to skip the review of')
  }
  return write(repo, effort, { kind: 'review_skipped', folder: folderId, hash, reason: reason.trim() })
}

/**
 * Record how much of the spec, at its current hash, one review examined, and the settlement id of
 * every ambiguity it returned (carried ones included). The Next line reads the latest of these: a
 * partial review of the text on disk sends the folder back for the axes left. The gate reads it too.
 */
export function recordReviewed(repo, effort, folderId, { complete, remaining = [], ambiguities = [] } = {}) {
  const bad = nameProblem(effort, folderId)
  if (bad) return refuse(bad)
  if (typeof complete !== 'boolean') return refuse('a review is complete or it is not, not ' + JSON.stringify(complete))
  if (!Array.isArray(remaining) || remaining.some((a) => typeof a !== 'string' || a.trim() === '')) {
    return refuse('remaining lists the unexamined axes by name')
  }
  if (complete !== (remaining.length === 0)) {
    return refuse(complete ? 'a complete review leaves no axis unexamined' : 'a partial review names the axes it left unexamined')
  }
  if (!Array.isArray(ambiguities) || ambiguities.some((a) => typeof a !== 'string' || a.trim() === '')) {
    return refuse('ambiguities lists the settlement id of each ambiguity the review returned')
  }
  let hash = ''
  try {
    hash = hashSpec(readFileSync(specPath(repo, effort, folderId), 'utf8'))
  } catch {
    return refuse('there is no spec that was reviewed')
  }
  return write(repo, effort, {
    kind: 'reviewed', folder: folderId, hash, complete, remaining: remaining.map((a) => a.trim()),
    ambiguities: [...new Set(ambiguities.map((a) => a.trim()))],
  })
}

/** Derived, never stored: the folder's approval state from its spec on disk and its ledger lines. */
export function approvalState(repo, effort, folderId) {
  let hash = ''
  try {
    hash = hashSpec(readFileSync(specPath(repo, effort, folderId), 'utf8'))
  } catch {
    hash = ''
  }
  const lines = nameProblem(effort, folderId) ? [] : readLog(repo, effort, 'ledger').entries.filter((l) => l.folder === folderId)
  const latest = (...kinds) => lines.filter((l) => kinds.includes(l.kind))
    .reduce((best, l) => (!best || (l.seq || 0) > (best.seq || 0) ? l : best), null)
  const signed = latest('approved', 'prepared')
  const approved = latest('approved')
  const compiled = latest('compiled')
  return {
    state: !signed ? 'none' : signed.hash !== hash ? 'edited' : signed.kind,
    hash,
    approved_hash: signed ? String(signed.hash || '') : '',
    compiled_hash: compiled ? String(compiled.hash || '') : '',
    decisions: approved && Array.isArray(approved.decisions) ? approved.decisions : [],
  }
}

/**
 * Derived, never stored: whether the spec as it stands passed its review. The latest `reviewed`
 * line at the spec's current hash says how much of this text was examined and which ambiguities
 * came back; a `disposition` line of the folder, from this round or an earlier one, settles an
 * ambiguity by its settlement id. An edit leaves no `reviewed` line at the new hash, so the gate
 * stays shut until a review reads the text the user is asked to approve.
 */
export function approvalGate(repo, effort, folderId) {
  const { hash } = approvalState(repo, effort, folderId)
  const lines = nameProblem(effort, folderId) || hash === '' ? [] : readLog(repo, effort, 'ledger').entries.filter((l) => l.folder === folderId)
  const review = lines.filter((l) => l.kind === 'reviewed' && l.hash === hash)
    .reduce((best, l) => (!best || (l.seq || 0) > (best.seq || 0) ? l : best), null)
  if (!review) return { ratifiable: false, open: [], coverage_complete: false, remaining: [], reviewed: false }
  const settled = new Set(lines.filter((l) => l.kind === 'disposition').map((l) => l.finding))
  const open = (Array.isArray(review.ambiguities) ? review.ambiguities : []).filter((id) => !settled.has(id))
  const coverage = review.complete === true
  return {
    ratifiable: coverage && open.length === 0, open, coverage_complete: coverage,
    remaining: Array.isArray(review.remaining) ? review.remaining : [], reviewed: true,
  }
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  try {
    const argv = process.argv.slice(2)
    const [command] = argv
    const repo = flagOf(argv, 'repo') || '.'
    const effort = flagOf(argv, 'effort')
    const folder = flagOf(argv, 'folder') || ROOT_ID
    const run = {
      approve: () => recordApproval(repo, effort, folder),
      prepare: () => recordPreparation(repo, effort, folder, { review: flagOf(argv, 'review') }),
      dispose: () => recordDisposition(repo, effort, folder, {
        finding: flagOf(argv, 'finding'), outcome: flagOf(argv, 'outcome'), by: flagOf(argv, 'by'),
      }),
      'skip-review': () => recordReviewSkipped(repo, effort, folder, flagOf(argv, 'reason')),
      reviewed: () => recordReviewed(repo, effort, folder, {
        complete: { true: true, false: false }[flagOf(argv, 'complete')],
        remaining: flagOf(argv, 'remaining').split(',').map((a) => a.trim()).filter(Boolean),
        ambiguities: flagOf(argv, 'ambiguities').split(',').map((a) => a.trim()).filter(Boolean),
      }),
      state: () => approvalState(repo, effort, folder),
      gate: () => approvalGate(repo, effort, folder),
    }[command]
    if (!run) throw new Error('unknown command ' + JSON.stringify(command || '') + ' — expected approve, prepare, dispose, skip-review, reviewed, state or gate')
    console.log(JSON.stringify(envelope(run())))
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
