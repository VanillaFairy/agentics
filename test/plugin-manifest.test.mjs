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

// This repository is its own single-plugin marketplace, so a user can
// `/plugin marketplace add VanillaFairy/agentics`. The marketplace's version is what
// `claude plugin list --available` and update tooling report, while plugin.json wins at
// install time — a drift between the two reads as a version nobody is running.
test('the repository is a single-plugin marketplace listing agentics at its root', async () => {
  const manifest = JSON.parse(await readFile(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
  const marketplace = JSON.parse(await readFile(new URL('../.claude-plugin/marketplace.json', import.meta.url), 'utf8'))

  assert.equal(marketplace.name, 'agentics')
  assert.equal(marketplace.owner.name, 'VanillaFairy')
  assert.equal(marketplace.plugins.length, 1, 'the marketplace ships exactly one plugin')
  const [entry] = marketplace.plugins
  assert.equal(entry.name, manifest.name)
  assert.equal(entry.source, './')
  assert.equal(entry.version, manifest.version, 'marketplace.json and plugin.json must carry the same version')
})
