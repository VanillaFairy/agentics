// test/fast/agentics-investigate-scenarios.test.mjs — the investigate workflow through the same
// harness: the survey-reference failure classes, and the report path's coverage
// passthrough. Parse-compilation of all three workflows is pinned here too, so a syntax
// error in any script fails the suite instead of the first live run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { compileWorkflow, runWorkflow, scriptedAgents } from './harness/workflow-host.mjs'

const wf = (name) => fileURLToPath(new URL('../../service-workflows/' + name, import.meta.url))
const WF = wf('answer-codebase-question-from-evidence.workflow.js')

const surveyResult = (over = {}) => ({
  question: 'q', topics: [], ground: [], items: [], reused: [], unrecorded: [], context: '', risks: [], history: null, docs: null,
  coverage: {
    complete: true, dropped: [], incomplete: [], failed_channels: [], unreached: [],
    resumable: { runId: 'r', remaining: [] },
  },
  ...over,
})

test('both workflow scripts compile as workflow bodies', () => {
  compileWorkflow(wf('gather-evidence-without-concluding.workflow.js'))
  compileWorkflow(wf('answer-codebase-question-from-evidence.workflow.js'))
})

test('a survey script path that does not resolve is reported as a broken plugin reference', async () => {
  const { result, prompts } = await runWorkflow(WF, {
    args: { question: 'how does X work' },
    agent: scriptedAgents({}),
    workflow: (ref) => { throw new Error(`Workflow "${ref.scriptPath}" not found.`) },
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
  const tierAt = async (intelligence) => {
    const { prompts } = await runWorkflow(WF, {
      args: { question: 'how does X work', intelligence },
      agent: scriptedAgents({ synthesize: 'the answer' }),
      workflow: () => surveyResult(),
    })
    const { model, effort } = prompts.find((p) => p.opts.label === 'synthesize').opts
    return { model, effort }
  }

  const normal = { model: 'opus', effort: 'medium' }
  assert.deepEqual(await tierAt('low'), { model: 'sonnet', effort: 'xhigh' })
  assert.deepEqual(await tierAt('normal'), normal)
  assert.deepEqual(await tierAt('max'), { model: 'opus', effort: 'high' })
  assert.deepEqual(await tierAt(undefined), normal, 'an absent dial is the derived `normal`')
  assert.deepEqual(await tierAt('cheap'), normal, 'and so is a position nobody defined')
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

test('the survey is handed the pace and the plugin root, and the synthesis is told it cannot search', async () => {
  let handed = null
  let handedRef = null
  const { prompts, result } = await runWorkflow(WF, {
    args: { question: 'how does X work', pace: 'fast', plugin_root: 'C:/plugin' },
    agent: scriptedAgents({ synthesize: 'the answer' }),
    workflow: (ref, a) => { handedRef = ref; handed = a; return surveyResult() },
  })

  assert.equal(handed.pace, 'fast')
  assert.equal(handed.plugin_root, 'C:/plugin')
  assert.ok(handedRef.scriptPath.startsWith('C:/plugin'), 'the survey is addressed under the given plugin_root')
  assert.ok(
    handedRef.scriptPath.endsWith('/service-workflows/gather-evidence-without-concluding.workflow.js'),
    'the survey is addressed by its own file',
  )
  assert.match(prompts.find((p) => p.opts.label === 'synthesize').prompt, /You have no search tools/)
  assert.equal(result.coverage.resumable.args.pace, 'fast', 'a resume re-passes what the survey was given')
})

const CONTEXT = 'C:/repo/.agentics/.state/context/0badc0de-1.md'
const ITEMS = [{ id: 'I12345678', topic: 'a', kind: 'behaviour', state: 'standing' }]
const RISKS = [{ topic: 'a', n: 1 }]

test("the survey's coverage passes through untouched", async () => {
  const coverage = { ...surveyResult().coverage, complete: false, incomplete: ['a'] }
  const { result } = await runWorkflow(WF, {
    args: { question: 'how does X work' },
    agent: scriptedAgents({ synthesize: 'the answer' }),
    workflow: () => surveyResult({ coverage }),
  })
  assert.deepEqual(result.coverage.incomplete, ['a'])
  assert.equal(result.coverage.complete, false)
  assert.ok(!('from_kb' in result.coverage))
})

test("the synthesis is pointed at the survey's one evidence file, and nothing it says is inlined", async () => {
  const { prompts } = await runWorkflow(WF, {
    args: { question: 'how does X work' },
    agent: scriptedAgents({ synthesize: 'the answer' }),
    workflow: () => surveyResult({ items: ITEMS, risks: RISKS, context: CONTEXT }),
  })
  const synth = prompts.find((p) => p.opts.label === 'synthesize').prompt
  assert.ok(synth.includes('read this file whole before you write anything: ' + CONTEXT))
  assert.doesNotMatch(synth, /I12345678/, 'the items are in the file, not the prompt')
})

test('a survey that wrote no evidence file leaves the synthesis nothing to rest on, and it is told so', async () => {
  const { prompts } = await runWorkflow(WF, {
    args: { question: 'how does X work' },
    agent: scriptedAgents({ synthesize: 'the answer' }),
    workflow: () => surveyResult(),
  })
  assert.match(prompts.find((p) => p.opts.label === 'synthesize').prompt, /wrote no evidence file/)
})

test('a synthesis that dies hands back the item handles and the files the survey established', async () => {
  const history = ['C:/repo/.agentics/.state/evidence/inbox/history-1.json']
  const docs = ['C:/repo/.agentics/.state/evidence/inbox/docs-1.json']
  const { result } = await runWorkflow(WF, {
    args: { question: 'how does X work' },
    agent: scriptedAgents({ synthesize: () => { throw new Error('overloaded') } }),
    workflow: () => surveyResult({ items: ITEMS, risks: RISKS, context: CONTEXT, history, docs }),
  })
  assert.deepEqual(result.evidence, { items: ITEMS, context: CONTEXT, risks: RISKS, history, docs })
  assert.ok(!('verdicts' in result.evidence))
})
