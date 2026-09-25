// test/agent-allowlists.test.mjs — every agent's tool allowlist, pinned exactly.
//
// Lint family, same stance as test/self-lint.test.mjs and test/design-doc.test.mjs: an invariant
// enforced against this plugin's own source, mechanically, forever. Its sibling
// test/agent-frontmatter.test.mjs tests the RULE against fixtures — that a `tools:` key exists
// and is non-empty. This file tests the shipped tree, and asks the question the rule cannot:
// which tools, exactly.
//
// The frontmatter allowlist is the only capability mechanism this harness gives us. Hooks are
// ruled out, so there is no fence, no interceptor, and nothing that inspects a command — an
// agent can do precisely what its list grants and nothing else, and every other separation in
// the pipeline is prose backed by a post-hoc audit. The sibling plugin `../reasonable` carried
// the warning as a comment in its own charters: weakening one of these silently breaks an
// adversarial separation. A comment is not a mechanism. This file is.
//
// So the map below is the contract, and the friction is the feature. Widening an allowlist,
// narrowing one, or adding an agent with no entry here fails `node --test` rather than shipping
// quietly — and changing one means editing this file in the same commit, which puts the decision
// in a diff a reviewer reads instead of in a frontmatter line nobody diffs twice.
//
// Design: docs/DESIGN.md#capability-layer.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

const AGENTS = new URL('../agents/', import.meta.url)

/**
 * agent name -> its exact tool allowlist, sorted.
 *
 * Sorted rather than in frontmatter order: the order a list is written in grants nothing, and
 * pinning it would fail a diff that reordered two words and taught the next reader to update this
 * file without reading it.
 */
const ALLOWLISTS = {
  // `Read` alone: the host refuses an agent with no tools, and an analyst judges what it is handed
  // — without Grep or Glob it cannot widen the evidence base, which is the point of the role.
  analyst: ['Read'],
  // Writes only its report file; it declares mutations and a script applies them.
  auditor: ['Glob', 'Grep', 'Read', 'Write'],
  // Runs one lib command and pastes stdout; the task tools move the launching session's todo
  // list. No Read: a courier that could open files would be tempted to tidy what it carries.
  courier: ['Bash', 'TaskCreate', 'TaskList', 'TaskUpdate'],
  'doc-researcher': ['Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch'],
  historian: ['Bash', 'Grep', 'Read'],
  implementer: ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'],
  investigator: ['Bash', 'Glob', 'Grep', 'Read'],
  planner: ['Bash', 'Glob', 'Grep', 'Read', 'Write'],
  reviewer: ['Bash', 'Glob', 'Grep', 'Read'],
  scout: ['Glob', 'Grep', 'Read'],
  'test-author': ['Edit', 'Glob', 'Grep', 'Read', 'Write'],
}

/**
 * The agents whose blindness is CAPABILITY rather than constitution prose: no shell, so nothing
 * they can be talked into executes, writes outside the harness's own file tools, or reaches git.
 *
 * Everything else in the roster carries Bash, and a shell subsumes writing — which is why the
 * read-only claims in those charters are discipline plus a post-hoc audit, and say so.
 *
 * `test-author` is the one whose membership was designed rather than inherited: it authors the
 * failing tests and must not be able to run, implement or commit them, so a Bash added here would
 * dissolve the separation the whole role exists for without changing a word of its charter.
 */
const NO_SHELL = ['analyst', 'auditor', 'doc-researcher', 'scout', 'test-author']

/** `tools:` out of the frontmatter block. CR-stripped: core.autocrlf is true on Windows. */
function toolsOf(source) {
  const lines = source.split('\n').map((line) => line.replace(/\r$/, ''))
  assert.equal(lines[0], '---', 'no frontmatter block')

  const end = lines.indexOf('---', 1)
  const line = lines.slice(1, end).find((l) => l.startsWith('tools:'))
  assert.ok(line, 'no tools: key in the frontmatter')

  return line.slice('tools:'.length).split(',').map((t) => t.trim()).filter(Boolean)
}

const files = (await readdir(AGENTS)).filter((n) => n.endsWith('.md')).sort()
const shipped = new Map()
for (const name of files) {
  shipped.set(name.replace(/\.md$/, ''), toolsOf(await readFile(new URL(name, AGENTS), 'utf8')))
}

test('the pinned roster is exactly the roster on disk', () => {
  // Both directions. A new constitution with no entry here would otherwise ship with whatever
  // allowlist its author typed, unreviewed — which is the case this whole file exists for, since
  // the lane agents are defined by what they cannot do.
  assert.deepEqual(
    [...shipped.keys()].sort(),
    Object.keys(ALLOWLISTS).sort(),
    'an agent was added or removed without pinning its allowlist in the same commit',
  )
})

test('every allowlist matches its pin exactly', () => {
  for (const [name, tools] of shipped) {
    const pinned = ALLOWLISTS[name]
    if (!pinned) continue // reported by the roster test above, with a better message

    assert.deepEqual(
      [...tools].sort(),
      [...pinned].sort(),
      `agents/${name}.md grants ${tools.join(', ')} — pinned as ${pinned.join(', ')}. ` +
        `Widening an allowlist is a capability change: state why in ` +
        `docs/DESIGN.md#capability-layer and edit this file in the same commit.`,
    )
  }
})

test('an allowlist never repeats a tool', () => {
  // A duplicate grants nothing and reads as two decisions, which is how a list drifts: the second
  // copy survives a removal of the first and the diff looks like a no-op.
  for (const [name, tools] of shipped) {
    assert.equal(new Set(tools).size, tools.length, `agents/${name}.md repeats a tool`)
  }
})

test('the shell-free agents are exactly the ones whose blindness is capability', () => {
  const observed = [...shipped].filter(([, tools]) => !tools.includes('Bash')).map(([n]) => n)

  assert.deepEqual(
    observed.sort(),
    [...NO_SHELL].sort(),
    'the set of agents that cannot execute anything changed. Giving one of them Bash converts ' +
      'a capability into a promise; taking Bash from an agent that needs it breaks a duty.',
  )
})
