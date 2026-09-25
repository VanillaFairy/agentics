// tools/migrate-legacy.mjs — the one-shot move of a repository's pre-tree agentics state out of
// the live paths.
//
// Design: docs/DESIGN.md#self-checks (GP2: a format change ships a one-shot migration, never a
// permanent second reader).
//
// What moves, and where:
//   .claude/agentics/runs/          → .claude/agentics/legacy/<stamp>/runs/
//   .claude/agentics/kb/            → .claude/agentics/legacy/<stamp>/kb/
//   .claude/agentics/programmes/    → .claude/agentics/legacy/<stamp>/programmes/
//   efforts/<e>/surveys/<s>.json    → efforts/<e>/evidence/<s>-survey.json (+ .anchor)
//   efforts/<e>/probes/<s>.json     → efforts/<e>/evidence/<s>-probe.json
//   efforts/<e>/links.jsonl         → .claude/agentics/legacy/<stamp>/links/<e>.jsonl
//
// Nothing is converted into nodes: an old run's plan is a list of work orders under a change
// string, and turning it into a tree would be this script authoring a plan nobody ratified. A run
// that was still in flight is finished with the plugin version that started it, or re-planned
// as an effort. Old branches (`agentics/<runstamp>-*`, `agentics/programme-*`) are listed and left
// alone. The default is a dry run; `--yes` performs the moves.

import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const stampNow = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

/**
 * The moves a repository needs, without performing them.
 * @returns {{moves: {from, to}[], branches: string[], notes: string[]}}
 */
export function plan(repo, stamp = stampNow()) {
  const base = join(repo, '.claude', 'agentics')
  const legacy = join(base, 'legacy', stamp)
  const moves = []
  const notes = []
  for (const dir of ['runs', 'kb', 'programmes']) {
    if (existsSync(join(base, dir))) moves.push({ from: join(base, dir), to: join(legacy, dir) })
  }
  const runs = join(base, 'runs')
  if (existsSync(runs)) {
    const stamps = readdirSync(runs).filter((d) => /^\d{8}-\d{6}/.test(d))
    if (stamps.length) notes.push(stamps.length + ' run(s) move to legacy; one still in flight is finished with the version that started it, or re-planned as an effort')
  }
  const efforts = join(base, 'efforts')
  if (existsSync(efforts)) {
    for (const e of readdirSync(efforts)) {
      const dir = join(efforts, e)
      for (const [kind, sub] of [['survey', 'surveys'], ['probe', 'probes']]) {
        const from = join(dir, sub)
        if (!existsSync(from)) continue
        for (const f of readdirSync(from)) {
          const m = /^(.+)\.(json|anchor)$/.exec(f)
          if (!m) continue
          moves.push({ from: join(from, f), to: join(dir, 'evidence', m[1] + '-' + kind + '.' + m[2]) })
        }
      }
      if (existsSync(join(dir, 'links.jsonl'))) moves.push({ from: join(dir, 'links.jsonl'), to: join(legacy, 'links', e + '.jsonl') })
    }
  }
  const listed = spawnSync('git', ['-C', repo, 'branch', '--list', 'agentics/*', '--format=%(refname:short)'], { encoding: 'utf8', windowsHide: true })
  const branches = (listed.stdout || '').split('\n').filter((b) => /^agentics\/(\d{8}-\d{6}-|programme-)/.test(b))
  if (branches.length) notes.push(branches.length + ' pre-tree branch(es) left in place; delete them with git once their work is accounted for')
  return { moves, branches, notes }
}

/** Perform the plan's moves. */
export function apply(moves) {
  for (const { from, to } of moves) {
    mkdirSync(join(to, '..'), { recursive: true })
    renameSync(from, to)
  }
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  const argv = process.argv.slice(2)
  const repo = argv.find((a) => !a.startsWith('--')) || '.'
  const p = plan(repo)
  if (argv.includes('--yes')) apply(p.moves)
  console.log(JSON.stringify({ applied: argv.includes('--yes'), ...p }, null, 1))
}
