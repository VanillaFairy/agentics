// test/evidence.test.mjs — the evidence item store: what check-item refuses, what record-items
// fills in and writes (or refuses to write), the project-wide seq, and the raw return kept
// beside the items it came from.
//
// Design: docs/DESIGN.md#evidence.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ITEM_KINDS, REQUIRED, RETURN_KINDS, checkItem, itemId, liveItems, recordItems, recordRaw, snapshotSpec,
} from '../lib/evidence.mjs'
import { appendProject, digestEntries, readProjectLog } from '../lib/ledger.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'
import { hashSpec } from '../lib/spec.mjs'
import {
  evidenceItemsPath, evidenceReturnsDir, evidenceSnapshotsDir, projectStateDir,
} from '../lib/store.mjs'

const CLI = fileURLToPath(new URL('../lib/evidence.mjs', import.meta.url))
const LEDGER_URL = new URL('../lib/ledger.mjs', import.meta.url).href
const NOW = new Date('2026-09-26T10:00:00Z')
const TODAY = NOW.toISOString().slice(0, 10)
const SHA = 'a'.repeat(40)
const RETURN = '20260926-100000-survey'

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

/** `n` numbered lines, so the text of any span is computable from its range. */
const numbered = (n, word = 'line') => Array.from({ length: n }, (_, i) => word + ' ' + (i + 1)).join('\n') + '\n'

function put(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, ...path.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
}

const bare = () => mkdtempSync(join(tmpdir(), 'agentics-evidence-'))

function gitRepo(files = { 'src/a.js': numbered(30) }) {
  const dir = bare()
  git(dir, 'init', '-q', '.')
  git(dir, 'config', 'user.email', 't@t')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'core.autocrlf', 'false')
  put(dir, files)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return dir
}

const base = {
  question: 'how are configs loaded', topic: 'loader', ground: ['src'],
  claim: 'the loader reads src/a.js', spans: [], queries: [], sources: [], rests_on: [],
  from_return: RETURN,
}

/** One valid item of every kind, each carrying exactly the anchors its kind requires. */
const VALID = {
  behaviour: { ...base, kind: 'behaviour', spans: [{ path: 'src/a.js', start: 2, end: 4, at: SHA }] },
  absence: { ...base, kind: 'absence', queries: [{ pattern: 'retry', scope: ['src'], result: [] }] },
  enumeration: { ...base, kind: 'enumeration', queries: [{ pattern: 'line 1', scope: ['src'], result: [{ path: 'src/a.js', text: 'line 1' }] }] },
  relation: {
    ...base, kind: 'relation',
    spans: [{ path: 'src/a.js', start: 2, end: 4, at: 'snapshot:0badc0de' }],
    queries: [{ pattern: 'line 2', scope: [], result: [{ path: 'src/a.js', text: 'line 2' }] }],
  },
  external: { ...base, kind: 'external', sources: [{ url: 'https://nodejs.org/api/fs.html', version: '24.1.0', retrieved: '2026-09-20' }] },
  derived: { ...base, kind: 'derived', rests_on: ['I0badc0de'] },
}

/** A fresh item for recording: `at` and `retrieved` left for the recorder to fill. */
const fresh = (over = {}) => ({
  ...base, kind: 'behaviour', spans: [{ path: 'src/a.js', start: 10, end: 14, at: '' }], ...over,
})

const storedLines = (repo) => readProjectLog(repo, 'items').entries

// ------------------------------------------------------------------ check-item

test('a valid item of every kind passes check-item', () => {
  assert.deepEqual([...ITEM_KINDS].sort(), Object.keys(REQUIRED).sort(), 'every kind states its anchors')
  for (const kind of ITEM_KINDS) assert.deepEqual(checkItem(VALID[kind]), [], kind)
})

test('check-item refuses each kind without each anchor it requires, naming the anchor', () => {
  for (const kind of ITEM_KINDS) {
    for (const anchor of REQUIRED[kind]) {
      const problems = checkItem({ ...VALID[kind], [anchor]: [] })
      assert.ok(problems.length > 0, kind + ' without ' + anchor + ' passed')
      assert.ok(problems.some((p) => p.includes(anchor) && p.includes(kind)),
        kind + ' without ' + anchor + ': ' + JSON.stringify(problems))
    }
  }
})

test('an absence whose query found something is refused', () => {
  const found = { ...VALID.absence, queries: [{ pattern: 'retry', scope: ['src'], result: [{ path: 'src/a.js', text: 'retry()' }] }] }
  assert.ok(checkItem(found).some((p) => /absence/.test(p)), JSON.stringify(checkItem(found)))
})

test('each malformed field is refused on its own', () => {
  const span = (over) => ({ ...VALID.behaviour, spans: [{ ...VALID.behaviour.spans[0], ...over }] })
  const query = (over) => ({ ...VALID.enumeration, queries: [{ ...VALID.enumeration.queries[0], ...over }] })
  const source = (over) => ({ ...VALID.external, sources: [{ ...VALID.external.sources[0], ...over }] })
  const cases = {
    'unknown kind': { ...VALID.behaviour, kind: 'opinion' },
    'empty claim': { ...VALID.behaviour, claim: ' ' },
    'empty topic': { ...VALID.behaviour, topic: '' },
    'empty question': { ...VALID.behaviour, question: '' },
    'ground that climbs': { ...VALID.behaviour, ground: ['../elsewhere'] },
    'span starting at 0': span({ start: 0 }),
    'span ending before it starts': span({ start: 5, end: 4 }),
    'span with a fractional line': span({ end: 4.5 }),
    'span path that climbs': span({ path: '../x.js' }),
    'span path that is absolute': span({ path: '/etc/passwd' }),
    'span with no at': span({ at: '' }),
    'span at a ref rather than a sha': span({ at: 'HEAD' }),
    'query with no pattern': query({ pattern: '' }),
    'query scope that climbs': query({ scope: ['../'] }),
    'query result that is not a list': query({ result: 'src/a.js' }),
    'source with no url': source({ url: '' }),
    'source retrieved on no ISO date': source({ retrieved: '26-09-2026' }),
    'rests_on naming no item': { ...VALID.derived, rests_on: ['the base claim'] },
    'anchors that are not lists': { ...VALID.behaviour, queries: null },
    'detail that is not an object': { ...VALID.behaviour, detail: 'ambiguity' },
  }
  for (const [name, item] of Object.entries(cases)) {
    assert.ok(checkItem(item).length > 0, name + ' passed check-item')
  }
})

test('an item id is its question, topic and claim, and nothing about its anchors', () => {
  const expected = 'I' + fnv1a(canonical({ question: base.question, topic: base.topic, claim: base.claim }))
  assert.equal(itemId(VALID.behaviour), expected)
  assert.equal(itemId(VALID.external), expected, 'kind and anchors are not identity')
  assert.notEqual(itemId({ ...VALID.behaviour, claim: 'another claim' }), expected)
  assert.notEqual(itemId({ ...VALID.behaviour, topic: 'another-topic' }), expected)
})

// ------------------------------------------------------------------ record-items

test('record-items fills what only a script can observe: the commit, the search result, the date', () => {
  const repo = gitRepo()
  const head = git(repo, 'rev-parse', 'HEAD')
  const out = recordItems(repo, RETURN, [
    fresh(),
    fresh({ kind: 'enumeration', claim: 'the tens', spans: [], queries: [{ pattern: 'line 1[0-9]', scope: ['src'] }] }),
    fresh({ kind: 'external', claim: 'fs is stable', spans: [], sources: [{ url: 'https://nodejs.org/api/fs.html', version: '24.1.0', retrieved: '' }] }),
  ], { now: NOW })
  assert.equal(out.ok, true, JSON.stringify(out))

  const stored = storedLines(repo)
  assert.deepEqual(stored.map((l) => l.kind), ['item', 'item', 'item'])
  assert.deepEqual(stored.map((l) => l.item.id), out.ids)
  assert.deepEqual(out.ids, stored.map((l) => itemId(l.item)))
  assert.ok(stored.every((l) => l.item.from_return === RETURN))

  assert.deepEqual(stored[0].item.spans, [{ path: 'src/a.js', start: 10, end: 14, at: head }])

  const tens = numbered(30).split('\n').filter((l) => /line 1[0-9]/.test(l))
    .map((text) => ({ path: 'src/a.js', text }))
  const byKey = (r) => r.path + '\0' + r.text
  assert.deepEqual(stored[1].item.queries[0].result.map(byKey).sort(), tens.map(byKey).sort())

  assert.equal(stored[2].item.sources[0].retrieved, TODAY)
})

test('a span on a file edited since HEAD is anchored at a snapshot of the text it was read from', () => {
  const repo = gitRepo()
  const edited = numbered(30).replace('line 12\n', 'line twelve\n')
  put(repo, { 'src/a.js': edited })

  const out = recordItems(repo, RETURN, [fresh()], { now: NOW })
  assert.equal(out.ok, true, JSON.stringify(out))
  const [{ item }] = storedLines(repo)
  assert.equal(item.spans[0].at, 'snapshot:' + hashSpec(edited))
  assert.equal(readFileSync(join(evidenceSnapshotsDir(repo), hashSpec(edited) + '.txt'), 'utf8'), edited)
})

test('one invalid item refuses the whole batch, and nothing is written', () => {
  const repo = gitRepo()
  const out = recordItems(repo, RETURN, [fresh(), fresh({ claim: 'no anchor', spans: [] })], { now: NOW })
  assert.equal(out.ok, false)
  assert.deepEqual(out.refused.map((r) => r.index), [1])
  assert.ok(out.refused[0].problems.some((p) => p.includes('spans')))
  assert.equal(existsSync(evidenceItemsPath(repo)), false)
})

test('an absence the re-run search contradicts is refused at record time, naming what it found', () => {
  const repo = gitRepo()
  const out = recordItems(repo, RETURN, [
    fresh({ kind: 'absence', claim: 'nothing says line 7', spans: [], queries: [{ pattern: 'line 7$', scope: ['src'] }] }),
  ], { now: NOW })
  assert.equal(out.ok, false)
  assert.ok(out.refused[0].problems.some((p) => /absence/.test(p) && /1 line/.test(p)), JSON.stringify(out.refused))

  const absent = recordItems(repo, RETURN, [
    fresh({ kind: 'absence', claim: 'nothing retries', spans: [], queries: [{ pattern: 'retry', scope: ['src'] }] }),
  ], { now: NOW })
  assert.equal(absent.ok, true, JSON.stringify(absent))
  assert.deepEqual(storedLines(repo)[0].item.queries[0].result, [])
})

test('a span past the end of its file, or on a file that is not there, is refused', () => {
  const repo = gitRepo()
  const past = recordItems(repo, RETURN, [fresh({ spans: [{ path: 'src/a.js', start: 29, end: 31, at: '' }] })], { now: NOW })
  assert.equal(past.ok, false)
  assert.ok(past.refused[0].problems.some((p) => p.includes('src/a.js') && p.includes('30')), JSON.stringify(past.refused))

  const gone = recordItems(repo, RETURN, [fresh({ spans: [{ path: 'src/nope.js', start: 1, end: 1, at: '' }] })], { now: NOW })
  assert.equal(gone.ok, false)
  assert.ok(gone.refused[0].problems.some((p) => p.includes('src/nope.js')))
})

test('a snapshot anchor must name a snapshot the store holds', () => {
  const repo = gitRepo()
  const unknown = recordItems(repo, RETURN, [fresh({ spans: [{ path: 'src/a.js', start: 1, end: 2, at: 'snapshot:deadbeef' }] })], { now: NOW })
  assert.equal(unknown.ok, false)
  assert.ok(unknown.refused[0].problems.some((p) => p.includes('snapshot:deadbeef')))

  const at = snapshotSpec(repo, numbered(30))
  const known = recordItems(repo, RETURN, [fresh({ spans: [{ path: 'src/a.js', start: 1, end: 2, at }] })], { now: NOW })
  assert.equal(known.ok, true, JSON.stringify(known))
})

test('a new revision of the same claim wins by seq', () => {
  const repo = gitRepo()
  const first = recordItems(repo, RETURN, [fresh()], { now: NOW })
  const second = recordItems(repo, RETURN, [fresh({ spans: [{ path: 'src/a.js', start: 20, end: 22, at: '' }] })], { now: NOW })
  assert.deepEqual(second.ids, first.ids, 'same question, topic and claim: same item')

  const live = liveItems(repo)
  assert.equal(live.size, 1)
  const item = live.get(first.ids[0])
  assert.equal(item.spans[0].start, 20)
  assert.ok(item.seq > first.seqs[0])
})

test('snapshots normalise line endings and are named by the spec hash', () => {
  const repo = bare()
  const lf = 'a\nb\n'
  const id = snapshotSpec(repo, 'a\r\nb\r\n')
  assert.equal(id, 'snapshot:' + hashSpec(lf))
  assert.equal(snapshotSpec(repo, lf), id, 'the same text in either ending is one snapshot')
  assert.equal(readFileSync(join(evidenceSnapshotsDir(repo), hashSpec(lf) + '.txt'), 'utf8'), lf)
})

// ------------------------------------------------------------------ the project log

test('appendProject mints one project-wide seq under the project lock', () => {
  const repo = bare()
  const a = appendProject(repo, 'items', [{ kind: 'judged', id: 'I00000001' }, { kind: 'judged', id: 'I00000002' }])
  const b = appendProject(repo, 'items', { kind: 'judged', id: 'I00000003', seq: 999 })
  assert.deepEqual([a.seqs, b.seqs], [[1, 2], [3]], 'a seq the caller supplies is overwritten')
  assert.deepEqual(storedLines(repo).map((l) => l.seq), [1, 2, 3])
  assert.equal(existsSync(join(projectStateDir(repo), '.lock')), false)
  assert.equal(readFileSync(join(projectStateDir(repo), 'seq'), 'utf8'), '3')
})

test('a lost project counter is rebuilt from the highest seq on disk', () => {
  const repo = bare()
  appendProject(repo, 'items', [{ kind: 'judged', id: 'I00000001' }, { kind: 'judged', id: 'I00000002' }])
  rmSync(join(projectStateDir(repo), 'seq'))
  assert.deepEqual(appendProject(repo, 'items', { kind: 'judged', id: 'I00000003' }).seqs, [3])
})

test('appendProject refuses an unknown log, a kindless entry and a digest mismatch, writing nothing', () => {
  const repo = bare()
  assert.match(appendProject(repo, 'nodes', { kind: 'x' }).error, /unknown project log/)
  const kindless = appendProject(repo, 'items', [{ kind: 'judged' }, { id: 'x' }])
  assert.equal(kindless.ok, false)
  assert.match(kindless.error, /entry 1/)
  const entries = [{ kind: 'judged', id: 'I00000001' }]
  assert.equal(appendProject(repo, 'items', entries, { digest: 'deadbeef' }).ok, false)
  assert.equal(storedLines(repo).length, 0)
  assert.equal(appendProject(repo, 'items', entries, { digest: digestEntries(entries) }).ok, true)
})

test('concurrent project writers never mint the same seq', async () => {
  const repo = bare()
  const runs = Array.from({ length: 6 }, (_, i) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', `
      import(${JSON.stringify(LEDGER_URL)}).then((m) => {
        for (let k = 0; k < 10; k++) m.appendProject(${JSON.stringify(repo)}, 'items', { kind: 'judged', id: 'I0000000${i}' })
      })`])
    child.on('close', resolve)
  }))
  await Promise.all(runs)
  const seqs = storedLines(repo).map((l) => l.seq)
  assert.equal(seqs.length, 60)
  assert.equal(new Set(seqs).size, 60)
  assert.equal(readFileSync(join(projectStateDir(repo), 'seq'), 'utf8'), '60')
})

// ------------------------------------------------------------------ raw returns

test('a raw return is written verbatim beside the items extracted from it', () => {
  const repo = gitRepo()
  const payload = { question: 'how are configs loaded', items: [fresh()] }
  const out = recordRaw(repo, 'survey', payload, { now: NOW })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.match(out.return, /^\d{8}-\d{6}-survey$/)
  assert.deepEqual(JSON.parse(readFileSync(join(evidenceReturnsDir(repo), out.return + '.json'), 'utf8')), payload)
  assert.deepEqual(out.ids, [itemId(payload.items[0])])
  assert.equal(liveItems(repo).get(out.ids[0]).from_return, out.return)

  const again = recordRaw(repo, 'survey', payload, { now: NOW })
  assert.equal(again.return, out.return.replace(/-survey$/, '-2-survey'), 'a same-second return takes -2 before the kind')
})

test('an unknown kind or a payload with no items is a typed refusal', () => {
  const repo = gitRepo()
  for (const kind of RETURN_KINDS) assert.notEqual(recordRaw(repo, kind, { items: 'x' }).error.kind, 'bad_kind')
  assert.equal(recordRaw(repo, 'sketch', { items: [fresh()] }).error.kind, 'bad_kind')
  assert.equal(recordRaw(repo, 'survey', { items: 'x' }).error.kind, 'bad_payload')
  assert.equal(recordRaw(repo, 'survey', { items: [] }).error.kind, 'bad_payload')
})

test('an approach draft is kept as a raw return with no items of its own', () => {
  const repo = gitRepo()
  assert.ok(RETURN_KINDS.includes('approach'))
  const draft = { approach: 'minimal-change', shape: 'one module', contracts: [], cites: [], risks: ['none named'] }
  const out = recordRaw(repo, 'approach', draft, { now: NOW })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.match(out.return, /^\d{8}-\d{6}-approach$/)
  assert.deepEqual(out.ids, [])
  assert.deepEqual(JSON.parse(readFileSync(join(evidenceReturnsDir(repo), out.return + '.json'), 'utf8')), draft)
  assert.equal(liveItems(repo).size, 0, 'a draft adds nothing to the pool')
  assert.equal(recordRaw(repo, 'approach', { ...draft, items: [] }, { now: NOW }).ok, true)
  assert.equal(recordRaw(repo, 'approach', { ...draft, items: 'x' }).error.kind, 'bad_payload')
  assert.equal(recordRaw(repo, 'survey', draft).error.kind, 'bad_payload', 'only a draft may carry no items')
})

test('a refused return leaves no raw file behind', () => {
  const repo = gitRepo()
  const out = recordRaw(repo, 'survey', { items: [fresh({ spans: [] })] }, { now: NOW })
  assert.equal(out.ok, false)
  assert.equal(out.refused.length, 1)
  const dir = evidenceReturnsDir(repo)
  assert.ok(!existsSync(dir) || readdirSync(dir).length === 0)
})

test('the CLI records a digest-checked token and prints an envelope, refusals included', () => {
  const repo = gitRepo()
  const payload = { items: [fresh()] }
  const token = Buffer.from(JSON.stringify(payload)).toString('base64')
  const run = (digest) => spawnSync(process.execPath,
    [CLI, 'record', '--repo', repo, '--kind', 'survey', '--digest', digest, '--b64', token], { encoding: 'utf8' })

  const good = run(fnv1a(canonical(payload)))
  assert.equal(good.status, 0, good.stdout + good.stderr)
  const out = JSON.parse(good.stdout)
  assert.equal(out.payload_digest, fnv1a(canonical(out.payload)))
  assert.equal(out.payload.ok, true)
  assert.deepEqual(out.payload.ids, [itemId(payload.items[0])])

  const linesBefore = storedLines(repo).length
  const returnsBefore = readdirSync(evidenceReturnsDir(repo)).length
  assert.equal(returnsBefore, 1)

  const bad = run('deadbeef')
  assert.equal(bad.status, 0, 'a damaged token is a typed refusal, not a failed program')
  assert.equal(JSON.parse(bad.stdout).payload.error.kind, 'digest_mismatch')
  assert.equal(storedLines(repo).length, linesBefore, 'the damaged token appended no item line')
  assert.equal(readdirSync(evidenceReturnsDir(repo)).length, returnsBefore, 'the damaged token kept no raw return')
})

// ------------------------------------------------------------------ where the store lives

test('a record made from a linked worktree lands in the main checkout', () => {
  const repo = gitRepo()
  const wt = join(bare(), 'wt')
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'side')
  const out = recordItems(wt, RETURN, [fresh()], { now: NOW })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.ok(liveItems(repo).has(out.ids[0]))
  assert.equal(existsSync(join(wt, '.agentics')), false)
})

test('the store ignores itself: recording leaves git status clean', () => {
  const repo = gitRepo()
  recordRaw(repo, 'survey', { items: [fresh()] }, { now: NOW })
  assert.equal(git(repo, 'status', '--porcelain'), '')
})

// ------------------------------------------------------------------ audit gaps: what the recorder fills

test('an untracked file and a staged edit are anchored at a snapshot of their text, never at HEAD', () => {
  const repo = gitRepo()
  const untracked = numbered(12, 'new')
  const staged = numbered(30).replace('line 3\n', 'line three\n')
  put(repo, { 'src/u.js': untracked, 'src/a.js': staged })
  git(repo, 'add', 'src/a.js')
  const out = recordItems(repo, RETURN, [
    fresh({ claim: 'untracked', spans: [{ path: 'src/u.js', start: 1, end: 2, at: '' }] }),
    fresh({ claim: 'staged' }),
  ], { now: NOW })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual(storedLines(repo).map((l) => l.item.spans[0].at),
    ['snapshot:' + hashSpec(untracked), 'snapshot:' + hashSpec(staged)])
})

test('a CRLF working copy of an LF commit under core.autocrlf reads as unchanged, so it anchors at HEAD', () => {
  const repo = gitRepo()
  git(repo, 'config', 'core.autocrlf', 'true')
  put(repo, { 'src/a.js': numbered(30).replace(/\n/g, '\r\n') })
  const out = recordItems(repo, RETURN, [fresh()], { now: NOW })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(storedLines(repo)[0].item.spans[0].at, git(repo, 'rev-parse', 'HEAD'))
})

test('an at the judge supplied is kept as given', () => {
  const repo = gitRepo()
  const head = git(repo, 'rev-parse', 'HEAD')
  const snap = snapshotSpec(repo, numbered(30))
  put(repo, { 'src/a.js': numbered(30).replace('line 1\n', 'line one\n') })
  const out = recordItems(repo, RETURN, [
    fresh({ claim: 'at head', spans: [{ path: 'src/a.js', start: 2, end: 3, at: head }] }),
    fresh({ claim: 'at a snapshot', spans: [{ path: 'src/a.js', start: 2, end: 3, at: snap }] }),
  ], { now: NOW })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual(storedLines(repo).map((l) => l.item.spans[0].at), [head, snap])
})

test('a query result is the re-run search, de-duplicated on {path, text}, whatever the judge wrote', () => {
  const repo = gitRepo({ 'src/a.js': 'dup\ndup\nkey: a:b\n' })
  const out = recordItems(repo, RETURN, [
    fresh({ kind: 'enumeration', claim: 'dups', spans: [], queries: [{ pattern: 'dup', scope: ['src'], result: [{ path: 'src/elsewhere.js', text: 'invented' }] }] }),
    fresh({ kind: 'enumeration', claim: 'colons', spans: [], queries: [{ pattern: 'a:b', scope: ['src'] }] }),
  ], { now: NOW })
  assert.equal(out.ok, true, JSON.stringify(out))
  const [dups, colons] = storedLines(repo).map((l) => l.item.queries[0].result)
  assert.deepEqual(dups, [{ path: 'src/a.js', text: 'dup' }])
  assert.deepEqual(colons, [{ path: 'src/a.js', text: 'key: a:b' }])
})

test('an empty retrieved is the UTC date of now, even where the local date has already turned', () => {
  const repo = gitRepo()
  const zone = process.env.TZ
  process.env.TZ = 'Pacific/Kiritimati'
  try {
    const now = new Date('2026-09-26T10:30:00Z')
    const utc = now.toISOString().slice(0, 10)
    assert.notEqual(now.toLocaleDateString('sv'), utc, 'the fixture straddles midnight in UTC+14')
    const out = recordItems(repo, RETURN, [
      fresh({ kind: 'external', spans: [], sources: [{ url: 'https://example.org/spec', version: '', retrieved: '' }] }),
    ], { now })
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(storedLines(repo)[0].item.sources[0].retrieved, utc)
  } finally {
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  }
})

test('ground and span paths are stored repository-relative and forward-slashed', () => {
  const repo = gitRepo()
  const out = recordItems(repo, RETURN, [
    fresh({ ground: ['src\\sub', './src/'], spans: [{ path: 'src\\a.js', start: 1, end: 2, at: '' }] }),
  ], { now: NOW })
  assert.equal(out.ok, true, JSON.stringify(out))
  const { item } = storedLines(repo)[0]
  assert.deepEqual(item.ground, ['src/sub', 'src'])
  assert.equal(item.spans[0].path, 'src/a.js')
})

test('an absolute or climbing ground, span path or query scope refuses its item', () => {
  const repo = gitRepo()
  const out = recordItems(repo, RETURN, [
    fresh({ claim: 'ground', ground: ['C:\\work\\x'] }),
    fresh({ claim: 'span', spans: [{ path: '/etc/passwd', start: 1, end: 1, at: '' }] }),
    fresh({ claim: 'scope', kind: 'absence', spans: [], queries: [{ pattern: 'zzz', scope: ['..\\up'] }] }),
  ], { now: NOW })
  assert.equal(out.ok, false)
  assert.deepEqual(out.refused.map((r) => r.index), [0, 1, 2])
  for (const r of out.refused) {
    assert.ok(r.problems.some((p) => p.includes('repository-relative')), JSON.stringify(r))
  }
})

test('a record made from a linked worktree reads the main checkout, not the worktree', () => {
  const repo = gitRepo()
  const wt = join(bare(), 'wt')
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'side')
  put(wt, { 'src/a.js': numbered(5) })
  const out = recordItems(wt, RETURN, [fresh({ spans: [{ path: 'src/a.js', start: 20, end: 22, at: '' }] })], { now: NOW })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(storedLines(repo)[0].item.spans[0].at, git(repo, 'rev-parse', 'HEAD'))
})

// ------------------------------------------------------------------ audit gaps: the store and its returns

test('liveItems takes the highest seq whatever the line order, and skips every line that is not an item', () => {
  const repo = bare()
  const id = itemId(VALID.behaviour)
  const rev = (start, seq) => JSON.stringify({ kind: 'item', item: { ...VALID.behaviour, id, spans: [{ ...VALID.behaviour.spans[0], start, end: start }] }, seq })
  const file = evidenceItemsPath(repo)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, [
    rev(9, 9),
    rev(3, 3),
    '{"kind":"item","item":',
    JSON.stringify({ kind: 'judged', id, verdict: 'holds', at: SHA, seq: 12 }),
    JSON.stringify({ kind: 'item', item: { ...VALID.behaviour, id: 'not-an-id', claim: 'other' }, seq: 20 }),
    JSON.stringify({ kind: 'item', item: { ...VALID.behaviour, claim: 'no id' }, seq: 21 }),
  ].join('\n') + '\n')
  const live = liveItems(repo)
  assert.deepEqual([...live.keys()], [id])
  assert.equal(live.get(id).spans[0].start, 9)
  assert.equal(live.get(id).seq, 9)
})

test('an unparseable project counter is rebuilt from the log, never reset to 0', () => {
  const repo = bare()
  appendProject(repo, 'items', [{ kind: 'judged', id: 'I00000001' }, { kind: 'judged', id: 'I00000002' }])
  writeFileSync(join(projectStateDir(repo), 'seq'), 'not a number')
  assert.deepEqual(appendProject(repo, 'items', { kind: 'judged', id: 'I00000003' }).seqs, [3])
})

test('a refused batch moves no counter', () => {
  const repo = gitRepo()
  const first = recordItems(repo, RETURN, [fresh()], { now: NOW })
  const refused = recordItems(repo, RETURN, [fresh({ claim: 'another' }), fresh({ claim: 'no anchor', spans: [] })], { now: NOW })
  assert.equal(refused.ok, false)
  assert.equal(readFileSync(join(projectStateDir(repo), 'seq'), 'utf8'), String(first.seqs.at(-1)))
  assert.equal(storedLines(repo).length, first.ids.length)
})

test('same-second recorders take -2 then -3, and a refused one deletes only its own file', () => {
  const repo = gitRepo()
  const payload = { items: [fresh()] }
  const names = [1, 2, 3].map(() => recordRaw(repo, 'survey', payload, { now: NOW }).return)
  const stem = names[0].replace(/-survey$/, '')
  assert.deepEqual(names, [stem + '-survey', stem + '-2-survey', stem + '-3-survey'])
  const refused = recordRaw(repo, 'survey', { items: [fresh({ claim: 'no anchor', spans: [] })] }, { now: NOW })
  assert.equal(refused.ok, false)
  const dir = evidenceReturnsDir(repo)
  assert.deepEqual(readdirSync(dir).sort(), names.map((n) => n + '.json').sort())
  for (const n of names) assert.deepEqual(JSON.parse(readFileSync(join(dir, n + '.json'), 'utf8')), payload)
})

test('an approach return that carries items records them like any other kind', () => {
  const repo = gitRepo()
  const out = recordRaw(repo, 'approach', { approach: 'minimal-change', cites: [], items: [fresh()] }, { now: NOW })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual(out.ids, [itemId(fresh())])
  assert.equal(liveItems(repo).get(out.ids[0]).from_return, out.return)
})

// ------------------------------------------------------------------ audit gaps: the project counter

test('a project counter behind the log is repaired, never minting a seq the log already holds', () => {
  const repo = bare()
  appendProject(repo, 'items', [{ kind: 'judged', id: 'I00000001' }, { kind: 'judged', id: 'I00000002' }, { kind: 'judged', id: 'I00000003' }])
  // What a crash between the append and the counter write leaves: lines past the counter.
  writeFileSync(join(projectStateDir(repo), 'seq'), '1')
  const out = appendProject(repo, 'items', { kind: 'judged', id: 'I00000004' })
  assert.equal(out.ok, true, JSON.stringify(out))
  const seqs = storedLines(repo).map((l) => l.seq)
  assert.equal(new Set(seqs).size, seqs.length, 'every seq is distinct: ' + seqs.join(', '))
  assert.ok(out.seqs[0] > Math.max(...seqs.slice(0, -1)), 'the new line is the latest: ' + seqs.join(', '))
})
