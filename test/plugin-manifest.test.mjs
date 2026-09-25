// test/plugin-manifest.test.mjs — pins the plugin manifest's required shape.
//
// The manifest is the one file Claude Code reads before anything else in the plugin;
// a malformed or renamed field makes every agent and workflow here unreachable, with
// no error that points back to this file. So it gets a test.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

test('plugin.json parses and declares the required fields', async () => {
  const raw = await readFile(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')
  const manifest = JSON.parse(raw)

  assert.equal(manifest.name, 'agentics')
  assert.equal(typeof manifest.description, 'string')
  assert.ok(manifest.description.length > 0, 'description must be non-empty')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.equal(manifest.author.name, 'VanillaFairy')
})

test('the vanillafairy marketplace lists agentics', async () => {
  const raw = await readFile(new URL('../../.claude-plugin/marketplace.json', import.meta.url), 'utf8')
  const marketplace = JSON.parse(raw)

  const entry = marketplace.plugins.find((p) => p.name === 'agentics')
  assert.ok(entry, 'agentics must be listed in the marketplace')
  assert.equal(entry.source, './agentics')
  assert.match(entry.version, /^\d+\.\d+\.\d+$/)
})

test('the sibling plugins are still listed', async () => {
  const raw = await readFile(new URL('../../.claude-plugin/marketplace.json', import.meta.url), 'utf8')
  const names = JSON.parse(raw).plugins.map((p) => p.name)

  // The siblings this marketplace actually ships. `investigate` stood here until the
  // capability moved into agentics and the slot was taken by vf-grill; the assertion
  // outlived the plugin and had been failing ever since, which is the quiet way a guard
  // stops guarding — it is red for a reason nobody reads, so a real regression looks
  // exactly like the noise.
  for (const name of ['vf-superpowers', 'reasonable', 'vf-grill']) {
    assert.ok(names.includes(name), `${name} must not be dropped from the marketplace`)
  }
})
