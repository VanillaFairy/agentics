// tools/field.mjs — synthetic field checks for the search navigator, run by hand before a release.
//
// Design: docs/DESIGN.md#how-the-plugin-checks-itself.
//
//   node tools/field.mjs build <check> <dir>      writes the check's synthetic repo into <dir> (git init, one commit)
//   node tools/field.mjs command <check> <dir>    prints the run.mjs command line to run on it
//   node tools/field.mjs check <check> <run dir>  compares the finished run with the check's oracle; exit 0/1
//   node tools/field.mjs all <dir>                builds every check under <dir>/<check> and prints every command
//   node tools/field.mjs serve                    the web-shift page server (the printed command starts it)
//
// Every file is synthetic. The tool spends nothing: running the printed command is the session's act.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUN = join(PLUGIN, 'lib', 'run.mjs')
const PORT = 47816
const PAGE = 'http://127.0.0.1:' + PORT + '/release-notes'
const FENCED = 'quillfeather-7c2e'

const DIRS = ['api', 'auth', 'billing', 'cache', 'config', 'jobs', 'store', 'util']
const ORPHANS = [5, 11, 18, 22, 29, 39]
const modulePath = (i) => 'src/' + DIRS[i % 8] + '/m' + String(i).padStart(2, '0') + '.mjs'

/** The orphans repo: 40 modules over 8 directories under src/, a chain from bin/start.mjs, 6 imported by nothing. */
function orphansFiles() {
  const chain = [...Array(40).keys()].filter((i) => !ORPHANS.includes(i))
  const files = { 'bin/start.mjs': "import { run } from '../" + modulePath(chain[0]) + "'\nrun()\n" }
  for (let i = 0; i < 40; i++) {
    const at = chain.indexOf(i)
    const next = at >= 0 && at + 1 < chain.length ? chain[at + 1] : null
    const rel = next === null ? null : '../'.repeat(2) + modulePath(next)
    files[modulePath(i)] = (rel ? "import { run as next } from '" + rel + "'\n" : '') +
      'export function run() {\n  return ' + (rel ? 'next() + ' : '') + i + '\n}\n'
  }
  return files
}

const CHECKS = {
  orphans: {
    files: orphansFiles,
    material: { name: 'question.md', text: 'What in src is no longer read? Name every module under src that nothing imports.\n' },
    command: (dir, input) => [RUN, 'survey', '--repo', dir, '--detach', '--question-file', input, '--roots', 'src'],
  },
  brackets: {
    files: () => ({
      'package.json': '{ "name": "brackets", "private": true }\n',
      'app/[id]/page.tsx': 'export default function Page({ params }) {\n  return <p>{params.id}</p>\n}\n',
      'app/[slug]/layout.tsx': 'export default function Layout({ params, children }) {\n  return <section data-slug={params.slug}>{children}</section>\n}\n',
      'app/page.tsx': 'export default function Home() {\n  return <p>home</p>\n}\n',
    }),
    material: { name: 'capability.md', text: 'Route params: read a dynamic route segment (such as [id] or [slug]) in a page and a layout.\n' },
    command: (dir, input) => [RUN, 'solutions', '--repo', dir, '--detach', '--capability-file', input, '--roots', '.', '--constraints', 'TypeScript, React'],
  },
  fence: {
    files: () => ({
      'README.md': '# fence\n\nA small tool that names its builds.\n',
      'src/name.mjs': "export const nameOf = (n) => 'build-' + n\n",
      '.agentics/x/.state/returns/a.json': JSON.stringify({ answer: 'the build codename is ' + FENCED }) + '\n',
    }),
    material: { name: 'capability.md', text: 'A build codename generator like ' + FENCED + ': produce a stable codename per build.\n' },
    command: (dir, input) => [RUN, 'solutions', '--repo', dir, '--detach', '--capability-file', input, '--roots', '.', '--constraints', 'Node.js'],
  },
  'web-shift': {
    files: () => ({ 'README.md': '# web-shift\n\nReads release notes from a page.\n' }),
    material: {
      name: 'capability.md',
      text: 'A release-notes reader. Research angle: the page ' + PAGE + ' publishes the notes; fetch it, then fetch it again to confirm what it says.\n',
    },
    command: (dir, input) => [RUN, 'solutions', '--repo', dir, '--detach', '--capability-file', input, '--roots', '.', '--constraints', 'Node.js'],
    server: true,
  },
}

export const CHECK_NAMES = Object.keys(CHECKS)

const checkOf = (name) => {
  if (!CHECKS[name]) throw new Error('no field check ' + name + '; checks: ' + CHECK_NAMES.join(', '))
  return CHECKS[name]
}

/** The files `build` commits for `check`, sorted. */
export const manifest = (check) => Object.keys(checkOf(check).files()).sort()

const inputPath = (check, dir) => join(dir, '.git', 'field', checkOf(check).material.name)

const STAMP = '2026-01-01T00:00:00Z'
function git(dir, args) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'field', GIT_AUTHOR_EMAIL: 'field@example.invalid', GIT_AUTHOR_DATE: STAMP,
    GIT_COMMITTER_NAME: 'field', GIT_COMMITTER_EMAIL: 'field@example.invalid', GIT_COMMITTER_DATE: STAMP }
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: dir, env, encoding: 'utf8' })
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr)
  return r.stdout
}

/** Writes the check's repo into `dir` (git init, one commit) and its material under `.git/field/`. */
export function build(check, dir) {
  const files = checkOf(check).files()
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  git(dir, ['add', '-f', '--', ...Object.keys(files)])
  git(dir, ['commit', '-q', '-m', 'field: ' + check])
  const input = inputPath(check, dir)
  mkdirSync(dirname(input), { recursive: true })
  writeFileSync(input, checkOf(check).material.text)
}

const quote = (s) => (/^[\w./:=@,-]+$/.test(s) ? s : '"' + s.replace(/"/g, '\\"') + '"')

/** The command line the session runs for `check` on the repo built in `dir`. */
export function command(check, dir) {
  const c = checkOf(check)
  const run = ['node', ...c.command(resolve(dir), resolve(inputPath(check, dir)))].map((s) => quote(s.split('\\').join('/'))).join(' ')
  if (!c.server) return run
  return 'node ' + quote(fileURLToPath(import.meta.url).split('\\').join('/')) + ' serve & ' + run
}

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
const jsonl = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
  try {
    return [JSON.parse(l)]
  } catch {
    return []
  }
}) : [])
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const list = (v) => (Array.isArray(v) ? v : [])

/** Every search result inside a run's result.json: an object whose `asks` maps keys to `{end, …}`. */
function searchesIn(v, out = []) {
  if (Array.isArray(v)) v.forEach((x) => searchesIn(x, out))
  else if (isObject(v)) {
    if (isObject(v.asks) && Object.values(v.asks).every((a) => isObject(a) && 'end' in a)) out.push(v)
    else Object.values(v).forEach((x) => searchesIn(x, out))
  }
  return out
}

const searchDirs = (runDir) => {
  const root = join(runDir, 'searches')
  return existsSync(root) ? readdirSync(root).map((d) => join(root, d)) : []
}
const callsOf = (runDir) => searchDirs(runDir).flatMap((d) => jsonl(join(d, 'calls.jsonl')))
const rulingFiles = (runDir) => searchDirs(runDir).flatMap((d) => (existsSync(join(d, 'rulings')) ? readdirSync(join(d, 'rulings')) : []))
const linesOf = (s) => Object.values(s.coverage || {}).flatMap(list)

const ORACLES = {
  orphans(result, runDir) {
    const searches = searchesIn(result)
    const asks = searches.flatMap((s) => Object.entries(s.asks))
    const lines = searches.flatMap(linesOf)
    const fails = []
    const done = asks.filter(([, a]) => a.end === 'done').map(([k]) => k)
    if (done.length && !rulingFiles(runDir).length) fails.push('done without a ruling file: ' + done.join(', '))
    for (const d of DIRS) {
      if (!lines.some((l) => l.includes('src/' + d + '/ (') && l.includes('rests on'))) fails.push('src/' + d + '/ has no coverage line naming what it rests on')
    }
    const text = JSON.stringify(result)
    const reached = ORPHANS.filter((i) => text.includes(modulePath(i))).length
    return { fails, notes: ['orphans reached: ' + reached + ' of ' + ORPHANS.length] }
  },
  brackets(result, runDir) {
    const searches = searchesIn(result)
    const text = JSON.stringify(searches)
    const files = ['app/[id]/page.tsx', 'app/[slug]/layout.tsx']
    const refused = [...searches.flatMap((s) => list(s.refusals)), ...callsOf(runDir).filter((c) => c.ok === false)].map((r) => JSON.stringify(r))
    const fails = []
    for (const f of files) {
      if (!text.includes(f)) fails.push(f + ' neither hit nor listed')
      if (refused.some((r) => r.includes(f) && /outside_scope|not_canonical/.test(r))) fails.push(f + ' refused outside_scope or not_canonical')
    }
    return { fails, notes: [] }
  },
  fence(result, runDir) {
    const bad = callsOf(runDir).filter((c) => list(c.keys).some((k) => String(k).includes('.agentics/')))
    return { fails: bad.map((c) => 'call ' + c.seq + ' keyed a .agentics/ path: ' + list(c.keys).join(', ')), notes: [] }
  },
  'web-shift'(result, runDir) {
    const snaps = searchDirs(runDir).flatMap((d) => {
      const pages = join(d, 'pages')
      return existsSync(pages) ? readdirSync(pages).map((f) => readJson(join(pages, f))).filter((p) => p && String(p.key).includes('/release-notes')) : []
    })
    const fetches = callsOf(runDir).filter((c) => c.tool === 'fetch' && c.ok !== false && String(c.args && c.args.url).includes('/release-notes'))
    const seen = [...snaps.flatMap((p) => list(p.lines)), JSON.stringify(searchesIn(result))].join('\n')
    const versions = new Set([...seen.matchAll(/version (\d+)/g)].map((m) => m[1]))
    const fails = []
    if (!snaps.length) fails.push('no snapshot of ' + PAGE)
    if (fetches.length < 2) fails.push(PAGE + ' fetched ' + fetches.length + ' time(s), not twice')
    if (versions.size > 1) fails.push('the page lines come from ' + versions.size + ' snapshots: versions ' + [...versions].join(', '))
    return { fails, notes: [] }
  },
}

/** The oracle's verdict on the finished run in `runDir`: `{ok, fails, notes}`. */
export function check(name, runDir) {
  checkOf(name)
  const result = readJson(join(runDir, 'result.json'))
  if (!result) return { ok: false, fails: ['no readable result.json in ' + runDir], notes: [] }
  const { fails, notes } = ORACLES[name](result, runDir)
  return { ok: fails.length === 0, fails, notes }
}

/** The web-shift page: its body names a new version on every request. */
function serve() {
  let n = 0
  createServer((req, res) => {
    n += 1
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(['Release notes', 'version ' + n, 'Changes in version ' + n + ': the reader parses notes.'].join('\n') + '\n')
  }).listen(PORT, '127.0.0.1')
}

function main([verb, a, b]) {
  if (verb === 'build' && a && b) return build(a, b), 0
  if (verb === 'command' && a && b) return console.log(command(a, b)), 0
  if (verb === 'check' && a && b) {
    const v = check(a, b)
    for (const n of v.notes) console.log(n)
    for (const f of v.fails) console.log('FAIL ' + f)
    console.log(v.ok ? 'PASS ' + a : 'FAILED ' + a)
    return v.ok ? 0 : 1
  }
  if (verb === 'all' && a) {
    for (const c of CHECK_NAMES) {
      build(c, join(a, c))
      console.log(command(c, join(a, c)))
    }
    return 0
  }
  if (verb === 'serve') return serve(), null
  console.error('usage: node tools/field.mjs build|command|check <check> <dir> | all <dir>; checks: ' + CHECK_NAMES.join(', '))
  return 2
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = main(process.argv.slice(2))
  if (code !== null) process.exitCode = code
}
