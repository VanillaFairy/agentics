// test/skill-plugin-root-parity.test.mjs — a service-workflow that nests another workflow by
// scriptPath needs plugin_root resolved: unlike the `$CLAUDE_PLUGIN_ROOT` fallback embedded in a
// shell command string, a scriptPath is never shell-expanded, so every skill that launches such a
// workflow must pass plugin_root through (I4).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL('../' + rel, import.meta.url)), 'utf8')

// Every service-workflow that nests another workflow by scriptPath, and the skill(s) that launch it.
const NESTERS = [
  { workflow: 'service-workflows/answer-codebase-question-from-evidence.workflow.js', skills: ['skills/investigate/SKILL.md'] },
  { workflow: 'service-workflows/execute-approved-plan-in-worktrees.workflow.js', skills: ['skills/develop/SKILL.md'] },
]

test('a skill launching a workflow that nests another workflow by scriptPath passes plugin_root', () => {
  for (const { workflow, skills } of NESTERS) {
    const src = read(workflow)
    assert.match(src, /workflow\(\{ ?scriptPath:/, workflow + ' is expected to nest another workflow by scriptPath')
    const name = workflow.split('/').pop()
    for (const skillPath of skills) {
      const skill = read(skillPath)
      const launch = skill.split('\n').find((l) => l.includes(name))
      assert.ok(launch, skillPath + ' has no Workflow(...) call naming ' + name)
      assert.match(launch, /plugin_root/, skillPath + '\'s launch of ' + name + ' must pass plugin_root')
    }
  }
})
