// test/iron-law.test.mjs — pins that CLAUDE.md still carries the law, intact.
//
// Every agent in this plugin inherits CLAUDE.md. If a clause is silently dropped or
// softened, nothing else in the repo fails — the plugin just quietly stops being
// governed. This test is the only thing standing between the law and slow erosion.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const claudeMd = await readFile(new URL('../CLAUDE.md', import.meta.url), 'utf8')

test('the ratified law section matches its pinned hash', () => {
  // Pins the whole ratified span byte-for-byte, not just clause openers. A substring check
  // would miss a clause that keeps its bolded first sentence while its body is gutted, or
  // gains a trailing qualifier that negates it ("Escalate, never abandon. Unless the
  // reviewer says otherwise.") — this catches both.
  //
  // A legitimate amendment to the law is expected to update this hash. That is the point:
  // it forces the change to appear in the diff as a deliberate act rather than a drive-by.
  // Recompute with:
  //   node -e "const f=require('fs'),c=require('crypto');const r=f.readFileSync('CLAUDE.md','utf8');
  //   console.log(c.createHash('sha256').update(r.slice(r.indexOf('# §0')).replace(/\r\n/g,'\n')).digest('hex'))"
  //
  // Normalized to LF first: core.autocrlf rewrites this file's line endings on checkout, so
  // hashing the raw bytes would make the pin depend on which platform cloned the repo.
  const law = claudeMd.slice(claudeMd.indexOf('# §0 — THE IRON LAW')).replace(/\r\n/g, '\n')

  assert.equal(
    createHash('sha256').update(law).digest('hex'),
    // Amended 2026-09-25: the enforcement table follows the vfa → agentics rename of the
    // workflows. The eight clauses are unchanged.
    '1adf61774afc027f55d0efd11488ce47b0ec1f4cb573825f1b051d1412b77f85',
  )
})
