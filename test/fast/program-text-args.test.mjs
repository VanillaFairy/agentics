// test/fast/program-text-args.test.mjs — pins that every free-text argument a program declares has
// its file twin: a text past one line goes in a file the session wrote, so the refusal that says so
// must have a flag to name.
//
// Design: docs/DESIGN.md#p2--code-does-what-is-deterministic-models-only-judge.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PROGRAM_NAMES } from '../../lib/run.mjs'

test('every text argument of a program has a file argument that reads into it', async () => {
  const texts = []
  for (const name of PROGRAM_NAMES) {
    const { ARGS } = await import('../../lib/programs/' + name + '.mjs')
    for (const [key, a] of Object.entries(ARGS)) {
      if (a.kind !== 'text') continue
      texts.push(name + ' ' + key)
      const keys = Object.keys(ARGS)
      const twin = ARGS[key + '_file']
      assert.deepEqual([twin && twin.kind, twin && twin.as], ['file', key], name + ' --' + key + ' has no --' + key + '-file')
      assert.ok(keys.indexOf(key + '_file') > keys.indexOf(key), name + ': the file twin is declared after the text it fills')
    }
  }
  assert.ok(texts.length > 0, 'no program declares a text argument: this test judges nothing')
})
