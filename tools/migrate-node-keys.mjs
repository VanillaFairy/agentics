// tools/migrate-node-keys.mjs — the one-shot rename of what a repository holds under a node's
// spelled-out id to the node's bounded key (docs/DESIGN.md#storage), run once, on the user's go.
//
// Design: docs/DESIGN.md#self-checks (a format change ships a one-shot migration, never a
// permanent second reader).
//
// Only a node whose id, its `/` spelled `.`, is longer than NAME_KEY_MAX has a key that differs.
// For each: its branch is renamed, its worktree moved, and every file the store names after it —
// a spec copy, a respec brief or rulings, a report, a brief, a close, a review round, a fixes file,
// a card — renamed to the key. A progress file loses its `.progress` infix, whatever its node.
// Records point at said files, merges and gates by path, so those stay as they are. Nodes are taken
// longest id first, so a file is claimed by the longest name it carries. A target that exists
// refuses that node whole. A second run finds nothing to do. The default is a dry run; `--yes`
// renames.

import { existsSync, readdirSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { readLog } from '../lib/ledger.mjs'
import {
  agenticsRoot, effortStateDir, executionsRoot, flat, git, nodeKey, posix, safeSlug, worktreeOf,
} from '../lib/store.mjs'

const EXECUTION_DIRS = ['briefs', 'closes', 'reviews', 'fixes', 'cards']
const PROGRESS = '.progress.json'

const entriesOf = (dir, dirs) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() === dirs).map((e) => e.name)
  } catch {
    return []
  }
}

const branchExists = (root, name) => git(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + name]).ok

/** Every directory of one effort whose files the store names after a node. */
function stateDirs(root, effort) {
  const state = effortStateDir(root, effort)
  const out = ['specs', 'respec', 'reports'].map((d) => join(state, d))
  for (const stamp of entriesOf(executionsRoot(root, effort), true)) {
    for (const d of EXECUTION_DIRS) out.push(join(executionsRoot(root, effort), stamp, d))
  }
  return out
}

/** Pure. `name` with the node's old spelling, delimited as the store delimits it, as the key; null when absent. */
export function renamed(name, old, key) {
  const at = [...name.matchAll(new RegExp('(^|-)' + old.replace(/[.]/g, '\\.') + '(?=[-@])', 'g'))][0]
  if (!at) return null
  const start = at.index + at[1].length
  return name.slice(0, start) + key + name.slice(start + old.length)
}

/** The renames a repository needs, without performing them. */
export function plan(repo) {
  const root = resolve(repo)
  const out = { root: posix(root), branches: [], worktrees: [], files: [], refused: [] }
  const claimed = new Set()

  for (const effort of entriesOf(agenticsRoot(root), true).filter((e) => safeSlug(e) === e).sort()) {
    const ids = [...new Set(readLog(root, effort, 'nodes').entries.map((e) => e.node && e.node.id).filter((id) => typeof id === 'string'))]
    const dirs = stateDirs(root, effort)

    for (const id of ids.filter((i) => flat(i) !== nodeKey(i)).sort((a, b) => b.length - a.length)) {
      const old = flat(id)
      const key = nodeKey(id)
      const branch = { from: 'agentics/' + effort + '--' + old, to: 'agentics/' + effort + '--' + key }
      const worktree = { from: posix(join(root, '.claude', 'worktrees', effort + '--' + old)), to: worktreeOf(root, effort, id) }
      const files = []
      for (const dir of dirs) {
        for (const name of entriesOf(dir, false)) {
          const to = claimed.has(join(dir, name)) ? null : renamed(name, old, key)
          if (to) files.push({ from: join(dir, name), to: join(dir, to) })
        }
      }
      const moves = [
        ...(branchExists(root, branch.from) ? [{ kind: 'branch', ...branch }] : []),
        ...(existsSync(worktree.from) ? [{ kind: 'worktree', ...worktree }] : []),
        ...files.map((f) => ({ kind: 'file', ...f })),
      ]
      const clash = moves.find((m) => (m.kind === 'branch' ? branchExists(root, m.to) : existsSync(m.to)))
      if (clash) {
        out.refused.push({ effort, id, why: posix(clash.to) + ' exists — nothing of this node was renamed' })
        continue
      }
      for (const m of moves) {
        if (m.kind === 'file') claimed.add(m.from)
        out[m.kind === 'branch' ? 'branches' : m.kind === 'worktree' ? 'worktrees' : 'files'].push({ from: posix(m.from), to: posix(m.to) })
      }
    }

    const reports = join(effortStateDir(root, effort), 'reports')
    for (const name of entriesOf(reports, false).filter((n) => n.endsWith(PROGRESS))) {
      const done = out.files.find((f) => f.from === posix(join(reports, name)))
      const from = done ? done.to : posix(join(reports, name))
      const to = from.slice(0, -PROGRESS.length) + '.json'
      if (existsSync(to)) out.refused.push({ effort, id: '', why: to + ' exists — ' + from + ' was left as it is' })
      else if (done) done.to = to
      else out.files.push({ from, to })
    }
  }
  return out
}

/** Perform what the plan lists: branches first, then worktrees, then files. */
export function apply(p) {
  for (const b of p.branches) {
    const r = git(p.root, ['branch', '-m', b.from, b.to])
    if (!r.ok) throw new Error('git branch -m ' + b.from + ' failed: ' + r.stderr)
  }
  for (const w of p.worktrees) {
    const r = git(p.root, ['worktree', 'move', w.from, w.to])
    if (!r.ok) throw new Error('git worktree move ' + w.from + ' failed: ' + r.stderr)
  }
  for (const f of p.files) renameSync(f.from, f.to)
  return { branches: p.branches.length, worktrees: p.worktrees.length, files: p.files.length }
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  const argv = process.argv.slice(2)
  const repo = argv.find((a) => !a.startsWith('--')) || '.'
  const p = plan(repo)
  const applied = argv.includes('--yes')
  if (applied) apply(p)
  console.log(JSON.stringify({ applied, ...p }, null, 1))
}
