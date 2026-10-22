// lib/respec.mjs — a change to a spec that was approved and compiled before: what it reaches,
// the brief a ruler rules it from, and what the rulings settle.
//
// Design: docs/DESIGN.md#a-changed-spec.
//
// `brief` previews the compile of the spec as it stands and writes the ruler's brief — the change
// (a diff against the copy compile kept), every node it reaches and every spec they name, whole,
// in the words of `rulerBrief` (lib/briefs/respec.mjs) — and names the rulings file the `rule`
// program writes the ruler's return to. The brief also holds every answer the user gave since the
// spec was last approved, and puts each of the user's choices the change makes — a decision added,
// changed or removed, a contract changed, a decision park cleared — to the ruler as a unit of its
// own. `settle` reads the rulings: when every unit is ruled unaffected, or `answered` by an answer
// the user gave, the change is approved on that ruling and compiled, and compile spares those nodes
// the parks a re-approval raises; otherwise the questions the answers leave open go to the user.
// Every ruling is a `ruled` ledger line the approval names, with the answers it rests on, so what
// was approved, and on whose word, is on record.
//
// Rulings are bound to a basis: a digest of the text ruled, of the answers it was ruled against
// and of everything the brief showed about the nodes it reaches. Anything of that moving on leaves
// no rulings to settle from.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'

import { answersSince } from './answers.mjs'
import { approvalState, recordApproval } from './approval.mjs'
import { rulerBrief } from './briefs/respec.mjs'
import { compileEffort } from './compile.mjs'
import { append, readLog } from './ledger.mjs'
import { canonical, fnv1a } from './plan-digest.mjs'
import { checkFolder, hashSpec, keptSpecDiff, ownerEntry, parseSpec } from './spec.mjs'
import {
  ROOT_ID, ancestorsOf, mainCheckout, mkdirState, nodeIdProblem, posix, respecPath, safeSlug, specPath,
} from './store.mjs'
import { readTree, subtreeOf } from './tree.mjs'

const RULINGS = ['unaffected', 'answered', 'affected']

/** A refusal and what the session does about it (`next`). */
const refused = (next, why, problems = []) => ({ status: 'refused', next, why, problems })

const latestOf = (lines) => lines.reduce((best, l) => (!best || (l.seq || 0) > (best.seq || 0) ? l : best), null)

/**
 * Everything a brief and a settlement both need, or the refusal: the compile preview, the nodes to
 * rule and why each is reached, the stops an approval would clear, and the basis the rulings are
 * bound to.
 */
function reach(repo, effort, folder) {
  if (!safeSlug(effort)) return refused('fix_spec', 'not an effort name: ' + JSON.stringify(effort))
  if (folder !== ROOT_ID && nodeIdProblem(folder)) return refused('fix_spec', nodeIdProblem(folder))
  const st = approvalState(repo, effort, folder)
  if (st.hash === '') return refused('fix_spec', 'there is no spec for ' + folder)
  if (st.state === 'none') return refused('user_approves', 'the spec of ' + folder + ' was never approved: its first approval is the user\'s')
  if (st.state !== 'edited') return refused('nothing', 'the spec of ' + folder + ' is not edited since its approval (' + st.state + ')')
  if (st.compiled_hash === '') return refused('user_approves', 'the spec of ' + folder + ' was never compiled: its first approval is the user\'s')
  const c = checkFolder(repo, effort, folder)
  if (c.problems.length) return refused('fix_spec', 'the spec has problems', c.problems)
  if (c.authoredBy === 'planner') return refused('planner', folder + ' is the planner\'s: it is re-derived and reviewed, never ruled')
  const blocking = c.spec.questions.filter((q) => q.grade === 'blocking')
  if (blocking.length) return refused('fix_spec', 'the spec has an open blocking question', blocking.map((q) => ({ file: c.file, line: q.line, problem: q.text })))
  const specAt = (f) => checkFolder(repo, effort, f).spec
  const above = folder === ROOT_ID ? null : ownerEntry(folder, specAt).folder
  if (above !== null && approvalState(repo, effort, above).state === 'edited') {
    return refused('rule_parent_first', 'the spec of ' + above + ', which names ' + folder + ', is edited too: it is ruled first')
  }
  const change = keptSpecDiff(repo, effort, folder, st.compiled_hash)
  if (!change.ok) {
    return refused('user_approves', change.kind === 'no_copy'
      ? 'no copy of the text ' + folder + ' was compiled from is kept, so the change cannot be shown'
      : 'git could not show the change to ' + folder)
  }
  const { copy, diff } = change
  const preview = compileEffort(repo, effort, { folder, preview: folder })
  if (!preview.ok) return refused('fix_spec', 'the spec would not compile as it stands', preview.problems)

  const tree = readTree(repo, effort)
  const statusOf = (id) => tree.status.get(id) || { status: 'planned', last: null }
  /** The folder whose spec states `id`'s entry: its nearest ancestor that is not a group. */
  const statedIn = (id) => ancestorsOf(id).find((a) => (tree.nodes.get(a) || {}).kind !== 'group') ?? null
  /** Stopped by an event of its own, not merely summarising its children. */
  const stopped = (id) => ['parked', 'escalated'].includes(statusOf(id).status) && Boolean(statusOf(id).last)
  const at = (id) => {
    const own = id !== folder && existsSync(specPath(repo, effort, id)) ? posix(specPath(repo, effort, id)) : ''
    const owner = id === ROOT_ID ? null : ownerEntry(id, specAt)
    return { own, entry: owner && owner.entry ? posix(specPath(repo, effort, owner.folder)) + ':' + owner.entry.line : '' }
  }

  // A node the change reaches and another spec states is ruled by name. One this spec states is
  // ruled with the spec itself.
  const why = new Map()
  const add = (id, text) => {
    if (id !== folder && statedIn(id) !== folder && !(why.get(id) || []).includes(text)) why.set(id, [...(why.get(id) || []), text])
  }
  for (const x of preview.consumers) add(x.node, 'consumes ' + x.contract + ', which this spec provides')
  for (const x of preview.flagged) add(x.node, 'realises ' + x.decision + ', whose text changed')
  // The stops approving this text clears, which are put to the ruler with the spec itself: a park
  // compile answers because this spec owns the node, and any stop on a node that compiles to a
  // new revision.
  const clears = [...tree.nodes.keys()].filter(stopped)
    .filter((id) => preview.written.includes(id) || (statusOf(id).status === 'parked' && (id === folder || statedIn(id) === folder)))
    .map((id) => {
      const last = statusOf(id).last
      return { node: id, status: statusOf(id).status, why: last.return || last.reason || '', question: last.question || last.detail || '', seq: last.seq || 0 }
    })
  const cleared = new Set(clears.map((x) => x.node))

  // The user's choices this change makes, each a unit of its own, and every answer the user gave
  // since the spec was last approved.
  const ledger = readLog(repo, effort, 'ledger').entries
  const lastApproved = latestOf(ledger.filter((l) => l.kind === 'approved' && l.folder === folder))
  const answers = answersSince(ledger, lastApproved ? lastApproved.seq || 0 : 0)
  const bound = userBound({
    approvedDecisions: st.decisions, decisions: c.spec.decisions,
    compiledEntries: parseSpec(readFileSync(copy, 'utf8')).entries, entries: c.spec.entries, clears,
  })
  const choices = bound
  // Any other node the user already has to act on is not ruled: its stop stands whatever this
  // change does.
  const standing = [...why.keys()].filter((id) => stopped(id) && !cleared.has(id))
  const reachedNodes = [folder, ...[...why.keys()].filter((id) => !stopped(id))]
  const located = new Map(reachedNodes.map((id) => [id, at(id)]))
  const nodes = [...reachedNodes, ...choices.map((b) => b.unit)]

  const work = subtreeOf(tree.nodes, folder)
    .filter((id) => tree.nodes.get(id).kind === 'leaf' && tree.events.some((e) => e.node === id && ['dispatched', 'merged'].includes(e.kind)))
    .map((id) => ({
      id, status: statusOf(id).status, entry: at(id).entry,
      change: preview.retired.includes(id) ? 'is retired' : preview.written.includes(id) ? 'changed' : 'is unchanged',
    }))

  const files = [...new Set([...located.values()].flatMap((l) => [l.own, l.entry.replace(/:\d+$/, '')]).filter(Boolean))].sort()
    .map((path) => [path, hashSpec(readFileSync(path, 'utf8'))])
  const basis = fnv1a(canonical({
    hash: st.hash, from: st.compiled_hash, nodes, standing, files, work: work.map((w) => [w.id, w.change]),
    clears: clears.map((x) => [x.node, x.seq]), revisions: reachedNodes.map((id) => (tree.nodes.get(id) || {}).seq || 0),
    answers: answers.map((a) => a.seq),
  }))
  return { status: 'reach', st, c, diff, preview, nodes, choices, answers, standing, why, located, work, clears, basis }
}

const pathsOf = (repo, effort, folder, r) => ({
  brief: respecPath(repo, effort, folder, r.st.hash + '-' + r.basis, 'md'),
  rulings: respecPath(repo, effort, folder, r.st.hash + '-' + r.basis, 'rulings.json'),
})

/** What the ruler's brief shows of reach `r`: every path repo-relative, every spec it names read whole. */
function briefParts(repo, effort, folder, r) {
  const { st, c, diff, preview, standing, why, located, work, clears, choices, answers } = r
  const main = mainCheckout(repo)
  const named = (p) => posix(relative(main, p))
  const namedEntry = (e) => e.replace(/^(.*):(\d+)$/, (_, p, line) => named(p) + ':' + line)
  const fileOf = (e) => e.replace(/:\d+$/, '')
  const own = posix(specPath(repo, effort, folder))
  const specs = [...new Set([own, ...[...located.values()].flatMap((l) => [l.own, fileOf(l.entry)]), ...work.map((w) => fileOf(w.entry))])]
    .filter(Boolean)
  return {
    effort, folder, file: c.file, from: st.compiled_hash, hash: st.hash, diff,
    changedDecisions: [...new Set(preview.flagged.map((f) => f.decision))], written: preview.written, retired: preview.retired,
    own: named(own),
    work: work.map((w) => ({ id: w.id, status: w.status, change: w.change, entry: namedEntry(w.entry) })),
    clears: clears.map((x) => ({ node: x.node, status: x.status, why: x.why, question: x.question })),
    reached: [...located.keys()].slice(1).map((id) => {
      const at = located.get(id)
      return { id, why: why.get(id), entry: at.entry ? namedEntry(at.entry) : '', own: at.own ? named(at.own) : '' }
    }),
    standing,
    choices,
    answers: answers.map((a) => ({ seq: a.seq, nodes: a.nodes || [], answers: a.answers || [] })),
    specs: specs.map((p) => ({ path: named(p), text: readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trimEnd() })),
  }
}

/**
 * Write the brief a ruler rules a changed spec from: the change, every node it reaches and every spec
 * they name, whole (`rulerBrief`). The ruler returns its rulings, which the `rule` program writes to
 * `rulings`. `parts` is what the brief is built from, `text` the brief the file holds.
 */
export function respecBrief(repo, effort, folder = ROOT_ID) {
  const r = reach(repo, effort, folder)
  if (r.status === 'refused') return r
  const { brief, rulings } = pathsOf(repo, effort, folder, r)
  const parts = briefParts(repo, effort, folder, r)
  const text = rulerBrief(parts)
  mkdirState(dirname(brief))
  writeFileSync(brief, text, 'utf8')
  return {
    status: 'brief', folder, hash: r.st.hash, from: r.st.compiled_hash, basis: r.basis, brief, rulings,
    nodes: r.nodes, standing: r.standing, clears: r.clears.map((x) => x.node), parts, text,
  }
}

/**
 * The rulings a ruler wrote about the spec and its reach as they stand, checked against the units it
 * was given: an `answered` ruling cites answers the brief held, and a choice of the user's is
 * `answered` or `affected`, never `unaffected`.
 */
function readRulings(file, nodes, { choices = [], answers = [] } = {}) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    return { error: 'no readable rulings at ' + file + ' for the spec and what it reaches as they stand: ' + err.message }
  }
  const list = parsed && Array.isArray(parsed.rulings) ? parsed.rulings : null
  if (!list) return { error: file + ' holds no rulings array' }
  const out = []
  for (const id of nodes) {
    const mine = list.filter((x) => x && x.node === id)
    if (mine.length !== 1) return { error: 'exactly one ruling is needed for ' + id + ', and ' + file + ' holds ' + mine.length }
    const { ruling, why = '', question = '', fix = '', answers: cited = [] } = mine[0]
    if (!RULINGS.includes(ruling)) return { error: id + ' is ruled ' + JSON.stringify(ruling) + ', not unaffected, answered or affected' }
    if (typeof why !== 'string' || why.trim() === '') return { error: 'the ruling of ' + id + ' says no why' }
    if (ruling === 'affected' && String(question).trim() === '' && String(fix).trim() === '') return { error: id + ' is ruled affected with neither a question nor a fix' }
    if (ruling === 'unaffected' && choices.includes(id)) {
      return { error: id + ' is a choice of the user\'s: rule it answered, citing their answer, or affected, with the question to ask them' }
    }
    const seqs = Array.isArray(cited) ? cited : []
    if (ruling === 'answered' && (seqs.length === 0 || seqs.some((n) => !answers.includes(n)))) {
      return { error: id + ' is ruled answered citing ' + JSON.stringify(seqs) + '; an answered ruling cites one or more of the answers the brief held: ' + (answers.join(', ') || 'none') }
    }
    const answered = ruling === 'answered' ? { answers: [...new Set(seqs)].sort((a, b) => a - b) } : {}
    out.push({ node: id, ruling, why: why.trim(), question: String(question).trim(), fix: String(fix).trim(), ...answered })
  }
  const extra = list.filter((x) => !x || !nodes.includes(x.node)).map((x) => (x && x.node) || '?')
  if (extra.length) return { error: 'rulings for nodes the brief did not give: ' + extra.join(', ') }
  return { rulings: out }
}

/**
 * Pure. The user's choices a change makes, each a unit only an answer of theirs settles
 * (docs/DESIGN.md#a-changed-spec): `{unit, why}`.
 */
export function userBound({ approvedDecisions = [], decisions = [], compiledEntries = [], entries = [], clears = [] }) {
  const units = []
  const before = new Map(approvedDecisions.map((d) => [d.id, d.text]))
  const now = new Map(decisions.map((d) => [d.id, d.text]))
  for (const [id, text] of now) {
    if (!before.has(id)) units.push({ unit: 'decision:' + id, why: 'adds decision ' + id })
    else if (before.get(id) !== text) units.push({ unit: 'decision:' + id, why: 'changes decision ' + id })
  }
  for (const id of before.keys()) if (!now.has(id)) units.push({ unit: 'decision:' + id, why: 'removes decision ' + id })
  const provided = (list) => new Map(list.filter((e) => e.provides && e.provides.length).map((e) => [e.name, canonical(e.provides)]))
  const was = provided(compiledEntries)
  const is = provided(entries)
  for (const name of new Set([...was.keys(), ...is.keys()])) {
    if (was.get(name) !== is.get(name)) units.push({ unit: 'contract:' + name, why: 'changes the contracts ' + name + ' provides' })
  }
  for (const x of clears) {
    if (x.why === 'needs_decision' || x.why === 'contract_changed') {
      units.push({ unit: 'park:' + x.node, why: 'answers the ' + x.why + ' park of ' + x.node })
    }
  }
  return units
}

/** Compile an approval that names its ruling, and say what that did. */
function compileRuled(repo, effort, folder, { hash, ruled, by }) {
  const compiled = compileEffort(repo, effort, { folder })
  if (!compiled.ok) return { status: 'compile_refused', folder, hash, ruled, problems: compiled.problems }
  const { written, retired, flagged, spared, parked, answered } = compiled
  return { status: 'approved', folder, hash, ruled, by, written, retired, flagged, spared, parked, answered }
}

/**
 * What settling reads — the reach and the rulings on disk — or the refusal it gives before anything
 * is appended; `same` is the latest ruled line at the hash when it holds these rulings over this
 * basis. An older line holding the same rulings is not reused: settle records them again as a fresh
 * line, so the line an approval names is the latest ruling of the text.
 */
function rulingsToSettle(repo, effort, folder, ledger) {
  const r = reach(repo, effort, folder)
  if (r.status === 'refused') return r
  const hash = r.st.hash
  const { brief, rulings: file } = pathsOf(repo, effort, folder, r)
  const read = readRulings(file, r.nodes, { choices: r.choices.map((b) => b.unit), answers: r.answers.map((a) => a.seq) })
  if (read.error) return refused('rule_it', read.error)
  const same = latestOf(ledger.filter((l) => l.kind === 'ruled' && l.folder === folder && l.hash === hash && l.basis === r.basis &&
    canonical(l.rulings) === canonical(read.rulings)))
  const latest = latestOf(ledger.filter((l) => l.kind === 'ruled' && l.folder === folder && l.hash === hash))
  return { status: 'readable', r, brief, rulings: read.rulings, same: same && same.seq === latest.seq ? same : null }
}

/**
 * Settle a changed spec from its rulings. When no unit is `affected`, the change is approved on the
 * ruling — by the user's answers when a unit was ruled `answered`, by the ruling alone otherwise — and compiled. Otherwise it is handed back as `needs_user` with each
 * affected unit's question or fix, and nothing is approved. An approval already recorded on a
 * ruling and not yet compiled is compiled.
 */
export function respecSettle(repo, effort, folder = ROOT_ID) {
  const ledger = safeSlug(effort) ? readLog(repo, effort, 'ledger').entries : []
  const st = safeSlug(effort) ? approvalState(repo, effort, folder) : { state: 'none' }
  const signed = latestOf(ledger.filter((l) => l.kind === 'approved' && l.folder === folder && l.hash === st.hash))
  if (st.state === 'approved' && signed && Number.isInteger(signed.ruled) && st.compiled_hash !== st.hash) {
    return compileRuled(repo, effort, folder, { hash: st.hash, ruled: signed.ruled, by: signed.by })
  }

  const got = rulingsToSettle(repo, effort, folder, ledger)
  if (got.status === 'refused') return got
  const { r, brief, rulings, same } = got
  const hash = r.st.hash
  let ruled = same ? same.seq : 0
  if (!ruled) {
    const out = append(repo, effort, 'ledger', {
      kind: 'ruled', folder, hash, from: r.st.compiled_hash, basis: r.basis, rulings, standing: r.standing,
      clears: r.clears.map(({ node, status, why }) => ({ node, status, why })), answers: r.answers.map((a) => a.seq),
      brief, by: 'ruler',
    })
    if (!out.ok) return refused('rule_it', 'the ruled line was not recorded: ' + out.error)
    ruled = out.seqs[0]
  }
  const affected = rulings.filter((x) => x.ruling === 'affected').map(({ node, why, question, fix }) => ({ node, why, question, fix }))
  if (affected.length) return { status: 'needs_user', folder, hash, ruled, affected }

  const answers = [...new Set(rulings.flatMap((x) => x.answers || []))].sort((a, b) => a - b)
  const by = answers.length ? 'answer' : 'ruling'
  const approval = recordApproval(repo, effort, folder, { by, ruled, answers })
  if (!approval.ok) return refused('rule_it', 'the approval was not recorded: ' + approval.error)
  return compileRuled(repo, effort, folder, { hash, ruled, by })
}
