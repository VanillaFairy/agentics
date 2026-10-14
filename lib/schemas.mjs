// lib/schemas.mjs — every role's return schema, handed to the host's --json-schema, and its kind.
//
// Design: docs/DESIGN.md#briefs-and-returns.

export const KINDS = ['producer', 'searcher', 'judge']

const str = { type: 'string' }
const int = { type: 'integer' }
const bool = { type: 'boolean' }
const strings = { type: 'array', items: str }
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required })
const arr = (items) => ({ type: 'array', items })
const one = (...values) => ({ type: 'string', enum: values })

const SEARCH_STOP = one('exhausted', 'unfinished', 'stuck')
const coverage = { searched: strings, no_match: str, not_reached: str, stop_reason: SEARCH_STOP }
/** A searcher's or a judge's schema: its own fields, and an optional `more` to continue a long return. */
const long = (properties, required = Object.keys(properties)) => obj({ ...properties, more: bool }, required)
const hit = obj({ path: str, line: int, note: str })
const gotcha = obj({
  kind: one('pitfall', 'command'), roles: strings, paths: strings, trigger: str, action: str,
  evidence: obj({ command: str, output: str }),
  command: obj({ name: one('build', 'typecheck', 'suite', 'suite_fast', 'test_one'), value: str, absent: bool }),
}, ['kind', 'roles', 'trigger', 'action', 'evidence'])
const mutation = obj({ file: str, find: str, replace: str, expect_failing: strings })
const unit = (...rulings) => obj({ unit: str, ruling: one(...rulings), ids: strings, why: str }, ['unit', 'ruling', 'why'])
const asksOf = arr(str)
/** A navigator's return (docs/DESIGN.md#roles): its domain's hits, and the dismissals, leads and per-ask declarations every domain shares. */
const navigator = (hit) => long({
  hits: arr(hit),
  dismissed: arr(obj({ ask: asksOf, path: str, glob: str, call: int, why: str }, ['ask', 'why'])),
  leads: arr(obj({ ask: str, path: str, why: str })),
  asks: arr(obj({ ask: str, declared: one('answered', 'absent', 'open') })),
}, ['hits', 'dismissed', 'leads', 'asks'])

export const SCHEMAS = {
  producer: {
    kind: 'producer',
    schema: obj({
      status: one('done', 'done_with_concerns', 'blocked', 'needs_context', 'needs_tests', 'needs_locus', 'decompose',
        'unsplittable', 'premise_mismatch', 'needs_decision', 'contract_changed', 'declined'),
      text: str, concerns: strings, gotchas: arr(gotcha), gotchas_stale: strings, mutations: arr(mutation), commit: str,
      needs_locus: obj({ paths: strings, why: str }),
    }, ['status', 'text']),
  },
  planner_write: {
    kind: 'producer',
    schema: obj({ status: one('written', 'needs_decision', 'contract_changed', 'premise_mismatch', 'unsplittable', 'blocked'), text: str }),
  },
  planner_settle: {
    kind: 'producer',
    schema: obj({
      status: one('settled', 'needs_decision', 'blocked'),
      dispositions: arr(obj({ finding: str, outcome: one('incorporated', 'discarded') })), text: str,
    }),
  },
  investigator: {
    kind: 'producer',
    schema: obj({ commands: arr(gotcha), unresolved: strings, text: str }),
  },
  survey_plan: {
    kind: 'producer',
    schema: obj({
      topics: arr(obj({ key: str, find: str, subtree: str })), common_ground: str, history_question: str, docs_question: str,
    }),
  },
  axes: {
    kind: 'producer',
    schema: obj({
      axes: arr(obj({ key: str, charge: str, source: str })), guidance_read: strings, notes: str,
      stop_reason: one('completed', 'no_guidance_found', 'unreadable'),
    }),
  },
  frame: {
    kind: 'producer',
    schema: obj({
      capability_line: str, hard_constraints: strings, disqualifiers: strings,
      angles: arr(obj({ key: str, find: str })), repo_question: str,
    }),
  },
  approach: {
    kind: 'producer',
    schema: obj({ approach: str, shape: str, contracts: strings, cites: strings, risks: strings }),
  },
  investigate_tasks: {
    kind: 'producer',
    schema: obj({
      summary: str, gaps: strings,
      tasks: arr(obj({ ref: str, subject: str, description: str, activeForm: str, blocked_by: strings })),
    }),
  },
  investigate_report: { kind: 'producer', schema: obj({ report: str }) },
  scout_hits: { kind: 'searcher', schema: long({ hits: arr(hit), ...coverage }) },
  scout_located: {
    kind: 'searcher',
    schema: long({ hits: arr(obj({ path: str, line: int, note: str, kind: one('guidance', 'ground') })), ...coverage }),
  },
  historian: { kind: 'searcher', schema: long({ findings: str, ...coverage }) },
  doc_research: { kind: 'searcher', schema: long({ findings: str, ...coverage }) },
  candidates: {
    kind: 'searcher',
    schema: long({
      candidates: arr(obj({
        name: str, source_url: str, what_it_is: str, latest_version: str, license: str, maintenance: str, covers: str, does_not_cover: str,
      })),
      ...coverage,
    }),
  },
  search_repo: { kind: 'searcher', schema: navigator(obj({ ask: asksOf, path: str, line: int, note: str })) },
  search_history: { kind: 'searcher', schema: navigator(obj({ ask: asksOf, commit: str, note: str })) },
  search_web: {
    kind: 'searcher',
    schema: navigator(obj({
      ask: asksOf, url: str, note: str,
      candidate: obj({
        name: str, source_url: str, what_it_is: str, latest_version: str, license: str, maintenance: str, covers: str, does_not_cover: str,
      }),
    }, ['ask', 'url', 'note'])),
  },
  items: {
    kind: 'judge',
    schema: long({
      items: arr(obj({
        topic: str, kind: one('behaviour', 'absence', 'enumeration', 'relation', 'external', 'derived'), claim: str,
        spans: arr(obj({ path: str, start: int, end: int })), queries: arr(obj({ pattern: str, scope: strings })),
        sources: arr(obj({ url: str, version: str })), rests_on: strings,
      }, ['topic', 'kind', 'claim'])),
      risks: arr(obj({ topic: str, text: str })),
      units: arr(unit('anchored', 'unanchored')),
    }, ['items', 'risks', 'units']),
  },
  prober: {
    kind: 'judge',
    schema: long({
      findings: arr(obj({ axis: str, severity: one('ambiguity', 'gap', 'note'), section: str, claim: str, evidence: str, start: int, end: int })),
      units: arr(unit('clean', 'findings')), notes: str,
      stop_reason: one('exhausted', 'unfinished', 'artefact_unreadable'), not_reached: str,
    }, ['findings', 'units', 'notes', 'stop_reason', 'not_reached']),
  },
  rejudge: {
    kind: 'judge',
    schema: long({ rulings: arr(obj({ id: str, ruling: one('holds', 'fails', 'unsure'), why: str })) }, ['rulings']),
  },
  assessment: {
    kind: 'judge',
    schema: long({
      assessed: arr(obj({
        name: str, source_url: str, what_it_is: str, latest_version: str, license: str, maintenance: str, covers: str,
        does_not_cover: str, disqualifiers_hit: strings,
      })),
      notes: str, units: arr(unit('assessed', 'unassessable')),
    }, ['assessed', 'notes', 'units']),
  },
  reviewer: {
    kind: 'judge',
    schema: long({
      units: arr(unit('clean', 'findings')),
      findings: arr(obj({
        id: str, severity: one('critical', 'major', 'minor'), claim: str, evidence: str, failure_scenario: str, remedy: one('code', 'tests'),
      }, ['id', 'severity', 'claim', 'evidence', 'failure_scenario'])),
      fix_rulings: arr(obj({ id: str, status: one('fixed', 'not_fixed', 'regressed'), evidence: str })),
      claims: arr(obj({ claim: str, ruling: one('met', 'under', 'over', 'deviates', 'spec_defect', 'cant_tell'), evidence: str })),
      notes: str,
    }, ['units', 'findings', 'fix_rulings', 'claims', 'notes']),
  },
  ruler_premises: {
    kind: 'judge',
    schema: long({
      rulings: arr(obj({ node: str, ruling: one('unaffected', 'affected'), why: str, question: str, fix: str }, ['node', 'ruling', 'why', 'question'])),
    }, ['rulings']),
  },
  ruler_respec: {
    kind: 'judge',
    schema: long({
      rulings: arr(obj({ node: str, ruling: one('unaffected', 'answered', 'affected'), why: str, question: str, fix: str, answers: arr(int) },
        ['node', 'ruling', 'why', 'question'])),
    }, ['rulings']),
  },
  ruler_convergence: {
    kind: 'judge',
    schema: long({ ruling: one('converging', 'not_converging'), why: str }, ['ruling', 'why']),
  },
  ruler_search: { kind: 'judge', schema: long({ units: arr(unit('converging', 'not_converging')) }, ['units']) },
  auditor: {
    kind: 'judge',
    schema: long({ mutations: arr(mutation), units: arr(unit('examined', 'unexamined')), text: str }, ['mutations', 'units', 'text']),
  },
}

/** Pure. The JSON Schema of `name`, or null. */
export const schemaOf = (name) => (Object.hasOwn(SCHEMAS, name) ? SCHEMAS[name].schema : null)

/** Pure. The kind of `name`, or ''. */
export const kindOf = (name) => (Object.hasOwn(SCHEMAS, name) ? SCHEMAS[name].kind : '')
