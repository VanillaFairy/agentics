// test/harness/program-rig.mjs — a program test's world: a temporary git repository holding the
// given files, one run's log over it, and a program context whose runner is the scripted one.
// `relaunch(script)` is the same run started again: a fresh log port and context over the same
// repository, so a test sees exactly what a relaunched program reads back.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { runLog } from '../../lib/ledger.mjs'
import { programContext } from '../../lib/programs/common.mjs'
import { configPath, writeJson } from '../../lib/store.mjs'
import { scriptedRunner } from './scripted-runner.mjs'

const RUN = '20260101-000000-test'
const NOW = () => '2026-01-01T00:00:00.000Z'

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })

export function programRig({ files = {}, script = {}, effort = '', maxAgents = 6, env = {}, config = {} } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-program-'))
  git(repo, 'init', '-q', '.')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  git(repo, 'config', 'core.autocrlf', 'false')
  for (const [path, content] of Object.entries(files)) {
    const full = join(repo, ...path.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  if (Object.keys(config).length) writeJson(configPath(repo), config)
  const cleanup = () => rmSync(repo, { recursive: true, force: true })
  const build = (s) => {
    const sleeps = []
    const log = runLog(repo, RUN)
    const runner = scriptedRunner(s, { log, now: NOW })
    const ctx = programContext({
      repo, run: RUN, effort, log, runAgent: runner.runAgent, now: NOW,
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve() },
      env, maxAgents, resumable: { program: 'test', scope: {}, args: {} },
    })
    return { repo, run: RUN, ctx, calls: runner.calls, sleeps, log, relaunch: (next = {}) => build(next), cleanup }
  }
  return build(script)
}
