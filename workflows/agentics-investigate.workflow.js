export const meta = {
  name: 'agentics-investigate',
  description: 'Answer one large question about the local codebase from evidence — current code, git history and vendor documentation — and return an ordered task list or a written report.',
  whenToUse: 'Use for "can we replace X with Y", "how does subsystem X work", "when did X break", or any question needing several parts of the codebase read, plus history or external documentation, before a decision.',
  phases: [
    { title: 'Survey' },
    { title: 'Synthesize' },
  ],
}

// ---------------------------------------------------------------- schema
//
// No minItems / maxItems / minLength / maxLength. The task ceiling is expressed in the
// prompt as behaviour and enforced in JS below.
//
// Field semantics go in `description`, never in a comment: comments are stripped before the
// schema reaches the model, so a field documented only here binds nobody.
//
// TASKS maps one-to-one onto the Task tools: subject / description / activeForm are
// TaskCreate's parameters, and blocked_by becomes TaskUpdate's addBlockedBy. ref never
// leaves the workflow.

const TASKS = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks', 'summary', 'gaps'],
  properties: {
    summary: { type: 'string', description: 'What the investigation concluded, in one or two sentences.' },
    gaps: {
      type: 'array',
      items: { type: 'string' },
      description: 'What the investigation could not establish. Never invent a task to paper over one of these.',
    },
    tasks: {
      type: 'array',
      description: 'The ordered work, at most 12 entries — merge rather than exceed.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'subject', 'description', 'activeForm', 'blocked_by'],
        properties: {
          ref: { type: 'string', description: 'Local id used only by blocked_by within this result.' },
          subject: { type: 'string', description: 'Imperative and short, e.g. "Replace the legacy timer poll".' },
          description: {
            type: 'string',
            description: 'Must stand alone: carry the path:line references and enough context to act on without ever seeing this investigation.',
          },
          activeForm: { type: 'string', description: 'Present continuous form of the subject, e.g. "Replacing the legacy timer poll".' },
          blocked_by: {
            type: 'array',
            items: { type: 'string' },
            description: 'The refs of tasks that must complete first. Empty for tasks that can start immediately.',
          },
        },
      },
    },
  },
}

// ---------------------------------------------------------------- inputs

const input = typeof args === 'string' ? { question: args } : (args || {})
// Trimmed, because the blank-question guard below tests truthiness and a question of spaces
// is truthy: it would buy a judge-tier planner call before dying one stage later.
const question = (input.question || '').trim()
const roots = input.roots || '.'
const notes = input.notes || ''
const asTasks = Boolean(input.as_tasks)
// The intelligence dial — the same three positions every skill in this plugin passes, because
// they share one derivation rule (fable → max, opus → normal, sonnet and below → low) and a
// sonnet session therefore sends `low` here as readily as it sends it to develop. The judging
// tier in this workflow is the analyst that synthesizes.
const JUDGE_TIER = { low: { model: 'sonnet' }, normal: { model: 'opus' }, max: { model: 'fable' } }
const intelligence = Object.hasOwn(JUDGE_TIER, input.intelligence) ? input.intelligence : 'normal'
const judge = JUDGE_TIER[intelligence]

const MAX_TASKS = 12

// The runtime does not expose a workflow's own run id to its script, so it cannot be
// written into `resumable` — and a null there is indistinguishable from a field nobody
// filled in. The Workflow launch result carries the real id; the skill records it at
// launch and pairs it with `remaining`.
const RUN_ID = 'unknown-to-script: pair `remaining` with the runId from the Workflow launch result'

// The launch arguments, echoed into every coverage block this workflow returns.
//
// A resume by scriptPath + resumeFromRunId runs the script with whatever args that call
// passes, and a caller who passes none gets a script with no question: it hits the blank
// guard, returns a coverage-honest empty result in a few milliseconds, and the interrupted
// run's cached agents become unreachable — the resume is spent and nothing is recovered.
// Field-observed 2026-08-27. The args are not secret and not large, so the fix is to make
// them travel with the thing a caller reads when deciding how to resume, instead of living
// only in a launch result the session may no longer have.
const LAUNCH_ARGS = { question, roots, notes, as_tasks: asTasks, intelligence }

const RESUME_NOTE = 'a resume must re-pass `args` alongside resumeFromRunId — the script is ' +
  're-executed and reads nothing from the prior run; `args` here is that object'

const resumable = (remaining) => ({ runId: RUN_ID, remaining, args: LAUNCH_ARGS, note: RESUME_NOTE })
const carryArgs = (block) => ({ ...(block || { runId: RUN_ID, remaining: [] }), args: LAUNCH_ARGS, note: RESUME_NOTE })

// The parameter is named `coverageBlock` so the key can be written out as `coverage:` without
// reading as a redundant `coverage: coverage`. Style only, matching `agentics-survey` — the
// `coverage-block` rule understands ES shorthand, so `{ …, coverage }` would lint clean too.
function investigateResult(mode, tasks, report, coverageBlock, evidence = null) {
  return { question, mode, tasks, report, evidence, coverage: coverageBlock }
}

if (!question) {
  return investigateResult('report', null, null, {
    complete: false,
    dropped: [],
    incomplete: [],
    failed_channels: [],
    unreached: ['no question was supplied, so nothing was investigated'],
    resumable: resumable([]),
  })
}

// ---------------------------------------------------------------- 1. survey

phase('Survey')

// Registered workflows are plugin-namespaced, so the qualified name is tried first and the
// bare name second. A lookup failure on both is a broken reference in this plugin —
// unconditional on every machine — and it is reported as exactly that rather than as an
// environmental survey failure: the two must stay distinguishable, or the defect hides in
// a degrade path forever.
const surveyArgs = { question, roots, notes, intelligence }
const notFound = (e) => /not found/i.test((e && e.message) || '')
let survey = null
let surveyUnresolved = false

try {
  survey = await workflow('agentics:agentics-survey', surveyArgs)
} catch (e) {
  if (!notFound(e)) {
    log(`WARNING: the survey threw: ${e && e.message}`)
  } else {
    try {
      survey = await workflow('agentics-survey', surveyArgs)
    } catch (e2) {
      if (notFound(e2)) surveyUnresolved = true
      else log(`WARNING: the survey threw: ${e2 && e2.message}`)
    }
  }
}

if (surveyUnresolved) {
  return investigateResult('report', null, null, {
    complete: false,
    dropped: [],
    incomplete: [],
    failed_channels: ['survey'],
    unreached: [
      'the agentics-survey sub-workflow resolved under neither "agentics:agentics-survey" nor ' +
      '"agentics-survey" — a broken reference in this plugin, not an environmental failure; ' +
      'nothing was searched',
    ],
    resumable: resumable([]),
  })
}

// The survey itself never throws and always returns its documented shape, so a missing
// coverage block means something changed underneath us. Say so rather than inventing one.
if (!survey || !survey.coverage) {
  return investigateResult('report', null, null, {
    complete: false,
    dropped: [],
    incomplete: [],
    failed_channels: ['survey'],
    unreached: ['agentics-survey returned no coverage block; the evidence phase did not complete'],
    resumable: resumable([]),
  })
}

// The survey's own coverage, with this workflow's launch args attached to its resume block.
// The survey cannot supply them — it never saw them in this shape — and a caller reading
// `resumable` to decide how to resume is exactly the caller who needs them.
const c = { ...survey.coverage, resumable: carryArgs(survey.coverage.resumable) }

// ---------------------------------------------------------------- 2. synthesize

phase('Synthesize')

// The structured coverage block is returned untouched. These lines exist so the PROSE also
// names what was missing — a report that reads smoothly while resting on two-thirds of the
// evidence is exactly what IRON LAW §4 forbids.
const caveats =
  (c.dropped.length > 0
    ? `NOTE: these topics produced no result and are missing from the evidence: ` +
      `${c.dropped.join(', ')}. Name them and say what they would have answered.\n\n` : '') +
  // `incomplete` carries topic keys and, since the evidence channels gained a stop_reason,
  // the names of channels that returned without exhausting their search. Both mean the same
  // thing to the reader — real evidence, known to be partial — so they share one caveat.
  (c.incomplete.length > 0
    ? `NOTE: these topics and evidence channels could not be searched to exhaustion: ` +
      `${c.incomplete.join(', ')}. Lead with that limit. Do not present the answer as ` +
      `settled, and say what would have to be searched to settle it.\n\n` : '') +
  (c.failed_channels.includes('history')
    ? `NOTE: the git history search did not run. Any claim about when or why something ` +
      `changed is unsupported. Say so.\n\n` : '') +
  (c.failed_channels.includes('docs')
    ? `NOTE: documentation research did not run. Any claim resting on vendor behaviour is ` +
      `unsupported. Say so.\n\n` : '') +
  (c.unreached.length > 0
    ? `NOTE: not reached at all: ${c.unreached.join('; ')}.\n\n` : '')

const evidence =
  `PER-TOPIC FINDINGS:\n${JSON.stringify(survey.verdicts, null, 1)}\n\n` +
  (survey.history ? `GIT HISTORY:\n${survey.history}\n\n` : '') +
  (survey.docs ? `EXTERNAL DOCUMENTATION:\n${survey.docs}\n\n` : '') +
  caveats

// What the survey established, handed back when synthesis dies.
//
// Synthesis is one agent at the end of a phase that may have cost several hundred thousand
// tokens, and its death used to return coverage arrays and nothing else — the verdicts, the
// history and the docs died inside the script. The session can hand-synthesize from these,
// or retry synthesis alone; either beats re-buying the survey to recover work already done.
const gathered = () => ({
  verdicts: survey.verdicts || [],
  history: survey.history || '',
  docs: survey.docs || '',
})

if (asTasks) {
  const result = await agent(
    `Turn this investigation into an ordered task list.\n\n` +
    `QUESTION: ${question}\n\n` + evidence +
    `Subjects are imperative and short. Every description must stand alone — carry the ` +
    `path:line references and enough context to act on without seeing this investigation. ` +
    `"ref" is a local id used only by blocked_by. Put anything the investigation could not ` +
    `establish in "gaps"; do not invent a task to paper over it. Return at most ` +
    `${MAX_TASKS} tasks — merge rather than exceed.`,
    { agentType: 'agentics:analyst', effort: 'high', schema: TASKS,
      label: 'synthesize:tasks', ...judge },
  ).catch((e) => {
    log(`WARNING: task synthesis failed: ${e && e.message}`)
    return null
  })

  if (!result) {
    return investigateResult('tasks', null, null, {
      complete: false,
      dropped: c.dropped,
      incomplete: c.incomplete,
      failed_channels: c.failed_channels.concat(['synthesis']),
      unreached: c.unreached.concat(['synthesis failed; the evidence was gathered but not turned into tasks']),
      resumable: c.resumable,
    }, gathered())
  }

  // The schema cannot cap array length, so enforce it here.
  //
  // Losing tasks to the cap is a real loss of coverage, so it is recorded in BOTH places:
  // in `gaps` for the reader, and in the coverage block so `complete` goes false. Recording
  // it only in `gaps` would let a truncated task list come back `complete: true` — a partial
  // result indistinguishable from a whole one, which is the single failure this plugin
  // exists to prevent. `agentics-survey` accounts for its own topic cap the same way, by putting
  // overflow into `dropped` rather than into a side note.
  let coverage = c

  if (result.tasks.length > MAX_TASKS) {
    log(`Synthesis returned ${result.tasks.length} tasks; keeping ${MAX_TASKS}.`)
    const cut = result.tasks
      .slice(MAX_TASKS)
      .map((t) => `dropped over the ${MAX_TASKS}-task cap: ${t.subject}`)

    result.tasks = result.tasks.slice(0, MAX_TASKS)
    result.gaps = result.gaps.concat(cut)
    coverage = { ...c, complete: false, unreached: c.unreached.concat(cut) }
  }

  return investigateResult('tasks', result, null, coverage)
}

const report = await agent(
  `Write the final answer to this question.\n\n` +
  `QUESTION: ${question}\n\n` + evidence +
  `Lead with the recommendation in one or two sentences. Then the reasons that decide it, ` +
  `each tied to a path:line, a commit, or a URL. Then risks and open questions, only where ` +
  `they change the decision. Do not restate the question. Do not list options you rejected.`,
  { agentType: 'agentics:analyst', effort: 'high', label: 'synthesize', ...judge },
).catch((e) => {
  log(`WARNING: report synthesis failed: ${e && e.message}`)
  return null
})

if (!report) {
  return investigateResult('report', null, null, {
    complete: false,
    dropped: c.dropped,
    incomplete: c.incomplete,
    failed_channels: c.failed_channels.concat(['synthesis']),
    unreached: c.unreached.concat(['synthesis failed; the evidence was gathered but not written up']),
    resumable: c.resumable,
  }, gathered())
}

return investigateResult('report', null, report, c)
