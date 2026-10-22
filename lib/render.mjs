// lib/render.mjs — the renders: views generated from specs and state for the user to read, never
// edited by hand and never read back as state.
//
// Design: docs/DESIGN.md#landing-and-drift.
//
// The evidence render (T26a) is generated from a folder's latest `cites.jsonl` line and the
// items' states, never edited, never read back.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { checkAnchors, latestCites, liveItems } from './evidence.mjs'
import { readLog } from './ledger.mjs'
import { parseSpec } from './spec.mjs'
import { EVIDENCE_RENDER, ROOT_ID, envelope, executionDir, flagOf, handleArgs, folderDir, mkdirState, nodeIdProblem, posix, readJson, returnPath, safeSlug, saidOf, specPath } from './store.mjs'
import { claimsEventOf, isHuman, ownerOf, readTree } from './tree.mjs'
import { PASSING } from './verdict.mjs'

/** Loss first: every verdict that is not a pass leads, `met` comes last. */
const ORDER = ['under', 'over', 'deviates', 'spec_defect', 'cant_tell', 'equivalent', 'accepted', 'met']
const rank = (c) => (ORDER.includes(c.ruling) ? ORDER.indexOf(c.ruling) : 0)

const LIST_ITEM = /^\s*(?:\d+[.)]|[-*])\s+(.*)$/

/** Pure. The items of the list under the Intent's "success criteria" line; [] when there is none. */
function successCriteria(intent) {
  const lines = String(intent || '').replace(/\r\n/g, '\n').split('\n')
  const at = lines.findIndex((l) => /success criteria/i.test(l))
  if (at === -1) return []
  const out = []
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '') continue
    const item = LIST_ITEM.exec(line)
    if (item) out.push(item[1].trim())
    else if (out.length && /^\s+\S/.test(line)) out[out.length - 1] += ' ' + line.trim()
    else break
  }
  return out
}

const cell = (s) => String(s == null ? '' : s).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')

/**
 * The landing view's account of work agentics did not build: each adopted leaf with its folder
 * review's ruling on each criterion (once a review newer than the adoption stands), then the
 * commits that belong to no leaf. [] when nothing was adopted.
 */
function outsideSection(repo, effort, tree) {
  const adopted = tree.events.filter((e) => e.kind === 'merged' && typeof e.by === 'string' && e.by && tree.nodes.has(e.node))
  const outside = tree.events.filter((e) => e.kind === 'outside')
  if (!adopted.length && !outside.length) return []
  const short = (shas) => (Array.isArray(shas) ? shas : []).map((c) => String(c).slice(0, 8)).join(', ')
  const out = ['## Work agentics did not build', '']
  for (const m of adopted) {
    const leaf = tree.nodes.get(m.node)
    const review = claimsEventOf(tree.events, ownerOf(tree.nodes, m.node))
    const judged = Boolean(review) && review.seq > m.seq
    const ret = judged && review.said && review.execution ? readJson(returnPath(executionDir(repo, effort, review.execution), review.said)) : null
    const units = new Map((ret && Array.isArray(ret.units) ? ret.units : []).map((u) => [u.unit, u]))
    out.push('- **' + m.node + '** — ' + leaf.title + ', adopted by ' + m.by + ' (' + short(m.commits) + ')')
    leaf.acceptance.forEach((c, i) => {
      const u = units.get('criterion:' + m.node + '#' + (i + 1))
      const ruling = isHuman(c) ? 'yours to check' : !judged ? 'not yet judged' : u ? u.ruling : 'not ruled'
      out.push('  - ' + ruling + ': ' + c.text)
    })
  }
  for (const o of outside) out.push('- commits on ' + o.node + ' that belong to no leaf, adopted by ' + (o.by || '') + ': ' + short(o.commits))
  return out
}

/**
 * The landing view: the root spec's success criteria beside the root integration review's claim
 * verdicts, loss first. A `cant_tell` is counted apart from the passes (`met`, `equivalent`, `accepted`), never as one.
 */
export function renderLanding(repo, effort) {
  const path = specPath(repo, effort, ROOT_ID)
  const out = ['# Landing view: ' + effort, '', '## Success criteria', '']
  if (!existsSync(path)) {
    out.push('The root folder has no DESIGN.md, so there are no success criteria to hold the work to.')
  } else {
    const spec = parseSpec(readFileSync(path, 'utf8'), { file: posix(path) })
    const intent = spec.sections.Intent ? spec.sections.Intent.body : ''
    const criteria = successCriteria(intent)
    out.push('From `' + posix(path) + '`:', '')
    if (criteria.length) out.push(...criteria.map((c, i) => (i + 1) + '. ' + c))
    else out.push('The Intent names no success-criteria list. It reads:', '', intent.trim())
  }
  out.push('', '## Claim verdicts', '')
  const tree = readTree(repo, effort)
  const tail = ((s) => (s.length ? ['', ...s] : []))(outsideSection(repo, effort, tree))
  const review = claimsEventOf(tree.events, ROOT_ID)
  const claims = review ? review.claims : null
  if (claims === null) {
    out.push('No integration review of the root recorded claim verdicts: nothing above has been judged against the merged work.')
    return [...out, ...tail].join('\n') + '\n'
  }
  const met = claims.filter((c) => PASSING.includes(c.ruling)).length
  const undecided = claims.filter((c) => c.ruling === 'cant_tell').length
  out.push('The root integration review judged ' + claims.length + ' claim(s): ' + met + ' met, ' +
    (claims.length - met - undecided) + ' not met, ' + undecided + ' it could not decide.', '',
  '| verdict | claim |', '|---|---|',
  ...[...claims].sort((a, b) => rank(a) - rank(b)).map((c) => '| ' + cell(c.ruling) + ' | ' + cell(c.claim) + ' |'),
  '')
  const said = saidOf(repo, effort, review)
  if (said) out.push('What the review said of the evidence behind each verdict:', '', said)
  else out.push('The review\'s evidence was not written down' + (review.said ? ': the return of ' + review.said + ' is missing.' : '.'))
  return [...out, ...tail].join('\n') + '\n'
}

// ------------------------------------------------------------------ evidence.md

/** One anchor, as a reader checks it by hand. */
function anchorText(item) {
  return [
    ...item.spans.map((s) => '`' + s.path + ':' + s.start + '-' + s.end + '` at `' + (s.at.startsWith('snapshot:') ? s.at : s.at.slice(0, 12)) + '`'),
    ...item.queries.map((q) => 'search `' + q.pattern + '` in ' + (q.scope.join(', ') || 'the repository') + ': ' + q.result.length + ' line(s)'),
    ...item.sources.map((s) => s.url + (s.version ? ' ' + s.version : '') + ' (retrieved ' + s.retrieved + ')'),
    ...item.rests_on.map((id) => 'rests on ' + id),
  ]
}

function evidenceText(title, byTopic, missing, gaps, states) {
  const out = ['# Evidence: ' + title, '',
    'Rendered from this folder\'s latest citation and the project\'s evidence items, with each item\'s state as of the render. Never edit it: the next render replaces it.', '']
  for (const [topic, items] of byTopic) {
    out.push('## ' + topic, '')
    for (const it of items) {
      const st = states.get(it.id)
      out.push('- **' + st.state + '** · ' + it.kind + ' · ' + it.claim)
      for (const a of anchorText(it)) out.push('  - ' + a)
      if (st.state !== 'standing') out.push('  - why: ' + st.why)
    }
    out.push('')
  }
  if (missing.length > 0) out.push('## Not in the store', '', ...missing.map((id) => '- ' + id), '')
  out.push('## Coverage gaps', '', ...(gaps.length ? gaps.map((g) => '- ' + g) : ['(none)']), '')
  return out.join('\n')
}

/** Write <folder>/evidence.md from the folder's latest citation; returns its path. Deterministic for a given store and tree. */
export function renderEvidence(repo, effort, folderId) {
  if (!safeSlug(effort)) throw new Error('bad effort id ' + JSON.stringify(effort))
  const problem = nodeIdProblem(folderId)
  if (problem) throw new Error(problem)
  const line = latestCites(readLog(repo, effort, 'cites').entries).get(folderId)
  const ids = [...new Set(line && Array.isArray(line.items) ? line.items.map(String) : [])]
  const gaps = line && Array.isArray(line.gaps) ? line.gaps.map(String) : []
  const live = liveItems(repo)
  const states = new Map(checkAnchors(repo, ids).map((s) => [s.id, s]))

  const byTopic = new Map()
  const missing = []
  for (const id of ids) {
    const item = live.get(id)
    if (!item) { missing.push(id); continue }
    if (!byTopic.has(item.topic)) byTopic.set(item.topic, [])
    byTopic.get(item.topic).push(item)
  }

  const title = folderId === ROOT_ID ? effort : folderId
  const path = join(folderDir(repo, effort, folderId), EVIDENCE_RENDER)
  mkdirState(dirname(path))
  writeFileSync(path, evidenceText(title, byTopic, missing, gaps, states), 'utf8')
  return posix(path)
}

// ------------------------------------------------------------------ CLI

/** The flags this CLI takes, each by its kind: a skill's session passes handles only (`handleArgs`). */
const FLAGS = {
  '--repo': 'path', '--effort': 'handle', '--folder': 'handle',
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
    if (argv[0] !== 'evidence') throw new Error('unknown command ' + JSON.stringify(argv[0] || '') + ' — expected evidence')
    const path = renderEvidence(flagOf(argv, 'repo') || '.', flagOf(argv, 'effort'), flagOf(argv, 'folder') || '.')
    console.log(JSON.stringify(envelope({ path })))
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
