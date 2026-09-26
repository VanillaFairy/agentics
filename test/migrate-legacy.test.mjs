// test/migrate-legacy.test.mjs — the one-shot copy of 3.2.0 state into `.agentics/`: in-flight
// work arrives intact, nothing is deleted, and a second run changes nothing.
//
// Design: docs/DESIGN.md#self-checks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { evidenceOf } from '../lib/effort.mjs'
import { readLog, seqMax } from '../lib/ledger.mjs'
import { heldBy, poolConfig } from '../lib/locks.mjs'
import { efforts } from '../lib/status.mjs'
import { agenticsRoot, configPath, effortStateDir, legacyDir, readConfig, safeSlug } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { apply, plan } from '../tools/migrate-legacy.mjs'

const CLI = fileURLToPath(new URL('../tools/migrate-legacy.mjs', import.meta.url))
const OLD = '.claude/agentics'
const STAMP = '20260926-120000'

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function put(repo, files) {
  for (const [path, text] of Object.entries(files)) {
    const full = join(repo, ...path.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
}

const jsonl = (...lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'

/** Every file under `dir` (git's own directory aside), repo-relative and forward-slashed, with its bytes. */
function snapshot(repo, dir) {
  const out = new Map()
  const walk = (d) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else out.set(relative(repo, full).split('\\').join('/'), readFileSync(full, 'utf8'))
    }
  }
  walk(join(repo, ...dir.split('/')))
  return out
}

/** A repository as 3.2.0 left it: one effort mid-execution, its committed design documents, the pool config. */
function legacyRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-migrate-'))
  git(repo, 'init', '-q', '-b', 'main')
  const e = OLD + '/efforts/e1/'
  put(repo, {
    [e + 'effort.json']: JSON.stringify({ about: 'parse configs', roots: ['.'], opened_at: '2026-09-20T10:00:00.000Z' }),
    [e + 'nodes.jsonl']: jsonl(
      { kind: 'node', node: { id: '.', kind: 'composite', title: 'the change', defines: [{ id: 'D1', text: 'do it' }] }, seq: 1 },
      { kind: 'node', node: { id: 'a', kind: 'leaf', title: 'do a', rigor: 'tdd', locus: ['src/a.js'], decisions: ['D1'], acceptance: [{ text: 'a works', check: 'node --test', decisions: ['D1'] }] }, seq: 2 },
      { kind: 'node', node: { id: 'd', kind: 'design', level: 'component', design_doc: 'docs/agentics/designs/e1/d.md', title: 'later', decisions: ['D1'] }, seq: 3 },
    ),
    [e + 'events.jsonl']: jsonl(
      { kind: 'planned', node: '.', execution: '', by: 'session', seq: 4 },
      { kind: 'dispatched', node: 'a', execution: STAMP, role: 'implementer', round: 1, seq: 5 },
      { kind: 'parked', node: 'a', execution: STAMP, return: 'needs_decision', question: 'which loader?', seq: 6 },
    ),
    [e + 'seq']: '8',
    [e + '.lock']: JSON.stringify({ pid: 1, host: 'gone', at: '2026-09-20T10:00:00.000Z' }),
    [e + 'branch.json']: JSON.stringify({ base_branch: 'main', base_sha: 'abc' }) + '\n',
    [e + 'evidence/20260920-100000-survey.json']: '{"coverage":{"complete":true}}\n',
    [e + 'evidence/20260920-100000-survey.anchor']: '{"observed_at":"abc","ground":["."]}\n',
    [e + 'knowledge/g-12345678.md']: '---\n{"id":"g-12345678"}\n---\nWhen x, do y.\n',
    [e + 'executions/' + STAMP + '/execution.json']: JSON.stringify({ stamp: STAMP, root: '.' }),
    [e + 'executions/' + STAMP + '/state.jsonl']: jsonl({ kind: 'checkpoint', reason: 'session limit', seq: 7 }),
    [e + 'executions/' + STAMP + '/journal.jsonl']: jsonl({ kind: 'series-done', node: 'a', seq: 8 }),
    [e + 'reports/' + STAMP + '-a-implementer-r1.md']: 'report\n',
    [e + 'locks/locus/0badf00d.lock']: JSON.stringify({ path: 'src/a.js', node: 'a', execution: STAMP }),
    [OLD + '/slots/config.json']: JSON.stringify({ max_parallel: 3 }),
    [OLD + '/slots/1.lock']: JSON.stringify({ effort: 'e1', execution: STAMP, node: 'a' }),
    [OLD + '/runs/20260901-100000/plan.json']: '{}',
    [OLD + '/context/abc-1.md']: 'excerpts\n',
    'docs/agentics/designs/e1/root.md': '# The change\n',
    'docs/agentics/designs/e1/d.md': '# Later\n',
    'src/a.js': 'export const a = 1\n',
  })
  git(repo, 'add', 'docs', 'src')
  git(repo, 'commit', '-q', '-m', 'the project, with its design documents')
  return repo
}

test('planning changes nothing', () => {
  const repo = legacyRepo()
  const before = snapshot(repo, '.')
  const p = plan(repo)
  assert.ok(p.copies.length > 0)
  assert.deepEqual(snapshot(repo, '.'), before)
})

test('an effort mid-execution arrives with its tree, statuses, seq, evidence and open execution intact', () => {
  const repo = legacyRepo()
  apply(plan(repo))

  const tree = readTree(repo, 'e1')
  assert.deepEqual([...tree.nodes.keys()].sort(), ['.', 'a', 'd'])
  assert.equal(tree.status.get('a').status, 'parked')
  assert.equal(tree.status.get('d').status, 'open')
  assert.equal(tree.malformed, 0)
  assert.equal(seqMax(repo, 'e1'), 8)
  assert.equal(readLog(repo, 'e1', 'journal:' + STAMP).entries.length, 1)

  const [listed] = efforts(repo).efforts
  assert.equal(listed.effort, 'e1')
  assert.equal(listed.about, 'parse configs')
  assert.deepEqual(listed.executions.map((x) => [x.stamp, x.closed, x.status]), [[STAMP, false, 'checkpoint']])

  const evidence = evidenceOf(repo, 'e1')
  assert.deepEqual(evidence.map((it) => it.kind), ['survey'])
  assert.equal(evidence[0].stamp, '20260920-100000')
})

test('every file of the effort lands in its .state byte for byte, except the effort\'s own lock', () => {
  const repo = legacyRepo()
  const old = snapshot(repo, OLD + '/efforts/e1')
  apply(plan(repo))
  const state = effortStateDir(repo, 'e1')
  for (const [path, text] of old) {
    const rel = path.slice((OLD + '/efforts/e1/').length)
    if (rel === '.lock') {
      assert.equal(existsSync(join(state, '.lock')), false, 'a lock names a process, and the process is gone')
      continue
    }
    assert.equal(readFileSync(join(state, ...rel.split('/')), 'utf8'), text, rel)
  }
})

test('design documents land in the effort\'s legacy folder, and the pool size in config.json', () => {
  const repo = legacyRepo()
  apply(plan(repo))
  assert.equal(readFileSync(join(legacyDir(repo, 'e1'), 'root.md'), 'utf8'), '# The change\n')
  assert.equal(readFileSync(join(legacyDir(repo, 'e1'), 'd.md'), 'utf8'), '# Later\n')
  assert.equal(safeSlug(basename(legacyDir(repo, 'e1'))), null, 'no sub-effort can be named like the legacy folder')
  assert.equal(readConfig(repo).max_parallel, 3)
  assert.ok(existsSync(configPath(repo)))
})

test('nothing is deleted: every legacy file, committed or not, still exists, and git sees no deletion', () => {
  const repo = legacyRepo()
  const before = snapshot(repo, OLD)
  const docs = snapshot(repo, 'docs')
  apply(plan(repo))
  assert.deepEqual(snapshot(repo, OLD), before)
  assert.deepEqual(snapshot(repo, 'docs'), docs)
  assert.equal(git(repo, 'status', '--porcelain').split('\n').filter((l) => /^ ?D/.test(l)).length, 0)
})

test('the committed files that were copied are listed for the user to delete', () => {
  const repo = legacyRepo()
  const p = plan(repo)
  assert.deepEqual([...p.committed].sort(), ['docs/agentics/designs/e1/d.md', 'docs/agentics/designs/e1/root.md'])
  assert.ok(p.notes.some((n) => /delet/i.test(n)))
})

test('pre-tree state and caches are named as left behind, never copied', () => {
  const repo = legacyRepo()
  const p = plan(repo)
  assert.ok(p.left.includes(OLD + '/runs'))
  assert.ok(p.left.includes(OLD + '/context'))
  assert.ok(!p.copies.some((c) => /[\\/]runs[\\/]|[\\/]context[\\/]|1\.lock$/.test(c.from)))
})

test('an effort name that breaks the segment rule is refused whole and reported', () => {
  const repo = legacyRepo()
  put(repo, {
    [OLD + '/efforts/old_name/nodes.jsonl']: jsonl({ kind: 'node', node: { id: '.', kind: 'composite', title: 't' }, seq: 1 }),
    'docs/agentics/designs/old_name/root.md': '# Old\n',
    [OLD + '/efforts/Dotted.Name/effort.json']: '{}',
  })
  const p = plan(repo)
  assert.deepEqual(p.refused.map((r) => r.name).sort(), ['Dotted.Name', 'old_name'])
  assert.ok(p.refused.every((r) => /segment|name/.test(r.why)))
  assert.ok(!p.copies.some((c) => /old_name|Dotted\.Name/.test(c.from)))
  assert.deepEqual(p.efforts.map((e) => e.name), ['e1'])
})

test('an effort whose target already holds other bytes is refused whole, and nothing of it is copied', () => {
  const repo = legacyRepo()
  mkdirSync(effortStateDir(repo, 'e1'), { recursive: true })
  writeFileSync(join(effortStateDir(repo, 'e1'), 'branch.json'), '{"base_sha":"other"}\n')
  const p = plan(repo)
  assert.ok(p.refused.some((r) => r.name === 'e1' && /differ/.test(r.why)))
  assert.ok(!p.copies.some((c) => c.to.startsWith(effortStateDir(repo, 'e1'))))
  assert.ok(!p.copies.some((c) => c.to.startsWith(legacyDir(repo, 'e1'))))
})

test('a designs-only effort gets its legacy folder and no state', () => {
  const repo = legacyRepo()
  put(repo, { 'docs/agentics/designs/only-docs/root.md': '# Docs only\n' })
  const p = plan(repo)
  const only = p.efforts.find((e) => e.name === 'only-docs')
  assert.equal(only.state, false)
  assert.equal(only.designs, true)
  apply(p)
  assert.equal(readFileSync(join(legacyDir(repo, 'only-docs'), 'root.md'), 'utf8'), '# Docs only\n')
  assert.equal(existsSync(effortStateDir(repo, 'only-docs')), false)
})

test('a second run copies nothing and changes nothing', () => {
  const repo = legacyRepo()
  apply(plan(repo))
  const after = snapshot(repo, '.')
  const again = plan(repo)
  assert.deepEqual(again.copies, [])
  assert.deepEqual(again.refused, [])
  assert.equal(apply(again).copied, 0)
  assert.deepEqual(snapshot(repo, '.'), after)
})

test('the CLI is a dry run without --yes, and copies with it', () => {
  const repo = legacyRepo()
  const dry = JSON.parse(execFileSync(process.execPath, [CLI, repo], { encoding: 'utf8' }))
  assert.equal(dry.applied, false)
  assert.ok(dry.copies.length > 0)
  assert.equal(existsSync(effortStateDir(repo, 'e1')), false)
  const wet = JSON.parse(execFileSync(process.execPath, [CLI, repo, '--yes'], { encoding: 'utf8' }))
  assert.equal(wet.applied, true)
  assert.equal(readTree(repo, 'e1').nodes.size, 3)
})

const seqsIn = (text) => text.split('\n').flatMap((l) => {
  try { const s = JSON.parse(l).seq; return Number.isInteger(s) ? [s] : [] } catch { return [] }
})

test('in-flight extras arrive byte for byte and read as before: a torn state line, a counter behind the logs, a job pid, a locus lock', () => {
  const repo = legacyRepo()
  const e = OLD + '/efforts/e1/'
  const torn = jsonl({ kind: 'checkpoint', reason: 'session limit', seq: 7 }) + '{"kind":"chec'
  put(repo, {
    [e + 'seq']: '2',
    [e + 'executions/' + STAMP + '/state.jsonl']: torn,
    [e + 'executions/' + STAMP + '/jobs/verify.pid']: String(process.pid),
  })
  const old = snapshot(repo, OLD + '/efforts/e1')
  const highest = Math.max(...[...old].filter(([p]) => p.endsWith('.jsonl')).flatMap(([, t]) => seqsIn(t)))
  apply(plan(repo))
  const state = effortStateDir(repo, 'e1')
  assert.equal(readFileSync(join(state, 'executions', STAMP, 'state.jsonl'), 'utf8'), torn)
  assert.equal(readFileSync(join(state, 'executions', STAMP, 'jobs', 'verify.pid'), 'utf8'), String(process.pid))
  assert.equal(seqMax(repo, 'e1'), highest)
  const [listed] = efforts(repo).efforts
  assert.deepEqual(listed.executions.map((x) => [x.stamp, x.closed, x.status]), [[STAMP, false, 'checkpoint']])
  const lock = heldBy(repo).locus.find((l) => l.effort === 'e1')
  assert.deepEqual([lock.path, lock.node, lock.execution], ['src/a.js', 'a', STAMP])
})

test('a copy stopped halfway is finished by the next run, never refused for its own files', () => {
  const repo = legacyRepo()
  const p = plan(repo)
  const half = Math.floor(p.copies.length / 2)
  apply({ ...p, copies: p.copies.slice(0, half) })
  const next = plan(repo)
  assert.deepEqual(next.refused, [])
  assert.deepEqual(next.copies.map((c) => c.to).sort(), p.copies.slice(half).map((c) => c.to).sort())
  apply(next)
  assert.deepEqual(plan(repo).copies, [])
})

test('an existing .agentics/.gitignore keeps its bytes', () => {
  const repo = legacyRepo()
  put(repo, { '.agentics/.gitignore': 'custom\n' })
  apply(plan(repo))
  assert.equal(readFileSync(join(agenticsRoot(repo), '.gitignore'), 'utf8'), 'custom\n')
})

test('apply never overwrites a target that appeared after planning', () => {
  const repo = legacyRepo()
  const p = plan(repo)
  const { to } = p.copies[0]
  mkdirSync(dirname(to), { recursive: true })
  writeFileSync(to, 'written in between\n')
  apply(p)
  assert.equal(readFileSync(to, 'utf8'), 'written in between\n')
})

test('committed lists only files of efforts that were migrated', () => {
  const repo = legacyRepo()
  put(repo, {
    [OLD + '/efforts/old_name/nodes.jsonl']: jsonl({ kind: 'node', node: { id: '.', kind: 'composite', title: 't' }, seq: 1 }),
    'docs/agentics/designs/old_name/root.md': '# Old\n',
    'docs/agentics/designs/e2/root.md': '# Two\n',
    '.agentics/e2/.legacy/root.md': 'other bytes\n',
  })
  git(repo, 'add', OLD, 'docs')
  git(repo, 'commit', '-q', '-m', 'legacy state committed before it ignored itself')
  const p = plan(repo)
  assert.ok(p.refused.some((r) => r.name === 'e2'))
  assert.ok(!p.committed.some((f) => f.includes('/old_name/')))
  assert.ok(!p.committed.some((f) => f.includes('/designs/e2/')))
  assert.ok(p.committed.includes(OLD + '/efforts/e1/nodes.jsonl'))
})

test('run from a linked worktree, sources come from the worktree and targets land in the main checkout', () => {
  const repo = legacyRepo()
  const wt = mkdtempSync(join(tmpdir(), 'agentics-migrate-wt-'))
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'side')
  const text = jsonl({ kind: 'node', node: { id: '.', kind: 'composite', title: 'w' }, seq: 1 })
  put(wt, { [OLD + '/efforts/w1/nodes.jsonl']: text })
  apply(plan(wt))
  assert.equal(readFileSync(join(effortStateDir(repo, 'w1'), 'nodes.jsonl'), 'utf8'), text)
  assert.equal(existsSync(join(wt, '.agentics')), false)
})

for (const [label, legacy, existing] of [['identical', '{"max_parallel":3}', '{"max_parallel":3}'], ['different', '{"max_parallel":3}', '{"max_parallel":5}']]) {
  test('an existing config.json ' + label + ' to slots/config.json is kept, and refused only when it differs', () => {
    const repo = legacyRepo()
    put(repo, { [OLD + '/slots/config.json']: legacy, '.agentics/config.json': existing })
    const p = plan(repo)
    assert.ok(!p.copies.some((c) => c.to === configPath(repo)))
    assert.equal(p.refused.some((r) => r.name === 'config.json'), legacy !== existing)
    apply(p)
    assert.equal(readFileSync(configPath(repo), 'utf8'), existing)
  })
}

test('a slots/config.json that is not JSON is copied as bytes, and poolConfig notes it', () => {
  const repo = legacyRepo()
  put(repo, { [OLD + '/slots/config.json']: 'not json\n' })
  apply(plan(repo))
  assert.equal(readFileSync(configPath(repo), 'utf8'), 'not json\n')
  assert.notEqual(poolConfig(repo).note, '')
})

test('upper-case, double-dash and over-long names are each refused once, both halves left alone', () => {
  const repo = legacyRepo()
  const bad = ['Upper', 'a--b', 'x'.repeat(121)]
  for (const name of bad) {
    put(repo, {
      [OLD + '/efforts/' + name + '/nodes.jsonl']: jsonl({ kind: 'node', node: { id: '.', kind: 'composite', title: 't' }, seq: 1 }),
      ['docs/agentics/designs/' + name + '/root.md']: '# ' + name + '\n',
    })
  }
  const p = plan(repo)
  for (const name of bad) {
    assert.equal(p.refused.filter((r) => r.name === name).length, 1, name)
    assert.ok(!p.copies.some((c) => c.from.split('\\').join('/').includes('/' + name + '/')), name)
  }
})

test('a note says nothing was deleted', () => {
  const p = plan(legacyRepo())
  assert.ok(p.notes.some((n) => /nothing/i.test(n) && /delet/i.test(n)))
})
