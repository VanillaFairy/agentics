// test/harness/survey-world.mjs — what the program-survey-scouts, -channels and -judges tests share:
// the scripted answers of the survey's planner, the topic searches, the channels and the judges, and
// the survey run over them. Nothing here runs at import.

import { liveItems } from '../../lib/evidence.mjs'
import { survey } from '../../lib/programs/survey.mjs'
import { loadRole } from '../../lib/roles.mjs'
import { fetchCall, hitTurn, historyReturn, showCall, webReturn } from './navigator.mjs'
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
/** A history turn that showed SHA and returns it with `note`. */
export const historyTurn = (note) => ({ calls: [showCall('history', SHA)], output: historyReturn({ hits: [['history', SHA, note]], declare: { history: 'answered' } }) })
/** A docs turn that fetched DOCS_URL and returns it with `note`. */
export const docsTurn = (note) => ({ calls: [fetchCall('docs', DOCS_URL)], output: webReturn({ hits: [['docs', DOCS_URL, note]], declare: { docs: 'answered' } }) })
export const behaviour = (topic, claim, line = 7) =>
  ({ topic, kind: 'behaviour', claim, spans: [{ path: FILE[topic], start: line, end: line }], queries: [], sources: [], rests_on: [] })

export const anchoredUnit = (topic) => ({ unit: topic, ruling: 'anchored', ids: [], why: 'every claim is anchored' })
export const judgeOut = ({ items = [], risks = [], units = [] } = {}) => ({ items, risks, units })

export const ARGS = (over = {}) => ({
  question: Q, roots: ['src'], notes: '', prior: '', max_topics: 8, intelligence: 'normal', pace: 'balanced', ground: [], ...over,
})

export const CLAIM = 'CLAIM-loader resolves a path at line 7'
export const basicScript = (over = {}) => ({
  'analyst||plan': [{ output: plan() }],
  'scout||scout:loader': [hitTurn('loader', [[FILE.loader, 7, 'NOTE-loader resolves here']])],
  'analyst||judge:1': [{ output: judgeOut({ items: [behaviour('loader', CLAIM)], units: [anchoredUnit('loader')] }) }],
  ...over,
})

/** Every port, every searcher: two topics, common ground, both channels, one judge. */
export const COMMON = 'COMMON-4d2e the shared helpers'
export const HQ = 'HQ-1a2b when did the loader last change'
export const DQ = 'DQ-3c4d what does node document about resolution'
export const fullScript = (over = {}) => ({
  'analyst||plan': [{ output: plan({ topics: [TOPIC.loader, TOPIC.store], common_ground: COMMON, history_question: HQ, docs_question: DQ }) }],
  'scout||scout:loader': [hitTurn('loader', [[FILE.loader, 7]])],
  'scout||scout:store': [hitTurn('store', [[FILE.store, 9]])],
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
