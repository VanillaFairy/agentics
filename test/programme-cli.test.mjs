// test/programme-cli.test.mjs — the reader and the CLI of lib/programme.mjs, over a real
// directory tree.
//
// test/programme.test.mjs covers the arithmetic with every filesystem fact passed in as an
// argument. What it cannot cover is the half that decides WHICH facts get passed: where the
// design tree is read from, what an absent state file means versus an unreadable one, whether
// an append verb actually refuses a duplicate on disk, and whether the mirror is rewritten.
// Those only fail in a directory.
//
// The lifecycle walked here is the whole layer in miniature: open the programme, deliver a
// slice with a gap, watch the frontier go empty while the programme is not complete, rule on
// the gap, watch the next slice become reachable.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { loadProgramme, listProgrammes, designRoot, stateFileOf, mirrorFileOf }
  from '../lib/programme.mjs'

const LIB = fileURLToPath(new URL('../lib/programme.mjs', import.meta.url))

const GRAPH = {
  advance: 'gated',
  nodes: [
    { id: 'world', kind: 'group', parent: '' },
    { id: 'walk', kind: 'slice', parent: 'world', delivers: 'a walkable meadow',
      deps: [], provides: [{ name: 'NavigationGrid', paths: ['src/core/navigation/'] }],
      consumes: [] },
    { id: 'hug', kind: 'slice', parent: 'world', delivers: 'the first need met',
      deps: ['walk'], provides: [{ name: 'NeedLifecycle', paths: ['src/core/needs/'] }],
      consumes: ['NavigationGrid'] },
  ],
}

const ROOT_DOC = [
  '# system',
  '<!-- agentics:section settled-evidence -->',
  'The tablet is the only target.',
  '<!-- /agentics:section -->',
].join('\n')

const leafDoc = (id) => [
  '# ' + id,
  '<!-- agentics:section change -->',
  'Deliver ' + id + '.',
  '<!-- /agentics:section -->',
  '<!-- agentics:section decisions -->',
  'Tap to move.',
  '<!-- /agentics:section -->',
  '<!-- agentics:section settled-evidence -->',
  'Godot 4.5.',
  '<!-- /agentics:section -->',
].join('\n')

const NAME = '2026-08-15-eva'

/** A repository with one programme, its root design, and walk's leaf. hug is undesigned. */
function fixture(over = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agentics-programme-'))
  const dir = join(root, 'docs', 'agentics', 'designs', NAME)

  mkdirSync(join(dir, 'slices'), { recursive: true })
  writeFileSync(join(dir, 'programme.json'), JSON.stringify(over.graph || GRAPH), 'utf8')
  writeFileSync(join(dir, 'system.md'), over.root === undefined ? ROOT_DOC : over.root, 'utf8')
  if (over.walk !== null) writeFileSync(join(dir, 'slices', 'walk.md'), over.walk || leafDoc('walk'), 'utf8')

  return { root, dir }
}

/** Run the CLI and return its trimmed stdout plus exit status. */
const cli = (root, ...args) => {
  const run = spawnSync(process.execPath, [LIB, root, '--programme', NAME, ...args],
    { encoding: 'utf8' })
  return { out: (run.stdout || '').trim(), status: run.status }
}

const json = (root, ...args) => JSON.parse(cli(root, ...args).out)

const coverageFile = (root, coverage) => {
  const path = join(root, 'coverage.json')
  writeFileSync(path, JSON.stringify(coverage), 'utf8')
  return path
}

const COMPLETE = { complete: true, dropped: [], incomplete: [], failed_channels: [],
                   unreached: [], resumable: { runId: 'r', remaining: [] } }

const withGap = { ...COMPLETE, complete: false,
                  unreached: ['W6: PWA manifest deferred — no offline install'] }

// --- discovery and reading ----------------------------------------------------------------

test('a programme is found by its design directory carrying a programme.json', (t) => {
  const { root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  assert.deepEqual(listProgrammes(root), [NAME])
})

test('a design directory with no programme.json is not a programme', (t) => {
  const { root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  mkdirSync(join(root, 'docs', 'agentics', 'designs', '2026-01-01-plain'), { recursive: true })

  assert.deepEqual(listProgrammes(root), [NAME])
})

test('marker completeness is read off the leaf files that exist', (t) => {
  const { root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const { derived } = loadProgramme(root, NAME)

  assert.equal(derived.slices.find((s) => s.id === 'walk').designed, true)
  assert.equal(derived.slices.find((s) => s.id === 'hug').designed, false,
    'hug has no leaf at all, which is what just-in-time design looks like on disk')
})

test('a leaf that exists but lost a marker is not a finished design', (t) => {
  const { root } = fixture({ walk: leafDoc('walk').replace('agentics:section decisions', 'agentics:section x') })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const { derived } = loadProgramme(root, NAME)

  assert.equal(derived.slices.find((s) => s.id === 'walk').designed, false)
  assert.equal(derived.slices.find((s) => s.id === 'walk').status, 'awaiting-design',
    'a session that died mid-design routes back here, with no ceremony anywhere')
})

test('the design tree is read from the programme worktree when one exists', (t) => {
  const { root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  // Leaf documents and plan revisions are committed on the programme branch, so they exist in
  // the worktree and not in the user's checkout until landing. Reading the checkout would
  // report every just-in-time leaf as never written.
  const wt = join(root, '.claude', 'worktrees', 'programme-' + NAME, 'docs', 'agentics', 'designs', NAME)
  mkdirSync(join(wt, 'slices'), { recursive: true })
  writeFileSync(join(wt, 'programme.json'), JSON.stringify(GRAPH), 'utf8')
  writeFileSync(join(wt, 'system.md'), ROOT_DOC, 'utf8')
  writeFileSync(join(wt, 'slices', 'walk.md'), leafDoc('walk'), 'utf8')
  writeFileSync(join(wt, 'slices', 'hug.md'), leafDoc('hug'), 'utf8')

  assert.ok(designRoot(root, NAME).endsWith('programme-' + NAME))
  assert.equal(loadProgramme(root, NAME).derived.slices.find((s) => s.id === 'hug').designed, true)
})

test('a malformed graph fails the whole load with a named diagnostic', (t) => {
  const { root } = fixture({ graph: { nodes: [{ id: 'a', kind: 'phase' }] } })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const result = loadProgramme(root, NAME)

  assert.match(result.error, /neither "group" nor "slice"/)
  assert.equal(result.derived, undefined)
})

test('an absent state file is a programme with no events, not a degraded one', (t) => {
  const { root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  assert.equal(loadProgramme(root, NAME).derived.degraded, '')
})

test('a state file with an unparseable line freezes the whole programme', (t) => {
  const { root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const path = stateFileOf(root, NAME)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '{"event":"opened","base_branch":"main","base_sha":"1e6c65d"}\nnope\n', 'utf8')

  const { derived } = loadProgramme(root, NAME)

  assert.match(derived.degraded, /line 2 is not JSON/)
  assert.ok(derived.slices.every((s) => s.status === 'unknown'))
})

// --- the lifecycle, through the CLI ---------------------------------------------------------

test('the whole lifecycle: open, deliver with a gap, rule on it, reach the next slice', (t) => {
  const { root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  assert.deepEqual(json(root, '--json').frontier, ['walk'])

  assert.equal(cli(root, '--append-opened', '--base-branch', 'main',
    '--base-sha', '1e6c65d').status, 0)

  const delivered = json(root, '--append-delivered', '--slice', 'walk',
    '--run', '20260817-091412', '--merged-sha', '4f2a91c',
    '--coverage', coverageFile(root, withGap))

  // The frontier goes empty and the programme is NOT complete. Those are different facts, and
  // conflating them is how an unruled gap reads as a finished programme.
  assert.deepEqual(delivered.frontier, [])
  assert.equal(delivered.complete, false)

  const accepted = json(root, '--append-accepted', '--slice', 'walk', '--gaps', 'all',
    '--ruling', 'ok without offline install until stage 4', '--by', 'user')

  assert.deepEqual(accepted.frontier, ['hug'])
  assert.deepEqual(accepted.appended.gaps, withGap.unreached,
    'the CLI copies gap text exact-string from the delivery; the caller supplies an index')

  const after = json(root, '--json')
  assert.equal(after.slices.find((s) => s.id === 'walk').status, 'delivered')
  assert.equal(after.slices.find((s) => s.id === 'hug').status, 'awaiting-design')
})

test('a second delivery for one slice is refused on disk, not just in the arithmetic', (t) => {
  const { root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const args = ['--append-delivered', '--slice', 'walk', '--run', 'r1', '--merged-sha', 'abc',
    '--coverage', coverageFile(root, COMPLETE)]

  assert.equal(cli(root, ...args).status, 0)

  const second = cli(root, ...args)
  assert.equal(second.status, 1)
  assert.match(JSON.parse(second.out).error, /already delivered/)

  const lines = readFileSync(stateFileOf(root, NAME), 'utf8').trim().split('\n')
  assert.equal(lines.length, 1, 'a refused append writes nothing')
})

test('every append rewrites the mirror from the same renderer', (t) => {
  const { root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  cli(root, '--append-opened', '--base-branch', 'main', '--base-sha', '1e6c65d')

  const mirror = readFileSync(mirrorFileOf(root, NAME), 'utf8')

  assert.match(mirror, /generated by lib\/programme\.mjs/)
  assert.match(mirror, /frontier: walk/)
})

test('an external delivery needs a ruling and is satisfied by it', (t) => {
  const { root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const refused = cli(root, '--append-delivered', '--slice', 'walk', '--run', '',
    '--merged-sha', 'abc')
  assert.equal(refused.status, 1)
  assert.match(JSON.parse(refused.out).error, /needs a ruling/)

  const ok = json(root, '--append-delivered', '--slice', 'walk', '--run', '',
    '--merged-sha', 'abc', '--ruling', 'built by hand before the programme existed')

  assert.deepEqual(ok.frontier, ['hug'], 'the brownfield door: the voucher is the evidence')
})

test('merged-to-base derives which slices it carried rather than trusting a typed list', (t) => {
  const { root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  cli(root, '--append-delivered', '--slice', 'walk', '--run', 'r1', '--merged-sha', 'abc',
    '--coverage', coverageFile(root, COMPLETE))

  const merged = json(root, '--append-merged', '--sha', 'e07f4a2', '--base-branch', 'main')

  assert.deepEqual(merged.appended.slices, ['walk'])
  assert.equal(json(root, '--json').slices.find((s) => s.id === 'walk').status, 'landed')
})

// --- notes and the view ---------------------------------------------------------------------

test('--notes concatenates the marked sections and names the predecessors', (t) => {
  const { root, dir } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writeFileSync(join(dir, 'slices', 'hug.md'), leafDoc('hug'), 'utf8')
  cli(root, '--append-delivered', '--slice', 'walk', '--run', 'r1', '--merged-sha', '4f2a91c',
    '--coverage', coverageFile(root, COMPLETE))

  const { out, status } = cli(root, '--notes', 'hug')

  assert.equal(status, 0)
  assert.match(out, /The tablet is the only target\./)
  assert.match(out, /Tap to move\./)
  assert.match(out, /walk delivered at 4f2a91c/)
})

test('--change prints the marked change section byte-exact', (t) => {
  const { root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const { out, status } = cli(root, '--change', 'walk')

  assert.equal(status, 0)
  // Byte-exact is the whole point: develop's existing_run guard compares this string exactly,
  // so a session retyping it — a rewrapped line, a normalized dash — plans the slice twice.
  assert.equal(out, 'Deliver walk.')
})

test('--change fails by name when the leaf carries no change section', (t) => {
  const { root, dir } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writeFileSync(join(dir, 'slices', 'walk.md'), '# walk\n\nstill drafting', 'utf8')
  const { out, status } = cli(root, '--change', 'walk')

  assert.equal(status, 1)
  assert.match(JSON.parse(out).error, /not a finished design/)
})

test('--section --file prints one marked section of any document, byte-exact', (t) => {
  const { root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  // A single-change design is one document with the same markers a leaf carries, and its
  // change section is what gets handed to develop. No programme is needed to read it.
  const doc = join(root, 'design.md')
  writeFileSync(doc, [
    '# design',
    '<!-- agentics:section change -->',
    'Replace the legacy timer poll with an event subscription.',
    '<!-- /agentics:section -->',
  ].join('\n'), 'utf8')

  const run = spawnSync(process.execPath, [LIB, root, '--section', 'change', '--file', doc],
    { encoding: 'utf8' })

  assert.equal(run.status, 0)
  assert.equal(run.stdout.trim(), 'Replace the legacy timer poll with an event subscription.')
})

test('--section fails by name when the marker is absent', (t) => {
  const { root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const doc = join(root, 'design.md')
  writeFileSync(doc, '# design\n\nstill drafting', 'utf8')

  const run = spawnSync(process.execPath, [LIB, root, '--section', 'change', '--file', doc],
    { encoding: 'utf8' })

  assert.equal(run.status, 1)
  assert.match(JSON.parse(run.stdout).error, /not a finished design/)
})

test('--append-delivered refuses a run that is visibly still in flight', (t) => {
  const { root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  // A run sitting in the programme's own worktree, planned and never finished.
  const runDir = join(root, '.claude', 'worktrees', 'programme-' + NAME,
    '.claude', 'agentics', 'runs', '20260817-091412')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify({
    change: 'Deliver walk.', programme: NAME, slice: 'walk',
    partition_raw: JSON.stringify({ waves: [['W1']], coupled: [] }),
  }), 'utf8')

  const { out, status } = cli(root, '--append-delivered', '--slice', 'walk',
    '--run', '20260817-091412', '--merged-sha', 'abc',
    '--coverage', coverageFile(root, COMPLETE))

  assert.equal(status, 1)
  // `delivered` is terminal for a slice, so a premature one can never be corrected by a
  // later append — the real delivery has nowhere to go.
  assert.match(JSON.parse(out).error, /A delivery is terminal/)
})

test('--notes fails loudly and by name when a marker is missing', (t) => {
  const { root } = fixture({ root: '# system\n\nno markers here' })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const { out, status } = cli(root, '--notes', 'walk')

  assert.equal(status, 1)
  assert.match(JSON.parse(out).error, /settled-evidence/)
})

test('--write-view splices the graph into plan.md and leaves the prose alone', (t) => {
  const { root, dir } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writeFileSync(join(dir, 'plan.md'), '# plan\n\nWhy this decomposition.\n', 'utf8')

  cli(root, '--write-view')
  cli(root, '--write-view')

  const planMd = readFileSync(join(dir, 'plan.md'), 'utf8')

  assert.match(planMd, /Why this decomposition\./)
  assert.match(planMd, /frontier: walk/)
  assert.equal(planMd.split('agentics:graph').length, 3, 'regeneration splices; it never appends again')
})

test('--out writes the same render the CLI printed', (t) => {
  const { root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const target = join(root, 'view.txt')
  const { out } = cli(root, '--out', target)

  assert.equal(readFileSync(target, 'utf8').trim(), out)
})

// --- the drift verb, over a real repository -------------------------------------------------
//
// `driftCheck`'s arithmetic is covered in test/programme.test.mjs with the moved files passed
// in. This covers the wiring: the verb asks git itself, because a diff that passed through a
// model's summary is not a diff, and that makes it the one place in this library where the
// pure core and the outside world are joined. The join broke silently once while every other
// test stayed green, which is the whole argument for spending a git repository on it.
//
// Hermetic: identity and hooks are supplied per-invocation, so nothing depends on the
// machine's git configuration.

const GIT = ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t',
  '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=']

const git = (cwd, ...args) =>
  spawnSync('git', [...GIT, '-C', cwd, ...args], { encoding: 'utf8' })

const gitAvailable = () => {
  const probe = spawnSync('git', ['--version'], { encoding: 'utf8' })
  return !probe.error && probe.status === 0
}

test('--drift flags a pending slice whose consumed contract moved', (t) => {
  if (!gitAvailable()) return t.skip('git is not on PATH')

  const { root, dir } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writeFileSync(join(dir, 'slices', 'hug.md'), leafDoc('hug'), 'utf8')
  mkdirSync(join(root, 'src', 'core', 'navigation'), { recursive: true })
  writeFileSync(join(root, 'src', 'core', 'navigation', 'grid.txt'), 'base\n', 'utf8')

  assert.equal(git(root, 'init', '-q', '.').status, 0)
  git(root, 'add', '-A')
  assert.equal(git(root, 'commit', '-qm', 'base').status, 0)

  const base = git(root, 'rev-parse', 'HEAD').stdout.trim()
  const worktree = join(root, '.claude', 'worktrees', 'programme-' + NAME)

  assert.equal(git(root, 'worktree', 'add', '-q', '-b', 'agentics/programme-' + NAME,
    worktree, 'HEAD').status, 0)

  // What a landed slice looks like: one file under a contract hug consumes, one that is not.
  writeFileSync(join(worktree, 'src', 'core', 'navigation', 'grid.txt'), 'changed\n', 'utf8')
  writeFileSync(join(worktree, 'README.md'), 'new\n', 'utf8')
  git(worktree, 'add', '-A')
  assert.equal(git(worktree, 'commit', '-qm', 'the walk slice').status, 0)

  const { out, status } = cli(root, '--drift', base)
  assert.equal(status, 0, out)

  const found = JSON.parse(out)

  assert.equal(found.moved, 2)
  assert.deepEqual(found.flagged, [
    { slice: 'hug', contract: 'NavigationGrid',
      paths: ['src/core/navigation/grid.txt'] },
  ], 'README.md moved and is under no contract anybody consumes')
  assert.deepEqual(found.unexamined, [])
})

test('--drift names an undesigned pending slice as unexamined', (t) => {
  if (!gitAvailable()) return t.skip('git is not on PATH')

  const { root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  git(root, 'init', '-q', '.')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'base')

  const base = git(root, 'rev-parse', 'HEAD').stdout.trim()
  git(root, 'worktree', 'add', '-q', '-b', 'agentics/programme-' + NAME,
    join(root, '.claude', 'worktrees', 'programme-' + NAME), 'HEAD')

  const found = JSON.parse(cli(root, '--drift', base).out)

  // hug has no leaf, so it declares nothing to intersect. Saying "no flag" about it would
  // reassure the user about a slice nobody looked at.
  assert.deepEqual(found.unexamined, ['hug'])
  assert.deepEqual(found.flagged, [])
})

test('--drift fails loudly when the anchor cannot be resolved', (t) => {
  if (!gitAvailable()) return t.skip('git is not on PATH')

  const { root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  git(root, 'init', '-q', '.')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'base')
  git(root, 'worktree', 'add', '-q', '-b', 'agentics/programme-' + NAME,
    join(root, '.claude', 'worktrees', 'programme-' + NAME), 'HEAD')

  const { out, status } = cli(root, '--drift', 'f'.repeat(40))

  assert.equal(status, 1, 'an unanswerable diff is never an empty one')
  assert.match(JSON.parse(out).error, /git diff --name-only/)
})

test('several programmes make the CLI list rather than choose', (t) => {
  const { root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const other = join(root, 'docs', 'agentics', 'designs', '2026-09-01-other')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'programme.json'), JSON.stringify({ nodes: [] }), 'utf8')

  const run = spawnSync(process.execPath, [LIB, root], { encoding: 'utf8' })

  assert.equal(run.status, 0, 'several programmes is a normal state, not an error')
  assert.deepEqual(JSON.parse(run.stdout).programmes, ['2026-08-15-eva', '2026-09-01-other'])
})
