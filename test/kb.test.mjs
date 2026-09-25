// test/kb.test.mjs — the knowledge base against real repositories.
//
// Like test/run-verdict-git.test.mjs and test/verify.test.mjs, this builds small real git repos
// rather than mocking git. The whole point of the freshness rule is an arithmetic
// over COMMITS, and the case that killed the previous design — a commit made by a hand outside
// any run, with no ledger line anywhere to see it — is only observable against a real repo.
//
// What is pinned here:
//
//   depth        LCA(about), including the prefix trap and the moved-subject re-file
//   chains       bounded by path, root always present
//   freshness    the git-event shortcut, its demotion to the digest check, and THE HAND COMMIT
//   states       fresh / stale / orphaned, and the anchor class this version cannot check
//   the writer   digest-checked, base64-transported, path-disciplined, anchors measured here
//   compaction   newest-id-wins, shadowed and orphaned lines dropped
//
// Design: docs/DESIGN.md#knowledge-base.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  appendEntries, chainFor, chainNodes, compactTree, digestEntry, entryProblem, indexTree, lcaOf,
  readNode, safePath, stateOf, treeNodes, verifyTree,
} from '../lib/kb.mjs'

const KB = fileURLToPath(new URL('../lib/kb.mjs', import.meta.url))
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

/** A repo with two source files and one commit. */
function repo(files = { 'src/a.js': 'alpha\n', 'src/ui/b.js': 'bravo\n' }) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-kb-')).split('\\').join('/')
  git(dir, 'init', '-q', '.')
  git(dir, 'config', 'user.email', 't@t')
  git(dir, 'config', 'user.name', 't')
  write(dir, files)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return { dir, head: git(dir, 'rev-parse', 'HEAD') }
}

function write(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, ...path.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
}

const commit = (dir, files, subject) => {
  write(dir, files)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', subject)
  return git(dir, 'rev-parse', 'HEAD')
}

const entry = (over = {}) => ({
  id: 'the-trap',
  claim: 'src/a.js is unimportable under the test runner: it touches the window at load.',
  kind: 'gotcha',
  about: ['src/a.js'],
  observed_at: '',
  source: { runstamp: '20260830-101500', via: 'coder-discovered' },
  ...over,
})

/** Append through the real writer surface, with a correctly minted digest. */
function deposit(dir, entries) {
  const payload = { entries }
  const out = appendEntries(dir, payload, digestEntry(payload))
  assert.equal(out.ok, true, out.error)
  return out
}

const stateFor = (dir, id) => {
  const found = verifyTree(dir).nodes.flatMap((n) => n.entries).find((e) => e.id === id)
  assert.ok(found, 'no entry with id ' + id)
  return found
}

// ── depth is derived, never declared ─────────────────────────────────────────────────────────

test('LCA of one path is that path — a single file is the deepest grain there is', () => {
  assert.equal(lcaOf(['src/game/ui/PointerGate.ts']), 'src/game/ui/PointerGate.ts')
})

test('LCA of siblings is their directory', () => {
  assert.equal(lcaOf(['src/game/a.ts', 'src/game/b.ts']), 'src/game')
})

test('LCA across roots is the repo-wide node', () => {
  assert.equal(lcaOf(['src/a.ts', 'lib/b.ts']), '')
  assert.equal(lcaOf([]), '')
})

test('LCA is segment-wise, so a shared name prefix does not file an entry under a sibling', () => {
  // The string prefix of these two is 'src/game', which is a directory neither is inside.
  assert.equal(lcaOf(['src/game/a.ts', 'src/gamepad/b.ts']), 'src')
})

test('a subject that moves is re-filed by arithmetic rather than by memory', () => {
  const { dir, head } = repo({ 'src/a.js': 'alpha\n', 'src/ui/b.js': 'bravo\n' })

  deposit(dir, [entry({ about: ['src/a.js'], observed_at: head })])
  assert.deepEqual(treeNodes(dir), ['src/a.js'])

  // The same claim, re-observed after the subject moved into the ui module. Nobody re-files it:
  // the writer computes LCA over the new `about` and the entry lands at the new node.
  deposit(dir, [entry({ about: ['src/ui/b.js'], observed_at: head })])
  assert.deepEqual(treeNodes(dir), ['src/a.js', 'src/ui/b.js'])
})

// ── chains ───────────────────────────────────────────────────────────────────────────────────

test('a chain is every level from the root down to the path, and no level below it', () => {
  assert.deepEqual(chainNodes('src/game/ui'), ['', 'src', 'src/game', 'src/game/ui'])
  assert.deepEqual(chainNodes(''), [''])
})

test('the chain carries the levels that hold something, and always the root', () => {
  const { dir, head } = repo()

  deposit(dir, [
    entry({ id: 'repo-wide', about: ['src/a.js', 'src/ui/b.js'], observed_at: head }),
    entry({ id: 'ui-only', about: ['src/ui/b.js'], observed_at: head }),
  ])

  // `repo-wide` is about both files, so LCA files it at `src`; `ui-only` is about one, so it
  // files at that file's own node. The chain picks both up on the way down, and reports no level
  // that holds nothing.
  const payload = chainFor(dir, ['src/ui/b.js'])
  assert.equal(payload.chains.length, 1)
  assert.deepEqual(payload.chains[0].nodes, ['', 'src', 'src/ui/b.js'])
  assert.deepEqual(payload.chains[0].entries.map((e) => e.id), ['repo-wide', 'ui-only'])
})

test('a chain is bounded by its path — a deeper node never rides along', () => {
  const { dir, head } = repo()
  deposit(dir, [entry({ id: 'deep', about: ['src/ui/b.js'], observed_at: head })])

  const payload = chainFor(dir, ['src/a.js'])
  assert.deepEqual(payload.chains[0].entries.map((e) => e.id), [],
    'a consumer at src/a.js is not taxed by what the repository knows about src/ui')
  assert.deepEqual(payload.chains[0].nodes, [''], 'the root is always present, even holding nothing')
})

test('a repository with no knowledge base answers with an empty chain rather than an error', () => {
  const { dir } = repo()
  const payload = chainFor(dir, ['src/a.js'])

  assert.deepEqual(payload.chains[0].nodes, [''])
  assert.deepEqual(payload.counts, { fresh: 0, stale: 0, orphaned: 0 })
})

// ── freshness: the git-event arithmetic, and the hand commit that broke the ledger design ────

test('an entry whose subject no commit has touched is fresh by event arithmetic alone', () => {
  const { dir, head } = repo()
  deposit(dir, [entry({ observed_at: head })])

  const found = stateFor(dir, 'the-trap')
  assert.equal(found.state, 'fresh')
  assert.match(found.reason, /no commit has touched its subject/)
})

test('a commit elsewhere in the repository leaves the entry fresh', () => {
  const { dir, head } = repo()
  deposit(dir, [entry({ observed_at: head })])
  commit(dir, { 'src/ui/b.js': 'bravo changed\n' }, 'feat: unrelated')

  assert.equal(stateFor(dir, 'the-trap').state, 'fresh',
    'the arithmetic is over the entry\'s own subject, not over the repository')
})

test('A HAND COMMIT demotes the entry — the case a ledger-keyed design certified fresh', () => {
  // The whole reason freshness is keyed to GIT rather than the run ledger.
  // This commit is made by a person, outside any run: there is no run directory, no state.jsonl,
  // and nothing in this repository has ever recorded an agentics run. Ledger arithmetic would find no
  // event and report the entry fresh; git finds the commit.
  const { dir, head } = repo()
  deposit(dir, [entry({ observed_at: head })])

  assert.equal(stateFor(dir, 'the-trap').state, 'fresh')
  commit(dir, { 'src/a.js': 'alpha, edited by hand\n' }, 'fix: by hand, in a direct session')

  const found = stateFor(dir, 'the-trap')
  assert.equal(found.state, 'stale')
  assert.match(found.reason, /src\/a\.js has moved/)
  assert.equal(existsSync(join(dir, '.claude', 'agentics', 'runs')), false,
    'nothing in this repository ever recorded a run, which is exactly the point')
})

test('a commit that touched the subject and left it identical demotes to the digest check, which passes', () => {
  // "non-empty demotes to the digest check" is not "non-empty means stale". A commit that moved
  // the file and moved it back is an event about nothing, and the bytes say so.
  const { dir, head } = repo()
  deposit(dir, [entry({ observed_at: head })])

  commit(dir, { 'src/a.js': 'alpha, briefly\n' }, 'wip')
  commit(dir, { 'src/a.js': 'alpha\n' }, 'revert')

  const found = stateFor(dir, 'the-trap')
  assert.equal(found.state, 'fresh')
  assert.match(found.reason, /still digests to what was recorded/,
    'it is fresh by the digest, not by the shortcut — the shortcut saw the commits')
})

test('an uncommitted edit is not an event, so the shortcut stands aside for the bytes', () => {
  const { dir, head } = repo()
  deposit(dir, [entry({ observed_at: head })])

  write(dir, { 'src/a.js': 'alpha, edited and not committed\n' })

  assert.equal(stateFor(dir, 'the-trap').state, 'stale',
    'an unobserved change must never read as no change')
})

test('an entry whose every subject is gone is orphaned, not stale', () => {
  const { dir, head } = repo()
  deposit(dir, [entry({ observed_at: head })])

  rmSync(join(dir, 'src', 'a.js'))

  const found = stateFor(dir, 'the-trap')
  assert.equal(found.state, 'orphaned')
  assert.match(found.reason, /every path it is about is gone/)
})

test('an entry with one surviving subject is judged on that one', () => {
  const { dir, head } = repo()
  deposit(dir, [entry({ about: ['src/a.js', 'src/ui/b.js'], observed_at: head })])

  rmSync(join(dir, 'src', 'a.js'))
  const found = stateFor(dir, 'the-trap')

  assert.equal(found.state, 'stale', 'the deleted anchor moved; the entry is a lead, not a ghost')
  assert.match(found.reason, /src\/a\.js is gone/)
})

test('an anchor class this version cannot check never reads as clean', () => {
  // Guardians and surface globs travel through the writer untouched. Until the
  // checker knows how to attest one, an entry carrying one is a lead: unchecked and clean are
  // different answers (IRON LAW §2).
  const { dir, head } = repo()
  deposit(dir, [entry({
    observed_at: head,
    anchors: [{ test_file: 'test/no-wall-clock.test.js', test_id: 'the save is clock-free' }],
  })])

  commit(dir, { 'src/a.js': 'alpha, moved\n' }, 'fix: something')

  const found = stateFor(dir, 'the-trap')
  assert.equal(found.state, 'stale')
  assert.match(found.reason, /class this version cannot check/)
})

test('an entry observed at nothing can never take the shortcut', () => {
  const { dir } = repo()
  deposit(dir, [entry({ observed_at: '' })])

  const found = stateFor(dir, 'the-trap')
  assert.equal(found.state, 'fresh', 'it still has a file anchor, and the anchor is clean')
  assert.match(found.reason, /still digests/)
})

// ── the writer surface ───────────────────────────────────────────────────────────────────────

test('the writer measures the anchors itself and never takes them from the caller', () => {
  const { dir, head } = repo()

  // A caller cannot digest anything — a workflow script has no filesystem — so a file anchor it
  // supplies is a claim wearing a measurement's shape, and it is dropped.
  deposit(dir, [entry({ observed_at: head, anchors: [{ path: 'src/a.js', digest: 'deadbeef' }] })])

  const [stored] = readNode(dir, 'src/a.js').entries
  assert.equal(stored.anchors.length, 1)
  assert.equal(stored.anchors[0].path, 'src/a.js')
  assert.notEqual(stored.anchors[0].digest, 'deadbeef')
  assert.equal(stateFor(dir, 'the-trap').state, 'fresh')
})

test('an about path with no file behind it contributes no anchor and invents nothing', () => {
  // A run's own brand-new files are not at the repo root until the human accepts the merge.
  const { dir, head } = repo()
  deposit(dir, [entry({ about: ['src/a.js', 'src/not-yet.js'], observed_at: head })])

  const [stored] = readNode(dir, 'src').entries
  assert.deepEqual(stored.anchors.map((a) => a.path), ['src/a.js'])
})

test('the writer refuses a payload that did not survive the trip', () => {
  const { dir, head } = repo()
  const payload = { entries: [entry({ observed_at: head })] }
  const digest = digestEntry(payload)

  payload.entries[0].claim = 'something else entirely'
  const out = appendEntries(dir, payload, digest)

  assert.equal(out.ok, false)
  assert.match(out.error, /digest mismatch/)
  assert.deepEqual(treeNodes(dir), [], 'a refused batch writes nothing at all')
})

test('the digest round-trips through the writer when nothing was damaged', () => {
  const { dir, head } = repo()
  const payload = { entries: [entry({ observed_at: head })] }
  const out = appendEntries(dir, payload, digestEntry(payload))

  assert.equal(out.ok, true)
  assert.equal(out.digest, digestEntry(payload))
  assert.deepEqual(out.written, [{ id: 'the-trap', node: 'src/a.js', anchors: 1 }])
})

test('a malformed member refuses the whole batch — the mint is wrong, not the transport', () => {
  const { dir, head } = repo()
  const payload = { entries: [entry({ observed_at: head }), entry({ id: 'bad', kind: 'rumour' })] }
  const out = appendEntries(dir, payload, digestEntry(payload))

  assert.equal(out.ok, false)
  assert.match(out.error, /"kind" must be one of/)
  assert.deepEqual(treeNodes(dir), [])
})

test('every path in an entry stays inside the tree', () => {
  assert.equal(safePath('../../etc/passwd'), null)
  assert.equal(safePath('/etc/passwd'), null)
  assert.equal(safePath('C:/Windows'), null)
  assert.equal(safePath('src\\game\\a.ts'), 'src/game/a.ts')
  assert.equal(safePath('./src/a.ts'), 'src/a.ts')

  const problem = entryProblem(entry({ about: ['../outside.js'] }))
  assert.match(problem, /is not a repo-relative path/)
})

test('an entry with no subject is refused — it would have nowhere to live', () => {
  assert.match(entryProblem(entry({ about: [] })), /"about" must be a non-empty array/)
})

// ── the command kind, which is machine-read rather than advisory ─────────────────────────────

test('a command entry carries the command, and an empty one must declare absence', () => {
  const ok = entry({
    id: 'command:build', kind: 'command', about: ['package.json'],
    claim: 'the build command is npm run build',
    command: { name: 'build', value: 'npm run build', absent: false },
  })
  assert.equal(entryProblem(ok), null)

  const unnamed = { ...ok, command: { name: 'build', value: '', absent: false } }
  assert.match(entryProblem(unnamed), /is not a fact about the repository/,
    'a repository with no build command and a command nobody established are different facts')

  const declared = { ...ok, command: { name: 'build', value: '', absent: true } }
  assert.equal(entryProblem(declared), null)

  const wrongName = { ...ok, command: { name: 'deploy', value: 'x', absent: false } }
  assert.match(entryProblem(wrongName), /command\.name must be one of/)
})

test('a command entry reaches a chain with its command intact', () => {
  const { dir, head } = repo({ 'package.json': '{"name":"x"}\n', 'src/a.js': 'alpha\n' })
  deposit(dir, [entry({
    id: 'command:suite', kind: 'command', about: ['package.json'],
    claim: 'the suite command is npm test', observed_at: head,
    command: { name: 'suite', value: 'npm test', absent: false },
    source: { runstamp: '20260830-101500', via: 'verify-established' },
  })])

  const found = chainFor(dir, ['package.json']).chains[0].entries[0]
  assert.equal(found.state, 'fresh')
  assert.deepEqual(found.command, { name: 'suite', value: 'npm test', absent: false })
  assert.equal(found.source.via, 'verify-established')
})

// ── newest-id-wins and compaction ────────────────────────────────────────────────────────────

test('the newest line for an id wins on read, and the older one keeps its place', () => {
  const { dir, head } = repo()
  deposit(dir, [entry({ observed_at: head, claim: 'first reading' })])
  deposit(dir, [entry({ id: 'other', claim: 'another fact', observed_at: head })])
  deposit(dir, [entry({ observed_at: head, claim: 'second reading' })])

  const read = readNode(dir, 'src/a.js')
  assert.equal(read.lines, 3)
  assert.equal(read.shadowed, 1)
  assert.deepEqual(read.entries.map((e) => e.claim), ['second reading', 'another fact'],
    'a re-observation replaces the claim in place rather than jumping to the end')
})

test('compaction drops shadowed and orphaned lines and keeps everything else', () => {
  const { dir, head } = repo()
  deposit(dir, [entry({ observed_at: head, claim: 'first reading' })])
  deposit(dir, [entry({ observed_at: head, claim: 'second reading' })])
  deposit(dir, [entry({ id: 'gone', about: ['src/ui/b.js'], claim: 'about a doomed file', observed_at: head })])

  rmSync(join(dir, 'src', 'ui', 'b.js'))

  const out = compactTree(dir)
  const byNode = Object.fromEntries(out.nodes.map((n) => [n.node, n]))

  assert.deepEqual(byNode['src/a.js'], {
    node: 'src/a.js', kept: 1, dropped_shadowed: 1, dropped_orphaned: 0, dropped_malformed: 0,
  })
  assert.deepEqual(byNode['src/ui/b.js'], {
    node: 'src/ui/b.js', kept: 0, dropped_shadowed: 0, dropped_orphaned: 1, dropped_malformed: 0,
  })

  assert.equal(readNode(dir, 'src/a.js').lines, 1)
  assert.equal(readNode(dir, 'src/a.js').entries[0].claim, 'second reading')
  assert.equal(readNode(dir, 'src/ui/b.js').lines, 0)
})

test('a line that will not parse is counted, never guessed at, and dropped by compaction', () => {
  const { dir, head } = repo()
  deposit(dir, [entry({ observed_at: head })])

  const file = join(dir, '.claude', 'agentics', 'kb', 'src', 'a.js', 'node.jsonl')
  writeFileSync(file, readFileSync(file, 'utf8') + '{"id":"broken",\n')

  assert.equal(readNode(dir, 'src/a.js').malformed, 1)
  assert.equal(verifyTree(dir).malformed, 1)

  compactTree(dir)
  assert.equal(readNode(dir, 'src/a.js').malformed, 0)
  assert.equal(readNode(dir, 'src/a.js').lines, 1)
})

// ── nothing is ever written back by a checker ────────────────────────────────────────────────

test('reading a chain leaves the node file byte-identical', () => {
  const { dir, head } = repo()
  deposit(dir, [entry({ observed_at: head })])

  const file = join(dir, '.claude', 'agentics', 'kb', 'src', 'a.js', 'node.jsonl')
  const before = readFileSync(file, 'utf8')

  chainFor(dir, ['src/a.js'])
  verifyTree(dir)
  commit(dir, { 'src/a.js': 'moved\n' }, 'fix: move it')
  chainFor(dir, ['src/a.js'])

  assert.equal(readFileSync(file, 'utf8'), before,
    'a status computed cannot be stale; a status written down outlives the thing it described')
})

test('the reported entry carries the state and leaves the anchors behind', () => {
  const { dir, head } = repo()
  deposit(dir, [entry({ observed_at: head })])

  const found = chainFor(dir, ['src/a.js']).chains[0].entries[0]
  assert.deepEqual(Object.keys(found).sort(),
    ['about', 'claim', 'id', 'kind', 'node', 'observed_at', 'reason', 'source', 'state'])
})

// ── the index: where this repository knows anything, bought before any path is known ─────────
//
// Before a decomposition runs, the only known paths are the
// question's roots, whose chain is the level-0 node alone — so a planner handed "the chain at
// the roots" is handed almost nothing. The index says where knowledge SITS, the decomposition
// names subtrees against it, and the chains are bought per topic afterwards.

test('the index reports every node that holds something, with counts and kinds', () => {
  const { dir, head } = repo()

  deposit(dir, [
    entry({ id: 'repo-wide', about: ['src/a.js', 'src/ui/b.js'], observed_at: head }),
    entry({ id: 'ui-only', about: ['src/ui/b.js'], observed_at: head }),
    entry({
      id: 'command:build', kind: 'command', about: ['src/ui/b.js'], observed_at: head,
      command: { name: 'build', value: 'npm run build', absent: false },
    }),
  ])

  const payload = indexTree(dir)
  assert.deepEqual(payload.nodes.map((n) => n.node), ['src', 'src/ui/b.js'])
  assert.deepEqual(payload.nodes.find((n) => n.node === 'src'), { node: 'src', entries: 1, kinds: { gotcha: 1 } })
  assert.deepEqual(payload.nodes.find((n) => n.node === 'src/ui/b.js').kinds, { gotcha: 1, command: 1 })
  assert.deepEqual(payload.counts, { nodes: 2, entries: 3 })
})

test('the index computes no state, and does not pretend to have asked', () => {
  const { dir, head } = repo()
  deposit(dir, [entry({ observed_at: head })])
  commit(dir, { 'src/a.js': 'alpha changed\n' }, 'a hand moves the subject')

  const payload = indexTree(dir)

  // The same entry reads `stale` through a chain. The index says only that a node holds one
  // gotcha — freshness costs a git call per entry, and this command exists to be affordable
  // before anybody knows which paths matter.
  assert.equal(stateFor(dir, 'the-trap').state, 'stale')
  assert.deepEqual(payload.nodes[0].kinds, { gotcha: 1 })
  assert.ok(!('dirty_readable' in payload),
    'the absent field is the honest signal that no freshness question was asked here')
  assert.ok(!/fresh|stale|orphaned/.test(JSON.stringify(payload.nodes)),
    'an index that named a state would be a status written down, which is the one thing this ' +
    'tree does not do')
})

test('the index of a repository with no knowledge base is an empty index, not an error', () => {
  const { dir } = repo()
  const payload = indexTree(dir)

  assert.deepEqual(payload.nodes, [])
  assert.deepEqual(payload.counts, { nodes: 0, entries: 0 })
})

test('a malformed line is counted by the index rather than counted as knowledge', () => {
  const { dir, head } = repo()
  deposit(dir, [entry({ observed_at: head })])
  appendFileSync(join(dir, '.claude/agentics/kb/src/a.js/node.jsonl'), '{"id":"broken"}\n', 'utf8')

  const payload = indexTree(dir)
  assert.equal(payload.malformed, 1)
  assert.equal(payload.counts.entries, 1, 'a line the reader cannot use is not a thing known')
})

// ── the CLI: one envelope, one digest, the pattern every courier in this plugin carries ──────

test('the read commands print a digest-covered envelope and exit 0', () => {
  const { dir, head } = repo()
  deposit(dir, [entry({ observed_at: head })])

  const out = execFileSync(process.execPath, [KB, 'chain', dir, 'src/a.js'], { encoding: 'utf8' })
  const parsed = JSON.parse(out)

  assert.equal(typeof parsed.payload_digest, 'string')
  assert.equal(parsed.payload.counts.fresh, 1)
  assert.equal(parsed.payload.chains[0].entries[0].id, 'the-trap')
})

test('the index travels in the same envelope, under the same digest', () => {
  const { dir, head } = repo()
  deposit(dir, [entry({ observed_at: head })])

  const out = execFileSync(process.execPath, [KB, 'index', dir], { encoding: 'utf8' })
  const parsed = JSON.parse(out)

  assert.equal(typeof parsed.payload_digest, 'string')
  assert.deepEqual(parsed.payload.counts, { nodes: 1, entries: 1 })
  assert.deepEqual(parsed.payload.nodes[0].kinds, { gotcha: 1 })
})

test('the writer prints the ledger\'s shape, so its dispatch reads like the recorder\'s', () => {
  const { dir, head } = repo()
  const payload = { entries: [entry({ observed_at: head })] }
  const token = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')

  const out = execFileSync(process.execPath,
    [KB, 'append', dir, '--digest', digestEntry(payload), '--b64', token], { encoding: 'utf8' })

  assert.equal(JSON.parse(out).ok, true)
  assert.equal(stateFor(dir, 'the-trap').state, 'fresh')
})

test('a base64 token damaged in transit is refused with a named reason', () => {
  const { dir, head } = repo()
  const payload = { entries: [entry({ observed_at: head })] }
  const token = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')

  let status = 0
  let out = ''
  try {
    out = execFileSync(process.execPath,
      [KB, 'append', dir, '--digest', 'deadbeef', '--b64', token], { encoding: 'utf8' })
  } catch (err) {
    status = err.status
    out = err.stdout
  }

  assert.equal(status, 1)
  assert.match(JSON.parse(out).error, /digest mismatch/)
  assert.deepEqual(treeNodes(dir), [])
})

// base64 is what makes a deposit SAFE on a command line, not what makes it FIT. Windows caps a
// process's command line at 8191 characters, and in run 20260902-124933 a ten-entry deposit came
// to 8.1 KB, was truncated mid-quote by the shell, and took three attempts — plain, heredoc,
// script file — that each put the same token on the same one line. A path is short whatever the
// deposit weighs, and reading a file is the safe direction: the bytes never cross a model.
test('a deposit too long for a command line arrives by path instead', () => {
  const { dir, head } = repo()
  const payload = { entries: [entry({ observed_at: head })] }
  const token = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  const tokenFile = join(dir, 'deposit.b64')
  writeFileSync(tokenFile, token, 'utf8')

  const out = execFileSync(process.execPath,
    [KB, 'append', dir, '--digest', digestEntry(payload), '--b64-file', tokenFile],
    { encoding: 'utf8' })

  assert.equal(JSON.parse(out).ok, true)
  assert.equal(stateFor(dir, 'the-trap').state, 'fresh',
    'the same entry, on disk, however its bytes reached the writer')
})

test('the digest still covers a deposit that arrived by path — the route is not the trust', () => {
  const { dir, head } = repo()
  const payload = { entries: [entry({ observed_at: head })] }
  const tokenFile = join(dir, 'deposit.b64')
  writeFileSync(tokenFile, Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'), 'utf8')

  let status = 0
  let out = ''
  try {
    out = execFileSync(process.execPath,
      [KB, 'append', dir, '--digest', 'deadbeef', '--b64-file', tokenFile], { encoding: 'utf8' })
  } catch (err) {
    status = err.status
    out = err.stdout
  }

  assert.equal(status, 1)
  assert.match(JSON.parse(out).error, /digest mismatch/)
  assert.deepEqual(treeNodes(dir), [])
})

test('a deposit file that is not there is a named refusal, never a silent empty append', () => {
  const { dir } = repo()

  let status = 0
  let out = ''
  try {
    out = execFileSync(process.execPath,
      [KB, 'append', dir, '--digest', 'deadbeef', '--b64-file', join(dir, 'absent.b64')],
      { encoding: 'utf8' })
  } catch (err) {
    status = err.status
    out = err.stdout
  }

  assert.equal(status, 1)
  assert.match(JSON.parse(out).error, /could not be read/)
})

test('an unknown command names what it expected instead of doing something adjacent', () => {
  const { dir } = repo()
  let out = ''
  try {
    out = execFileSync(process.execPath, [KB, 'harvest', dir], { encoding: 'utf8' })
  } catch (err) {
    out = err.stdout
  }
  assert.match(JSON.parse(out).error, /expected chain, index, verify, compact or append/)
})

// ── stateOf is callable on its own, which is what a later increment will extend ──────────────

test('stateOf answers about one entry without walking anything', () => {
  const { dir, head } = repo()
  const single = entry({ observed_at: head, anchors: [] })

  assert.equal(stateOf(dir, single, []).state, 'fresh',
    'no commit touched the subject, so no anchor has to be read at all')
})

// ---------------------------------------------------------------- the HEAD sentinel (inc 25)
//
// A caller with a tree of its own passes the sha it cut from. A caller with none — the survey,
// depositing an absence it just observed — has no filesystem and no git, and a model asked for a
// sha invents one that orders history confidently and wrongly. So the sentinel is resolved in the
// process standing in the repository, exactly as the anchors are.

test('the HEAD sentinel is resolved where the repository is, not where the caller is', () => {
  const { dir, head } = repo()
  const entry = {
    id: 'absence:1', claim: 'a search of src found nothing', kind: 'absence',
    about: ['src'], observed_at: 'HEAD', source: { via: 'survey-absence' },
  }
  const payload = { entries: [entry] }

  assert.equal(appendEntries(dir, payload, digestEntry(payload)).ok, true)

  const stored = readNode(dir, 'src').entries[0]
  assert.equal(stored.observed_at, head, 'the sentinel became the commit the repo is on')
  assert.deepEqual(stored.anchors, [], 'a directory subject contributes no file anchor')
})

test('an absence about a directory reads fresh until something touches that directory', () => {
  const { dir } = repo()
  const entry = {
    id: 'absence:1', claim: 'a search of src found nothing', kind: 'absence',
    about: ['src'], observed_at: 'HEAD', source: { via: 'survey-absence' },
  }
  appendEntries(dir, { entries: [entry] })

  const before = chainFor(dir, ['src']).chains[0].entries.find((e) => e.id === 'absence:1')
  assert.equal(before.state, 'fresh')

  write(dir, { 'src/c.js': 'charlie\n' })
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'a hand commit into the searched ground')

  const after = chainFor(dir, ['src']).chains[0].entries.find((e) => e.id === 'absence:1')
  assert.equal(after.state, 'stale',
    'the ground moved, so "I looked and it was not there" is a lead rather than a fact')
})

test('the sentinel is refused where git cannot answer, never written empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-kb-nogit-')).split('\\').join('/')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.js'), 'alpha\n', 'utf8')

  const out = appendEntries(dir, { entries: [{
    id: 'absence:1', claim: 'c', kind: 'absence', about: ['src'], observed_at: 'HEAD',
  }] })

  assert.equal(out.ok, false)
  assert.match(out.error, /git could not say what commit/)
})
