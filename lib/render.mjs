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
import { EVIDENCE_RENDER, ROOT_ID, envelope, flagOf, folderDir, mkdirState, nodeIdProblem, posix, safeSlug, specPath } from './store.mjs'
import { claimsOf, readTree } from './tree.mjs'

/** Loss first: every verdict that is not a pass leads, `met` comes last. */
const ORDER = ['under', 'over', 'deviates', 'spec_defect', 'cant_tell', 'met']
const rank = (c) => (ORDER.includes(c.verdict) ? ORDER.indexOf(c.verdict) : 0)

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
 * The landing view: the root spec's success criteria beside the root integration review's claim
 * verdicts, loss first. A `cant_tell` is counted apart from `met`, never as a pass.
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
  const claims = claimsOf(readTree(repo, effort).events, ROOT_ID)
  if (claims === null) {
    out.push('No integration review of the root recorded claim verdicts: nothing above has been judged against the merged work.')
    return out.join('\n') + '\n'
  }
  const met = claims.filter((c) => c.verdict === 'met').length
  const undecided = claims.filter((c) => c.verdict === 'cant_tell').length
  out.push('The root integration review judged ' + claims.length + ' claim(s): ' + met + ' met, ' +
    (claims.length - met - undecided) + ' not met, ' + undecided + ' it could not decide.', '',
  '| verdict | claim | evidence |', '|---|---|---|',
  ...[...claims].sort((a, b) => rank(a) - rank(b)).map((c) => '| ' + cell(c.verdict) + ' | ' + cell(c.claim) + ' | ' + cell(c.evidence) + ' |'))
  return out.join('\n') + '\n'
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

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  try {
    const argv = process.argv.slice(2)
    if (argv[0] !== 'evidence') throw new Error('unknown command ' + JSON.stringify(argv[0] || '') + ' — expected evidence')
    const path = renderEvidence(flagOf(argv, 'repo') || '.', flagOf(argv, 'effort'), flagOf(argv, 'folder') || '.')
    console.log(JSON.stringify(envelope({ path })))
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
