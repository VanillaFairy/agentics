// test/harness/seeded-repo.mjs — a fresh git repository holding given files in one commit, built
// once per distinct request in this process and copied for every later caller, so a test file pays
// git for its fixture once, not once per test.

import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const run = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr)
}

const seeds = new Map()
process.on('exit', () => { for (const dir of seeds.values()) rmSync(dir, { recursive: true, force: true }) })

/**
 * A new directory named `prefix…` holding `files` (path -> content) in one commit `message` on
 * `branch` ('' keeps git's default), authored by `identity`. The seed is keyed on everything but
 * `prefix`; each call copies it.
 */
export function seededRepo(prefix, { branch = '', message, files, identity = { email: 't@t', name: 't' }, autocrlf = true }) {
  const key = JSON.stringify([branch, message, files, identity, autocrlf])
  if (!seeds.has(key)) {
    const seed = mkdtempSync(join(tmpdir(), 'agentics-seed-'))
    run(seed, 'init', '-q', ...(branch ? ['-b', branch] : []))
    run(seed, 'config', 'user.email', identity.email)
    run(seed, 'config', 'user.name', identity.name)
    if (!autocrlf) run(seed, 'config', 'core.autocrlf', 'false')
    for (const [path, content] of Object.entries(files)) {
      const full = join(seed, ...path.split('/'))
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content)
    }
    run(seed, 'add', '-A')
    run(seed, 'commit', '-q', '--allow-empty', '-m', message)
    seeds.set(key, seed)
  }
  const repo = mkdtempSync(join(tmpdir(), prefix))
  cpSync(seeds.get(key), repo, { recursive: true, preserveTimestamps: true })
  return repo
}
