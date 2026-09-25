// test/verbatim-blocks.test.mjs — makes "copied verbatim" a checked invariant instead of
// a comment. A contract restated in prose drifts: the self-audit found the develop skill
// narrowing the review-loop exit back to "zero criticals", the reviewer charter dropping
// the contract-order carve-out from the severity ladder, and the merge contract described
// three ways by three files. Each such contract now lives between paired markers:
//
//   <!-- agentics:verbatim <id> -->
//   ...the contract text...
//   <!-- /agentics:verbatim -->
//
// and this test collects every block across the repo's markdown and asserts that all
// copies of an id are identical after whitespace normalization (so indentation and line
// wrapping may differ, words may not). This is a TEST rather than a lint rule on purpose:
// rule modules are pure per-file functions, and comparing across files would break that
// contract — while a test has the filesystem and one job.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// `superpowers` is docs/superpowers/, gitignored planning scratch: a stale copy of a block there
// must neither satisfy a pin nor fail one.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.claude', 'superpowers'])

/** Ids that must exist somewhere; a refactor that deletes the markers fails loudly. */
const REQUIRED_IDS = [
  'review-loop-exit', 'severity-ladder', 'merge-result',
  // The design phase rules on its own ladder. The code one above speaks entirely in
  // acceptance criteria, commit series and declared loci, none of which a design document
  // has — so a probe holding it would invent a mapping and rule badly in both directions.
  'design-severity-ladder',
  // Four skills pass `intelligence`, and a session reads exactly one of them. A copy that
  // drifts back to "default normal" lets that skill's session pick the tier by taste again,
  // which is the failure this rule was written for.
  'intelligence-tier',
  // The two agents that write files and the one that judges them must be held to the same
  // comment law, or the reviewer's minor is an opinion about a rule the coder never had.
  'comment-policy',
  // Probe and design both dispose of the same findings, and a disposition described twice
  // drifts toward whichever copy was edited last. The failure it guards is a field report:
  // 46 blocking ambiguities delivered as prose, one question per turn, and a user who ruled
  // past a computed gate because reading the findings cost more than the design did.
  'probe-disposition',
  // Two halves of one cost model: what a dispatcher owes, and what a dispatched agent owes. A
  // constitution whose copy drifts leaves that one agent paging whole files while the rest work
  // from the excerpts they were handed, and nothing else would notice.
  'dispatch-economy', 'dispatched-economy',
]

const OPEN = /<!--\s*agentics:verbatim\s+([a-z0-9-]+)\s*-->/g
const CLOSE = /<!--\s*\/agentics:verbatim\s*-->/g

function mdFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) mdFiles(full, out)
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

const normalize = (s) => s.replace(/\s+/g, ' ').trim()

function collectBlocks() {
  const blocks = new Map() // id -> [{ file, text }]

  for (const full of mdFiles(ROOT)) {
    const file = relative(ROOT, full).split(sep).join('/')
    const text = readFileSync(full, 'utf8')

    OPEN.lastIndex = 0
    let open
    while ((open = OPEN.exec(text))) {
      CLOSE.lastIndex = OPEN.lastIndex
      const close = CLOSE.exec(text)
      assert.ok(close, `${file}: unclosed agentics:verbatim block "${open[1]}"`)

      const id = open[1]
      if (!blocks.has(id)) blocks.set(id, [])
      blocks.get(id).push({ file, text: normalize(text.slice(OPEN.lastIndex, close.index)) })

      OPEN.lastIndex = CLOSE.lastIndex
    }
  }

  return blocks
}

test('the contract blocks exist where the docs promise them', () => {
  const blocks = collectBlocks()
  for (const id of REQUIRED_IDS) {
    assert.ok(blocks.has(id), `no agentics:verbatim block with id "${id}" found anywhere`)
  }
})

test('every verbatim id has at least two copies — a lone block guards nothing', () => {
  for (const [id, copies] of collectBlocks()) {
    assert.ok(copies.length >= 2,
      `agentics:verbatim "${id}" appears only in ${copies[0].file} — the copy it should pin was removed or unmarked`)
  }
})

test('all copies of a verbatim block are identical modulo whitespace', () => {
  for (const [id, copies] of collectBlocks()) {
    const canonical = copies[0]
    for (const copy of copies.slice(1)) {
      assert.equal(copy.text, canonical.text,
        `agentics:verbatim "${id}" drifted between ${canonical.file} and ${copy.file}`)
    }
  }
})
