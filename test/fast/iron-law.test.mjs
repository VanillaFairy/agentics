// test/fast/iron-law.test.mjs — pins that the design still carries its Laws, intact, and that
// CLAUDE.md maps each one to what enforces it.
//
// If a law is silently dropped or softened, nothing else in the repo fails — the plugin just
// quietly stops being governed. This test is the only thing standing between the laws and slow
// erosion.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const design = (await readFile(new URL('../../docs/DESIGN.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
const claudeMd = await readFile(new URL('../../CLAUDE.md', import.meta.url), 'utf8')
const LAWS = ['L1', 'L2', 'L3', 'L4']

test('the Laws section matches its pinned hash', () => {
  // The whole span byte for byte. A legitimate amendment updates this hash, so the change shows in
  // the diff as a deliberate act. Recompute with:
  //   node -e "const f=require('fs'),c=require('crypto');const r=f.readFileSync('docs/DESIGN.md','utf8').replace(/\r\n/g,'\n');
  //   console.log(c.createHash('sha256').update(r.slice(r.indexOf('## Laws'),r.indexOf('## Principles'))).digest('hex'))"
  const laws = design.slice(design.indexOf('## Laws'), design.indexOf('## Principles'))
  assert.equal(createHash('sha256').update(laws).digest('hex'), 'dfad424269cec33ec7cf1f594eb1abccc22aa5b458cbe6cd1177e099ffd6da25')
})

test('each law names its enforcement', () => {
  for (const law of LAWS) {
    const at = design.indexOf('### ' + law + ' — ')
    assert.ok(at > -1, law + ' is missing')
    const body = design.slice(at, design.indexOf('\n### ', at + 5))
    assert.match(body, /\*Enforced by:\*/, law + ' names no enforcing mechanism — a law without one is a defect')
  }
})

test('CLAUDE.md maps every law to what enforces it', () => {
  for (const law of LAWS) assert.match(claudeMd, new RegExp('\\| ' + law + ' — '), law + ' has no row')
})
