// tools/rules/size-budget.mjs — every agent and skill definition fits the budget it was given.
//
// Design: docs/DESIGN.md#self-checks. Runtime text is re-read on every turn of every dispatch
// that loads it, so its size is a recurring cost, and reasons belong in DESIGN.md rather than in
// the prompt. A file over its budget, or a definition with no budget at all, is a finding; the
// budgets live in one file, tools/budgets.json, so raising one is a diff somebody reads.

import { readFileSync } from 'node:fs'

export const id = 'size-budget'

export const applies = /^((agents|roles)\/[^/]+\.md|skills\/.+\.md)$/

let budgets = null
const load = () => {
  if (budgets) return budgets
  try {
    budgets = JSON.parse(readFileSync(new URL('../budgets.json', import.meta.url), 'utf8')).files || {}
  } catch {
    budgets = {}
  }
  return budgets
}

export function check(source, filePath) {
  const limit = load()[filePath]
  const lines = source.split('\n').length - (source.endsWith('\n') ? 1 : 0)
  if (!Number.isInteger(limit)) {
    return [{ line: 0, message: filePath + ' has no size budget in tools/budgets.json — every definition is sized to its role' }]
  }
  if (lines > limit) {
    return [{ line: limit + 1, message: filePath + ' is ' + lines + ' lines against a budget of ' + limit + ' — move reasons into docs/DESIGN.md, or raise the budget in tools/budgets.json' }]
  }
  return []
}
