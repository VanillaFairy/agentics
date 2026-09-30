// test/harness/evidence-fixture.mjs — the repositories, items and CLI calls the
// test/evidence-anchors*.test.mjs files share.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkAnchors, recordItems, snapshotSpec } from '../../lib/evidence.mjs'
import { readProjectLog } from '../../lib/ledger.mjs'
import { canonical, fnv1a } from '../../lib/plan-digest.mjs'
import { evidenceSnapshotsDir } from '../../lib/store.mjs'

export const CLI = fileURLToPath(new URL('../../lib/evidence.mjs', import.meta.url))
export const RETURN = '20260926-100000-survey'

export const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

export const lines = (n, word = 'line') => Array.from({ length: n }, (_, i) => word + ' ' + (i + 1))
export const text = (ls, eol = '\n') => ls.join(eol) + eol

export function write(dir, path, content) {
  const full = join(dir, ...path.split('/'))
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

export function gitRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-anchors-'))
  git(dir, 'init', '-q', '.')
  git(dir, 'config', 'user.email', 't@t')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'core.autocrlf', 'false')
  for (const [path, content] of Object.entries(files)) write(dir, path, content)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return dir
}

export const commit = (dir) => {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'edit')
  return git(dir, 'rev-parse', 'HEAD')
}

export const itemOf = (item) => ({
  question: 'q', topic: 't', ground: ['src'], spans: [], queries: [], sources: [], rests_on: [], ...item,
})

/** Record one item through the real recorder and return its id. */
export function record(repo, item, opts) {
  const out = recordItems(repo, RETURN, [itemOf(item)], opts)
  assert.equal(out.ok, true, JSON.stringify(out))
  return out.ids[0]
}

export const span = (path, start, end, extra = {}) => ({
  kind: 'behaviour', claim: path + ':' + start + '-' + end + ' says what it says',
  spans: [{ path, start, end, at: '' }], ...extra,
})

export const stateOf = (repo, id, opts) => checkAnchors(repo, [id], opts)[0]

/** The 30-line file every span test starts from, with its span 10-14 recorded. */
export function spanFixture() {
  const repo = gitRepo({ 'src/a.js': text(lines(30)) })
  return { repo, id: record(repo, span('src/a.js', 10, 14)) }
}

export const withLine = (ls, lineNo, value) => ls.map((l, i) => (i === lineNo - 1 ? value : l))

/** A gitignored 12-line spec with its span 3-5 recorded at a snapshot, and that snapshot's file. */
export function specFixture() {
  const repo = gitRepo({ 'src/a.js': text(lines(3)), '.agentics/.gitignore': '*\n' })
  const path = '.agentics/e1/DESIGN.md'
  const spec = lines(12, 'spec')
  write(repo, path, text(spec))
  const at = snapshotSpec(repo, text(spec))
  const id = record(repo, {
    kind: 'behaviour', claim: 'the spec says so', ground: ['.agentics/e1'], spans: [{ path, start: 3, end: 5, at }],
  })
  return { repo, path, spec, id, file: join(evidenceSnapshotsDir(repo), at.slice('snapshot:'.length) + '.txt') }
}

/** A linked worktree of `repo` on a new branch, outside the main checkout. */
export function linkedWorktree(repo) {
  const wt = join(mkdtempSync(join(tmpdir(), 'agentics-anchors-wt-')), 'wt')
  git(repo, 'worktree', 'add', '-q', '-b', 'side', wt)
  return wt
}

/** The store's lines of one kind, in seq order. */
export const logOf = (repo, kind) => readProjectLog(repo, 'items').entries.filter((e) => e.kind === kind)

/** Run the CLI against `repo`: every verb exits 0 and prints a digest-covered envelope. */
export const cli = (repo) => (...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args, '--repo', repo], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.payload_digest, fnv1a(canonical(out.payload)))
  return out.payload
}

export const token = (value) => ['--digest', fnv1a(canonical(value)), '--b64', Buffer.from(JSON.stringify(value)).toString('base64')]
