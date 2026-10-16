// test/harness/survey-world.mjs — what the program-survey-scouts, -channels and -judges tests share:
// the scripted answers of the survey's planner, the topic searches, the channels and the judges, and
// the survey run over them. Nothing here runs at import.

import { liveItems } from '../../lib/evidence.mjs'
import { askAfter } from '../../lib/programs/converge.mjs'
import { survey } from '../../lib/programs/survey.mjs'
import { loadRole } from '../../lib/roles.mjs'
import { hitTurn, scoutStep } from '../fast/harness/scout.mjs'
import { endSearch } from './navigator.mjs'
import { programRig } from './program-rig.mjs'

// --- the world --------------------------------------------------------------------------------

export const Q = 'How does the loader resolve a module path?'
export const GUIDE = 'GUIDE-7f3a: name every loader path you cite.'
const lines = (word, n) => Array.from({ length: n }, (_, i) => `${word} line ${i + 1}`).join('\n') + '\n'
export const FILES = {
  'CLAUDE.md': '# Project\n\n' + GUIDE + '\n',
  'src/loader/index.mjs': lines('alpha', 80),
  'src/store/index.mjs': lines('beta', 80),
  'src/cache/index.mjs': lines('gamma', 80),
  'src/shared/index.mjs': lines('delta', 40),
}
export const FILE = { loader: 'src/loader/index.mjs', store: 'src/store/index.mjs', cache: 'src/cache/index.mjs', shared: 'src/shared/index.mjs' }
export const TOPIC = {
  loader: { key: 'loader', find: 'FIND-loader where module paths resolve', subtree: 'src/loader' },
  store: { key: 'store', find: 'FIND-store where returns are written', subtree: 'src/store' },
  cache: { key: 'cache', find: 'FIND-cache where results are kept', subtree: 'src/cache' },
}

export const plan = ({ topics = [TOPIC.loader], common_ground = '', history_question = '', docs_question = '' } = {}) =>
  ({ topics, common_ground, history_question, docs_question })
export const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
export const DOCS_URL = 'https://nodejs.org/api/modules.html'
/** A history search's step: it found SHA, noting `note`. */
export const historyTurn = (note) => scoutStep({ hits: [{ commit: SHA, note }] })
/** A docs search's step: it found DOCS_URL, noting `note`. */
export const docsTurn = (note) => scoutStep({ hits: [{ url: DOCS_URL, note }] })
export const behaviour = (topic, claim, line = 7) =>
  ({ topic, kind: 'behaviour', claim, spans: [{ path: FILE[topic], start: line, end: line }], queries: [], sources: [], rests_on: [] })

/**
 * A search's script: its `turns` on `role||thread`, then the stall and the ruler's ruling of `asks`
 * `ruling` that end it.
 */
export const ended = (role, thread, turns, asks, ruling = 'answered') => endedRounds(role, thread, [{ turns, asks, ruling }])
/**
 * A search that wants reopen: each round `{turns, asks, ruling = 'answered', quiet = false}` is its
 * turns, then the ruler's ruling of the round's `asks`, after the stall an idle turn makes or at a
 * check-in on the round's last turn. A check-in on an earlier turn of a round is ruled `open`. A
 * `quiet` round's turns move no stamp, so a check-in has nothing of it to rule: only the stall does.
 */
export function endedRounds(role, thread, rounds) {
  const steps = []
  const script = { [role + '||' + thread]: steps }
  for (const { turns, asks, ruling = 'answered', quiet = false } of rounds) {
    const first = steps.length + 1
    const last = steps.length + turns.length
    for (let turn = first; turn < last; turn++) {
      if (askAfter(turn) && !quiet) Object.assign(script, rulerAt(thread, turn - 1, asks, 'open'))
    }
    if (askAfter(last) && !quiet) {
      steps.push(...turns)
      Object.assign(script, rulerAt(thread, last - 1, asks, ruling))
    } else {
      const end = endSearch({ name: thread, turn: last, asks, ruling })
      steps.push(...turns, ...end.navigator)
      script[end.ruler.key] = end.ruler.steps
    }
  }
  return script
}
/** The ruler's script step that rules `asks` `ruling` after turn `turn + 1`. */
const rulerAt = (thread, turn, asks, ruling) => {
  const { ruler } = endSearch({ name: thread, turn, asks, ruling })
  return { [ruler.key]: ruler.steps }
}
/** `[path, line, note?]` locations as path hits. */
export const pathHits = (locations) => locations.map(([path, line, note = 'NOTE-' + path + ':' + line]) => ({ path, line, note }))
/** A topic search's script: the scout on topic `key` finds `locations`. */
export const topicSearch = (key, locations) => ({ ['scout||scout:' + key]: [hitTurn(pathHits(locations))] })
/** An asking search's script: the scout's `turns` on topic `key`, then the stall and the ruling of `key`. */
export const scouted = (key, turns, ruling) => ended('scout', 'scout:' + key, turns, key, ruling)
/** A topic search a want reopens: `first` ends ruled on `key`, then `wanted` on the want `want` (default `want:1`). */
export const rescouted = (key, first, wanted, want = 'want:1') =>
  endedRounds('scout', 'scout:' + key, [{ turns: first, asks: key }, { turns: wanted, asks: want }])

export const anchoredUnit = (topic) => ({ unit: topic, ruling: 'anchored', ids: [], why: 'every claim is anchored' })
export const judgeOut = ({ items = [], risks = [], units = [] } = {}) => ({ items, risks, units })

export const ARGS = (over = {}) => ({
  question: Q, roots: ['src'], notes: '', prior: '', max_topics: 8, intelligence: 'normal', pace: 'balanced', ground: [], ...over,
})

export const CLAIM = 'CLAIM-loader resolves a path at line 7'
export const basicScript = (over = {}) => ({
  'analyst||plan': [{ output: plan() }],
  ...topicSearch('loader', [[FILE.loader, 7, 'NOTE-loader resolves here']]),
  'analyst||judge:1': [{ output: judgeOut({ items: [behaviour('loader', CLAIM)], units: [anchoredUnit('loader')] }) }],
  ...over,
})

/** Every port, every searcher: two topics, common ground, both channels, one judge. */
export const COMMON = 'COMMON-4d2e the shared helpers'
export const HQ = 'HQ-1a2b when did the loader last change'
export const DQ = 'DQ-3c4d what does node document about resolution'
export const fullScript = (over = {}) => ({
  'analyst||plan': [{ output: plan({ topics: [TOPIC.loader, TOPIC.store], common_ground: COMMON, history_question: HQ, docs_question: DQ }) }],
  ...topicSearch('loader', [[FILE.loader, 7]]),
  ...topicSearch('store', [[FILE.store, 9]]),
  'historian||history': [historyTurn('HIST-FINDINGS-8a1b')],
  'doc-researcher||docs': [docsTurn('DOCS-FINDINGS-9b2c')],
  'analyst||judge:1': [{
    output: judgeOut({
      items: [behaviour('loader', CLAIM), behaviour('store', 'CLAIM-store writes at line 9', 9)],
      risks: [{ topic: 'store', text: 'RISK-5e6f the store may race' }],
      units: [anchoredUnit('loader'), anchoredUnit('store')],
    }),
  }],
  ...over,
})

export function rigFor(t, script, opts = {}) {
  const rig = programRig({ files: FILES, script, ...opts })
  t.after(() => rig.cleanup())
  return rig
}
export async function runSurvey(t, script, over = {}) {
  const rig = rigFor(t, script)
  const result = await survey(rig.ctx, ARGS(over))
  return { rig, result }
}

export const on = (rig, thread) => rig.calls.filter((c) => c.thread.key === thread)

export const pool = (rig) => [...liveItems(rig.repo).values()]

export const roleOf = (name) => loadRole(name).role
export const cov = (result) => result.coverage
