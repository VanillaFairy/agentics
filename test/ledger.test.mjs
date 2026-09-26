import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

import { append, digestEntries, fileFor, parseLog, readLog, seqMax } from '../lib/ledger.mjs'
import { effortStateDir } from '../lib/store.mjs'

const repo = () => mkdtempSync(join(tmpdir(), 'agentics-ledger-'))
const LEDGER = fileURLToPath(new URL('../lib/ledger.mjs', import.meta.url))

test('seq is minted by the ledger, one counter across every log of an effort', () => {
  const r = repo()
  const a = append(r, 'e1', 'nodes', { kind: 'node', node: { id: '.' } })
  const b = append(r, 'e1', 'events', [{ kind: 'planned', node: '.' }, { kind: 'dispatched', node: '.' }])
  const c = append(r, 'e1', 'journal:20260925-120000', { kind: 'series-done', node: 'x' })
  assert.deepEqual([a.seqs, b.seqs, c.seqs], [[1], [2, 3], [4]])
  assert.equal(seqMax(r, 'e1'), 4)
  rmSync(r, { recursive: true, force: true })
})

test('a seq the caller supplies is ignored and overwritten', () => {
  const r = repo()
  append(r, 'e1', 'events', { kind: 'planned', node: '.', seq: 999 })
  const [line] = readLog(r, 'e1', 'events').entries
  assert.equal(line.seq, 1)
})

test('efforts count separately', () => {
  const r = repo()
  append(r, 'e1', 'events', { kind: 'planned', node: '.' })
  const other = append(r, 'e2', 'events', { kind: 'planned', node: '.' })
  assert.deepEqual(other.seqs, [1])
})

test('a lost counter file is rebuilt from the highest seq on disk', () => {
  const r = repo()
  append(r, 'e1', 'events', [{ kind: 'a' }, { kind: 'b' }, { kind: 'c' }])
  rmSync(join(effortStateDir(r, 'e1'), 'seq'))
  assert.deepEqual(append(r, 'e1', 'state:20260925-120000', { kind: 'closed' }).seqs, [4])
})

test('the batch is all or nothing: one entry without a kind writes nothing', () => {
  const r = repo()
  const out = append(r, 'e1', 'events', [{ kind: 'planned' }, { node: 'x' }])
  assert.equal(out.ok, false)
  assert.match(out.error, /entry 1/)
  assert.equal(readLog(r, 'e1', 'events').entries.length, 0)
})

test('a digest that does not match refuses the batch', () => {
  const r = repo()
  const entries = [{ kind: 'planned', node: 'a' }]
  assert.equal(append(r, 'e1', 'events', entries, { digest: 'deadbeef' }).ok, false)
  assert.equal(append(r, 'e1', 'events', entries, { digest: digestEntries(entries) }).ok, true)
})

test('unknown files and unsafe efforts are refused by name', () => {
  assert.match(fileFor('/r', 'e1', 'plan').error, /unknown ledger file/)
  assert.match(fileFor('/r', 'e1', 'state:yesterday').error, /unknown ledger file/)
  assert.match(fileFor('/r', '../x', 'events').error, /not an effort name/)
  assert.match(fileFor('/r', 'a--b', 'events').error, /not an effort name/)
})

test('reading is tolerant: a torn line is counted, not thrown on', () => {
  const out = parseLog('{"kind":"a","seq":1}\n{"kind":"b",\n\n{"no":"kind"}\n')
  assert.equal(out.entries.length, 1)
  assert.equal(out.malformed, 2)
})

test('the CLI appends from base64 with a digest, and from stdin for a heredoc', () => {
  const r = repo()
  const entries = [{ kind: 'planned', node: 'a' }]
  const token = Buffer.from(JSON.stringify(entries)).toString('base64')
  const one = spawnSync('node', [LEDGER, 'append', '--repo', r, '--effort', 'e1', '--file', 'events',
    '--digest', digestEntries(entries), '--b64', token], { encoding: 'utf8' })
  assert.equal(one.status, 0, one.stdout)
  assert.deepEqual(JSON.parse(one.stdout).seqs, [1])

  const two = spawnSync('node', [LEDGER, 'append', '--repo', r, '--effort', 'e1', '--file', 'journal:20260925-120000', '--stdin'],
    { encoding: 'utf8', input: '{"kind":"series-done","node":"a","head_sha":"abc"}' })
  assert.equal(two.status, 0, two.stdout)
  assert.deepEqual(JSON.parse(two.stdout).seqs, [2])

  const bad = spawnSync('node', [LEDGER, 'append', '--repo', r, '--effort', 'e1', '--file', 'events', '--stdin'],
    { encoding: 'utf8', input: '{"kind": "x", ' })
  assert.equal(bad.status, 1)
  assert.match(JSON.parse(bad.stdout).error, /not JSON/)
})

test('concurrent writers never mint the same seq', async () => {
  const r = repo()
  const runs = Array.from({ length: 6 }, (_, i) => new Promise((resolve) => {
    const child = spawn('node', ['-e', `
      import(${JSON.stringify(new URL('../lib/ledger.mjs', import.meta.url).href)}).then((m) => {
        for (let k = 0; k < 10; k++) m.append(${JSON.stringify(r)}, 'e1', 'events', { kind: 'x', w: ${i} })
      })`])
    child.on('close', resolve)
  }))
  await Promise.all(runs)
  const seqs = readLog(r, 'e1', 'events').entries.map((e) => e.seq).sort((a, b) => a - b)
  assert.equal(seqs.length, 60)
  assert.equal(new Set(seqs).size, 60)
  assert.equal(existsSync(join(effortStateDir(r, 'e1'), '.lock')), false)
  assert.equal(readFileSync(join(effortStateDir(r, 'e1'), 'seq'), 'utf8'), '60')
})
