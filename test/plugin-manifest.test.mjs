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
