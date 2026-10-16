// tools/field.mjs: synthetic repos for the navigator's field checks, and the oracle over a finished run.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'

import { CHECK_NAMES, build, check, command, manifest } from '../tools/field.mjs'

const root = mkdtempSync(join(tmpdir(), 'field-'))
after(() => rmSync(root, { recursive: true, force: true }))

const lsFiles = (dir) => spawnSync('git', ['-c', 'core.quotepath=off', 'ls-files'], { cwd: dir, encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort()
const head = (dir) => spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim()

test('build is deterministic', () => {
  for (const c of CHECK_NAMES) {
    const one = join(root, 'a', c)
    const two = join(root, 'b', c)
    build(c, one)
    build(c, two)
    assert.deepEqual(lsFiles(one), manifest(c), c)
    assert.equal(head(one), head(two), c)
    assert.match(command(c, one), /lib\/run\.mjs (survey|solutions) /, c)
  }
  const src = manifest('orphans').filter((f) => f.startsWith('src/'))
  assert.equal(src.length, 40)
  assert.equal(new Set(src.map((f) => f.split('/')[1])).size, 8)
  assert.ok(manifest('brackets').includes('app/[id]/page.tsx') && manifest('brackets').includes('app/[slug]/layout.tsx'))
  assert.ok(manifest('fence').includes('.agentics/x/.state/returns/a.json'))
  assert.match(command('web-shift', join(root, 'a', 'web-shift')), /field\.mjs serve & node /)
})

let n = 0
function runDir({ result, calls = [], rulings = false, pages = [] }) {
  const dir = join(root, 'run-' + ++n)
  const s = join(dir, 'searches', 'navigator')
  mkdirSync(s, { recursive: true })
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result))
  writeFileSync(join(s, 'calls.jsonl'), calls.map((c) => JSON.stringify(c) + '\n').join(''))
  if (rulings) {
    mkdirSync(join(s, 'rulings'))
    writeFileSync(join(s, 'rulings', '2-1.md'), 'ruling brief\n')
  }
  pages.forEach((p, i) => {
    mkdirSync(join(s, 'pages'), { recursive: true })
    writeFileSync(join(s, 'pages', i + '.json'), JSON.stringify(p))
  })
  return dir
}
const resultOf = (coverage = {}) => ({ question: 'q', coverage: { complete: false, ...coverage } })
const DIRS = ['api', 'auth', 'billing', 'cache', 'config', 'jobs', 'store', 'util']
const restsOn = DIRS.map((d) => 'navigator:t1: src/' + d + '/ (5 files) rests on grep import')
const ruled = 'navigator:t1: ruled answered: six modules are orphans — looked grep import'

test('check reads the oracle off the coverage lines', () => {
  const good = { declared: [ruled, ...restsOn] }
  assert.equal(check('orphans', runDir({ result: resultOf(good), rulings: true })).ok, true)
  assert.equal(check('orphans', runDir({ result: resultOf(good) })).ok, false, 'done without a ruling file')
  assert.equal(check('orphans', runDir({ result: resultOf({ declared: [ruled, ...restsOn.slice(1)] }), rulings: true })).ok, false, 'a directory without rests on')
  assert.equal(check('orphans', runDir({ result: { topics: [{ coverage: good }] }, rulings: true })).ok, true, 'a nested coverage counts')
  assert.match(check('orphans', runDir({ result: resultOf(good), rulings: true })).notes[0], /orphans reached: 0 of 6/)

  const listed = { declared: ['r: app/[id]/page.tsx'], unreached: ['r: lead app/[slug]/layout.tsx'] }
  assert.equal(check('brackets', runDir({ result: resultOf(listed) })).ok, true)
  assert.equal(check('brackets', runDir({ result: { question: 'app/[id]/page.tsx app/[slug]/layout.tsx', coverage: { declared: [] } } })).ok, false, 'named only outside coverage')
  assert.equal(check('brackets', runDir({ result: resultOf({ declared: ['r: app/[id]/page.tsx'] }) })).ok, false, 'a file missed')
  const refused = { ...listed, unreached: [...listed.unreached, 'r: refused read app/[slug]/layout.tsx (not_canonical: not a canonical key)'] }
  assert.equal(check('brackets', runDir({ result: resultOf(refused) })).ok, false, 'a refusal on a file')
  const refusedCall = { seq: 3, tool: 'read', ok: false, refusal: 'outside_scope', args: { path: 'app/[id]/page.tsx' }, keys: [] }
  assert.equal(check('brackets', runDir({ result: resultOf(listed), calls: [refusedCall] })).ok, false, 'a refused call on a file')

  const clean = [{ seq: 1, tool: 'grep', ok: true, keys: ['src/name.mjs'] }]
  assert.equal(check('fence', runDir({ result: resultOf(), calls: clean })).ok, true)
  const leaked = [...clean, { seq: 2, tool: 'read', ok: true, keys: ['.agentics/x/.state/returns/a.json'] }]
  assert.equal(check('fence', runDir({ result: resultOf(), calls: leaked })).ok, false, 'a .agentics/ key')

  const page = (v) => ({ key: 'http://127.0.0.1:47816/release-notes', status: 200, bytes: 9, lines: ['Release notes', 'version ' + v, 'Changes in version ' + v] })
  const fetchCall = (seq, p) => ({ seq, tool: 'fetch', ok: true, args: { url: 'http://127.0.0.1:47816/release-notes', page: p }, keys: ['http://127.0.0.1:47816/release-notes'] })
  const twice = [fetchCall(1, 1), fetchCall(2, 2)]
  const notes = (...v) => resultOf({ declared: v.map((n) => 'navigator:t1: ruled answered: the notes say version ' + n + ' — looked fetch') })
  assert.equal(check('web-shift', runDir({ result: notes(1, 1), pages: [page(1)], calls: twice })).ok, true)
  assert.equal(check('web-shift', runDir({ result: notes(1, 2), pages: [page(1)], calls: twice })).ok, false, 'two versions in the ruled lines')
  assert.equal(check('web-shift', runDir({ result: notes(1), pages: [page(1)], calls: [fetchCall(1, 1)] })).ok, false, 'fetched once')
  assert.equal(check('web-shift', runDir({ result: resultOf(), pages: [page(1), page(2)], calls: twice })).ok, false, 'two snapshots')
  assert.equal(check('web-shift', runDir({ result: resultOf(), calls: twice })).ok, false, 'no snapshot')
  assert.equal(check('fence', join(root, 'nowhere')).ok, false, 'no result.json')
})

test('the CLI exits 1 on a missed oracle', () => {
  const dir = runDir({ result: resultOf() })
  const r = spawnSync(process.execPath, [join(dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'tools', 'field.mjs'), 'check', 'orphans', dir], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAILED orphans/)
})
