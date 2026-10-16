// The web pin: a fetched URL's body is kept under the run's pages directory for the whole search,
// and read back by pinnedPage.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { fnv1a } from '../lib/plan-digest.mjs'
import * as query from '../lib/search/query.mjs'
import * as ledger from '../lib/search/ledger.mjs'
import * as tools from '../lib/search/tools.mjs'

const { fetchUrl } = tools
const canonicalUrl = query.canonicalUrl ?? ledger.canonicalUrl

let server
let base
let hits = 0
let body = (n) => 'body ' + n + '\n'
const dirs = []
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), 'pin-'))
  dirs.push(d)
  return d
}

before(async () => {
  server = createServer((req, res) => {
    hits += 1
    res.setHeader('content-type', 'text/plain')
    if (req.url === '/chunked') {
      res.write('12345')
      res.end('67890')
      return
    }
    res.end(body(hits))
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  base = 'http://127.0.0.1:' + server.address().port
})
after(() => {
  server.close()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const lots = (n) => Array.from({ length: n }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n'
const snapshots = (pages) => (existsSync(pages) ? readdirSync(pages).filter((f) => f.endsWith('.json')) : [])

test('pages of a URL come from one body', async () => {
  const pages = join(fresh(), 'p')
  const was = body
  body = (n) => lots(250).replace('line 1\n', 'request ' + n + '\n')
  try {
    const one = await fetchUrl({ url: base + '/a', page: 1 }, { pages })
    const two = await fetchUrl({ url: base + '/a', page: 2 }, { pages })
    assert.equal(one.ok, true)
    assert.equal(two.ok, true)
    assert.equal(one.pages, 2)
    assert.equal(two.lines[0].text, 'line 201')
    assert.match(one.lines[0].text, /^request \d+$/)
    const back = await fetchUrl({ url: base + '/a', page: 1 }, { pages })
    assert.equal(back.lines[0].text, one.lines[0].text, 'page 1 again is the body page 2 came from')
  } finally {
    body = was
  }
})

test('a fetched URL is read from its snapshot', async () => {
  const pages = join(fresh(), 'p')
  hits = 0
  const one = await fetchUrl({ url: base + '/b', page: 1 }, { pages })
  const again = await fetchUrl({ url: base + '/b', page: 1 }, { pages })
  assert.equal(hits, 1)
  assert.deepEqual(again, one)
  assert.equal(snapshots(pages).length, 1)
  assert.equal(existsSync(join(pages, fnv1a(canonicalUrl(base + '/b')) + '.json')), true, 'pinned directly under pages, by its key')
})

test('a body past the bound is refused', async () => {
  const pages = join(fresh(), 'p')
  const r = await fetchUrl({ url: base + '/c' }, { pages, bytes: 4 })
  assert.equal(r.ok, false)
  assert.equal(r.refusal, 'too_large')
  assert.match(r.detail, /\d+/)
  assert.equal(snapshots(pages).length, 0)
  const chunked = await fetchUrl({ url: base + '/chunked' }, { pages, bytes: 8 })
  assert.equal(chunked.refusal, 'too_large', 'a body with no declared length is cut at the bound')
  assert.equal(snapshots(pages).length, 0)
  const fits = await fetchUrl({ url: base + '/chunked' }, { pages, bytes: 10 })
  assert.equal(fits.ok, true)
})

test('the snapshot is keyed canonically', async () => {
  const pages = join(fresh(), 'p')
  hits = 0
  await fetchUrl({ url: base + '/d/?utm_source=x#frag' }, { pages })
  await fetchUrl({ url: base + '/d' }, { pages })
  assert.equal(hits, 1)
  assert.equal(snapshots(pages).length, 1)
})

test('a missing snapshot is fetched', async () => {
  const pages = join(fresh(), 'p')
  hits = 0
  await fetchUrl({ url: base + '/e' }, { pages })
  assert.equal(hits, 1)
})

test('a deleted snapshot is fetched again', async () => {
  const pages = join(fresh(), 'p')
  hits = 0
  await fetchUrl({ url: base + '/f' }, { pages })
  for (const f of snapshots(pages)) rmSync(join(pages, f))
  await fetchUrl({ url: base + '/f', page: 1 }, { pages })
  assert.equal(hits, 2)
  assert.equal(snapshots(pages).length, 1)
})

test('a malformed snapshot is replaced', async () => {
  const pages = join(fresh(), 'p')
  hits = 0
  await fetchUrl({ url: base + '/g' }, { pages })
  const file = join(pages, snapshots(pages)[0])
  writeFileSync(file, '{ not json', 'utf8')
  const r = await fetchUrl({ url: base + '/g' }, { pages })
  assert.equal(r.ok, true)
  assert.equal(hits, 2)
  const third = await fetchUrl({ url: base + '/g' }, { pages })
  assert.equal(hits, 2)
  assert.equal(third.ok, true)
  writeFileSync(file, JSON.stringify({ key: 'http://elsewhere', status: 200, bytes: 1, lines: ['x'] }), 'utf8')
  const other = await fetchUrl({ url: base + '/g' }, { pages })
  assert.equal(hits, 3, 'a snapshot of another key does not answer for this URL')
  assert.equal(other.ok, true)
})

test('pinnedPage reads a pinned page back', async () => {
  const pages = join(fresh(), 'p')
  assert.equal(tools.pinnedPage(pages, base + '/h'), null, 'nothing pinned yet, not even the directory')
  const got = await fetchUrl({ url: base + '/h' }, { pages })
  assert.equal(got.ok, true)
  const lines = tools.pinnedPage(pages, base + '/h')
  assert.ok(Array.isArray(lines), 'the pinned lines')
  assert.deepEqual(lines.map((l) => (typeof l === 'string' ? l : l.text)), got.lines.map((l) => l.text))
  assert.equal(tools.pinnedPage(pages, base + '/never'), null, 'an unfetched url')
})
