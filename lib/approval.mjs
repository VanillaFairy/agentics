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
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { compileEffort } from './compile.mjs'
import { askLine, confirmAct } from './host.mjs'
import { append, readLog } from './ledger.mjs'
import { checkFolder, hashSpec } from './spec.mjs'
import {
  ROOT_ID, envelope, flagOf, handleArgs, mainCheckout, nodeIdProblem, posix, readJson, resolveHandle, resultPath, safeSlug, specPath,
  textFlag,
} from './store.mjs'

const OUTCOMES = ['incorporated', 'discarded']
const DISPOSERS = ['user', 'planner']
const APPROVERS = ['user', 'terminal', 'ruling']

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

/** The folder's spec, checked, if it can be approved at `hash` (when given), or `recordApproval`'s refusal. */
function approvable(repo, effort, folderId, hash) {
  const bad = nameProblem(effort, folderId)
  if (bad) return { refusal: refuse(bad) }
  const { c, error } = checked(repo, effort, folderId)
  if (error) return { refusal: refuse(error) }
  if (hash !== undefined && hash !== c.hash) {
    return { refusal: refuse({ kind: 'spec_changed', message: 'the user was asked about the spec at ' + (String(hash).slice(0, 8) || 'no hash') +
      ' and it is at ' + c.hash.slice(0, 8) + ' now: ask again' }) }
  }
  const blocking = c.spec.questions.filter((q) => q.grade === 'blocking')
  if (blocking.length) {
    return { refusal: refuse('the spec has an open blocking question, so it cannot be approved: ' +
      blocking.map((q) => c.file + ':' + q.line + ' ' + q.text).join('; ')) }
  }
  return { c }
}

/**
 * Record the approval of the folder's spec as it stands: the user's, only after they approve in so
 * many words, or a ruling's, when `lib/respec.mjs` found that a change to a spec approved before
 * moves nothing it reaches. A spec with an open blocking question has not passed the Grill, so it
 * is not approvable. Given `hash`, the hash the user's token named, a spec that has moved on since
 * is refused: the user approved that text, not this one.
 */
export function recordApproval(repo, effort, folderId, { by = 'user', ruled, hash } = {}) {
  if (!APPROVERS.includes(by)) return refuse('a spec is approved by the user, the terminal or a ruling, not ' + JSON.stringify(by))
  if (by === 'ruling' && !Number.isInteger(ruled)) return refuse('an approval by ruling names its ruled line')
  const { c, refusal } = approvable(repo, effort, folderId, hash)
  if (refusal) return refusal
  const decisions = c.spec.decisions.map(({ id, text }) => ({ id, text }))
  const out = write(repo, effort, { kind: 'approved', folder: folderId, hash: c.hash, decisions, by, ...(Number.isInteger(ruled) ? { ruled } : {}) })
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
 * Record how much of the spec, at its current hash, one review examined, the settlement id of every
 * ambiguity it returned (carried ones included) with the section each sits in (`sections`), and the
 * sections it ruled clean. The Next line reads the latest of these: a partial review of the text on
 * disk sends the folder back for the axes left. The gate reads it too.
 */
export function recordReviewed(repo, effort, folderId, { complete, remaining = [], ambiguities = [], clean = [], sections = {} } = {}) {
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
  if (!Array.isArray(clean) || clean.some((s) => typeof s !== 'string' || s.trim() === '')) {
    return refuse('clean lists the sections the review ruled clean by slug')
  }
  const ids = [...new Set(ambiguities.map((a) => a.trim()))]
  if (!isObject(sections) || Object.entries(sections).some(([id, s]) => !ids.includes(id) || typeof s !== 'string' || s.trim() === '')) {
    return refuse('sections maps the settlement id of an ambiguity the review returned to the section it sits in')
  }
  let hash = ''
  try {
    hash = hashSpec(readFileSync(specPath(repo, effort, folderId), 'utf8'))
  } catch {
    return refuse('there is no spec that was reviewed')
  }
  return write(repo, effort, {
    kind: 'reviewed', folder: folderId, hash, complete, remaining: remaining.map((a) => a.trim()), ambiguities: ids,
    clean: [...new Set(clean.map((s) => s.trim()))],
    sections: Object.fromEntries(Object.entries(sections).map(([id, s]) => [id, s.trim()])),
  })
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const listOf = (v) => (Array.isArray(v) ? v : [])

const nonBlank = (v) => typeof v === 'string' && v.trim() !== ''

/**
 * Pure. The sections a probe round ruled clean: every ruling of the section `clean`, none of its
 * units open, and no finding of the round (carried ones included) naming it. A unit is
 * `<axis>@<section>`.
 */
function cleanSections(rulings, open, findings) {
  const sectionOf = (unit) => unit.slice(unit.lastIndexOf('@') + 1)
  const blocked = new Set(listOf(open).filter(nonBlank).map(sectionOf).concat(findings.map((f) => f.section)))
  const verdict = new Map()
  for (const r of rulings.filter((r) => nonBlank(r.unit) && r.unit.includes('@'))) {
    const s = sectionOf(r.unit)
    verdict.set(s, verdict.get(s) !== false && r.ruling === 'clean')
  }
  return [...verdict].filter(([s, clean]) => clean && s !== '' && !blocked.has(s)).map(([s]) => s)
}

/**
 * Record the round a probe reviewed, from its result, so no list passes through a model: complete
 * when its coverage is and no finding went unrecorded; remaining its open units, then each failed
 * channel as `channel:<c>`, then its coverage's incomplete entries, then each unrecorded finding as
 * `unrecorded:<id>`; each ambiguity by its settlement id, with its section; the sections it ruled
 * clean, read from its findings file. The round must have probed this folder's spec as it stands:
 * a result naming another artefact, a snapshot that does not parse or of text the spec has moved on
 * from, and an empty snapshot no unrecorded finding explains are refused, so the gate never opens on
 * a review of other text. A round that kept no snapshot rules no section clean.
 */
export function reviewedFromResult(repo, effort, folderId, result) {
  const bad = nameProblem(effort, folderId)
  if (bad) return refuse(bad)
  if (!isObject(result)) return refuse({ kind: 'no_result', message: 'there is no result to read' })
  if (!isObject(result.units)) return refuse({ kind: 'not_a_probe', message: 'the result rules no units, so it is no probe' })
  const { hash } = approvalState(repo, effort, folderId)
  if (!hash) return refuse('there is no spec that was reviewed')
  const main = mainCheckout(repo)
  const spec = posix(relative(main, specPath(repo, effort, folderId)))
  const probed = posix(relative(main, resolve(main, String(result.artifact || ''))))
  if (probed !== spec) return refuse({ kind: 'not_this_spec', message: 'the round probed ' + (probed || 'nothing') + ', not ' + spec })
  const snapshot = String(result.snapshot || '')
  const unrecorded = listOf(result.unrecorded).filter(nonBlank)
  if (snapshot === '' && unrecorded.length === 0) {
    return refuse({ kind: 'no_snapshot', message: 'the round kept no snapshot and names no unrecorded finding, so the text it read is unknown: probe the spec again' })
  }
  const snap = /^snapshot:([0-9a-f]{8})$/.exec(snapshot)
  if (snapshot !== '' && !snap) return refuse({ kind: 'bad_snapshot', message: 'the round names ' + JSON.stringify(snapshot) + ', which is no snapshot' })
  if (snap && snap[1] !== hash) {
    return refuse({ kind: 'spec_changed', message: 'the round probed the spec at ' + snap[1] + ' and it is ' + hash + ' now: probe it again' })
  }
  const coverage = isObject(result.coverage) ? result.coverage : {}
  const findings = listOf(result.findings).filter(isObject)
  const byId = new Map(findings.map((f) => [f.id, f]))
  const idOf = (id) => (byId.get(id) || {}).item || hash + '#' + id
  const ambiguities = listOf(result.ambiguities)
  const file = snap && nonBlank(result.findings_file) ? readJson(result.findings_file) : null
  return recordReviewed(repo, effort, folderId, {
    complete: coverage.complete === true && unrecorded.length === 0,
    remaining: [
      ...listOf(result.units.open), ...listOf(coverage.failed_channels).map((c) => 'channel:' + c), ...listOf(coverage.incomplete),
      ...unrecorded.map((id) => 'unrecorded:' + id),
    ],
    ambiguities: ambiguities.map(idOf),
    sections: Object.fromEntries(ambiguities.filter((id) => nonBlank((byId.get(id) || {}).section)).map((id) => [idOf(id), byId.get(id).section])),
    clean: isObject(file) ? cleanSections(listOf(file.units).filter(isObject), result.units.open, findings) : [],
  })
}

/** `reviewedFromResult` over a run's result.json. */
function reviewedFromRun(repo, effort, folderId, run) {
  const bad = nameProblem(effort, folderId)
  if (bad) return refuse(bad)
  const handle = resolveHandle(repo, 'run', run)
  if (!handle.ok) return refuse(handle.error)
  const result = readJson(resultPath(repo, handle.value))
  if (!isObject(result)) return refuse({ kind: 'no_result', message: 'run ' + run + ' has no result to read' })
  return reviewedFromResult(repo, effort, folderId, result)
}

/** Pure. The token an act's question must contain (docs/DESIGN.md#the-users-word). */
export function actToken({ act, folder = '', effort = '', hash, seq = null }) {
  const short = String(hash || '').slice(0, 8)
  if (act === 'approve') return 'approve ' + folder + '@' + short + (Number.isInteger(seq) ? '#' + seq : '')
  if (act === 'land') return 'land ' + effort + '@' + short
  if (act === 'adopt') return 'adopt ' + folder + '@' + short
  throw new Error('no token form for the act ' + JSON.stringify(act))
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
    token: hash ? actToken({ act: 'approve', folder: folderId, hash }) : '',
  }
}

/**
 * What stops the spec as it stands from being approved and compiled — its own problems, an open
 * blocking question, or what the compile of it would refuse — as `{file, line, problem}`.
 */
function approvalProblems(repo, effort, folderId, hash) {
  const { refusal } = approvable(repo, effort, folderId, hash)
  if (refusal) return [{ file: '', line: 0, problem: typeof refusal.error === 'string' ? refusal.error : refusal.error.message }]
  const preview = compileEffort(repo, effort, { folder: folderId, preview: folderId })
  return preview.ok ? [] : preview.problems
}

/**
 * The folder's approval state as the session reads it before asking the user: the state, and the
 * token only when the spec can be approved and compiled as it stands; otherwise `problems` say what
 * to fix first, so the user is never asked to approve a text that has to change again.
 */
export function askState(repo, effort, folderId) {
  const st = approvalState(repo, effort, folderId)
  if (!st.token || !['none', 'edited'].includes(st.state)) return { ...st, problems: [] }
  const problems = approvalProblems(repo, effort, folderId, st.hash)
  return { ...st, token: problems.length ? '' : st.token, problems }
}

/**
 * The user's approval on their confirmed word (docs/DESIGN.md#the-users-word): the token of the spec
 * as it stands goes to `confirmAct`, and the approval binds the hash that token named. A spec that
 * cannot be approved and compiled as read is refused first, so nobody is asked about it.
 */
export async function approveAct(repo, effort, folderId, { env = process.env, stdinIsTTY = false, ask } = {}) {
  const { token, hash } = approvalState(repo, effort, folderId)
  const { refusal } = token ? approvable(repo, effort, folderId, hash) : {}
  if (refusal) return refusal
  const problems = token ? approvalProblems(repo, effort, folderId, hash) : []
  if (problems.length) return refuse({ kind: 'compile_refused', message: problems.map((p) => p.file + ':' + p.line + ' ' + p.problem).join('; ') })
  const word = await confirmAct({ token, option: 'Approve', env, stdinIsTTY, ask })
  if (!word.ok) return word
  return recordApproval(repo, effort, folderId, { by: word.by, hash })
}

/**
 * Derived, never stored: whether the spec as it stands passed its review. The latest `reviewed`
 * line at the spec's current hash says how much of this text was examined and which ambiguities
 * came back; a `disposition` line of the folder, from this round or an earlier one, settles an
 * ambiguity by its settlement id: a discard at once, an incorporation only once a `reviewed` line
 * at the current hash, after the disposition, lists the ambiguity's section (as the latest line
 * names it) in `clean`. An edit leaves no `reviewed` line at the new hash, so the gate stays shut
 * until a review reads the text the user is asked to approve.
 */
export function approvalGate(repo, effort, folderId) {
  const { hash } = approvalState(repo, effort, folderId)
  const lines = nameProblem(effort, folderId) || hash === '' ? [] : readLog(repo, effort, 'ledger').entries.filter((l) => l.folder === folderId)
  const atHash = lines.filter((l) => l.kind === 'reviewed' && l.hash === hash)
  const review = atHash.reduce((best, l) => (!best || (l.seq || 0) > (best.seq || 0) ? l : best), null)
  if (!review) return { ratifiable: false, open: [], coverage_complete: false, remaining: [], reviewed: false }
  const sections = isObject(review.sections) ? review.sections : {}
  const cleanAfter = (seq, section) => atHash.some((l) => (l.seq || 0) > seq && listOf(l.clean).includes(section))
  const settles = (d) => d.outcome === 'discarded' ||
    (d.outcome === 'incorporated' && nonBlank(sections[d.finding]) && cleanAfter(d.seq || 0, sections[d.finding]))
  const settled = new Set(lines.filter((l) => l.kind === 'disposition' && settles(l)).map((l) => l.finding))
  const open = listOf(review.ambiguities).filter((id) => !settled.has(id))
  const coverage = review.complete === true
  return {
    ratifiable: coverage && open.length === 0, open, coverage_complete: coverage,
    remaining: Array.isArray(review.remaining) ? review.remaining : [], reviewed: true,
  }
}

/** The flags this CLI takes, each by its kind: a skill's session passes handles only (`handleArgs`). */
const FLAGS = {
  '--repo': 'path', '--effort': 'handle', '--folder': 'handle', '--finding': 'handle', '--outcome': 'handle', '--by': 'handle',
  '--from-run': 'handle', '--complete': 'handle', '--remaining': 'handle', '--ambiguities': 'handle', '--reason': 'text',
  '--reason-file': 'path',
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  try {
    const argv = process.argv.slice(2)
    const bad = handleArgs(argv, FLAGS, { from: 1 })
    if (bad) {
      console.log(JSON.stringify({ error: bad.message, kind: bad.kind }))
      process.exit(1)
    }
    const [command] = argv
    const repo = flagOf(argv, 'repo') || '.'
    const effort = flagOf(argv, 'effort')
    const folder = flagOf(argv, 'folder') || ROOT_ID
    const run = {
      approve: () => approveAct(repo, effort, folder, { stdinIsTTY: process.stdin.isTTY === true, ask: askLine }),
      dispose: () => recordDisposition(repo, effort, folder, {
        finding: flagOf(argv, 'finding'), outcome: flagOf(argv, 'outcome'), by: flagOf(argv, 'by'),
      }),
      'skip-review': () => {
        const reason = textFlag(argv, 'reason')
        return reason.ok ? recordReviewSkipped(repo, effort, folder, reason.value) : refuse(reason.error)
      },
      reviewed: () => {
        if (!argv.includes('--from-run')) {
          return recordReviewed(repo, effort, folder, {
            complete: { true: true, false: false }[flagOf(argv, 'complete')],
            remaining: flagOf(argv, 'remaining').split(',').map((a) => a.trim()).filter(Boolean),
            ambiguities: flagOf(argv, 'ambiguities').split(',').map((a) => a.trim()).filter(Boolean),
          })
        }
        if (['--complete', '--remaining', '--ambiguities'].some((f) => argv.includes(f))) {
          return refuse({ kind: 'bad_args', message: 'a round is read from --from-run or given by --complete, --remaining and --ambiguities, not both' })
        }
        return reviewedFromRun(repo, effort, folder, flagOf(argv, 'from-run'))
      },
      state: () => askState(repo, effort, folder),
      gate: () => approvalGate(repo, effort, folder),
    }[command]
    if (!run) throw new Error('unknown command ' + JSON.stringify(command || '') + ' — expected approve, dispose, skip-review, reviewed, state or gate')
    console.log(JSON.stringify(envelope(await run())))
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
