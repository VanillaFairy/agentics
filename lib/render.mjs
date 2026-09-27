// lib/render.mjs — the renders: views generated from specs and state for the user to read, never
// edited by hand and never read back as state.
//
// Design: docs/DESIGN.md#landing-and-drift.

import { existsSync, readFileSync } from 'node:fs'

import { parseSpec } from './spec.mjs'
import { ROOT_ID, posix, specPath } from './store.mjs'
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
