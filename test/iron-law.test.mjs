// test/iron-law.test.mjs — pins that the design still carries the Iron Laws, intact.
//
// If a law is silently dropped or softened, nothing else in the repo fails — the plugin just
// quietly stops being governed. This test is the only thing standing between the laws and slow
// erosion.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const design = (await readFile(new URL('../docs/DESIGN.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
const claudeMd = await readFile(new URL('../CLAUDE.md', import.meta.url), 'utf8')

test('the Iron Laws section matches its pinned hash', () => {
  // The whole span byte for byte, not clause openers: a substring check would miss a law that
  // keeps its heading while its body is gutted, or gains a trailing qualifier that negates it.
  //
  // A legitimate amendment is expected to update this hash; that is the point — it makes the
  // change appear in the diff as a deliberate act. Recompute with:
  //   node -e "const f=require('fs'),c=require('crypto');const r=f.readFileSync('docs/DESIGN.md','utf8').replace(/\r\n/g,'\n');
  //   console.log(c.createHash('sha256').update(r.slice(r.indexOf('## Iron Laws'),r.indexOf('## Guiding Principles'))).digest('hex'))"
  const law = design.slice(design.indexOf('## Iron Laws'), design.indexOf('## Guiding Principles'))
  assert.equal(createHash('sha256').update(law).digest('hex'),
    '0828db18275d211f0bf229d014a497a340b4917f2deb31a49507f710594618a8')
})

test('each law names its enforcement', () => {
  for (const law of ['IL1', 'IL2', 'IL3', 'IL4']) {
    const at = design.indexOf('### ' + law)
    assert.ok(at > -1, law + ' is missing')
    const body = design.slice(at, design.indexOf('\n### ', at + 5))
    assert.match(body, /\*Enforced by:\*/, law + ' names no enforcing mechanism — a law without one is a defect')
  }
})

test('CLAUDE.md maps every law to the rule that enforces it', () => {
  for (const law of ['IL1', 'IL2', 'IL3', 'IL4']) assert.match(claudeMd, new RegExp('\\| ' + law + ' '), law + ' has no row')
})
