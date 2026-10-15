// lib/search/server.mjs — the search tool server: one stdio MCP server per navigator dispatch,
// serving one search's tools over its pinned tree and appending every call to the search's call
// log before it answers, so what a navigator saw is code's own record.
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
import { GLOB_RULES } from './query.mjs'
import { PAGE_LINES, fetchUrl, files, grep, log, read, refs, show } from './tools.mjs'

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

/** Each tool: what it takes, how it runs, what its result shows the navigator and what code records of it. */
const TOOLS = {
  grep: {
    description: 'Search the tree for a pattern: an extended regex (\\d \\s \\w and their capitals work; \\b, (? groups and lazy quantifiers are refused), or a plain string with fixed. ' +
      'Returns the matching lines, ' + PAGE_LINES + ' to a page.',
    props: { pattern: str, fixed: bool, ignore_case: bool, paths: globPaths, page: int }, required: ['pattern'],
    defaults: { fixed: false, ignore_case: false, paths: [], page: 1 },
    run: (tree, a, scope) => grep(tree, a, { scope }),
    observed: (r) => r.lines.map((l) => ({ key: l.key, line: l.line })),
    keys: (r) => [...new Set(r.lines.map((l) => l.key))],
    text: (r) => [r.total + ' matching line(s) in ' + r.files + ' file(s); ' + (r.total ? pageLine(r) : 'nothing matched'),
      ...r.lines.map((l) => l.key + ':' + l.line + ': ' + l.text)].join('\n'),
  },
  read: {
    description: 'Read lines of one file of the tree, from `from` to `to` (0 = to the end), at most ' + PAGE_LINES + ' at a time.',
    props: { path: str, from: int, to: int }, required: ['path'],
    defaults: { from: 1, to: 0 },
    run: (tree, a, scope) => read(tree, a, { scope }),
    observed: (r) => r.lines.map((l) => ({ key: r.key, line: l.line })),
    keys: (r) => [r.key],
    ended: (r) => ({ key: r.key, to: r.to, total_lines: r.total_lines }),
    text: (r) => [r.key + ': lines ' + r.from + '-' + r.to + ' of ' + r.total_lines +
      (r.to < r.total_lines ? '; lines after ' + r.to + ' are not read' : ''), ...r.lines.map((l) => l.line + ': ' + l.text)].join('\n'),
  },
  files: {
    description: 'List the files of the tree matching a glob, ' + PAGE_LINES + ' to a page. ' + GLOB_RULES,
    props: { glob: str, page: int }, required: ['glob'],
    defaults: { page: 1 },
    run: (tree, a, scope) => files(tree, a, { scope }),
    observed: () => [],
    keys: (r) => r.keys,
    text: (r) => [r.total + ' file(s); ' + (r.total ? pageLine(r) : 'none matched'), ...r.keys].join('\n'),
  },
  refs: {
    description: 'Count the word-bounded references to a symbol, by file, tests marked.',
    props: { symbol: str }, required: ['symbol'],
    defaults: {},
    run: (tree, a, scope) => refs(tree, a, { scope }),
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
    run: (tree, a) => log(tree, a),
    observed: () => [],
    keys: (r) => r.commits.map((c) => c.sha),
    text: (r) => [r.total + ' commit(s); ' + (r.total ? pageLine(r) : 'none matched'),
      ...r.commits.map((c) => c.sha + ' ' + c.date + ' ' + c.subject + (c.keys.length ? '\n  ' + c.keys.join(', ') : ''))].join('\n'),
  },
  show: {
    description: 'Show one commit, or one path in it.',
    props: { commit: str, path: str }, required: ['commit'],
    defaults: { path: '' },
    run: (tree, a) => show(tree, a),
    observed: (r) => r.lines.map((l) => ({ key: r.sha, line: l.line })),
    keys: (r) => [r.sha],
    text: (r) => r.lines.map((l) => l.text).join('\n'),
  },
  fetch: {
    description: 'Fetch one web page by its URL, ' + PAGE_LINES + ' lines to a page.',
    props: { url: str, page: int }, required: ['url'],
    defaults: { page: 1 },
    run: (tree, a, scope, dir) => fetchUrl(a, { dir }),
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

/** Pure. The MCP tool list for a spec: each tool's own arguments, plus the ask or asks it serves. */
export function toolDefs(spec) {
  const asks = spec.asks.map((a) => a.key)
  const ask = {
    description: 'the ask this call serves, or several',
    anyOf: [{ type: 'string', enum: asks }, { type: 'array', items: { type: 'string', enum: asks } }],
  }
  return spec.tools.filter((name) => Object.hasOwn(TOOLS, name)).map((name) => ({
    name,
    description: TOOLS[name].description,
    inputSchema: { type: 'object', properties: { ...TOOLS[name].props, ask }, required: [...TOOLS[name].required, 'ask'] },
  }))
}

const scopeOf = (spec, asks) => [...new Set(spec.asks.filter((a) => asks.includes(a.key)).flatMap((a) => a.scope || ['.']))].sort()
const countsOf = (r) => Object.fromEntries(['total', 'page', 'pages'].filter((k) => typeof r[k] === 'number').map((k) => [k, r[k]]))
const RESULT_FIELDS = ['ok', 'refusal', 'detail', 'total', 'page', 'pages', 'observed', 'keys', 'ended']
const refusedText = (r) => 'Refused (' + r.refusal + '): ' + (r.detail || '')

/**
 * Handle one tools/call: run the tool, or answer an exact repeat from the first call it repeats.
 * The record is numbered after `prior`'s last, and its text starts with that number, so the
 * navigator can name the call. Never throws.
 */
export async function handle(spec, prior, name, args) {
  const tool = Object.hasOwn(TOOLS, name) && spec.tools.includes(name) ? TOOLS[name] : null
  if (!tool) return { text: 'No tool named ' + JSON.stringify(name) + ' is served here.', record: null }
  const given = args && typeof args === 'object' ? args : {}
  const asks = [given.ask].flat().filter((a) => typeof a === 'string')
  const canon = { ...tool.defaults, ...Object.fromEntries(Object.keys(tool.props).filter((k) => given[k] !== undefined).map((k) => [k, given[k]])) }
  const seq = prior.reduce((n, r) => Math.max(n, r.seq || 0), 0) + 1
  const base = { seq, tool: name, args: canon, asks }
  const said = (text, record) => ({ text: 'call ' + seq + ': ' + text, record })
  const known = spec.asks.map((a) => a.key)
  const stray = asks.length ? asks.find((a) => !known.includes(a)) : '(none named)'
  if (stray !== undefined) {
    const record = { ...base, ok: false, refusal: 'unknown_ask', detail: 'no ask ' + stray + ' in this search', observed: [], keys: [] }
    return said(refusedText(record), record)
  }
  const scope = scopeOf(spec, asks)
  const same = prior.find((p) => p.refusal !== 'unknown_ask' && p.tool === name && canonical(p.args) === canonical(canon) && canonical(scopeOf(spec, p.asks)) === canonical(scope))
  if (same) {
    const original = same.repeat_of ?? same.seq
    const result = Object.fromEntries(RESULT_FIELDS.filter((k) => same[k] !== undefined).map((k) => [k, same[k]]))
    const record = { ...base, ...result, repeat_of: original }
    return said('already run at call ' + original + ', same result' + (result.ok ? '.' : ': ' + refusedText(result)), record)
  }
  let r
  try {
    r = await tool.run(spec.tree, canon, scope, dirname(spec.calls))
  } catch (err) {
    r = { ok: false, refusal: 'expander_error', detail: String((err && err.message) || err) }
  }
  if (!r.ok) {
    const record = { ...base, ok: false, refusal: r.refusal, detail: r.detail || '', observed: [], keys: [] }
    return said(refusedText(record), record)
  }
  const record = { ...base, ok: true, ...countsOf(r), observed: tool.observed(r), keys: tool.keys(r), ...(tool.ended ? { ended: tool.ended(r) } : {}) }
  return said(tool.text(r), record)
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
      const { text, record } = await handle(spec, prior, p.name, p.arguments || {})
      if (record) {
        mkdirState(dirname(spec.calls))
        appendFileSync(spec.calls, JSON.stringify(record) + '\n')
        prior.push(record)
      }
      return reply(m.id, { content: [{ type: 'text', text }], isError: !(record && record.ok) })
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
