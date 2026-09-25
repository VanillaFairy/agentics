// test/agentics-find-existing-solutions-scenarios.test.mjs — executes the build-or-adopt sweep
// through the harness with scripted agents.
//
// One mechanism here matters more than the rest, and most of these scenarios are about it:
// **an empty candidate list means two opposite things.** After an exhausted search it says
// "nothing exists, build it". After a search that never opened the registry it says nothing
// at all — and both arrive as `candidates: []`. Everywhere else in this plugin an incomplete
// search weakens a conclusion; here it can license weeks of writing code that already exists.
// So the coverage derivation is the unit under test, not a footnote to it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runWorkflow, scriptedAgents } from './harness/workflow-host.mjs'

const WF = fileURLToPath(new URL('../workflows/agentics-find-existing-solutions.workflow.js', import.meta.url))

const ARGS = { capability: 'rate-limit inbound HTTP requests per API key', roots: '.' }

const frame = (over = {}) => ({
  capability_line: 'Limit inbound HTTP request rate per API key',
  hard_constraints: ['Node.js 24+', 'permissive licence'],
  disqualifiers: ['GPL-licensed', 'no release in over two years'],
  angles: [{ key: 'stdlib', find: 'does node ship this' },
           { key: 'registry', find: 'search npm' }],
  repo_question: 'what already rate-limits here',
  ...over,
})

const candidate = (name, over = {}) => ({
  name,
  source_url: 'https://example.invalid/' + name,
  what_it_is: 'a rate limiter',
  latest_version: '3.1.0',
  license: 'MIT',
  maintenance: 'released 2026-07-02',
  covers: 'per-key token bucket',
  does_not_cover: 'distributed counters',
  ...over,
})

const found = (candidates, over = {}) => ({
  candidates,
  searched: ['npm search rate-limit'],
  stop_reason: 'exhausted',
  no_match: '',
  not_reached: '',
  ...over,
})

const scouted = (hits = [], over = {}) => ({
  hits,
  searched: ['package.json'],
  stop_reason: 'exhausted',
  no_match: '',
  not_reached: '',
  ...over,
})

const assessedAs = (rows, over = {}) => ({ assessed: rows, notes: '', ...over })

const rule = (name, hit = [], over = {}) => ({ ...candidate(name), disqualifiers_hit: hit, ...over })

// Overrides go in FIRST, then the defaults fill the gaps. `scriptedAgents` takes the first
// key that matches, and the default `'find:'` is a PREFIX — spread after an override it would
// swallow `find:registry` and hand it the generic answer, which is a fixture bug that looks
// exactly like a workflow that never dispatched the second angle.
const happy = (over = {}) => {
  const script = { ...over }
  const base = {
    frame: frame(),
    'find:': found([candidate('limiter-a')]),
    repo: scouted(),
    assess: assessedAs([rule('limiter-a')]),
  }
  for (const [label, value] of Object.entries(base)) {
    if (!(label in script)) script[label] = value
  }
  return scriptedAgents(script)
}

const run = (opts) => runWorkflow(WF, { args: ARGS, ...opts })

// The dial reaches here for the same reason it reaches investigate: one derivation rule,
// shared verbatim by every skill that passes `intelligence`. Framing the capability and
// assessing each candidate are both judgment, so both move with it — and the searching angles
// never do.
test('the framing and assessing analysts follow the dial; the search tier does not', async () => {
  const tiersAt = async (intelligence) => {
    const { prompts } = await run({ args: { ...ARGS, intelligence }, agent: happy() })
    const at = (label) => {
      const { model, effort } = prompts.find((p) => p.opts.label === label).opts
      return `${model}/${effort}`
    }
    return { frame: at('frame'), assess: at('assess'), find: at('find:stdlib') }
  }

  // Sonnet runs one step above the site's base (frame medium, assess high); opus runs medium,
  // one step up at `max`. The search tier keeps its frontmatter model and its low effort.
  assert.deepEqual(await tiersAt('low'),
    { frame: 'sonnet/high', assess: 'sonnet/xhigh', find: 'undefined/low' })
  assert.deepEqual(await tiersAt('normal'),
    { frame: 'opus/medium', assess: 'opus/medium', find: 'undefined/low' })
  assert.deepEqual(await tiersAt('max'),
    { frame: 'opus/high', assess: 'opus/high', find: 'undefined/low' })
  assert.deepEqual(await tiersAt(undefined),
    { frame: 'opus/medium', assess: 'opus/medium', find: 'undefined/low' },
    'an absent dial is the derived `normal`')
})

/** The invariant the whole workflow exists to protect. */
const assertEmptyNeverReadsAsExhausted = (result) => {
  if (result.candidates.length > 0) return
  if (result.coverage.complete) return
  assert.ok(result.coverage.unreached.length > 0,
    'an empty candidate list from an incomplete sweep must say what was not reached — ' +
    'otherwise it reads exactly like an exhausted search that found nothing')
}

// --- the baseline -------------------------------------------------------------------------

test('a clean sweep returns assessed candidates with complete coverage', async () => {
  const { result } = await run({ agent: happy() })

  assert.equal(result.candidates.length, 1)
  assert.deepEqual(result.viable, ['limiter-a'])
  assert.deepEqual(result.ruled_out, [])
  assert.equal(result.coverage.complete, true)
  assert.equal(result.frame.capability_line, 'Limit inbound HTTP request rate per API key')
})

test('the prompts carry the clauses that keep the search honest', async () => {
  const { prompts } = await run({ agent: happy() })
  const byLabel = (l) => prompts.find((p) => p.opts.label === l).prompt

  assert.match(byLabel('frame'), /ANY implementation of it would qualify/)
  assert.match(byLabel('frame'), /standard library/)
  assert.match(byLabel('find:stdlib'), /listicle/)
  assert.match(byLabel('find:stdlib'), /TODAY/)
  assert.match(byLabel('repo'), /dependency manifests/)
  assert.match(byLabel('assess'), /VERBATIM/)
  assert.match(byLabel('assess'), /caller's decision/)
})

// The analysts carry `Read` and nothing that searches, so neither the framer nor the assessor may
// be charged with finding anything: the locating is the scout's and the researchers'.
test('no analyst here is asked to search, and none is dispatched with a search agent type', async () => {
  const { prompts } = await run({ agent: happy() })
  const byLabel = (l) => prompts.find((p) => p.opts.label === l)

  assert.match(byLabel('frame').prompt, /nothing that searches/)
  assert.match(byLabel('assess').prompt, /you have no search tools/)
  for (const label of ['frame', 'assess']) assert.equal(byLabel(label).opts.agentType, 'agentics:analyst')
  assert.equal(byLabel('repo').opts.agentType, 'agentics:scout', 'the repository is searched by a scout')
  assert.ok(!prompts.some((p) => /agentics:(ground|kb|verifier)/.test(p.opts.agentType || '')))
})

test('every angle and the repo scan are searched, not just the first', async () => {
  const { prompts } = await run({ agent: happy() })
  const labels = prompts.map((p) => p.opts.label)

  assert.ok(labels.includes('find:stdlib'))
  assert.ok(labels.includes('find:registry'))
  assert.ok(labels.includes('repo'))
})

// --- viability is computed, never reported --------------------------------------------------

test('a candidate hitting a disqualifier is ruled out, carrying the reason', async () => {
  const { result } = await run({
    agent: happy({
      assess: assessedAs([
        rule('limiter-a'),
        rule('limiter-b', ['GPL-licensed']),
      ]),
    }),
  })

  assert.deepEqual(result.viable, ['limiter-a'])
  assert.deepEqual(result.ruled_out, [{ name: 'limiter-b', why: 'GPL-licensed' }])
  assert.equal(result.candidates.length, 2, 'a ruled-out candidate still travels, with its reason')
})

test('several disqualifiers on one candidate all reach the reader', async () => {
  const { result } = await run({
    agent: happy({
      assess: assessedAs([rule('limiter-b', ['GPL-licensed', 'no release in over two years'])]),
    }),
  })

  assert.deepEqual(result.viable, [])
  assert.match(result.ruled_out[0].why, /GPL-licensed; no release in over two years/)
})

// --- an empty result means two opposite things ----------------------------------------------

test('an exhausted search that found nothing is complete, and says what it covered', async () => {
  const { result } = await run({
    agent: happy({
      'find:': found([], { no_match: 'no maintained npm package does per-key limiting' }),
      assess: assessedAs([]),
    }),
  })

  assert.deepEqual(result.candidates, [])
  assert.deepEqual(result.viable, [])
  // The no_match line is evidence FOR building, and it must survive to the reader.
  assert.ok(result.coverage.unreached.some((u) => /searched and found nothing/.test(u)))
  assert.equal(result.coverage.complete, false,
    'a no_match line is a finding worth reading, so it keeps complete false rather than ' +
    'letting an empty list pass silently as a settled answer')
  assertEmptyNeverReadsAsExhausted(result)
})

// A resumed round is labelled `find:<key>#2`, and `scriptedAgents` treats only a key ending
// in ':' as a prefix — so per-angle scripting across rounds has to dispatch on the label
// inside one handler rather than keying on `find:registry`.
const byAngle = (stdlib, registry) => (prompt, opts) =>
  opts.label.startsWith('find:stdlib') ? stdlib(prompt, opts) : registry(prompt, opts)

test('an unexhausted angle is carried as never-reached, worded apart from found-nothing', async () => {
  const { result } = await run({
    agent: happy({
      'find:': byAngle(
        () => found([]),
        () => found([], { stop_reason: 'unfinished', not_reached: 'crates.io and PyPI' }),
      ),
      assess: assessedAs([]),
    }),
  })

  assert.equal(result.coverage.complete, false)
  assert.ok(result.coverage.incomplete.includes('registry'))
  assert.ok(result.coverage.unreached.some((u) => /registry never reached: crates\.io and PyPI/.test(u)))
  assert.ok(!result.coverage.unreached.some((u) => /registry searched and found nothing/.test(u)),
    'never-reached and found-nothing must never be phrased alike — they justify opposite decisions')
  assert.ok(result.coverage.resumable.remaining.includes('registry'))
  assertEmptyNeverReadsAsExhausted(result)
})

test('an unexhausted angle is resumed rather than reported', async () => {
  let rounds = 0
  const { result, prompts } = await run({
    agent: happy({
      'find:': byAngle(
        () => found([]),
        () => {
          rounds += 1
          return rounds === 1
            ? found([], { stop_reason: 'unfinished', not_reached: 'crates.io' })
            : found([candidate('limiter-c')])
        },
      ),
      assess: assessedAs([rule('limiter-c')]),
    }),
  })

  assert.equal(rounds, 2, 'IL1: an incomplete search is resumed, not reported')
  const resumed = prompts.find((p) => p.opts.label === 'find:registry#2')
  assert.match(resumed.prompt, /do not start over/)
  assert.match(resumed.prompt, /crates\.io/)
  assert.deepEqual(result.viable, ['limiter-c'])
  assert.equal(result.coverage.complete, true)
})

test('an angle that stops without naming what it missed is a dead end, not another round', async () => {
  let rounds = 0
  const { result } = await run({
    agent: happy({
      'find:': byAngle(
        () => found([]),
        () => {
          rounds += 1
          return found([], { stop_reason: 'stuck', not_reached: '' })
        },
      ),
      assess: assessedAs([]),
    }),
  })

  assert.equal(rounds, 1, 'a resume handed an empty task would return "exhausted" having done nothing')
  assert.ok(result.coverage.unreached.some((u) => /without naming what was missed/.test(u)))
  assert.equal(result.coverage.complete, false)
})

// --- the repo channel: the cheapest answer, and a real side channel --------------------------

test('what the repository already carries leads the result', async () => {
  const { result } = await run({
    agent: happy({
      repo: scouted([{ path: 'package.json', line: 21, note: 'depends on express-rate-limit' }]),
    }),
  })

  assert.equal(result.already_present.length, 1)
  assert.match(result.already_present[0].note, /express-rate-limit/)
  assert.equal(result.coverage.complete, true)
})

test('a failed repo scan degrades the run and says the claim is unsupported', async () => {
  const { result } = await run({
    agent: happy({ repo: () => { throw new Error('grep exploded') } }),
  })

  assert.deepEqual(result.already_present, [])
  assert.ok(result.coverage.failed_channels.includes('repo'))
  assert.ok(result.coverage.unreached.some((u) => /already depend on something that does this/.test(u)))
  assert.equal(result.coverage.complete, false)
  assert.equal(result.candidates.length, 1, 'IL2: the external search already paid for is kept')
})

// --- framing failures ------------------------------------------------------------------------

test('no framing means no search, and the result says so rather than reading as empty', async () => {
  const { result, prompts } = await run({
    agent: scriptedAgents({ frame: () => { throw new Error('budget') } }),
  })

  assert.deepEqual(result.candidates, [])
  assert.ok(result.coverage.failed_channels.includes('frame'))
  assert.ok(result.coverage.unreached.some((u) => /says nothing about whether an existing solution exists/.test(u)))
  assert.ok(!prompts.some((p) => (p.opts.label || '').startsWith('find:')))
  assertEmptyNeverReadsAsExhausted(result)
})

test('angles beyond the cap are dropped by name, never silently', async () => {
  const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => ({ key: k, find: 'look in ' + k }))
  const { result } = await run({
    args: { ...ARGS, max_angles: 2 },
    agent: happy({ frame: frame({ angles: many }) }),
  })

  assert.deepEqual(result.coverage.dropped, ['c', 'd', 'e', 'f'])
  assert.equal(result.coverage.complete, false)
  assert.ok(result.coverage.resumable.remaining.includes('c'))
})

test('no capability supplied searches nothing and says nothing was searched', async () => {
  const { result } = await runWorkflow(WF, { args: { roots: '.' }, agent: scriptedAgents({}) })

  assert.deepEqual(result.candidates, [])
  assert.equal(result.coverage.complete, false)
  assert.match(result.coverage.unreached[0], /no capability was supplied/)
})

// --- the assessment stage --------------------------------------------------------------------

test('a candidate the assessor dropped is named, not vanished', async () => {
  // The failure this catches: two agents, two name spellings, one row quietly missing — and
  // the result still reads as a complete sweep of everything that was found.
  const { result } = await run({
    agent: happy({
      'find:': found([candidate('limiter-a'), candidate('limiter-b')]),
      assess: assessedAs([rule('limiter-a')]),
    }),
  })

  assert.ok(result.coverage.unreached.some((u) => /found but never ruled on: limiter-b/.test(u)))
  assert.equal(result.coverage.complete, false)
})

test('candidate names are matched case-insensitively across the two stages', async () => {
  const { result } = await run({
    agent: happy({
      'find:': found([candidate('Limiter-A')]),
      assess: assessedAs([rule('limiter-a')]),
    }),
  })

  assert.ok(!result.coverage.unreached.some((u) => /never ruled on/.test(u)),
    'a spelling difference between two models is not a dropped candidate')
  assert.equal(result.coverage.complete, true)
})

test('an assessment that never ran returns candidates raw, with the emptiness explained', async () => {
  const { result } = await run({
    agent: happy({ assess: () => { throw new Error('budget') } }),
  })

  // Both angles reported the same package; the exact-name merge is the half JS can do, and
  // it runs even on this path so the degraded output is still readable.
  assert.equal(result.candidates.length, 1)
  assert.deepEqual(result.candidates[0].disqualifiers_hit, [])

  // The candidate rides in candidates[] and in neither verdict list. `viable` is computed
  // from disqualifiers_hit, and on this path that array is this script's own invention —
  // computing over it would present a candidate the user's licence policy might kill as one
  // that cleared every check.
  assert.deepEqual(result.viable, [],
    'an unmeasured candidate must not read as one that passed every disqualifier')
  assert.deepEqual(result.ruled_out, [])
  assert.ok(result.coverage.failed_channels.includes('assess'))
  assert.ok(result.coverage.unreached.some((u) => /because nobody checked rather than because nothing was hit/.test(u)))
  assert.equal(result.coverage.complete, false)
})

test('an empty viable list on a dead assessment still trips the incomplete-sweep warning', async () => {
  const { logs } = await run({
    agent: happy({ assess: () => { throw new Error('budget') } }),
  })

  // The warning fires on `!complete && viable.length === 0`. While the dead channel minted a
  // viable list, it suppressed the one line telling the reader not to conclude "build it".
  assert.ok(logs.some((l) => /INCOMPLETE SWEEP WITH NO VIABLE CANDIDATE/.test(l)),
    'the reader must be told nobody finished looking')
})

test('a candidate is never ruled out on a ground nobody declared', async () => {
  const { result } = await run({
    agent: happy({
      assess: assessedAs([{ name: 'limiter-a', disqualifiers_hit: ['I do not care for the API'] }]),
    }),
  })

  assert.deepEqual(result.viable, ['limiter-a'], 'an invented ground rules nothing out')
  assert.deepEqual(result.ruled_out, [])
  assert.ok(result.coverage.unreached.some((u) => /grounds nobody declared/.test(u)))
})

test('a duplicate found by two angles is one candidate, not two', async () => {
  const { result } = await run({ agent: happy() })

  assert.equal(result.candidates.length, 1, 'both angles reported limiter-a')
  assert.deepEqual(result.viable, ['limiter-a'])
})

test('what the assessment could not settle travels instead of being smoothed away', async () => {
  const { result } = await run({
    agent: happy({
      assess: assessedAs([rule('limiter-a')], { notes: 'limiter-a states no licence anywhere' }),
    }),
  })

  assert.ok(result.coverage.unreached.some((u) => /states no licence anywhere/.test(u)))
  assert.equal(result.coverage.complete, false)
})

test('no candidates means no assessor is dispatched', async () => {
  const { prompts } = await run({
    agent: happy({ 'find:': found([]), assess: assessedAs([]) }),
  })

  assert.ok(!prompts.some((p) => p.opts.label === 'assess'))
})
