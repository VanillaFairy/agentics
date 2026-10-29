// lib/brief.mjs — a leaf round's thread brief, computed by script from the tree, the effort's
// recorded evidence and its gotchas, and the repository's guidance every prompt carries.
//
// Design: docs/DESIGN.md#p2--code-does-what-is-deterministic-models-only-judge.
//
// Why a script writes it. Everything in a brief is already on disk — the node, the decisions it
// realises, the traps recorded under the files it expects to change. Having a model gather that is
// paying for turns to copy text, and copying is where a path gets paraphrased or a criterion dropped.
//
// Why it says what leaf-close will measure. An executor that knows the yardstick up front writes
// the series the yardstick expects — a red leaf's tests failing for want of the implementation, a
// tests-only leaf's declared mutations — instead of learning it from a fix round.
//
// Why evidence is excerpted to claims. An item's anchors are the analyst's input and its claim is
// the conclusion. The executor gets the standing claims whose ground meets what it touches, never
// the survey behind them, because what an agent is handed is context it pays for on every turn.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { itemsFor } from './evidence.mjs'
import { COMMAND_NAMES, gotchasFor } from './gotchas.mjs'
import { fnv1a } from './plan-digest.mjs'
import { cycleTests } from './integration.mjs'
import { writesOf } from './permissions.mjs'
import { AGENTICS_DIR, STATE_DIR, mainCheckout, posix, readConfig } from './store.mjs'
import { designCitedBy } from './spec.mjs'
import { definedFor, executorRole, isHuman, ownReview, readTree } from './tree.mjs'

const bullets = (items) => (items.length ? items.map((i) => '- ' + i).join('\n') : '(none)')

/**
 * Pure. What leaf-close will measure for a leaf, one sentence per check, by rigor and role, and for
 * an audit by who answers the round.
 * @param {{rigor: string, role: string, provides: object[]}} leaf
 * @param {string} [executor] the round's agent role
 * @returns {string[]}
 */
export function measuresFor(leaf, executor = executorRole(leaf)) {
  const writes = writesOf(executor, leaf)
  const series = 'a commit series on your branch — no amends, no rebases; nothing under .agentics/' +
    (writes === 'tests' ? ', and test files only' : writes === 'no-tests' ? ', and no test file' : '') +
    '; a change your role may not make is a blocking finding'
  const health = 'build and typecheck do not fail, and the test files your branch changed pass'
  const named = 'the named check of every acceptance criterion that has one'
  const role = leaf.role || 'none'
  let out
  if (leaf.rigor === 'verify') {
    out = ['nothing is written: ' + named + ' is run and its result recorded; a failure is a finding for the parent, not a fix round']
  } else if (role === 'red') {
    out = [series, 'build and typecheck do not fail',
      'your new tests fail now and fail at the base — for want of the implementation, not for a broken test']
  } else if (role === 'green' && executor === 'test-author') {
    out = [series, 'build and typecheck do not fail', 'the cycle\'s tests and your new ones pass now',
      'each new test file fails at the round\'s base, the red\'s head where the implementation is its stubs, or is named in the expect_failing of a break listed to you that you redeclare and that bites: add the tests that close what the findings and requests sent to you name. You never read the implementation, so you declare no break of your own', named]
  } else if (role === 'green') {
    out = [series, 'build and typecheck do not fail', 'the red leaf\'s tests pass now, and they are untouched', named]
  } else if (role === 'audit' && executor === 'test-author') {
    out = [series, 'the cycle\'s tests pass now',
      'every mutation the audit applied in an earlier round is applied again, beside any you declare, and each must make the tests its expect_failing names fail: add to the cycle\'s test files the tests that catch the surviving mutations sent to you, and name them by redeclaring that mutation with them in expect_failing']
  } else if (role === 'audit') {
    out = ['no new tests are expected',
      'every mutation you declare is applied by script and the tests you name in expect_failing must fail under it (at least one declaration is required); one they let through is held, and a test-author closes it']
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
    out.push('no other test: the fast suite runs when your branch merges and the full one before its folder merges up, so run exactly these, nothing wider')
    out.push(ownReview(leaf) ? 'then a review loop of its own' : 'then review at integration, with its siblings')
  }
  return out
}

/**
 * The standing evidence a leaf's brief carries (`evidenceFor` over its ground and expected files).
 * Deriving it checks every anchor with git, so a program awaits it in a child (`childCall`) and
 * hands it to `leafBrief` as `evidence`.
 */
export function briefEvidence(repo, effort, nodeId) {
  const node = readTree(repo, effort).nodes.get(nodeId)
  return node ? evidenceFor(repo, [...node.ground, ...node.expects]) : []
}

/** The standing evidence items whose ground meets `paths`: claims and their anchors, never the survey behind them. */
function evidenceFor(repo, paths) {
  return itemsFor(repo, { ground: paths, states: ['standing'] }).map((it) => ({
    topic: it.topic, kind: it.kind, claim: it.claim,
    anchors: [
      ...it.spans.map((s) => s.path + ':' + s.start + '-' + s.end),
      ...it.queries.map((q) => 'search ' + q.pattern),
      ...it.sources.map((s) => s.url + (s.version ? ' ' + s.version : '')),
    ],
  }))
}

/**
 * Pure. A repo-relative path in its one spelling (`./a//b/../c/` → `a/c`, the root ''), or null when
 * it leaves the repository: absolute, or climbing above the root with `..`. A `dirs` entry or a
 * `guidance` file comes from a session or a config, and what lies outside the root never reaches a
 * prompt.
 */
function withinRoot(path) {
  const p = posix(String(path))
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null
  const out = []
  for (const segment of p.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment !== '..') out.push(segment)
    else if (out.length) out.pop()
    else return null
  }
  return out.join('/')
}

/** The guidance files of `guidanceOf`, each `### <posix path>` and its text, in their order. */
function guidanceBlocks(root, { dirs = ['.'], config = {} } = {}) {
  const found = []
  for (const dir of dirs) {
    const at = withinRoot(dir)
    if (at === null) continue
    const segments = at === '' ? [] : at.split('/')
    for (let depth = 0; depth <= segments.length; depth++) found.push([...segments.slice(0, depth), 'CLAUDE.md'].join('/'))
  }
  const listed = Array.isArray(config.guidance) ? config.guidance.map(withinRoot).filter((p) => p !== null && p !== '') : []
  const shown = [...new Set([...found.filter((p) => existsSync(join(root, p))), ...listed])]
  const body = (p) => {
    try {
      return readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n').trim()
    } catch (err) {
      return err.code === 'ENOENT' || err.code === 'ENOTDIR' ? '(not found)' : '(unreadable)'
    }
  }
  return shown.map((p) => '### ' + p + '\n\n' + body(p))
}

/**
 * The repository's guidance for a dispatch (docs/DESIGN.md#briefs-and-returns): for each
 * repo-relative directory in `dirs`, every `CLAUDE.md` from `root` down to it, root first; then each
 * file `config.guidance` lists, in its order. Each file once, under `### <posix path>`; a listed file
 * that is missing reads `(not found)`, one that cannot be read `(unreadable)`; a directory or a file
 * outside `root` is dropped. '' when there is nothing.
 */
export function guidanceOf(root, opts = {}) {
  const blocks = guidanceBlocks(root, opts)
  return blocks.length ? ['## Repository guidance', ...blocks].join('\n\n') : ''
}

/** A path into the agentics store as a text names it. */
const STORE_PATH = /\.agentics\/[A-Za-z0-9._/-]+/g

/**
 * The effort's store files a leaf reads or its intent or context cites, each `### <path>` and its
 * text from the main checkout, in the order named: the store is gitignored, so no worktree holds
 * them, and a producer is confined to its worktree. A path that is no file there, or one under the
 * store's records (`.state/`), is not handed.
 */
function storeFiles(repo, effort, node) {
  const store = AGENTICS_DIR + '/' + effort + '/'
  const named = [...node.reads.map(posix), ...[node.intent, node.context].flatMap((t) => String(t || '').match(STORE_PATH) || [])]
    .map((p) => p.replace(/[.,;:]+$/, ''))
    .filter((p) => p.startsWith(store) && !p.split('/').includes(STATE_DIR) && !p.split('/').includes('..'))
  const root = mainCheckout(repo)
  return [...new Set(named)].flatMap((p) => {
    try {
      return statSync(join(root, p)).isFile() ? ['### ' + p + '\n\n' + readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n').trim()] : []
    } catch {
      return []
    }
  })
}

/** Pure. The directory a path entry names: a directory entry itself, a file's folder, the root as ''. */
const entryDir = (entry) => {
  const p = posix(entry)
  if (p.endsWith('/')) return p.replace(/\/+$/, '')
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

/**
 * A leaf round's thread brief (docs/DESIGN.md#briefs-and-returns): the leaf, the part of its spec's
 * Design its entry cites (`designCitedBy`) and the effort's store files it reads or cites
 * (`storeFiles`), each a section only when there is any, what will measure it, where it
 * works and the repository's guidance, each a `## ` section. It names no round, no
 * findings and no report, which reach the thread as messages, so the same records give the same
 * text in every round and `parts` says which section moved when they do not.
 *
 * @param {string} repo
 * @param {string} effort
 * @param {string} nodeId
 * @param {{role?: string, worktree: string, commands?: object, evidence?: object[]}} opts `role` defaults to the leaf's
 *   executor role; `commands` is the effort's established `{build, typecheck, suite, suite_fast,
 *   test_one}` (`commandsOf`), each a string or absent; `evidence`, `briefEvidence` already derived
 * @returns {{text: string, digest: string, parts: Object<string, string>}} `parts` maps each heading
 *   to the fnv1a of its section, heading line included
 * @throws when the node is not in the live tree — the caller has named something that is not there
 */
export function leafBrief(repo, effort, nodeId, { role, worktree, commands = {}, evidence: given } = {}) {
  const tree = readTree(repo, effort)
  const node = tree.nodes.get(nodeId)
  if (!node) throw new Error('no live node ' + JSON.stringify(nodeId) + ' in effort ' + effort)
  const who = role || executorRole(node) || 'none'
  const tests = (node.role === 'green' || node.role === 'audit') && who === 'test-author'
    ? cycleTests(repo, effort, tree.nodes, nodeId)
    : null
  const defined = definedFor(tree.nodes, nodeId)
  const evidence = Array.isArray(given) ? given : evidenceFor(repo, [...node.ground, ...node.expects])
  const gotchas = gotchasFor(repo, effort, { role: who, paths: node.expects })
  const dirs = [...new Set([...(tests || []), ...node.expects].map(entryDir))]
  const guidance = guidanceBlocks(repo, { dirs: dirs.length ? dirs : ['.'], config: readConfig(repo) })
  const established = COMMAND_NAMES.filter((n) => typeof commands[n] === 'string' && commands[n].trim() !== '')
  const stored = storeFiles(repo, effort, node)
  const cited = designCitedBy(repo, effort, nodeId)

  const sections = [
    ['Task', [
      node.id + ' — ' + node.title, '',
      '- rigor: ' + (node.rigor + (node.role && node.role !== 'none' ? '/' + node.role : '') || '(none)'),
      '- your role: ' + who, '',
      'Intent:', '', node.intent.trim() || '(none)', '',
      'Context:', '', node.context.trim() || '(none)',
    ].join('\n')],
    ['Acceptance criteria', bullets(node.acceptance.map((a) =>
      a.text + (isHuman(a) ? ' — routed to the user' : ' — check: `' + a.check + '`') +
      (a.decisions.length ? ' [' + a.decisions.join(', ') + ']' : '')))],
    ['Decisions realised', bullets(node.decisions.map((id) => {
      const d = defined.get(id) || {}
      return id + (d.defined_at ? ' (defined at ' + d.defined_at + ')' : '') + ': ' + (d.text || '(not defined by this node or an ancestor)')
    }))],
    ['Expected files and reads', [
      ...(tests
        ? ['You change the cycle\'s tests, and add any test file the work needs; never a source file:', bullets(tests), '']
        : []),
      'Expected to change (the plan\'s prediction, not a limit: change what the work needs):', bullets(node.expects), '',
      'You read:', bullets(node.reads),
    ].join('\n')],
    ...(cited && cited.parts.length
      ? [['Spec Design', ['Your Task cites the Design of its spec, ' + cited.file + ', which is in the effort\'s store and not in your ' +
        'worktree. What it cites, as this brief was written, is here: read it here, never at its path.',
      ...cited.parts.map((p) => (p.heading ? '### Design › ' + p.heading + '\n\n' + p.text.replace(/^###[^\n]*\n*/, '') : '### Design, whole\n\n' + p.text)),
    ].join('\n\n')]]
      : []),
    ...(stored.length
      ? [['Effort files', ['These files are in the effort\'s store, which your worktree does not hold. Their text as this brief was ' +
        'written is here: read them here, never at their path.', ...stored].join('\n\n')]]
      : []),
    ['Evidence', evidence.length
      ? bullets(evidence.map((e) => '[' + e.topic + ', ' + e.kind + '] ' + e.claim.trim() +
        (e.anchors.length ? '\n  anchors: ' + e.anchors.join('; ') : '')))
      : '(none)'],
    ['Gotchas', gotchas.length ? gotchas.map((g) => '### ' + g.id + '\n\n' + g.body).join('\n\n') : '(none)'],
    ['Measures', bullets(measuresFor(node, who))],
    ['Commands', [
      established.length ? bullets(established.map((n) => n + ': `' + commands[n].trim() + '`')) : '(none established yet)',
      ...(who === 'implementer' && node.runs ? ['', 'The work runs, and you may run:', bullets(node.runs.map((c) => '`' + c + '`'))] : []),
    ].join('\n')],
    ['Worktree', resolve(worktree)],
    ['Repository guidance', guidance.length ? guidance.join('\n\n') : '(none)'],
  ].map(([heading, body]) => [heading, '## ' + heading + '\n\n' + body])

  const text = sections.map(([, s]) => s).join('\n\n') + '\n'
  return { text, digest: fnv1a(text), parts: Object.fromEntries(sections.map(([h, s]) => [h, fnv1a(s)])) }
}
