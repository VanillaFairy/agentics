// The web pin: a fetched URL's body is kept under <dir>/pages/ for the whole search.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { fetchUrl } from '../lib/search/tools.mjs'

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
const pagesDir = (d) => join(d, 'pages')
const snapshots = (d) => (existsSync(pagesDir(d)) ? readdirSync(pagesDir(d)).filter((f) => f.endsWith('.json')) : [])

test('pages of a URL come from one body', async () => {
  const dir = fresh()
  const was = body
  body = (n) => lots(250).replace('line 1\n', 'request ' + n + '\n')
  try {
    const one = await fetchUrl({ url: base + '/a', page: 1 }, { dir })
    const two = await fetchUrl({ url: base + '/a', page: 2 }, { dir })
    assert.equal(one.ok, true)
    assert.equal(two.ok, true)
    assert.equal(one.pages, 2)
    assert.equal(two.lines[0].text, 'line 201')
    assert.match(one.lines[0].text, /^request \d+$/)
  } finally {
    body = was
  }
})

test('a fetched URL is read from its snapshot', async () => {
  const dir = fresh()
  hits = 0
  const one = await fetchUrl({ url: base + '/b', page: 1 }, { dir })
  const again = await fetchUrl({ url: base + '/b', page: 1 }, { dir })
  assert.equal(hits, 1)
  assert.deepEqual(again, one)
  assert.equal(snapshots(dir).length, 1)
})

test('a body past the bound is refused', async () => {
  const dir = fresh()
  const r = await fetchUrl({ url: base + '/c' }, { dir, bytes: 4 })
  assert.equal(r.ok, false)
  assert.equal(r.refusal, 'too_large')
  assert.match(r.detail, /\d+/)
  assert.equal(snapshots(dir).length, 0)
  const chunked = await fetchUrl({ url: base + '/chunked' }, { dir, bytes: 8 })
  assert.equal(chunked.refusal, 'too_large', 'a body with no declared length is cut at the bound')
  assert.equal(snapshots(dir).length, 0)
  const fits = await fetchUrl({ url: base + '/chunked' }, { dir, bytes: 10 })
  assert.equal(fits.ok, true)
})

test('the snapshot is keyed canonically', async () => {
  const dir = fresh()
  hits = 0
  await fetchUrl({ url: base + '/d/?utm_source=x#frag' }, { dir })
  await fetchUrl({ url: base + '/d' }, { dir })
  assert.equal(hits, 1)
  assert.equal(snapshots(dir).length, 1)
})

test('a missing snapshot is fetched', async () => {
  const dir = fresh()
  hits = 0
  await fetchUrl({ url: base + '/e' }, { dir })
  assert.equal(hits, 1)
})

test('a deleted snapshot is fetched again', async () => {
  const dir = fresh()
  hits = 0
  await fetchUrl({ url: base + '/f' }, { dir })
  for (const f of snapshots(dir)) rmSync(join(pagesDir(dir), f))
  await fetchUrl({ url: base + '/f', page: 1 }, { dir })
  assert.equal(hits, 2)
  assert.equal(snapshots(dir).length, 1)
})

test('a malformed snapshot is replaced', async () => {
  const dir = fresh()
  hits = 0
  await fetchUrl({ url: base + '/g' }, { dir })
  const file = join(pagesDir(dir), snapshots(dir)[0])
  writeFileSync(file, '{ not json', 'utf8')
  const r = await fetchUrl({ url: base + '/g' }, { dir })
  assert.equal(r.ok, true)
  assert.equal(hits, 2)
  const third = await fetchUrl({ url: base + '/g' }, { dir })
  assert.equal(hits, 2)
  assert.equal(third.ok, true)
  writeFileSync(file, JSON.stringify({ key: 'http://elsewhere', status: 200, bytes: 1, lines: ['x'] }), 'utf8')
  const other = await fetchUrl({ url: base + '/g' }, { dir })
  assert.equal(hits, 3, 'a snapshot of another key does not answer for this URL')
  assert.equal(other.ok, true)
})
