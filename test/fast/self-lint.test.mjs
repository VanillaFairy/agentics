// The gate runs itself.
//
// Every other test in this directory checks a rule against fixture strings. None of them
// pointed the rule set at the real tree, and nothing else did either: no CI file, no git
// hook, no package script. `node tools/lint.mjs` was a convention living in CLAUDE.md, so a
// committer — human or coder agent — who ran only `node --test` shipped over a red gate and
// saw green. What a skipped run lets through is silent at runtime by construction: a
// workflow whose meta stopped being a literal is simply absent when something invokes it.
//
// So the gate is a test now. `node --test` alone carries it.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PLUGIN_ROOT, formatFindings, lintPlugin, loadRules } from '../../tools/lint.mjs'

test('the shipped tree passes its own lint', async () => {
  const findings = await lintPlugin(PLUGIN_ROOT)
  assert.equal(
    findings.length,
    0,
    `lint findings in the shipped tree:\n${formatFindings(findings)}`,
  )
})

test('the rule set is non-empty — a green run over zero rules proves nothing', async () => {
  const rules = await loadRules(PLUGIN_ROOT)
  assert.ok(rules.length > 0, 'no rules loaded from tools/rules')
})

test('lintPlugin refuses to report clean when no rules loaded', async () => {
  await assert.rejects(
    () => lintPlugin(PLUGIN_ROOT, []),
    /nothing was checked/,
    'an empty rule set must throw, not return zero findings',
  )
})

test('PLUGIN_ROOT is the plugin, not the caller cwd', async () => {
  const rules = await loadRules(PLUGIN_ROOT)
  const ids = rules.map((r) => r.id)
  assert.ok(ids.includes('no-turn-caps'), `expected the shipped rules, got ${ids.join(', ')}`)
})
