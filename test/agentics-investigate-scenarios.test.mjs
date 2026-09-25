// test/agentics-investigate-scenarios.test.mjs — the investigate workflow through the same
// harness: the survey-reference failure classes, and the report path's coverage
// passthrough. Parse-compilation of all three workflows is pinned here too, so a syntax
// error in any script fails the suite instead of the first live run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { compileWorkflow, runWorkflow, scriptedAgents } from './harness/workflow-host.mjs'

const wf = (name) => fileURLToPath(new URL('../workflows/' + name, import.meta.url))
const WF = wf('agentics-investigate.workflow.js')

const surveyResult = (over = {}) => ({
  question: 'q', topics: [], verdicts: [], history: null, docs: null,
  coverage: {
    complete: true, dropped: [], incomplete: [], failed_channels: [], unreached: [],
    resumable: { runId: 'r', remaining: [] },
  },
  ...over,
})

test('all three workflow scripts compile as workflow bodies', () => {
  compileWorkflow(wf('agentics-survey.workflow.js'))
  compileWorkflow(wf('agentics-investigate.workflow.js'))
  compileWorkflow(wf('agentics-develop.workflow.js'))
})

test('a survey resolving under neither name is reported as a broken plugin reference', async () => {
  const { result, prompts } = await runWorkflow(WF, {
    args: { question: 'how does X work' },
    agent: scriptedAgents({}),
    workflow: (name) => { throw new Error(`Workflow "${name}" not found.`) },
  })

  assert.equal(result.mode, 'report')
  assert.equal(result.report, null)
  assert.deepEqual(result.coverage.failed_channels, ['survey'])
  assert.match(result.coverage.unreached[0], /broken reference/)
  assert.equal(prompts.length, 0)
})

// The dial reaches here because every skill derives its position from one shared rule — fable
// → max, opus → normal, sonnet and below → low — so a sonnet session sends `low` to this
// workflow as readily as it sends it to develop. A script that recognised only two positions
// would serve the third as `normal` while the caller reported the tier it derived.
test('the judging tier follows the dial through all three positions', async () => {
  const modelAt = async (intelligence) => {
    const { prompts } = await runWorkflow(WF, {
      args: { question: 'how does X work', intelligence },
      agent: scriptedAgents({ synthesize: 'the answer' }),
      workflow: () => surveyResult(),
    })
    return prompts.find((p) => p.opts.label === 'synthesize').opts.model
  }

  assert.equal(await modelAt('low'), 'sonnet')
  assert.equal(await modelAt('normal'), 'opus')
  assert.equal(await modelAt('max'), 'fable')
  assert.equal(await modelAt(undefined), 'opus', 'an absent dial is the derived `normal`')
  assert.equal(await modelAt('cheap'), 'opus', 'and so is a position nobody defined')
})

test('report mode hands back the synthesis verbatim with the survey coverage', async () => {
  const { result } = await runWorkflow(WF, {
    args: { question: 'how does X work' },
    agent: scriptedAgents({ synthesize: 'The answer, with path:line receipts.' }),
    workflow: () => surveyResult(),
  })

  assert.equal(result.mode, 'report')
  assert.equal(result.report, 'The answer, with path:line receipts.')
  assert.equal(result.coverage.complete, true)
})
