// lib/search/server.mjs — the search tool server: one stdio MCP server per CLI process of a
// search, serving its tools and hit over its pinned tree and journaling every call, tagged with
// the session, before it answers, so what a searcher saw and found is code's own record.
//
// Design: docs/DESIGN.md#searches.
//
// CLI: node lib/search/server.mjs --spec <path to spec json>

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { canonical, fnv1a } from '../plan-digest.mjs'
import { mkdirState, writeWhole } from '../store.mjs'
import { GLOB_RULES, canonicalUrl, within } from './query.mjs'
import { PAGE_LINES, commitOf, fetchUrl, files, grep, keyOf, log, read, refs, show } from './tools.mjs'

export const SERVER_NAME = 'search'
export const TOOLS_BY_DOMAIN = { repo: ['grep', 'read', 'files', 'refs'], history: ['log', 'show', 'grep', 'read'], web: ['fetch'] }

const SERVER_FILE = fileURLToPath(import.meta.url)
const PROTOCOL = '2025-06-18'

const str = { type: 'string' }
const int = { type: 'integer' }
const bool = { type: 'boolean' }
const strs = { type: 'array', items: str }
const globPaths = { type: 'array', items: str, description: 'Files, directories or globs to search, inside the scope; omitted, the whole scope. ' + GLOB_RULES }
const pageLine = (r) => 'page ' + r.page + ' of ' + r.pages + (r.page < r.pages ? '; page ' + (r.page + 1) + ' holds the next ones' : '')

/** Each tool: what it takes, how it runs, what its result shows the scout and what code records of it. */
const TOOLS = {
  grep: {
    description: 'Search the tree for a pattern: an extended regex (\\d \\s \\w and their capitals work; \\b, (? groups and lazy quantifiers are refused), or a plain string with fixed. ' +
      'Returns the matching lines, ' + PAGE_LINES + ' to a page.',
    props: { pattern: str, fixed: bool, ignore_case: bool, paths: globPaths, page: int }, required: ['pattern'],
    defaults: { fixed: false, ignore_case: false, paths: [], page: 1 },
    run: (tree, a, scope, spec) => grep(tree, a, { scope }),
    observed: (r) => r.lines.map((l) => ({ key: l.key, line: l.line })),
    keys: (r) => [...new Set(r.lines.map((l) => l.key))],
    text: (r) => [r.total + ' matching line(s) in ' + r.files + ' file(s); ' + (r.total ? pageLine(r) : 'nothing matched'),
      ...r.lines.map((l) => l.key + ':' + l.line + ': ' + l.text)].join('\n'),
  },
  read: {
    description: 'Read lines of one file of the tree, from `from` to `to` (0 = to the end), at most ' + PAGE_LINES + ' at a time.',
    props: { path: str, from: int, to: int }, required: ['path'],
    defaults: { from: 1, to: 0 },
    run: (tree, a, scope, spec) => read(tree, a, { scope }),
    observed: (r) => r.lines.map((l) => ({ key: r.key, line: l.line })),
    keys: (r) => [r.key],
    text: (r) => [r.key + ': lines ' + r.from + '-' + r.to + ' of ' + r.total_lines +
      (r.to < r.total_lines ? '; lines after ' + r.to + ' are not read' : ''), ...r.lines.map((l) => l.line + ': ' + l.text)].join('\n'),
  },
  files: {
    description: 'List the files of the tree matching a glob, ' + PAGE_LINES + ' to a page. ' + GLOB_RULES,
    props: { glob: str, page: int }, required: ['glob'],
    defaults: { page: 1 },
    run: (tree, a, scope, spec) => files(tree, a, { scope }),
    observed: () => [],
    keys: (r) => r.keys,
    text: (r) => [r.total + ' file(s); ' + (r.total ? pageLine(r) : 'none matched'), ...r.keys].join('\n'),
  },
  refs: {
    description: 'Count the word-bounded references to a symbol, by file, tests marked.',
    props: { symbol: str }, required: ['symbol'],
    defaults: {},
    run: (tree, a, scope, spec) => refs(tree, a, { scope }),
    observed: () => [],
    keys: (r) => r.files.map((f) => f.key),
    text: (r) => [r.total + ' reference(s) in ' + r.files.length + ' file(s)',
      ...r.files.map((f) => f.key + ': ' + f.count + (f.test ? ' (test)' : ''))].join('\n'),
  },
  log: {
    description: 'Search the history: mode G (added or removed lines matching a regex), S (a string whose count changed) or grep (commit messages), ' +
      PAGE_LINES + ' commits to a page.',
    props: { mode: { type: 'string', enum: ['G', 'S', 'grep'] }, pattern: str, paths: strs, page: int }, required: ['mode', 'pattern'],
    defaults: { paths: [], page: 1 },
    run: (tree, a, scope, spec) => log(tree, a),
    observed: () => [],
    keys: (r) => r.commits.map((c) => c.sha),
    text: (r) => [r.total + ' commit(s); ' + (r.total ? pageLine(r) : 'none matched'),
      ...r.commits.map((c) => c.sha + ' ' + c.date + ' ' + c.subject + (c.keys.length ? '\n  ' + c.keys.join(', ') : ''))].join('\n'),
  },
  show: {
    description: 'Show one commit, or one path in it.',
    props: { commit: str, path: str }, required: ['commit'],
    defaults: { path: '' },
    run: (tree, a, scope, spec) => show(tree, a),
    observed: (r) => r.lines.map((l) => ({ key: r.sha, line: l.line })),
    keys: (r) => [r.sha],
    text: (r) => r.lines.map((l) => l.text).join('\n'),
  },
  fetch: {
    description: 'Fetch one web page by its URL, ' + PAGE_LINES + ' lines to a page.',
    props: { url: str, page: int }, required: ['url'],
    defaults: { page: 1 },
    run: (tree, a, scope, spec) => fetchUrl(a, { pages: spec.pages }),
    observed: (r) => r.lines.map((l) => ({ key: r.key, line: l.line })),
    keys: (r) => [r.key],
    text: (r) => [r.key + ' (status ' + r.status + ', ' + r.bytes + ' bytes); ' + (r.pages ? pageLine(r) : 'empty'),
      ...r.lines.map((l) => l.line + ': ' + l.text)].join('\n'),
  },
}

/** Where a search's files live. */
export function searchDir(runDir, searchKey) {
  return join(runDir, 'searches', String(searchKey).split(':').join('~'))
}

/** Write a dispatch's server spec and MCP config; the config's absolute path, for --mcp-config. */
export function mcpConfigFor(runDir, searchKey, spec) {
  const dir = resolve(searchDir(runDir, searchKey))
  const digest = fnv1a(canonical(spec))
  const specPath = join(dir, 'server-' + digest + '.json')
  const configPath = join(dir, 'mcp-' + digest + '.json')
  writeWhole(specPath, spec)
  writeWhole(configPath, { mcpServers: { [SERVER_NAME]: { type: 'stdio', command: process.execPath, args: [SERVER_FILE, '--spec', specPath] } } })
  return configPath
}

const CANDIDATE = {
  type: 'object',
  properties: Object.fromEntries(['name', 'source_url', 'what_it_is', 'latest_version', 'license', 'maintenance', 'covers', 'does_not_cover'].map((k) => [k, str])),
  required: ['name', 'source_url', 'what_it_is', 'latest_version', 'license', 'maintenance', 'covers', 'does_not_cover'],
  additionalProperties: false,
}

/** Pure. The MCP tool list for a spec: each served tool's own arguments, then hit. */
export function toolDefs(spec) {
  const labels = spec.labels || []
  const served = spec.tools.filter((name) => Object.hasOwn(TOOLS, name)).map((name) => ({
    name,
    description: TOOLS[name].description,
    inputSchema: { type: 'object', properties: TOOLS[name].props, required: TOOLS[name].required },
  }))
  return [...served, {
    name: 'hit',
    description: 'Record one finding the moment a tool shows it: a path and its line, a commit, or a URL; a one-line note' +
      (labels.length ? '; its label' : '') + '; the candidate when it is one.',
    inputSchema: {
      type: 'object',
      properties: { path: str, commit: str, url: str, line: int, note: str, ...(labels.length ? { label: { type: 'string', enum: labels } } : {}), candidate: CANDIDATE },
      required: ['note'],
    },
  }]
}

export const STALL_WINDOW = 12
const STALLED = 'stalled: nothing new in the last ' + STALL_WINDOW + ' calls; record what you found and return'

const countsOf = (r) => Object.fromEntries(['total', 'page', 'pages'].filter((k) => typeof r[k] === 'number').map((k) => [k, r[k]]))
const RESULT_FIELDS = ['ok', 'refusal', 'detail', 'total', 'page', 'pages', 'observed', 'keys']
const refusedText = (r) => 'Refused (' + r.refusal + '): ' + (r.detail || '')
const bad = (detail) => ({ ok: false, refusal: 'bad_hit', detail })

/** A hit's place resolved to its canonical key, or a bad_hit refusal. */
async function hitOf(spec, a) {
  const note = typeof a.note === 'string' ? a.note.trim() : ''
  const named = ['path', 'commit', 'url'].filter((k) => typeof a[k] === 'string' && a[k] !== '')
  if (!note) return bad('a hit needs a note')
  if (named.length !== 1) return bad('a hit names exactly one of path, commit or url')
  if (a.label !== undefined && !(spec.labels || []).includes(a.label)) {
    return bad((spec.labels || []).length ? 'label must be one of ' + spec.labels.join(', ') : 'this search takes no label')
  }
  const label = a.label !== undefined ? { label: a.label } : {}
  if (named[0] === 'path') {
    if (!Number.isInteger(a.line) || a.line < 1) return bad('a path hit needs its line, from 1')
    const k = keyOf(spec.tree, a.path)
    if (!k.ok) return bad(k.detail)
    if (!spec.subject.some((part) => within(k.key, part))) return bad(k.key + " is outside the search's subject: " + spec.subject.join(', '))
    return { ok: true, hit: { path: k.key, line: a.line, note, ...label } }
  }
  if (named[0] === 'commit') {
    const c = await commitOf(spec.tree, a.commit)
    return c.ok ? { ok: true, hit: { commit: c.sha, note, ...label } } : bad(c.detail)
  }
  return {
    ok: true,
    hit: {
      url: canonicalUrl(a.url), ...(Number.isInteger(a.line) && a.line > 0 ? { line: a.line } : {}), note, ...label,
      ...(a.candidate && typeof a.candidate === 'object' ? { candidate: a.candidate } : {}),
    },
  }
}

const shown = (r) => [...(r.observed || []).map((o) => o.key + ':' + o.line), ...(r.keys || []).map((k) => 'key ' + k)]
const toolRecords = (prior, session) => prior.filter((r) => r.session === session && typeof r.tool === 'string' && r.tool !== 'hit' && r.tool !== 'websearch')
const stalledIn = (prior, session) => prior.some((r) => r.stalled && r.session === session)

/**
 * Handle one tools/call: record a hit, refuse a stalled session's call, answer an exact repeat in
 * this session from the call it repeats, or run the tool; then fire the loop guard when the
 * session's last STALL_WINDOW tool calls showed nothing new. Records are numbered after `prior`'s
 * last, and the text starts with the call's number, so the scout can name it. Never throws.
 */
export async function handle(spec, prior, name, args) {
  const given = args && typeof args === 'object' ? args : {}
  const seq = prior.reduce((n, r) => Math.max(n, r.seq || 0), 0) + 1
  const base = { seq, session: spec.session }
  const said = (text, records) => ({ text: 'call ' + seq + ': ' + text, records })
  if (name === 'hit') {
    const h = await hitOf(spec, given)
    const record = h.ok ? { ...base, tool: 'hit', args: given, ok: true, hit: h.hit } : { ...base, tool: 'hit', args: given, ok: false, refusal: h.refusal, detail: h.detail }
    return said(h.ok ? 'recorded' : refusedText(record), [record])
  }
  const tool = Object.hasOwn(TOOLS, name) && spec.tools.includes(name) ? TOOLS[name] : null
  if (!tool) return { text: 'No tool named ' + JSON.stringify(name) + ' is served here.', records: [] }
  const canon = { ...tool.defaults, ...Object.fromEntries(Object.keys(tool.props).filter((k) => given[k] !== undefined).map((k) => [k, given[k]])) }
  const head = { ...base, tool: name, args: canon }
  if (stalledIn(prior, spec.session)) {
    return said(STALLED, [{ ...head, ok: false, refusal: 'stalled', detail: STALLED, observed: [], keys: [], new: false }])
  }
  let record
  let text
  const same = prior.find((p) => p.session === spec.session && p.tool === name && p.refusal !== 'stalled' && canonical(p.args) === canonical(canon))
  if (same) {
    const original = same.repeat_of ?? same.seq
    const result = Object.fromEntries(RESULT_FIELDS.filter((k) => same[k] !== undefined).map((k) => [k, same[k]]))
    record = { ...head, ...result, repeat_of: original, new: false }
    text = 'already run at call ' + original + ', same result' + (result.ok ? '.' : ': ' + refusedText(result))
  } else {
    let r
    try {
      r = await tool.run(spec.tree, canon, spec.scope, spec)
    } catch (err) {
      r = { ok: false, refusal: 'expander_error', detail: String((err && err.message) || err) }
    }
    if (!r.ok) {
      record = { ...head, ok: false, refusal: r.refusal, detail: r.detail || '', observed: [], keys: [], new: false }
      text = refusedText(record)
    } else {
      record = { ...head, ok: true, ...countsOf(r), observed: tool.observed(r), keys: tool.keys(r) }
      const seen = new Set(prior.flatMap(shown))
      record.new = shown(record).some((x) => !seen.has(x))
      text = tool.text(r)
    }
  }
  const records = [record]
  const window = [...toolRecords(prior, spec.session), record].slice(-STALL_WINDOW)
  if (window.length === STALL_WINDOW && window.every((r) => !r.new)) {
    records.push({ seq: seq + 1, session: spec.session, stalled: true, window: STALL_WINDOW })
    text += '\n\n' + STALLED
  }
  return said(text, records)
}

/**
 * The call log as written so far: every whole record, a torn one left out. A log whose last line
 * was cut off mid-write is ended with a newline first, so the next record starts a line of its own.
 */
export function openCalls(path) {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  if (text !== '' && !text.endsWith('\n')) appendFileSync(path, '\n')
  return text.split('\n').flatMap((l) => {
    try { return l.trim() ? [JSON.parse(l)] : [] } catch { return [] }
  })
}

/** Serve MCP over stdio until stdin closes, one message at a time; each call is in the log before its answer leaves. */
export function serve(spec, { input = process.stdin, output = process.stdout } = {}) {
  const prior = openCalls(spec.calls)
  const send = (m) => output.write(JSON.stringify(m) + '\n')
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
  async function answer(m) {
    if (m.method === 'initialize') {
      return reply(m.id, { protocolVersion: (m.params && m.params.protocolVersion) || PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'agentics-' + SERVER_NAME, version: '1' } })
    }
    if (m.method === 'tools/list') return reply(m.id, { tools: toolDefs(spec) })
    if (m.method === 'tools/call') {
      const p = m.params || {}
      const { text, records } = await handle(spec, prior, p.name, p.arguments || {})
      if (records.length) mkdirState(dirname(spec.calls))
      for (const record of records) {
        appendFileSync(spec.calls, JSON.stringify(record) + '\n')
        prior.push(record)
      }
      return reply(m.id, { content: [{ type: 'text', text }], isError: records.length === 0 || !records[0].ok })
    }
    if (m.method === 'ping') return reply(m.id, {})
    if (m.id !== undefined && m.id !== null) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found: ' + m.method } })
  }
  let queue = Promise.resolve()
  const lines = createInterface({ input, crlfDelay: Infinity })
  lines.on('line', (line) => {
    let m
    try { m = JSON.parse(line) } catch { return }
    if (m && typeof m === 'object') {
      queue = queue.then(() => answer(m)).catch((err) => {
        const message = String((err && err.message) || err)
        process.stderr.write('search server: ' + message + '\n')
        if (m.id !== undefined && m.id !== null) {
          try { send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message } }) } catch { /* the output is gone */ }
        }
      })
    }
  })
  return new Promise((done) => lines.on('close', () => { queue.then(done) }))
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  const at = process.argv.indexOf('--spec')
  let spec = null
  try { spec = at > 0 ? JSON.parse(readFileSync(process.argv[at + 1], 'utf8')) : null } catch { spec = null }
  if (!spec) {
    process.stderr.write('usage: node lib/search/server.mjs --spec <path to spec json>\n')
    process.exit(2)
  }
  serve(spec)
}
