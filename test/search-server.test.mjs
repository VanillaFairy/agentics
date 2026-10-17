// test/search-server.test.mjs — pins the search tool server: the tools it lists and the hit tool,
// each call run on the pinned tree and journaled with its session and whether it showed anything
// new before its answer leaves, exact repeats in a session answered from the journal, hits
// recorded under their canonical place, the loop guard that stalls a session after a window of
// calls that showed nothing new, the files a dispatch's --mcp-config names, and the CLI.
//
// Design: docs/DESIGN.md#searches.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { createServer } from 'node:http'
import { PassThrough, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { fnv1a } from '../lib/plan-digest.mjs'
import { canonicalUrl } from '../lib/search/query.mjs'
import * as server from '../lib/search/server.mjs'

const { SERVER_NAME, TOOLS_BY_DOMAIN, handle, mcpConfigFor, searchDir, serve, toolDefs } = server

const SERVER = fileURLToPath(new URL('../lib/search/server.mjs', import.meta.url))
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: ENV, windowsHide: true }).trim()
const FILES = { 'src/a.mjs': 'const NEEDLE = 1\nuse(NEEDLE)\n', 'docs/b.md': 'NEEDLE in prose\n', 'src/c.txt': 'one\ntwo\nthree\n' }

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
  writeFileSync(join(base, 'outside.txt'), 'not in the tree\n')
})

after(() => rmSync(base, { recursive: true, force: true }))

let n = 0
/** A fresh search over `on`: its own run directory, call log and pages directory. */
function specOf({ tools = TOOLS_BY_DOMAIN.repo, labels = [], session = 's1', scope = ['.'], subject = scope, on = tree } = {}) {
  const run = join(base, 'runs', String(++n))
  return { run, spec: { tree: on, scope, subject, labels, tools, calls: join(searchDir(run, 'probe:x'), 'calls.jsonl'), pages: join(run, 'pages'), session } }
}
/** The same search under another session. */
const renewed = (spec, session) => ({ ...spec, session })
const callLog = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } }) : [])
const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })
const toolCall = (id, name, args) => rpc(id, 'tools/call', { name, arguments: args })

/** Handle one call against `journal` and append what it produced, as serve does. */
async function step(spec, journal, name, args) {
  const out = await handle(spec, journal, name, args)
  journal.push(...out.records)
  return out
}
/** A grep that matches nothing in the tree; each `i` a different call. */
const blank = (i) => ({ pattern: 'ZQXNOMATCH' + i + 'QZ' })
const stalls = (journal) => journal.filter((r) => r.stalled === true)
const hitArgs = (i) => ({ path: 'src/a.mjs', line: 1, note: 'hit ' + i })

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

test('the stall window is twelve calls', () => {
  assert.equal(server.STALL_WINDOW, 12)
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
  const srv = config.mcpServers[SERVER_NAME]
  assert.equal(srv.type, 'stdio')
  assert.equal(srv.command, process.execPath)
  assert.equal(srv.args[0], SERVER)
  assert.equal(srv.args[1], '--spec')
  assert.deepEqual(JSON.parse(readFileSync(srv.args[2], 'utf8')), spec)
  assert.deepEqual(Object.keys(config.mcpServers), [SERVER_NAME], 'one server, and no other')
})

test('the same spec gives the same config path, another spec another', () => {
  const { run, spec } = specOf()
  const one = mcpConfigFor(run, 'probe:x', spec)
  assert.equal(mcpConfigFor(run, 'probe:x', spec), one)
  assert.notEqual(mcpConfigFor(run, 'probe:x', renewed(spec, 's2')), one, 'another session is another spec')
  assert.ok(existsSync(one), 'the earlier config is kept')
})

// ------------------------------------------------------------------ the tool list

test("the tool list is the spec's tools and hit, none taking an ask", () => {
  const { spec } = specOf()
  const defs = toolDefs(spec)
  const names = defs.map((d) => d.name)
  assert.deepEqual([...names].sort(), [...spec.tools, 'hit'].sort())
  assert.equal(new Set(names).size, names.length, 'each tool once')
  for (const d of defs) {
    assert.equal(typeof d.description, 'string')
    assert.equal(d.inputSchema.type, 'object')
    assert.equal(Object.hasOwn(d.inputSchema.properties || {}, 'ask'), false, d.name + ' takes no ask')
    assert.equal((d.inputSchema.required || []).includes('ask'), false, d.name + ' requires no ask')
  }
  assert.ok(defs.find((d) => d.name === 'grep').inputSchema.required.includes('pattern'))
  assert.ok(defs.find((d) => d.name === 'read').inputSchema.required.includes('path'))
})

test('a web search lists only fetch and hit', () => {
  assert.deepEqual(toolDefs(specOf({ tools: TOOLS_BY_DOMAIN.web }).spec).map((d) => d.name).sort(), ['fetch', 'hit'])
})

test("hit takes a label only from the search's labels", () => {
  const labelled = toolDefs(specOf({ labels: ['guidance', 'ground:a'] }).spec).find((d) => d.name === 'hit')
  assert.ok(labelled, 'hit is listed')
  assert.deepEqual([...labelled.inputSchema.properties.label.enum].sort(), ['ground:a', 'guidance'])
  const bare = toolDefs(specOf({ labels: [] }).spec).find((d) => d.name === 'hit')
  assert.ok(bare, 'hit is listed with no labels too')
  assert.equal(Object.hasOwn(bare.inputSchema.properties || {}, 'label'), false, 'no label to give when the search has none')
  assert.equal((bare.inputSchema.required || []).includes('label'), false)
})

// ------------------------------------------------------------------ one call

test('a call runs its tool and becomes a record of what it showed', async () => {
  const { spec } = specOf()
  const { text, records } = await handle(spec, [], 'grep', { pattern: 'NEEDLE' })
  assert.equal(records.length, 1)
  const [record] = records
  assert.ok(text.includes('src/a.mjs:1: const NEEDLE = 1'), text)
  assert.equal(record.tool, 'grep')
  assert.equal(record.ok, true)
  assert.deepEqual(record.args, { pattern: 'NEEDLE', fixed: false, ignore_case: false, paths: [], page: 1 }, 'as given, defaults filled')
  assert.deepEqual([record.total, record.page, record.pages], [3, 1, 1])
  assert.deepEqual(record.observed, [{ key: 'docs/b.md', line: 1 }, { key: 'src/a.mjs', line: 1 }, { key: 'src/a.mjs', line: 2 }])
  assert.deepEqual(record.keys, ['docs/b.md', 'src/a.mjs'])
  assert.equal(record.seq, 1, 'numbered after an empty log')
  assert.ok(text.startsWith('call 1: '), 'the text names its own call: ' + text)
  assert.equal(Object.hasOwn(record, 'asks'), false, 'no record carries asks')
  assert.equal(Object.hasOwn(record, 'ended'), false, 'no record carries ended')
})

test("a call is numbered after the log's last record, and its text says so", async () => {
  const { spec } = specOf()
  const prior = [{ seq: 6, session: 's1', tool: 'files', args: { glob: 'x', page: 1 }, ok: true, observed: [], keys: [], new: false }]
  const { text, records } = await handle(spec, prior, 'refs', { symbol: 'NEEDLE' })
  assert.equal(records[0].seq, 7)
  assert.ok(text.startsWith('call 7: '), text)
})

test('a read records the lines it showed', async () => {
  const { spec } = specOf()
  const { text, records } = await handle(spec, [], 'read', { path: 'src/a.mjs', to: 1 })
  assert.deepEqual(records[0].observed, [{ key: 'src/a.mjs', line: 1 }])
  assert.ok(text.includes('1: const NEEDLE = 1'), text)
  assert.deepEqual(records[0].keys, ['src/a.mjs'])
  const later = await handle(spec, [], 'read', { path: 'src/c.txt', from: 2 })
  assert.deepEqual(later.records[0].observed, [{ key: 'src/c.txt', line: 2 }, { key: 'src/c.txt', line: 3 }])
})

test("a call runs inside the search's scope", async () => {
  const { spec } = specOf({ scope: ['src'] })
  const narrow = await handle(spec, [], 'grep', { pattern: 'NEEDLE' })
  assert.ok(narrow.records[0].observed.length > 0)
  assert.ok(narrow.records[0].observed.every((o) => o.key.startsWith('src/')))
  const outside = await handle(spec, [], 'read', { path: 'docs/b.md' })
  assert.deepEqual([outside.records[0].ok, outside.records[0].refusal], [false, 'outside_scope'])
})

test("a tool's refusal is recorded with its class and nothing observed", async () => {
  const { spec } = specOf()
  const { records } = await handle(spec, [], 'grep', { pattern: '\\bNEEDLE' })
  const [record] = records
  assert.deepEqual([record.ok, record.refusal, record.observed, record.keys], [false, 'unsupported_syntax', [], []])
  assert.equal(typeof record.detail, 'string')
})

test('a fetch records the page lines it showed under the page key', async (t) => {
  const http = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('one\ntwo\n') })
  await new Promise((r) => http.listen(0, '127.0.0.1', r))
  t.after(() => http.close())
  const { spec } = specOf({ tools: TOOLS_BY_DOMAIN.web })
  const url = 'http://127.0.0.1:' + http.address().port + '/doc'
  const { text, records } = await handle(spec, [], 'fetch', { url })
  const [record] = records
  assert.equal(record.ok, true, text)
  assert.deepEqual(record.keys, [canonicalUrl(url)])
  assert.deepEqual(record.observed, [{ key: canonicalUrl(url), line: 1 }, { key: canonicalUrl(url), line: 2 }])
  assert.deepEqual([record.page, record.pages, record.args.page], [1, 1, 1])
  assert.ok(text.includes('2: two'), text)
})

test("a fetch pins its body under the run's pages directory", async (t) => {
  const http = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('one\ntwo\n') })
  await new Promise((r) => http.listen(0, '127.0.0.1', r))
  t.after(() => http.close())
  const { spec } = specOf({ tools: TOOLS_BY_DOMAIN.web })
  const url = 'http://127.0.0.1:' + http.address().port + '/pin'
  const { records } = await handle(spec, [], 'fetch', { url })
  assert.equal(records[0].ok, true)
  assert.equal(existsSync(join(spec.pages, fnv1a(canonicalUrl(url)) + '.json')), true, 'the snapshot sits in spec.pages')
  assert.equal(existsSync(join(dirname(spec.calls), 'pages')), false, 'nothing pinned under the search directory')
})

test('a tool this search does not serve is answered and not recorded; nothing throws', async () => {
  const { spec } = specOf({ tools: ['grep'] })
  for (const [name, args] of [['read', { path: 'src/a.mjs' }], ['rm', {}], [undefined, null]]) {
    const out = await handle(spec, [], name, args)
    assert.ok(Array.isArray(out.records), String(name))
    assert.equal(out.records.length, 0, String(name))
    assert.equal(typeof out.text, 'string')
  }
})

test('a tree that is a linked worktree is served like a main checkout', async () => {
  const { spec } = specOf({ on: worktree })
  const { records } = await handle(spec, [], 'read', { path: 'src/a.mjs' })
  assert.equal(records[0].ok, true)
  assert.deepEqual(records[0].observed, [{ key: 'src/a.mjs', line: 1 }, { key: 'src/a.mjs', line: 2 }])
})

// ------------------------------------------------------------------ session and new

test('every record carries the session of its server', async () => {
  const { spec } = specOf({ session: 'sess-xyz', labels: ['guidance'] })
  const journal = []
  await step(spec, journal, 'grep', { pattern: 'NEEDLE' })
  await step(spec, journal, 'grep', { pattern: 'NEEDLE' })
  await step(spec, journal, 'read', { path: 'nope.mjs' })
  await step(spec, journal, 'hit', { path: 'src/a.mjs', line: 1, note: 'the needle', label: 'guidance' })
  await step(spec, journal, 'hit', { note: 'nowhere' })
  for (let i = 0; i < 12; i++) await step(spec, journal, 'grep', blank(i))
  await step(spec, journal, 'grep', { pattern: 'use' })
  assert.ok(journal.some((r) => r.repeat_of !== undefined), 'a repeat is among them')
  assert.ok(journal.some((r) => r.tool === 'hit' && r.ok === false), 'a refused hit is among them')
  assert.equal(stalls(journal).length, 1, 'a stall record is among them')
  assert.ok(journal.some((r) => r.refusal === 'stalled'), 'a stalled refusal is among them')
  for (const r of journal) assert.equal(r.session, 'sess-xyz', JSON.stringify(r))
})

test('a call that shows something the journal never showed is new', async () => {
  const { spec } = specOf()
  const journal = []
  const first = await step(spec, journal, 'read', { path: 'src/a.mjs', to: 1 })
  assert.equal(first.records[0].new, true, 'an unseen key')
  const second = await step(spec, journal, 'read', { path: 'src/a.mjs', from: 2 })
  assert.equal(second.records[0].new, true, 'a seen key at an unseen line')
  const third = await step(spec, journal, 'grep', { pattern: 'use\\(NEEDLE' })
  assert.deepEqual(third.records[0].observed, [{ key: 'src/a.mjs', line: 2 }])
  assert.equal(third.records[0].new, false, 'every line it showed was shown before')
  const fourth = await step(spec, journal, 'refs', { symbol: 'NEEDLE' })
  assert.equal(fourth.records[0].new, true, 'docs/b.md was never shown')
})

test('a call that matches nothing is not new', async () => {
  const { spec } = specOf()
  const { records } = await handle(spec, [], 'grep', blank(0))
  assert.deepEqual([records[0].ok, records[0].new], [true, false])
})

test('a refused call is not new', async () => {
  const { spec } = specOf()
  for (const [name, args] of [['read', { path: 'nope.mjs' }], ['grep', { pattern: '\\bNEEDLE' }], ['read', { path: '../outside.txt' }]]) {
    const { records } = await handle(spec, [], name, args)
    assert.deepEqual([records[0].ok, records[0].new], [false, false], name + ' ' + JSON.stringify(args))
  }
})

test('an exact repeat in the same session is answered from the journal', async () => {
  const { spec } = specOf()
  const journal = []
  const first = (await step(spec, journal, 'grep', { pattern: 'NEEDLE' })).records[0]
  assert.equal(first.new, true)
  const again = await step(spec, journal, 'grep', { pattern: 'NEEDLE', page: 1 })
  const [rec] = again.records
  assert.equal(again.records.length, 1)
  assert.equal(rec.seq, 2)
  assert.equal(rec.repeat_of, 1)
  assert.equal(rec.new, false)
  for (const k of ['ok', 'total', 'page', 'pages', 'observed', 'keys']) assert.deepEqual(rec[k], first[k], 'copied: ' + k)
  assert.ok(again.text.startsWith('call 2: ') && again.text.includes('call 1'), 'the answer names its own call and the one it repeats: ' + again.text)
  const twice = await step(spec, journal, 'grep', { pattern: 'NEEDLE' })
  assert.equal(twice.records[0].repeat_of, 1, 'a repeat of a repeat names the first call')
})

test('a repeat copies a refusal and names the call that ran', async () => {
  const { spec } = specOf()
  const journal = []
  const refused = (await step(spec, journal, 'grep', { pattern: '\\bNEEDLE' })).records[0]
  const again = await step(spec, journal, 'grep', { pattern: '\\bNEEDLE' })
  const [rec] = again.records
  assert.deepEqual([rec.ok, rec.refusal, rec.detail, rec.repeat_of, rec.new], [false, refused.refusal, refused.detail, 1, false])
  assert.ok(again.text.includes('Refused (unsupported_syntax)'), again.text)
})

test('a repeat needs the same tool and the same arguments', async () => {
  const { spec } = specOf()
  const prior = [{ seq: 1, session: 's1', tool: 'grep', args: { symbol: 'NEEDLE' }, ok: true, observed: [], keys: [], new: false }]
  const otherTool = await handle(spec, prior, 'refs', { symbol: 'NEEDLE' })
  assert.equal(otherTool.records[0].repeat_of, undefined, 'the same arguments to another tool run')
  const journal = []
  await step(spec, journal, 'grep', { pattern: 'NEEDLE' })
  const otherArgs = await handle(spec, journal, 'grep', { pattern: 'prose' })
  assert.equal(otherArgs.records[0].repeat_of, undefined, 'other arguments run')
})

test('a renewed session runs a call its predecessor ran, and it is not new', async () => {
  const { spec } = specOf()
  const journal = []
  const first = (await step(spec, journal, 'grep', { pattern: 'NEEDLE' })).records[0]
  const out = await step(renewed(spec, 's2'), journal, 'grep', { pattern: 'NEEDLE' })
  const [rec] = out.records
  assert.equal(rec.repeat_of, undefined, 'ran again')
  assert.equal(rec.seq, 2)
  assert.equal(rec.session, 's2')
  assert.equal(rec.ok, true)
  assert.deepEqual(rec.observed, first.observed)
  assert.equal(rec.new, false, 'nothing in it is new to the journal')
})

test('a listing is new only for a key nobody showed', async () => {
  const { spec } = specOf()
  const journal = []
  await step(spec, journal, 'grep', { pattern: 'NEEDLE' })
  const seen = await step(spec, journal, 'files', { glob: 'src/*.mjs' })
  assert.deepEqual(seen.records[0].keys, ['src/a.mjs'])
  assert.equal(seen.records[0].new, false, 'src/a.mjs was shown by the grep')
  const unseen = await step(spec, journal, 'files', { glob: 'src/*.txt' })
  assert.deepEqual(unseen.records[0].keys, ['src/c.txt'])
  assert.equal(unseen.records[0].new, true)
})

// ------------------------------------------------------------------ hits

test('a path hit is recorded under its canonical key', async () => {
  const { spec } = specOf()
  const { text, records } = await handle(spec, [], 'hit', { path: 'src/a.mjs', line: 2, note: 'uses the needle' })
  assert.equal(records.length, 1)
  const [rec] = records
  assert.equal(rec.tool, 'hit')
  assert.equal(rec.ok, true)
  assert.deepEqual(rec.hit, { path: 'src/a.mjs', line: 2, note: 'uses the needle' })
  assert.equal(rec.seq, 1)
  assert.ok(text.trimEnd().endsWith('recorded'), text)
})

test('a hit path is canonicalised', async () => {
  const { spec } = specOf()
  const { records } = await handle(spec, [], 'hit', { path: './src/a.mjs', line: 1, note: 'n' })
  assert.equal(records[0].ok, true)
  assert.equal(records[0].hit.path, 'src/a.mjs')
})

test('a path hit outside the tree or without its line is refused bad_hit', async () => {
  const { spec } = specOf()
  for (const args of [
    { path: '../outside.txt', line: 1, note: 'n' },
    { path: 'src/gone.mjs', line: 1, note: 'n' },
    { path: 'src/a.mjs', note: 'n' },
  ]) {
    const { text, records } = await handle(spec, [], 'hit', args)
    assert.equal(records.length, 1, JSON.stringify(args))
    assert.deepEqual([records[0].tool, records[0].ok, records[0].refusal], ['hit', false, 'bad_hit'], JSON.stringify(args))
    assert.equal(records[0].hit, undefined)
    assert.equal(typeof text, 'string')
    assert.equal(text.trimEnd().endsWith('recorded'), false, text)
  }
})

test("a path hit outside the search's subject is refused while a read there is served", async () => {
  const { spec } = specOf({ subject: ['src'] })
  const read = await handle(spec, [], 'read', { path: 'docs/b.md' })
  assert.equal(read.records[0].ok, true)
  const outside = await handle(spec, [], 'hit', { path: 'docs/b.md', line: 1, note: 'n' })
  assert.deepEqual([outside.records[0].ok, outside.records[0].refusal], [false, 'bad_hit'])
  const inside = await handle(spec, [], 'hit', { path: 'src/a.mjs', line: 1, note: 'n' })
  assert.equal(inside.records[0].ok, true)
})

test('a commit hit is stored by its full sha', async () => {
  const { spec } = specOf({ tools: TOOLS_BY_DOMAIN.history })
  const ok = await handle(spec, [], 'hit', { commit: tree.sha.slice(0, 8), note: 'the first commit' })
  assert.equal(ok.records[0].ok, true)
  assert.deepEqual(ok.records[0].hit, { commit: tree.sha, note: 'the first commit' })
  const bad = await handle(spec, [], 'hit', { commit: 'nosuchcommit', note: 'n' })
  assert.deepEqual([bad.records[0].ok, bad.records[0].refusal], [false, 'bad_hit'])
})

test('a url hit is stored by its canonical url, with its candidate', async () => {
  const { spec } = specOf({ tools: TOOLS_BY_DOMAIN.web })
  const url = 'https://Example.com/lib/?utm_source=x#top'
  const candidate = { name: 'lib', source_url: 'https://example.com/lib', what_it_is: 'a library', latest_version: '1.2.3', license: 'MIT', maintenance: 'active', covers: 'parsing', does_not_cover: 'writing' }
  const full = await handle(spec, [], 'hit', { url, line: 3, note: 'the readme', candidate })
  assert.equal(full.records[0].ok, true)
  assert.deepEqual(full.records[0].hit, { url: canonicalUrl(url), line: 3, note: 'the readme', candidate })
  const bare = await handle(spec, [], 'hit', { url, note: 'the page' })
  assert.equal(bare.records[0].ok, true)
  assert.deepEqual(bare.records[0].hit, { url: canonicalUrl(url), note: 'the page' })
})

test('a hit names exactly one place and a note', async () => {
  const { spec } = specOf({ tools: [...TOOLS_BY_DOMAIN.repo, 'log', 'show', 'fetch'] })
  for (const args of [
    { path: 'src/a.mjs', line: 1, commit: tree.sha, note: 'n' },
    { path: 'src/a.mjs', line: 1, url: 'https://example.com/', note: 'n' },
    { commit: tree.sha, url: 'https://example.com/', note: 'n' },
    { note: 'n' },
    { path: 'src/a.mjs', line: 1 },
    { url: 'https://example.com/' },
    { commit: tree.sha },
  ]) {
    const { records } = await handle(spec, [], 'hit', args)
    assert.deepEqual([records[0].tool, records[0].ok, records[0].refusal], ['hit', false, 'bad_hit'], JSON.stringify(args))
  }
})

test("a label outside the search's labels is refused", async () => {
  const { spec } = specOf({ labels: ['guidance', 'ground:a'] })
  const bad = await handle(spec, [], 'hit', { path: 'src/a.mjs', line: 1, note: 'n', label: 'nope' })
  assert.deepEqual([bad.records[0].ok, bad.records[0].refusal], [false, 'bad_hit'])
  const good = await handle(spec, [], 'hit', { path: 'src/a.mjs', line: 1, note: 'n', label: 'ground:a' })
  assert.equal(good.records[0].ok, true)
  assert.equal(good.records[0].hit.label, 'ground:a')
})

// ------------------------------------------------------------------ the loop guard

test('the twelfth call in a row that shows nothing new stalls the session', async () => {
  const { spec } = specOf()
  const journal = []
  for (let i = 0; i < 11; i++) {
    const out = await step(spec, journal, 'grep', blank(i))
    assert.equal(out.records.length, 1, 'call ' + (i + 1) + ' does not stall')
  }
  assert.equal(stalls(journal).length, 0)
  const out = await step(spec, journal, 'grep', blank(11))
  assert.equal(out.records.length, 2)
  const [call, stall] = out.records
  assert.equal(call.tool, 'grep')
  assert.equal(call.new, false)
  assert.notEqual(call.refusal, 'stalled', 'the twelfth call itself ran')
  assert.deepEqual({ stalled: stall.stalled, window: stall.window, session: stall.session }, { stalled: true, window: 12, session: 's1' })
  assert.equal(stall.seq, call.seq + 1, 'the stall is numbered after the call')
  assert.ok(out.text.includes('stalled'), out.text)
})

test('one new call resets the window', async () => {
  const { spec } = specOf()
  const journal = []
  for (let i = 0; i < 11; i++) await step(spec, journal, 'grep', blank(i))
  const fresh = await step(spec, journal, 'grep', { pattern: 'NEEDLE' })
  assert.equal(fresh.records[0].new, true)
  for (let i = 11; i < 22; i++) await step(spec, journal, 'grep', blank(i))
  assert.equal(stalls(journal).length, 0, 'eleven since the new call')
  assert.equal(journal.some((r) => r.refusal === 'stalled'), false)
  await step(spec, journal, 'grep', blank(22))
  assert.equal(stalls(journal).length, 1, 'the twelfth since the new call stalls')
})

test('hits do not break or fill the window', async () => {
  const { spec } = specOf()
  const journal = []
  for (let i = 0; i < 11; i++) {
    await step(spec, journal, 'grep', blank(i))
    await step(spec, journal, 'hit', hitArgs(i))
  }
  for (let i = 11; i < 20; i++) await step(spec, journal, 'hit', hitArgs(i))
  assert.equal(stalls(journal).length, 0, 'hits do not fill the window')
  const out = await step(spec, journal, 'grep', blank(11))
  assert.equal(out.records.length, 2, 'hits did not break it either')
  assert.equal(stalls(journal).length, 1)
})

test('after a stall only hit is served', async () => {
  const { spec } = specOf()
  const journal = []
  for (let i = 0; i < 12; i++) await step(spec, journal, 'grep', blank(i))
  assert.equal(stalls(journal).length, 1)
  for (const [name, args] of [['grep', { pattern: 'NEEDLE' }], ['read', { path: 'src/c.txt' }], ['files', { glob: '**' }], ['grep', blank(0)]]) {
    const out = await step(spec, journal, name, args)
    assert.equal(out.records.length, 1, name)
    const [rec] = out.records
    assert.deepEqual([rec.tool, rec.ok, rec.refusal, rec.new], [name, false, 'stalled', false], name)
    assert.deepEqual([rec.observed, rec.keys], [[], []])
    assert.ok(out.text.includes('stalled: nothing new in the last 12 calls'), out.text)
  }
  const hit = await step(spec, journal, 'hit', hitArgs(0))
  assert.equal(hit.records[0].ok, true)
  assert.ok(hit.text.trimEnd().endsWith('recorded'), hit.text)
  assert.equal(stalls(journal).length, 1, 'the stall is journaled once')
})

test('a call refused for the stall is not a repeat source', async () => {
  const { spec } = specOf()
  const ran = (await handle(renewed(spec, 'other'), [], 'grep', { pattern: 'NEEDLE' })).records[0]
  const prior = [{ seq: 1, session: 's1', tool: 'grep', args: ran.args, ok: false, refusal: 'stalled', detail: 'stalled', observed: [], keys: [], new: false }]
  const out = await handle(spec, prior, 'grep', { pattern: 'NEEDLE' })
  assert.equal(out.records[0].repeat_of, undefined)
  assert.equal(out.records[0].ok, true, 'it ran')
  assert.ok(out.records[0].observed.length > 0)
})

test('a resumed session keeps its window across a server restart', async () => {
  const { spec } = specOf()
  await session(spec, Array.from({ length: 11 }, (_, i) => toolCall(i + 1, 'grep', blank(i))))
  assert.equal(stalls(callLog(spec.calls)).length, 0)
  await session(spec, [toolCall(1, 'grep', blank(11))])
  const log = callLog(spec.calls)
  assert.equal(stalls(log).length, 1)
  assert.equal(log.at(-1).stalled, true)
  await session(spec, [toolCall(1, 'grep', { pattern: 'NEEDLE' })])
  assert.equal(callLog(spec.calls).at(-1).refusal, 'stalled', 'still stalled after another restart')
})

test('a new session starts a fresh window', async () => {
  const { spec } = specOf()
  const journal = []
  for (let i = 0; i < 12; i++) await step(spec, journal, 'grep', blank(i))
  assert.equal(stalls(journal).length, 1)
  const next = renewed(spec, 's2')
  for (let i = 0; i < 11; i++) {
    const out = await step(next, journal, 'grep', blank(100 + i))
    assert.equal(out.records.length, 1)
    assert.notEqual(out.records[0].refusal, 'stalled', 'call ' + (i + 1) + ' of the new session')
  }
  const ran = await step(next, journal, 'grep', { pattern: 'NEEDLE' })
  assert.equal(ran.records[0].ok, true)
  assert.equal(stalls(journal).length, 1, 'the new session has not stalled')
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
  assert.deepEqual(replyTo(replies, 1).reply.result.tools.map((t) => t.name).sort(), [...spec.tools, 'hit'].sort())
  assert.deepEqual(replyTo(replies, 2).reply.result, {})
  assert.equal(replies.length, 4, 'a notification and a torn line get no reply')
})

test('every call is in the call log before its answer leaves, numbered from 1', async () => {
  const { spec } = specOf()
  const replies = await session(spec, [
    toolCall(10, 'grep', { pattern: 'NEEDLE' }),
    toolCall(11, 'read', { path: 'src/a.mjs' }),
    toolCall(12, 'read', { path: 'nope.mjs' }),
  ])
  const log = callLog(spec.calls)
  assert.deepEqual(log.map((c) => c.seq), [1, 2, 3])
  assert.deepEqual(log.map((c) => c.tool), ['grep', 'read', 'read'])
  for (const c of log) assert.equal(c.session, 's1')
  for (const [i, id] of [10, 11, 12].entries()) assert.ok(replyTo(replies, id).logged.includes(i + 1), 'call ' + (i + 1) + ' was logged before answer ' + id)
  assert.equal(replyTo(replies, 10).reply.result.isError, false)
  assert.equal(replyTo(replies, 12).reply.result.isError, true, 'a refusal is an error result')
  assert.ok(replyTo(replies, 10).reply.result.content[0].text.includes('src/a.mjs'))
  for (const [i, id] of [10, 11, 12].entries()) assert.ok(replyTo(replies, id).reply.result.content[0].text.startsWith('call ' + (i + 1) + ': '), 'answer ' + id + ' names its call')
})

test('the stall record is in the journal before the answer leaves', async () => {
  const { spec } = specOf()
  const replies = await session(spec, Array.from({ length: 12 }, (_, i) => toolCall(i + 1, 'grep', blank(i))))
  const log = callLog(spec.calls)
  assert.equal(log.length, 13)
  assert.deepEqual(log.map((c) => c.seq), Array.from({ length: 13 }, (_, i) => i + 1))
  assert.equal(log[11].tool, 'grep', 'the call first')
  assert.equal(log[12].stalled, true, 'then the stall')
  assert.ok(replyTo(replies, 12).logged.includes(13), 'both were journaled before answer 12 left')
  assert.ok(replyTo(replies, 12).reply.result.content[0].text.includes('stalled'))
  for (const id of [1, 11]) assert.equal(replyTo(replies, id).logged.includes(13), false)
})

test('a hit served over the protocol is journaled and answered recorded', async () => {
  const { spec } = specOf()
  const replies = await session(spec, [toolCall(1, 'hit', hitArgs(0)), toolCall(2, 'hit', { note: 'nowhere' })])
  assert.deepEqual(callLog(spec.calls).map((c) => [c.seq, c.tool, c.ok]), [[1, 'hit', true], [2, 'hit', false]])
  assert.equal(replyTo(replies, 1).reply.result.isError, false)
  assert.ok(replyTo(replies, 1).reply.result.content[0].text.trimEnd().endsWith('recorded'))
  assert.equal(replyTo(replies, 2).reply.result.isError, true)
})

test('calls that arrive together are run one at a time, in order', async () => {
  const { spec } = specOf()
  await session(spec, [toolCall(1, 'grep', { pattern: 'NEEDLE' }), toolCall(2, 'grep', { pattern: 'NEEDLE' })])
  const log = callLog(spec.calls)
  assert.deepEqual(log.map((c) => [c.seq, c.repeat_of]), [[1, undefined], [2, 1]], 'the second saw the first')
})

test("a later server on the same search numbers its calls after the log's last, and knows its repeats", async () => {
  const { spec } = specOf()
  await session(spec, [toolCall(1, 'grep', { pattern: 'NEEDLE' })])
  await session(spec, [toolCall(1, 'grep', { pattern: 'NEEDLE' }), toolCall(2, 'files', { glob: '**' })])
  assert.deepEqual(callLog(spec.calls).map((c) => [c.seq, c.repeat_of]), [[1, undefined], [2, 1], [3, undefined]])
})

test('a torn last line of the call log is skipped, and numbering goes on after the last whole record', async () => {
  const { spec } = specOf()
  await session(spec, [toolCall(1, 'grep', { pattern: 'NEEDLE' })])
  appendFileSync(spec.calls, '{"seq":2,"tool":"gr')
  await session(spec, [toolCall(1, 'files', { glob: '**' })])
  const whole = readFileSync(spec.calls, 'utf8').split('\n').filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
  assert.deepEqual(whole.map((c) => c.seq), [1, 2])
  assert.equal(whole[1].tool, 'files')
})

test('a call that cannot be journaled is answered with an error, never left hanging', async () => {
  const { run, spec } = specOf()
  const blocker = join(run, 'blocker')
  mkdirSync(run, { recursive: true })
  writeFileSync(blocker, 'a file where the log directory would go')
  const input = new PassThrough()
  const sent = []
  const output = new Writable({ write(chunk, _enc, done) { sent.push(...String(chunk).split('\n').filter((x) => x.trim()).map((x) => JSON.parse(x))); done() } })
  const served = serve({ ...spec, calls: join(blocker, 'calls.jsonl') }, { input, output })
  input.write(toolCall(5, 'grep', { pattern: 'NEEDLE' }) + '\n')
  input.end()
  await served
  assert.equal(sent.length, 1)
  assert.equal(sent[0].id, 5)
  assert.equal(sent[0].error.code, -32603)
  assert.equal(sent[0].result, undefined, 'no result leaves for a call that is not in the log')
})

// ------------------------------------------------------------------ the CLI

test('the CLI serves the spec its --spec names over stdio, and refuses to start without one', async () => {
  const { run, spec } = specOf()
  const config = JSON.parse(readFileSync(mcpConfigFor(run, 'probe:x', spec), 'utf8')).mcpServers[SERVER_NAME]
  const child = spawn(config.command, config.args, { windowsHide: true })
  let out = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d) => { out += d })
  child.stdin.end([rpc(0, 'initialize', { protocolVersion: '2025-06-18' }), toolCall(1, 'refs', { symbol: 'NEEDLE' })].join('\n') + '\n')
  const code = await new Promise((r) => child.on('close', r))
  assert.equal(code, 0)
  const replies = out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  assert.ok(replies.find((r) => r.id === 1).result.content[0].text.includes('src/a.mjs'))
  assert.deepEqual(callLog(spec.calls).map((c) => [c.tool, c.session]), [['refs', 's1']])

  const bare = spawn(process.execPath, [SERVER], { windowsHide: true })
  bare.stdin.end()
  assert.equal(await new Promise((r) => bare.on('close', r)), 2)
})
