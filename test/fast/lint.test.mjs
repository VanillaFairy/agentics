// test/fast/lint.test.mjs — pins the orchestrator's contract with the rule modules.
//
// Seven rule tasks are written in parallel against this contract without seeing each
// other's code. The two things that can silently break all of them are: `applies` being
// tested against a non-POSIX path, and violations losing their file/rule attribution on
// the way to a finding. Both are pinned here with fake rules, so no rule module is needed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lintSource, formatFindings, loadRules } from '../../tools/lint.mjs'

const workflowRule = {
  id: 'fake-workflow-rule',
  applies: /\.workflow\.js$/,
  check: () => [{ line: 7, message: 'bad thing' }],
}

const agentRule = {
  id: 'fake-agent-rule',
  applies: /^agents\/.*\.md$/,
  check: () => [{ line: 0, message: 'missing thing' }],
}

const cleanRule = {
  id: 'fake-clean-rule',
  applies: /.*/,
  check: () => [],
}

test('a violation becomes a finding carrying file and rule id', () => {
  const found = lintSource('src', 'workflows/agentics-survey.workflow.js', [workflowRule])

  assert.deepEqual(found, [{
    file: 'workflows/agentics-survey.workflow.js',
    rule: 'fake-workflow-rule',
    line: 7,
    message: 'bad thing',
  }])
})

test('a rule whose applies does not match is skipped', () => {
  const found = lintSource('src', 'agents/scout.md', [workflowRule])
  assert.deepEqual(found, [])
})

test('every matching rule runs, and results accumulate', () => {
  const found = lintSource('src', 'agents/scout.md', [workflowRule, agentRule, cleanRule])

  assert.equal(found.length, 1)
  assert.equal(found[0].rule, 'fake-agent-rule')
})

test('a rule that finds nothing contributes nothing', () => {
  const found = lintSource('src', 'workflows/x.workflow.js', [cleanRule])
  assert.deepEqual(found, [])
})

test('formatFindings reports the clean case explicitly', () => {
  assert.equal(formatFindings([]), 'OK: no findings')
})

test('formatFindings renders one line per finding, file first', () => {
  const rendered = formatFindings([
    { file: 'workflows/a.workflow.js', rule: 'r1', line: 3, message: 'first' },
    { file: 'agents/b.md', rule: 'r2', line: 0, message: 'second' },
  ])

  assert.equal(
    rendered,
    'workflows/a.workflow.js:3  [r1] first\n' +
    'agents/b.md:0  [r2] second',
  )
})

// --- loadRules: the contract gate ------------------------------------------------
//
// Rule modules are written in parallel by agents who cannot see each other's code, so the
// orchestrator refuses to load one that breaks the contract and names the file when it does.
// Each fixture below is a real .mjs on disk, because that is the only way to exercise the
// dynamic import path these guards live on.

/** Build a throwaway plugin root containing tools/rules/<name> for each entry. */
async function pluginWithRules(files) {
  const root = await mkdtemp(join(tmpdir(), 'agentics-lint-'))
  await mkdir(join(root, 'tools', 'rules'), { recursive: true })
  for (const [name, source] of Object.entries(files)) {
    await writeFile(join(root, 'tools', 'rules', name), source, 'utf8')
  }
  return root
}

const wellFormed = (id, applies = '/\\.workflow\\.js$/') => `
export const id = '${id}'
export const applies = ${applies}
export function check() { return [] }
`

test('a plugin with no tools/rules yet loads no rules and does not throw', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentics-lint-'))
  try {
    assert.deepEqual(await loadRules(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('well-formed rules load in filename order', async () => {
  const root = await pluginWithRules({
    'b-rule.mjs': wellFormed('b-rule'),
    'a-rule.mjs': wellFormed('a-rule'),
    'notes.txt': 'not a rule',
  })
  try {
    const rules = await loadRules(root)

    assert.deepEqual(rules.map((r) => r.id), ['a-rule', 'b-rule'])
    assert.ok(rules[0].applies instanceof RegExp)
    assert.equal(typeof rules[0].check, 'function')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an id that disagrees with its filename is rejected, naming the file', async () => {
  const root = await pluginWithRules({ 'no-imports.mjs': wellFormed('no-improts') })
  try {
    await assert.rejects(loadRules(root), /no-imports\.mjs.*no-improts.*must equal 'no-imports'/s)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a misspelled applies export is rejected, naming the file', async () => {
  const root = await pluginWithRules({
    'no-imports.mjs': `
      export const id = 'no-imports'
      export const applise = /\\.workflow\\.js$/
      export function check() { return [] }
    `,
  })
  try {
    await assert.rejects(loadRules(root), /no-imports\.mjs.*'applies' must be a RegExp/s)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a missing check export is rejected, naming the file', async () => {
  const root = await pluginWithRules({
    'no-imports.mjs': `
      export const id = 'no-imports'
      export const applies = /\\.workflow\\.js$/
    `,
  })
  try {
    await assert.rejects(loadRules(root), /no-imports\.mjs.*'check' must be a function/s)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
