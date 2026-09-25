// lib/brief.mjs — the brief one dispatch works from, assembled by script from the tree, the
// effort's recorded evidence and its gotchas.
//
// Design: docs/DESIGN.md#gp4--scripts-do-the-deterministic-work-each-agent-gets-only-what-it-needs.
//
// Why a script writes it. Everything in a brief is already on disk — the node, the decisions it
// realises, the contracts its dependencies provide, the intents above it, the traps recorded
// under its locus. Having a model gather that is paying for turns to copy text, and copying is
// where a locus gets paraphrased or a criterion dropped. So the brief is computed here, written
// to a file, and the executor fetches it by reference and confirms its digest: bytes never ride a
// model, a path and a digest do.
//
// Why it says what leaf-close will measure. An executor that knows the yardstick up front writes
// the series the yardstick expects — a red leaf's tests failing for want of the implementation, a
// tests-only leaf's declared mutations — instead of learning it from a fix round.
//
// Why evidence is excerpted to verdicts. A survey's evidence is the analyst's input; its verdict
// is the conclusion. The executor gets the conclusion and the risks for the ground it touches,
// never the whole survey, because what an agent is handed is context it pays for on every turn.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { gotchasFor, pathsOverlap } from './gotchas.mjs'
import { fnv1a } from './plan-digest.mjs'
import { ancestorsOf, briefPath, effortDir, flagOf, posix, reportPath, mkdirState } from './store.mjs'
import { definedFor, executorRole, isHuman, ownReview, readTree } from './tree.mjs'

/** The typed statuses an executor returns, with what each one means. */
export const EXECUTOR_STATUSES = {
  done: 'the series is committed and the criteria hold as far as you can tell',
  done_with_concerns: 'done, with concerns the reviewer should read (name them in the report)',
  blocked: 'something outside your locus stops you; the report says what',
  needs_context: 'the brief lacks a fact you need; the report names it',
  decompose: 'the leaf is not atomic; the report proposes its children',
  unsplittable: 'the leaf is too large for one dispatch and cannot be split; the report says why',
  premise_mismatch: 'the tree states something the code contradicts; the report shows both',
  needs_decision: 'a choice the decisions do not settle; the report states the options',
  contract_changed: 'a contract this leaf consumes or provides must change; the report says how',
}

const bullets = (items) => (items.length ? items.map((i) => '- ' + i).join('\n') : '(none)')

/**
 * Pure. What leaf-close will measure for a leaf, one sentence per check, by rigor and role.
 * @param {{rigor: string, role: string, provides: object[]}} leaf
 * @returns {string[]}
 */
export function measuresFor(leaf) {
  const series = 'a commit series on your branch inside the locus — no amends, no rebases; a file outside the locus is a blocking finding'
  const health = 'build and typecheck do not fail, and the existing suite does not fail'
  const named = 'the named check of every acceptance criterion that has one'
  const role = leaf.role || 'none'
  let out
  if (leaf.rigor === 'verify') {
    out = ['nothing is written: ' + named + ' is run and its result recorded; a failure is a finding for the parent, not a fix round']
  } else if (role === 'red') {
    out = [series, 'build and typecheck do not fail',
      'your new tests fail now and fail at the base — for want of the implementation, not for a broken test']
  } else if (role === 'green') {
    out = [series, health, 'the red leaf\'s tests pass now, and they are untouched']
  } else if (role === 'audit') {
    out = ['no new tests are expected',
      'every mutation you declare is applied by script and the tests you name in expect_failing must fail under it (at least one declaration is required)']
  } else if (leaf.rigor === 'tests-only') {
    out = [series, health, 'each new test passes now',
      'every mutation you declare makes the tests you name in expect_failing fail (at least one declaration is required)', named]
  } else if (leaf.rigor === 'tdd') {
    out = [series, health, 'at least one new test; each new test fails at the base and passes now',
      'declared mutations, when you declare any', named]
  } else {
    out = [series, health, named + ', when it needs one to show it works']
  }
  if (leaf.rigor !== 'verify') {
    out.push(ownReview(leaf) ? 'then a review loop of its own' : 'then review at integration, with its siblings')
  }
  return out
}

/** Pure. A topic's ground in a survey return, or null when it names none. `.` is repo-wide. */
function topicGround(survey, topicKey) {
  const topics = Array.isArray(survey.topics) ? survey.topics : []
  const t = topics.find((x) => x && (x.key === topicKey || x.topic === topicKey || x.name === topicKey))
  const raw = t ? (t.ground ?? t.subtree ?? t.kb_path) : undefined
  if (raw !== undefined) {
    const list = (Array.isArray(raw) ? raw : [raw]).map((p) => posix(p).trim().replace(/\/+$/, ''))
    return list.map((p) => (p === '' ? '.' : p))
  }
  return Array.isArray(survey.ground) && survey.ground.length ? survey.ground : null
}

/**
 * The verdicts of the effort's recorded surveys whose topic ground overlaps `paths`, newest survey
 * first: conclusion and risks only.
 * @returns {{stamp: string, topic: string, conclusion: string, risks: string[]}[]}
 */
function evidenceFor(repo, effort, paths) {
  const dir = join(effortDir(repo, effort), 'evidence')
  let files
  try {
    files = readdirSync(dir).filter((n) => /-survey\.json$/.test(n)).sort().reverse()
  } catch {
    return []
  }
  const out = []
  for (const name of files) {
    let survey
    try {
      survey = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      continue
    }
    if (!survey || !Array.isArray(survey.verdicts)) continue
    const stamp = name.replace(/-survey\.json$/, '')
    for (const v of survey.verdicts) {
      if (!v || typeof v.conclusion !== 'string') continue
      const ground = topicGround(survey, v.topic)
      if (!ground || !ground.some((g) => paths.some((p) => pathsOverlap(g, p)))) continue
      const risks = Array.isArray(v.risks) ? v.risks.filter((r) => typeof r === 'string') : typeof v.risks === 'string' && v.risks ? [v.risks] : []
      out.push({ stamp, topic: String(v.topic || ''), conclusion: v.conclusion, risks })
    }
  }
  return out
}

const REPORT_CONTRACT = (role) => [
  'Write your report to the report path above. Anything the workflow must read goes in these fenced blocks, each JSON unless said otherwise:',
  '',
  '- ```agentics-gotchas``` — an array of `{kind: "pitfall", roles: [agent], paths: [locus prefix], trigger, action, evidence: {command, output}}`. Only a trap you hit in this effort, resolved and saw work, about the environment (tooling, commands, setup, platform) and not the work, statable as "when <trigger>, do <action>", with the failing command and the output line that showed it, and not already in this brief.',
  '- ```agentics-gotchas-stale``` — an array of gotcha ids above that you observed no longer hold; they are deleted.',
  ...(role === 'test-author' || role === 'auditor'
    ? ['- ```agentics-mutations``` — an array of `{file, find, replace, expect_failing: [test]}`; leaf-close applies each by script, runs the suite and restores the file.',
      '- ```agentics-commit``` — one line: the commit subject leaf-close uses when it commits your files in the locus.']
    : []),
  '',
  'Return only one typed status, with a one-line reason:',
  '',
  ...Object.entries(EXECUTOR_STATUSES).map(([k, v]) => '- `' + k + '` — ' + v),
]

/**
 * Pure. The brief's text for one dispatch, from facts already read.
 * @param {object} facts `{node, role, round, fix, decisions, consumed, provided, ancestors, evidence, gotchas, report_path}`
 * @returns {string}
 */
function renderBrief(facts) {
  const { node, role, round, fix, decisions, consumed, provided, ancestors, evidence, gotchas, report_path } = facts
  const rigor = node.rigor + (node.role && node.role !== 'none' ? '/' + node.role : '')
  const s = []
  s.push('# Brief — ' + node.id + ': ' + node.title)
  s.push('')
  s.push('- node: ' + node.id)
  s.push('- role: ' + role)
  s.push('- round: ' + round)
  s.push('- rigor: ' + (rigor || '(none)'))
  s.push('')
  s.push('Leaf-close will measure:')
  s.push(bullets(measuresFor(node)))
  s.push('')
  s.push('## Intent')
  s.push('')
  s.push(node.intent.trim() || '(none)')
  s.push('')
  s.push('## Decisions realised')
  s.push('')
  s.push(bullets(decisions.map((d) => d.id + (d.defined_at ? ' (defined at ' + d.defined_at + ')' : '') + ': ' + (d.text || '(not defined by this node or an ancestor)'))))
  s.push('')
  s.push('## Acceptance criteria')
  s.push('')
  s.push(bullets(node.acceptance.map((a) =>
    a.text + (isHuman(a) ? ' — routed to the user' : ' — check: `' + a.check + '`') +
    (a.decisions.length ? ' [' + a.decisions.join(', ') + ']' : ''))))
  s.push('')
  s.push('## Locus')
  s.push('')
  s.push(bullets(node.locus))
  s.push('')
  s.push('## Reads')
  s.push('')
  s.push(bullets(node.reads))
  s.push('')
  s.push('## Contracts')
  s.push('')
  s.push('Consumed:')
  s.push(bullets(consumed.map((c) => c.name + (c.from ? ' (from ' + c.from + ')' : '') + ': ' + c.paths.join(', '))))
  s.push('')
  s.push('Provided:')
  s.push(bullets(provided.map((c) => c.name + ': ' + c.paths.join(', '))))
  s.push('')
  s.push('## Context')
  s.push('')
  s.push(node.context.trim() || '(none)')
  s.push('')
  s.push('## Ancestor intents')
  s.push('')
  s.push(bullets(ancestors.map((a) => a.id + ' — ' + a.title + (a.intent ? ': ' + a.intent.replace(/\s+/g, ' ').trim() : ''))))
  s.push('')
  s.push('## Standing evidence')
  s.push('')
  s.push(evidence.length
    ? bullets(evidence.map((e) => '[survey ' + e.stamp + (e.topic ? ', ' + e.topic : '') + '] ' + e.conclusion.trim() +
      (e.risks.length ? '\n  risks: ' + e.risks.join('; ') : '')))
    : '(none)')
  s.push('')
  s.push('## Gotchas')
  s.push('')
  s.push(gotchas.length ? gotchas.map((g) => '### ' + g.id + '\n\n' + g.body).join('\n\n') : '(none)')
  s.push('')
  if (round > 1 || fix.length) {
    s.push('## Fix round ' + round)
    s.push('')
    s.push('Clear these; each is a failure or an open finding from the round before.')
    s.push('')
    s.push(bullets(fix.map((f) => '[' + (f.source || '?') + '] ' + (f.claim || '') +
      (f.evidence ? '\n  evidence: ' + String(f.evidence).replace(/\s*\n\s*/g, ' / ') : ''))))
    s.push('')
  }
  s.push('## Report')
  s.push('')
  s.push('Report path: ' + report_path)
  s.push('')
  s.push(...REPORT_CONTRACT(role))
  return s.join('\n') + '\n'
}

/**
 * Assemble and write the brief for one dispatch of one node.
 *
 * @param {string} repo
 * @param {string} effort
 * @param {string} execution the execution's stamp
 * @param {string} nodeId
 * @param {{role?: string, round?: number, fix?: {source, claim, evidence}[]}} [opts] `role`
 *   defaults to the leaf's executor role
 * @returns {{path: string, digest: string, bytes: number, text: string}}
 * @throws when the node is not in the live tree — the caller has named something that is not there
 */
export function assembleBrief(repo, effort, execution, nodeId, { role, round = 1, fix = [] } = {}) {
  const tree = readTree(repo, effort)
  const node = tree.nodes.get(nodeId)
  if (!node) throw new Error('no live node ' + JSON.stringify(nodeId) + ' in effort ' + effort)
  const who = role || executorRole(node) || 'none'
  const n = Number.isInteger(round) && round > 0 ? round : 1

  const defined = definedFor(tree.nodes, nodeId)
  const decisions = node.decisions.map((id) => ({ id, text: '', defined_at: '', ...(defined.get(id) || {}) }))

  const consumed = []
  for (const dep of node.deps) {
    const d = tree.nodes.get(dep)
    if (d) for (const c of d.provides) consumed.push({ ...c, from: dep })
  }
  for (const c of node.consumes) {
    if (!consumed.some((x) => x.name === c.name)) consumed.push({ ...c, from: '' })
  }

  const ancestors = ancestorsOf(nodeId).map((id) => tree.nodes.get(id)).filter(Boolean)
  const evidence = evidenceFor(repo, effort, [...node.ground, ...node.locus])
  const gotchas = gotchasFor(repo, effort, { role: who, locus: node.locus })
  const report_path = reportPath(repo, effort, execution, nodeId, who, n)

  const text = renderBrief({
    node, role: who, round: n, fix: Array.isArray(fix) ? fix : [], decisions,
    consumed, provided: node.provides, ancestors, evidence, gotchas, report_path,
  })
  const path = briefPath(repo, effort, execution, nodeId, who, n)
  mkdirState(dirname(path))
  writeFileSync(path, text, 'utf8')
  return { path, digest: fnv1a(text), bytes: Buffer.byteLength(text, 'utf8'), text }
}

// ------------------------------------------------------------------ CLI

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  const argv = process.argv.slice(2)
  const [command] = argv
  if (command !== 'fetch') {
    console.log(JSON.stringify({ error: 'unknown command ' + JSON.stringify(command || '') + ' — expected fetch' }))
    process.exit(1)
  }
  const path = flagOf(argv, 'path')
  const expected = flagOf(argv, 'digest')
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    console.log('REFUSED: the brief ' + JSON.stringify(path) + ' could not be read (' + err.message + ') — do not start; return blocked')
    process.exit(1)
  }
  const actual = fnv1a(text)
  if (!expected || actual !== expected) {
    console.log('REFUSED: the brief ' + JSON.stringify(path) + ' digests to ' + actual + ', not ' +
      JSON.stringify(expected) + ' — copy the path and digest again exactly; do not work from it')
    process.exit(1)
  }
  process.stdout.write(text)
  process.exit(0)
}
