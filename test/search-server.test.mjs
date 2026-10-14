// test/search-server.test.mjs — pins the search tool server: the tools it lists for a search's
// asks, each call run on the pinned tree and written to the search's call log before its answer
// leaves, exact repeats answered from the call they repeat, refusals recorded, the files a
// dispatch's --mcp-config names, and the CLI the host starts.
//
// Design: docs/DESIGN.md#evidence.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { createServer } from 'node:http'
import { PassThrough, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { canonicalUrl } from '../lib/search/ledger.mjs'
import { SERVER_NAME, TOOLS_BY_DOMAIN, handle, mcpConfigFor, searchDir, serve, toolDefs } from '../lib/search/server.mjs'

const SERVER = fileURLToPath(new URL('../lib/search/server.mjs', import.meta.url))
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: ENV, windowsHide: true }).trim()
const FILES = { 'src/a.mjs': 'const NEEDLE = 1\nuse(NEEDLE)\n', 'docs/b.md': 'NEEDLE in prose\n' }

let base
let tree
let worktree

before(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'agentics-search-server-')))
  const root = join(base, 'repo')
  mkdirSync(root)
  git(root, 'init', '-q'); git(root, 'config', 'core.autocrlf', 'false')
  for (const [p, text] of Object.entries(FILES)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text) }
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'init')
  tree = { root: root.split('\\').join('/'), sha: git(root, 'rev-parse', 'HEAD') }
  const wt = join(base, 'pinned')
  git(root, 'worktree', 'add', '-q', '--detach', wt, tree.sha)
  worktree = { root: wt.split('\\').join('/'), sha: tree.sha }
})

after(() => rmSync(base, { recursive: true, force: true }))

let n = 0
/** A fresh search over `on`: its own run directory and call log. */
function specOf({ on = tree, asks = [{ key: 'guidance', scope: ['.'], domain: 'repo' }, { key: 'ground:a', scope: ['src'], domain: 'repo' }], tools = TOOLS_BY_DOMAIN.repo } = {}) {
  const run = join(base, 'runs', String(++n))
  return { run, spec: { tree: on, asks, tools, calls: join(searchDir(run, 'probe:x'), 'calls.jsonl') } }
}
const callLog = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : [])
const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })
const toolCall = (id, name, args) => rpc(id, 'tools/call', { name, arguments: args })

/** Serve `lines` to completion over in-memory streams; the parsed replies, and what the log held as each left. */
async function session(spec, lines) {
  const input = new PassThrough()
  const replies = []
  const output = new Writable({
    write(chunk, _enc, done) {
      for (const l of String(chunk).split('\n').filter((x) => x.trim())) replies.push({ reply: JSON.parse(l), logged: callLog(spec.calls).map((c) => c.seq) })
      done()
    },
  })
  const served = serve(spec, { input, output })
  for (const l of lines) input.write(l + '\n')
  input.end()
  await served
  return replies
}
const replyTo = (replies, id) => replies.find((r) => r.reply.id === id)

// ------------------------------------------------------------------ names and files

test('the server is named search and serves each domain its tools', () => {
  assert.equal(SERVER_NAME, 'search')
  assert.deepEqual(TOOLS_BY_DOMAIN, { repo: ['grep', 'read', 'files', 'refs'], history: ['log', 'show', 'grep', 'read'], web: ['fetch'] })
})

test("a search's files live under the run's searches directory, a ':' in its key spelled '~'", () => {
  assert.equal(searchDir(join('r', 'run'), 'survey:a/b:2'), join('r', 'run', 'searches', 'survey~a/b~2'))
})

test("a dispatch's MCP config names node, this server and the search's spec file", () => {
  const { run, spec } = specOf()
  const path = mcpConfigFor(run, 'probe:x', spec)
  assert.ok(isAbsolute(path))
  assert.ok(path.startsWith(searchDir(run, 'probe:x')))
  const config = JSON.parse(readFileSync(path, 'utf8'))
  const server = config.mcpServers[SERVER_NAME]
  assert.equal(server.type, 'stdio')
  assert.equal(server.command, process.execPath)
  assert.equal(server.args[0], SERVER)
  assert.equal(server.args[1], '--spec')
  assert.deepEqual(JSON.parse(readFileSync(server.args[2], 'utf8')), spec)
  assert.deepEqual(Object.keys(config.mcpServers), [SERVER_NAME], 'one server, and no other')
})

test('the same spec gives the same config path, another spec another', () => {
  const { run, spec } = specOf()
  const one = mcpConfigFor(run, 'probe:x', spec)
  assert.equal(mcpConfigFor(run, 'probe:x', spec), one)
  const more = { ...spec, asks: [...spec.asks, { key: 'want:1', scope: ['.'], domain: 'repo' }] }
  assert.notEqual(mcpConfigFor(run, 'probe:x', more), one)
  assert.ok(existsSync(one), 'the earlier config is kept')
})

// ------------------------------------------------------------------ the tool list

test("the tool list is the spec's tools, each taking its arguments and a required ask of this search", () => {
  const { spec } = specOf()
  const defs = toolDefs(spec)
  assert.deepEqual(defs.map((d) => d.name), spec.tools)
  for (const d of defs) {
    assert.equal(typeof d.description, 'string')
    assert.equal(d.inputSchema.type, 'object')
    assert.ok(d.inputSchema.required.includes('ask'), d.name)
    const ask = JSON.stringify(d.inputSchema.properties.ask)
    for (const a of spec.asks) assert.ok(ask.includes(JSON.stringify(a.key)), d.name + ' names ask ' + a.key)
  }
  assert.ok(defs.find((d) => d.name === 'grep').inputSchema.required.includes('pattern'))
  assert.ok(defs.find((d) => d.name === 'read').inputSchema.required.includes('path'))
})

test('a web search lists only fetch', () => {
  assert.deepEqual(toolDefs(specOf({ tools: TOOLS_BY_DOMAIN.web }).spec).map((d) => d.name), ['fetch'])
})

// ------------------------------------------------------------------ one call

test('a call runs its tool and becomes a record of what it showed', async () => {
  const { spec } = specOf()
  const { text, record } = await handle(spec, [], 'grep', { pattern: 'NEEDLE', ask: 'guidance' })
  assert.ok(text.includes('src/a.mjs:1: const NEEDLE = 1'), text)
  assert.equal(record.tool, 'grep')
  assert.deepEqual(record.asks, ['guidance'])
  assert.equal(record.ok, true)
  assert.deepEqual(record.args, { pattern: 'NEEDLE', fixed: false, ignore_case: false, paths: [], page: 1 }, 'as given minus ask, defaults filled')
  assert.deepEqual([record.total, record.page, record.pages], [3, 1, 1])
  assert.deepEqual(record.observed, [{ key: 'docs/b.md', line: 1 }, { key: 'src/a.mjs', line: 1 }, { key: 'src/a.mjs', line: 2 }])
  assert.deepEqual(record.keys, ['docs/b.md', 'src/a.mjs'])
  assert.equal(record.seq, 1, 'numbered after an empty log')
  assert.ok(text.startsWith('call 1: '), 'the text names its own call: ' + text)
})

test("a call is numbered after the log's last record, and its text says so", async () => {
  const { spec } = specOf()
  const prior = [{ seq: 6, tool: 'files', args: { glob: 'x', page: 1 }, asks: ['guidance'], ok: true, observed: [], keys: [] }]
  const { text, record } = await handle(spec, prior, 'refs', { symbol: 'NEEDLE', ask: 'guidance' })
  assert.equal(record.seq, 7)
  assert.ok(text.startsWith('call 7: '), text)
})

test('a read records how far it read, of how many lines', async () => {
  const { spec } = specOf()
  const { text, record } = await handle(spec, [], 'read', { path: 'src/a.mjs', to: 1, ask: ['ground:a'] })
  assert.deepEqual(record.observed, [{ key: 'src/a.mjs', line: 1 }])
  assert.deepEqual(record.ended, { key: 'src/a.mjs', to: 1, total_lines: 2 })
  assert.ok(text.includes('1: const NEEDLE = 1'), text)
})

test("a call runs inside the union of its asks' scopes", async () => {
  const { spec } = specOf()
  const narrow = await handle(spec, [], 'grep', { pattern: 'NEEDLE', ask: 'ground:a' })
  assert.ok(narrow.record.observed.every((o) => o.key.startsWith('src/')))
  const outside = await handle(spec, [], 'read', { path: 'docs/b.md', ask: 'ground:a' })
  assert.deepEqual([outside.record.ok, outside.record.refusal], [false, 'outside_scope'])
  const both = await handle(spec, [], 'read', { path: 'docs/b.md', ask: ['ground:a', 'guidance'] })
  assert.equal(both.record.ok, true)
})

test('a call naming no ask, or an ask this search lacks, is refused unknown_ask and recorded', async () => {
  const { spec } = specOf()
  for (const ask of [undefined, 'nope', ['guidance', 'nope']]) {
    const { text, record } = await handle(spec, [], 'grep', { pattern: 'NEEDLE', ...(ask === undefined ? {} : { ask }) })
    assert.deepEqual([record.ok, record.refusal], [false, 'unknown_ask'], JSON.stringify(ask))
    assert.deepEqual([record.observed, record.keys], [[], []])
    assert.ok(text.length > 0)
  }
})

test("a tool's refusal is recorded with its class and nothing observed", async () => {
  const { spec } = specOf()
  const { record } = await handle(spec, [], 'grep', { pattern: '\\bNEEDLE', ask: 'guidance' })
  assert.deepEqual([record.ok, record.refusal, record.observed, record.keys], [false, 'unsupported_syntax', [], []])
  assert.equal(typeof record.detail, 'string')
})

test('an exact repeat over the same scope is answered from the first call it repeats', async () => {
  const { spec } = specOf({ asks: [{ key: 'guidance', scope: ['.'], domain: 'repo' }, { key: 'more', scope: ['.'], domain: 'repo' }, { key: 'ground:a', scope: ['src'], domain: 'repo' }] })
  const first = (await handle(spec, [], 'grep', { pattern: 'NEEDLE', ask: 'guidance' })).record
  const again = await handle(spec, [first], 'grep', { pattern: 'NEEDLE', page: 1, ask: ['more'] })
  assert.equal(again.record.seq, 2)
  assert.equal(again.record.repeat_of, 1)
  assert.deepEqual(again.record.asks, ['more'], 'a repeat keeps its own asks')
  for (const k of ['ok', 'total', 'page', 'pages', 'observed', 'keys']) assert.deepEqual(again.record[k], first[k], 'copied: ' + k)
  assert.ok(again.text.startsWith('call 2: ') && again.text.includes('call 1'), 'the answer names its own call and the one it repeats: ' + again.text)
  const twice = await handle(spec, [first, again.record], 'grep', { pattern: 'NEEDLE', ask: 'guidance' })
  assert.equal(twice.record.repeat_of, 1, 'a repeat of a repeat names the first call')
  const elsewhere = await handle(spec, [first], 'grep', { pattern: 'NEEDLE', ask: 'ground:a' })
  assert.equal(elsewhere.record.repeat_of, undefined, 'the same arguments over another scope union run again')
})

test('a fetch records the page lines it showed under the page key', async (t) => {
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('one\ntwo\n') })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const { spec } = specOf({ asks: [{ key: 'research:a', scope: ['.'], domain: 'web' }], tools: TOOLS_BY_DOMAIN.web })
  const url = 'http://127.0.0.1:' + server.address().port + '/doc'
  const { text, record } = await handle(spec, [], 'fetch', { url, ask: 'research:a' })
  assert.equal(record.ok, true, text)
  assert.deepEqual(record.keys, [canonicalUrl(url)])
  assert.deepEqual(record.observed, [{ key: canonicalUrl(url), line: 1 }, { key: canonicalUrl(url), line: 2 }])
  assert.deepEqual([record.page, record.pages, record.args.page], [1, 1, 1])
  assert.ok(text.includes('2: two'), text)
})

test('a tool this search does not serve is answered and not recorded; nothing throws', async () => {
  const { spec } = specOf({ tools: ['grep'] })
  for (const [name, args] of [['read', { path: 'src/a.mjs', ask: 'guidance' }], ['rm', {}], [undefined, null]]) {
    const out = await handle(spec, [], name, args)
    assert.equal(out.record, null, String(name))
    assert.equal(typeof out.text, 'string')
  }
})

test('a tree that is a linked worktree is served like a main checkout', async () => {
  const { spec } = specOf({ on: worktree })
  const { record } = await handle(spec, [], 'read', { path: 'src/a.mjs', ask: 'guidance' })
  assert.deepEqual([record.ok, record.ended], [true, { key: 'src/a.mjs', to: 2, total_lines: 2 }])
})

// ------------------------------------------------------------------ the protocol

test('the server answers initialize, tools/list and ping, refuses a method it lacks, and ignores notifications', async () => {
  const { spec } = specOf()
  const replies = await session(spec, [
    rpc('server-discover-probe-1', 'server/discover'),
    rpc(0, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude', version: '1' } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    'not json at all',
    rpc(1, 'tools/list'),
    rpc(2, 'ping'),
  ])
  assert.equal(replyTo(replies, 'server-discover-probe-1').reply.error.code, -32601)
  const init = replyTo(replies, 0).reply.result
  assert.equal(init.protocolVersion, '2025-06-18')
  assert.ok(init.capabilities.tools)
  assert.deepEqual(replyTo(replies, 1).reply.result.tools.map((t) => t.name), spec.tools)
  assert.deepEqual(replyTo(replies, 2).reply.result, {})
  assert.equal(replies.length, 4, 'a notification and a torn line get no reply')
})

test('every call is in the call log before its answer leaves, numbered from 1', async () => {
  const { spec } = specOf()
  const replies = await session(spec, [
    toolCall(10, 'grep', { pattern: 'NEEDLE', ask: 'guidance' }),
    toolCall(11, 'read', { path: 'src/a.mjs', ask: 'ground:a' }),
    toolCall(12, 'read', { path: 'nope.mjs', ask: 'guidance' }),
  ])
  const log = callLog(spec.calls)
  assert.deepEqual(log.map((c) => c.seq), [1, 2, 3])
  assert.deepEqual(log.map((c) => c.tool), ['grep', 'read', 'read'])
  for (const [i, id] of [10, 11, 12].entries()) assert.ok(replyTo(replies, id).logged.includes(i + 1), 'call ' + (i + 1) + ' was logged before answer ' + id)
  assert.equal(replyTo(replies, 10).reply.result.isError, false)
  assert.equal(replyTo(replies, 12).reply.result.isError, true, 'a refusal is an error result')
  assert.ok(replyTo(replies, 10).reply.result.content[0].text.includes('src/a.mjs'))
  for (const [i, id] of [10, 11, 12].entries()) assert.ok(replyTo(replies, id).reply.result.content[0].text.startsWith('call ' + (i + 1) + ': '), 'answer ' + id + ' names its call')
})

test('calls that arrive together are run one at a time, in order', async () => {
  const { spec } = specOf()
  await session(spec, [toolCall(1, 'grep', { pattern: 'NEEDLE', ask: 'guidance' }), toolCall(2, 'grep', { pattern: 'NEEDLE', ask: 'guidance' })])
  const log = callLog(spec.calls)
  assert.deepEqual(log.map((c) => [c.seq, c.repeat_of]), [[1, undefined], [2, 1]], 'the second saw the first')
})

test("a later server on the same search numbers its calls after the log's last, and knows its repeats", async () => {
  const { spec } = specOf()
  await session(spec, [toolCall(1, 'grep', { pattern: 'NEEDLE', ask: 'guidance' })])
  await session(spec, [toolCall(1, 'grep', { pattern: 'NEEDLE', ask: 'guidance' }), toolCall(2, 'files', { glob: '**', ask: 'guidance' })])
  assert.deepEqual(callLog(spec.calls).map((c) => [c.seq, c.repeat_of]), [[1, undefined], [2, 1], [3, undefined]])
})

test('a torn last line of the call log is skipped, and numbering goes on after the last whole record', async () => {
  const { spec } = specOf()
  await session(spec, [toolCall(1, 'grep', { pattern: 'NEEDLE', ask: 'guidance' })])
  appendFileSync(spec.calls, '{"seq":2,"tool":"gr')
  await session(spec, [toolCall(1, 'files', { glob: '**', ask: 'guidance' })])
  const whole = readFileSync(spec.calls, 'utf8').split('\n').filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
  assert.deepEqual(whole.map((c) => c.seq), [1, 2])
  assert.equal(whole[1].tool, 'files')
})

// ------------------------------------------------------------------ the CLI

test('the CLI serves the spec its --spec names over stdio, and refuses to start without one', async () => {
  const { run, spec } = specOf()
  const config = JSON.parse(readFileSync(mcpConfigFor(run, 'probe:x', spec), 'utf8')).mcpServers[SERVER_NAME]
  const child = spawn(config.command, config.args, { windowsHide: true })
  let out = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d) => { out += d })
  child.stdin.end([rpc(0, 'initialize', { protocolVersion: '2025-06-18' }), toolCall(1, 'refs', { symbol: 'NEEDLE', ask: 'guidance' })].join('\n') + '\n')
  const code = await new Promise((r) => child.on('close', r))
  assert.equal(code, 0)
  const replies = out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  assert.ok(replies.find((r) => r.id === 1).result.content[0].text.includes('src/a.mjs'))
  assert.deepEqual(callLog(spec.calls).map((c) => c.tool), ['refs'])

  const bare = spawn(process.execPath, [SERVER], { windowsHide: true })
  bare.stdin.end()
  assert.equal(await new Promise((r) => bare.on('close', r)), 2)
})
