// test/fast/harness/scout.mjs — scripted scout steps for the scripted runner: journal records (a hit,
// a grep, the guard firing) and the steps and script entries a test plays for a search's dispatch.
export const hitRecord = (hit) => ({ tool: 'hit', args: hit, ok: true, hit })
export const grepRecord = (lines, pattern = 'TOKEN') => ({ tool: 'grep', args: { pattern, fixed: false, ignore_case: false, paths: [], page: 1 }, ok: true, total: lines.length, page: 1, pages: 1, observed: lines.map(([key, line]) => ({ key, line })), keys: [...new Set(lines.map(([key]) => key))], new: lines.length > 0 })
export const stalledRecord = () => ({ stalled: true, window: 12 })
export const scoutStep = ({ hits = [], calls = [], summary = 'searched' } = {}) => ({ calls: [...calls, ...hits.map(hitRecord)], output: { summary } })
export const hitTurn = (hits, opts = {}) => scoutStep({ ...opts, calls: [grepRecord(hits.filter((h) => h.path).map((h) => [h.path, h.line]))], hits })
export const foundSearch = ({ role = 'scout', name, hits = [] }) => ({ [role + '||' + name]: [hitTurn(hits)] })
export const closedSearch = ({ role = 'scout', name }) => ({ [role + '||' + name]: [scoutStep({ summary: 'nothing here bears on it' })] })
