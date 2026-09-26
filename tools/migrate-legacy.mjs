// tools/migrate-legacy.mjs — the one-shot copy of a repository's 3.2.0 agentics state into
// `.agentics/`, run once, on the user's go (D8).
//
// Design: docs/DESIGN.md#self-checks (a format change ships a one-shot migration, never a
// permanent second reader).
//
// What is copied, and where:
//   .claude/agentics/efforts/<e>/**      → .agentics/<e>/.state/**   (not the effort's own .lock)
//   docs/agentics/designs/<e>/**         → .agentics/<e>/.legacy/**
//   .claude/agentics/slots/config.json   → .agentics/config.json
//
// It copies and never deletes, moves or overwrites a user's file: each copy lands beside its
// target and is renamed in, so a stop mid-file leaves no partial target. In-flight executions,
// parked nodes and the seq counter arrive byte for byte, and the old paths stay until the user
// removes them. Committed files among the sources are listed for the user to delete with git. A
// name the segment rule refuses, or a target that already holds other bytes, refuses that effort
// whole. A second run finds every target identical and copies nothing. The default is a dry run;
// `--yes` copies.

import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { configPath, effortStateDir, git, legacyDir, mkdirState, posix, safeSlug } from '../lib/store.mjs'

const OLD = ['.claude', 'agentics']
const DESIGNS = ['docs', 'agentics', 'designs']
const LEFT = ['runs', 'kb', 'programmes', 'legacy', 'context']

const dirsIn = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/** Every file below `dir`, as paths relative to it. */
function filesBelow(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) filesBelow(full, base, out)
    else out.push(relative(base, full))
  }
  return out
}

const sameBytes = (a, b) => readFileSync(a).equals(readFileSync(b))

/** The copies a repository needs, without performing them. */
export function plan(repo) {
  const root = resolve(repo)
  const oldEfforts = join(root, ...OLD, 'efforts')
  const oldDesigns = join(root, ...DESIGNS)
  const out = { efforts: [], copies: [], refused: [], committed: [], left: [], notes: [] }

  const names = [...new Set([...dirsIn(oldEfforts), ...dirsIn(oldDesigns)])].sort()
  const tracked = new Set(git(root, ['ls-files', '-z', '--', posix(join(...OLD)), posix(join(...DESIGNS))])
    .stdout.split('\0').filter(Boolean))

  for (const name of names) {
    if (safeSlug(name) !== name) {
      out.refused.push({ name, why: 'the name breaks the segment rule (lower-case letters, digits and single dashes) — rename the directory and run again' })
      continue
    }
    const pairs = []
    const state = join(oldEfforts, name)
    if (existsSync(state)) {
      for (const rel of filesBelow(state)) if (rel !== '.lock') pairs.push({ from: join(state, rel), to: join(effortStateDir(root, name), rel) })
    }
    const designs = join(oldDesigns, name)
    if (existsSync(designs)) {
      for (const rel of filesBelow(designs)) pairs.push({ from: join(designs, rel), to: join(legacyDir(root, name), rel) })
    }
    const clash = pairs.find((p) => existsSync(p.to) && !sameBytes(p.from, p.to))
    if (clash) {
      out.refused.push({ name, why: posix(clash.to) + ' exists and differs from ' + posix(clash.from) + ' — nothing of this effort was copied' })
      continue
    }
    out.efforts.push({ name, state: existsSync(state), designs: existsSync(designs) })
    out.copies.push(...pairs.filter((p) => !existsSync(p.to)))
    for (const p of pairs) {
      const rel = posix(relative(root, p.from))
      if (tracked.has(rel)) out.committed.push(rel)
    }
  }

  const config = join(root, ...OLD, 'slots', 'config.json')
  if (existsSync(config)) {
    if (!existsSync(configPath(root))) out.copies.push({ from: config, to: configPath(root) })
    else if (!sameBytes(config, configPath(root))) out.refused.push({ name: 'config.json', why: posix(configPath(root)) + ' exists and differs — keep the one you want' })
  }

  for (const dir of LEFT) if (existsSync(join(root, ...OLD, dir))) out.left.push(posix(join(...OLD, dir)))

  out.notes.push('Nothing was deleted. Once the copies are checked, remove ' + posix(join(...OLD)) + ' and ' + posix(join(...DESIGNS)) + ' yourself.')
  if (out.committed.length) out.notes.push(out.committed.length + ' committed file(s) were copied; delete them with git rm when you are ready.')
  return out
}

/** Copy what the plan lists. Never deletes, moves or overwrites a user's file: each copy is written
 *  beside its target and renamed into place, so a stop mid-file leaves no partial target. */
export function apply(p, { copy = copyFileSync } = {}) {
  let copied = 0
  for (const { from, to } of p.copies) {
    if (existsSync(to)) continue
    mkdirState(dirname(to))
    const tmp = to + '.' + process.pid + '.migrating'
    try {
      copy(from, tmp)
      renameSync(tmp, to)
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    }
    copied++
  }
  return { copied }
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
