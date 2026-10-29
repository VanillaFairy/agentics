// test/harness/template.mjs — a world built once per shape in a process, and a private copy of it
// per test.
//
// A copied linked worktree still names the template's absolute paths in `.git/worktrees/<name>/gitdir`
// and in its own `.git`, and an unrepaired one quietly resolves back into the template. The
// template's worktrees are listed once, when it is built, and every copy repairs each of them, so a
// world that grows a worktree needs no list kept by hand.

import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr)
  return r.stdout
}

const posix = (p) => String(p).split('\\').join('/')

let root = null
const templates = new Map()

function templateRoot() {
  if (root) return root
  root = mkdtempSync(join(tmpdir(), 'agentics-template-'))
  process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }) } catch { /* the OS gets it */ } })
  return root
}

/** The linked worktrees of the repository at `dir`, relative to it. */
function linkedWorktrees(dir) {
  const paths = git(dir, 'worktree', 'list', '--porcelain').split('\n')
    .filter((l) => l.startsWith('worktree ')).map((l) => resolve(l.slice('worktree '.length)))
  return paths.slice(1).map((p) => posix(relative(resolve(dir), p)))
}

/**
 * A private copy, under a fresh `prefix…` directory removed in `t.after`, of the repository
 * `build(dir)` makes. `build` runs once per `key` in this process, into a directory no test is ever
 * handed, so nothing can write into a template. `build` returns what every copy shares (shas, ids);
 * a path in it names the template, so it returns none. Returns `{dir, built}`.
 */
export function templated(t, prefix, key, build) {
  if (!templates.has(key)) {
    const dir = mkdtempSync(join(templateRoot(), 'tmpl-'))
    const built = build(dir)
    templates.set(key, { dir, built, worktrees: linkedWorktrees(dir) })
  }
  const { dir: template, built, worktrees } = templates.get(key)
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cpSync(template, dir, { recursive: true })
  if (worktrees.length) git(dir, 'worktree', 'repair', ...worktrees.map((w) => join(dir, w)))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, built }
}
