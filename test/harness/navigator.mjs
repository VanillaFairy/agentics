// test/harness/navigator.mjs — a navigator's turns as program tests script them: the calls the
// search tool server would have journaled (the scripted runner's `calls` seam) and the search_*
// return. Nothing here runs at import.

import { canonicalUrl } from '../../lib/search/ledger.mjs'

/** The resolver's answer when a test fixes it: no row and no seed. */
export const EMPTY_GROUND = { rows: [], seeds: [] }
/** A program context whose resolver answers `ground` for every search it runs; each call's options are pushed to `seen`. */
export const withGround = (ctx, ground = EMPTY_GROUND, seen = null) => ({
  ...ctx, groundOf: async (tree, opts) => { if (seen) seen.push(opts); return ground },
})

const askList = (ask) => (Array.isArray(ask) ? ask : [ask])
const declared = (declare) => Object.entries(declare).map(([ask, d]) => ({ ask, declared: d }))
const absentAll = (keys) => Object.fromEntries(keys.map((k) => [k, 'absent']))

/** A grep call that showed `lines`, each `[key, line]`, for `ask` (one ask key or several). */
export const grepCall = (ask, lines, pattern = 'TOKEN') => ({
  tool: 'grep', args: { pattern, fixed: false, ignore_case: false, paths: [], page: 1 }, asks: askList(ask), ok: true,
  total: lines.length, page: 1, pages: 1,
  observed: lines.map(([key, line]) => ({ key, line })), keys: [...new Set(lines.map(([key]) => key))],
})
/** A show call that showed commit `sha` for `ask`. */
export const showCall = (ask, sha) => ({
  tool: 'show', args: { commit: sha, path: '' }, asks: askList(ask), ok: true, observed: [{ key: sha, line: 1 }], keys: [sha],
})
/** A fetch call that read `url` for `ask`. */
export const fetchCall = (ask, url) => {
  const key = canonicalUrl(url)
  return { tool: 'fetch', args: { url }, asks: askList(ask), ok: true, observed: [{ key, line: 1 }], keys: [key] }
}

/** A search_repo return; each hit `[ask, path, line, note?]`. */
export const repoReturn = ({ hits = [], dismissed = [], leads = [], declare = {} } = {}) => ({
  hits: hits.map(([ask, path, line, note = 'seen at ' + path + ':' + line]) => ({ ask: askList(ask), path, line, note })),
  dismissed, leads, asks: declared(declare),
})
/** A search_history return; each hit `[ask, commit, note?]`. */
export const historyReturn = ({ hits = [], dismissed = [], leads = [], declare = {} } = {}) => ({
  hits: hits.map(([ask, commit, note = 'commit ' + commit]) => ({ ask: askList(ask), commit, note })),
  dismissed, leads, asks: declared(declare),
})
/** A search_web return; each hit `[ask, url, note?, candidate?]`. */
export const webReturn = ({ hits = [], dismissed = [], leads = [], declare = {} } = {}) => ({
  hits: hits.map(([ask, url, note = 'read at ' + url, candidate]) => ({ ask: askList(ask), url, note, ...(candidate ? { candidate } : {}) })),
  dismissed, leads, asks: declared(declare),
})

/** A turn that looked at nothing and declares every ask in `keys` absent; a declaration ends nothing. */
export const quietTurn = (keys) => ({ output: repoReturn({ declare: absentAll(keys) }) })
/**
 * A turn that greps for each ask in `keys` and finds nothing, dismisses everything on every agenda and
 * declares each absent. A declaration ends nothing: `endSearch` scripts the stall and the ruling after it.
 */
export const closingTurn = (keys) => ({
  calls: [grepCall(keys, [], 'ABSENT')],
  output: repoReturn({ dismissed: keys.map((k) => ({ ask: k, glob: '**', why: 'nothing here bears on it' })), declare: absentAll(keys) }),
})
/**
 * A turn that greps each hit's line for `ask` and returns it, dismisses the rest of every agenda
 * (hits apply before dismissals, so the hits stand), and declares `ask` answered and `others`
 * absent. Each hit `[path, line, note?]`. `endSearch` scripts the stall and the ruling that end it.
 */
export const hitTurn = (ask, hits, others = []) => ({
  calls: [grepCall(ask, hits.map(([path, line]) => [path, line])), ...(others.length ? [grepCall(others, [], 'ABSENT')] : [])],
  output: repoReturn({
    hits: hits.map(([path, line, note]) => [ask, path, line, note]),
    dismissed: [ask, ...others].map((k) => ({ ask: k, glob: '**', why: 'nothing else here bears on it' })),
    declare: { [ask]: 'answered', ...absentAll(others) },
  }),
})
/** A turn that hits like `hitTurn` but declares nothing and names `lead` (a path) still to read: its ask stays open. */
export const openTurn = (ask, hits, lead) => ({
  calls: [grepCall(ask, hits.map(([path, line]) => [path, line]))],
  output: repoReturn({ hits: hits.map(([path, line, note]) => [ask, path, line, note]), leads: [{ ask, path: lead, why: 'not read yet' }] }),
})

/**
 * The script steps that end a search after `turn`: an idle navigator turn and the ruler's ruling of `asks`.
 * `name` is the search's thread key; the ruler steps go under `ruler.key`.
 */
export function endSearch({ name, turn, asks, ruling = 'absent' }) {
  const units = askList(asks).map((unit) => ({ unit, ruling, why: unit + ' is ' + ruling + ' on what the turns showed' }))
  return {
    navigator: [{ output: repoReturn() }],
    ruler: { key: 'ruler||ruler:search:' + name + ':' + (turn + 1), steps: [{ output: { units } }] },
  }
}
