// test/migrate-effort-titles.test.mjs — the one-shot that titles efforts opened before titles existed.
//
// Design: docs/DESIGN.md#migrations.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readEffort } from '../lib/effort.mjs'
import { plan } from '../tools/migrate-effort-titles.mjs'

/** A repository whose store holds each effort's identity file as given. */
function storeOf(t, identities) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-titles-')).split('\\').join('/')
  t.after(() => rmSync(repo, { recursive: true, force: true, maxRetries: 3 }))
  for (const [effort, held] of Object.entries(identities)) {
    const dir = join(repo, '.agentics', effort, '.state')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'effort.json'), JSON.stringify(held))
  }
  return repo
}

const OLD = { about: 'I want a portrait editor in the asset manager, where…', roots: ['.'], opened_at: '2026-11-22T00:00:00.000Z' }

test('a dry run lists the untitled efforts and writes nothing', (t) => {
  const repo = storeOf(t, { a: OLD, b: { ...OLD, title: 'Has one' } })
  const before = readFileSync(join(repo, '.agentics', 'a', '.state', 'effort.json'), 'utf8')
  const out = plan(repo, { a: { title: 'Portrait editor' } })
  assert.deepEqual([out.untitled, out.would_write], [['a'], ['a']])
  assert.equal(readFileSync(join(repo, '.agentics', 'a', '.state', 'effort.json'), 'utf8'), before)
})

test('--yes writes the title and the replacing description, keeps every other field, and runs once', (t) => {
  const repo = storeOf(t, { a: OLD, c: OLD })
  const out = plan(repo, { a: { title: ' Portrait  editor ', about: 'A designer tab that composes any portrait.' } }, { write: true })
  assert.deepEqual([out.written, out.untitled], [['a'], ['a', 'c']])
  const read = readEffort(repo, 'a').identity
  assert.deepEqual(read, { title: 'Portrait editor', about: 'A designer tab that composes any portrait.', roots: OLD.roots, opened_at: OLD.opened_at })
  assert.deepEqual(plan(repo, { a: { title: 'Other' } }, { write: true }).written, [], 'a titled effort is left alone')
})

test('an entry without a usable title is refused, not written', (t) => {
  const repo = storeOf(t, { a: OLD, b: OLD })
  const out = plan(repo, { a: { title: '  ' }, b: { title: 'x'.repeat(81) } }, { write: true })
  assert.deepEqual(out.refused.map((r) => r.effort), ['a', 'b'])
  assert.deepEqual(out.written, [])
  assert.equal(readEffort(repo, 'a').identity.title, '')
})
