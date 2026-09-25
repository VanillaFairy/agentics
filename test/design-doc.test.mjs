// test/design-doc.test.mjs — pins that docs/DESIGN.md exists, keeps its shape, and that every
// pointer into it lands on a real heading.
//
// Lint family, same stance as test/no-turn-caps.test.mjs and test/iron-law.test.mjs: an
// invariant enforced against this plugin's own source, mechanically, forever. The invariant
// here is documentary, and it is the one that erodes without anything failing.
//
// DESIGN.md is the single description of the system as it is. Code, tests, skills and agents
// point into it as `docs/DESIGN.md#<anchor>`, and a renamed heading silently strands every one
// of those pointers. So the anchors are checked here rather than trusted: a pointer that no
// longer resolves fails the suite, and so does a link inside the document itself. This is a
// test rather than a lint rule for the reason test/verbatim-blocks.test.mjs gives — rule modules
// are pure per-file functions, and this comparison spans files.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const design = readFileSync(join(ROOT, 'docs', 'DESIGN.md'), 'utf8')

// `superpowers` is gitignored planning scratch under docs/; nothing in it is part of the design.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'superpowers'])
const SOURCE = /\.(md|mjs|js|json)$/

/** GitHub's heading anchor: lowercase, punctuation dropped, each space a hyphen. */
function anchorOf(heading) {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')
}

const headings = [...design.matchAll(/^#{1,6} (.+)$/gm)].map((m) => m[1])
const anchors = new Set(headings.map(anchorOf))

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (SOURCE.test(entry.name)) out.push(full)
  }
  return out
}

/** The body of one `## <title>` section: everything up to the next `## ` heading or the end. */
function sectionBody(source, title) {
  const heading = '\n## ' + title + '\n'
  const at = source.indexOf(heading)
  if (at === -1) return null

  const rest = source.slice(at + heading.length)
  const next = rest.indexOf('\n## ')
  return (next === -1 ? rest : rest.slice(0, next)).trim()
}

test('the design document exists and describes a system', () => {
  assert.ok(design.length > 20000,
    'a design doc short enough to be a placeholder is a placeholder')
})

test('no top-level section is a bare heading', () => {
  // A heading with nothing under it is the failure mode where the structure is satisfied and
  // the document says nothing.
  const sections = [...design.matchAll(/^## (.+)$/gm)].map((m) => m[1])
  assert.ok(sections.length > 10, 'the document has lost its sections')
  for (const title of sections) {
    const body = sectionBody(design, title)
    assert.ok(body && body.length > 20, `## ${title} has no body`)
  }
})

test('every heading has its own anchor', () => {
  // Two headings with one anchor make a pointer ambiguous: GitHub suffixes the second, and a
  // reader following `#x` lands on whichever came first.
  const seen = new Map()
  for (const heading of headings) {
    const anchor = anchorOf(heading)
    assert.ok(!seen.has(anchor), `"${heading}" and "${seen.get(anchor)}" share #${anchor}`)
    seen.set(anchor, heading)
  }
})

test('every link inside the document resolves', () => {
  for (const [, anchor] of design.matchAll(/\]\(#([^)]+)\)/g)) {
    assert.ok(anchors.has(anchor), `DESIGN.md links to #${anchor}, which no heading produces`)
  }
})

test('every pointer into the document from the repository resolves', () => {
  let pointers = 0
  for (const full of sourceFiles(ROOT)) {
    const file = relative(ROOT, full).split(sep).join('/')
    const text = readFileSync(full, 'utf8')
    for (const [, anchor] of text.matchAll(/DESIGN\.md#([a-z0-9_-]+)/g)) {
      pointers++
      assert.ok(anchors.has(anchor), `${file} points at DESIGN.md#${anchor}, which no heading produces`)
    }
  }
  assert.ok(pointers > 0, 'nothing points into the design document — the pointer scan is broken')
})

test('the guiding principles are stated, not merely referenced', () => {
  // The sentences the rest of the codebase is a consequence of. If they go, the document has
  // become a table of contents. `\s+` because the document is hard-wrapped.
  for (const gp of ['GP1', 'GP2', 'GP3', 'GP4', 'GP5']) assert.match(design, new RegExp('^### ' + gp + ' — ', 'm'))
  assert.match(design, /Leanness is legible/)
  assert.match(design, /Leanness never touches verdicts/)
  assert.match(design, /Schedule by readiness/)
})

test('the parts that make agent-written durability safe are named', () => {
  // Each of these is a property something else in the repo depends on, and each is the kind of
  // sentence that gets summarized away.
  assert.match(design, /No agent records a\s+verdict/)
  assert.match(design, /Bytes that cross a model carry a digest/)
  assert.match(design, /where the record and git agree/)
  assert.match(design, /a reviewer has findings and no approval to give/)
})
