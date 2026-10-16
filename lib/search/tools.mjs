// lib/search/tools.mjs — the tools a search's calls run over one pinned tree: grep, read, files,
// refs, log, show and fetch, every path keyed the way git prints it for that tree.
//
// Design: docs/DESIGN.md#searches.
//
// Every function takes the tree first and answers `ok: false` with one of REFUSALS instead of
// throwing. A page is PAGE_LINES long; later pages stay where they are for a later call.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { fnv1a } from '../plan-digest.mjs'
import { writeWhole } from '../store.mjs'
import { canonicalUrl, fenced, globOf, grepArgv, isAlternation, isGlob, pathKey, queryOf, within } from './query.mjs'

const ALTERNATION = 'brace alternation is not in the glob dialect; ask for each name in its own glob'

export const PAGE_LINES = 200
const FETCH_BYTES = 8 * 1024 * 1024
export const REFUSALS = ['not_canonical', 'past_eof', 'unsupported_syntax', 'does_not_compile',
  'expander_error', 'unknown_ask', 'outside_scope', 'too_large']

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' }
const GIT_PROCESS_ENV = { ...process.env, ...GIT_ENV }
const no = (refusal, detail) => ({ ok: false, refusal, detail })
const toKey = (p) => p.split(sep).join('/').normalize('NFC')

/** Run git in `cwd` without a shell; never rejects. */
function git(cwd, args) {
  return new Promise((done) => {
    const child = spawn('git', ['-C', cwd, ...args], { windowsHide: true, env: { ...process.env, ...GIT_ENV } })
    const out = []
    let err = ''
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => done({ status: -1, stdout: '', stderr: String(e.message) }))
    child.on('close', (status) => done({ status, stdout: Buffer.concat(out).toString('utf8'), stderr: err }))
  })
}

/** A failed git call as a refusal: a pattern git cannot compile, or anything else. */
const gitRefusal = (r) => (/regex|regexp|Unmatched|Invalid (preceding|range|character|back)|Trailing backslash/i.test(r.stderr)
  ? no('does_not_compile', r.stderr.trim().split('\n')[0])
  : no('expander_error', (r.stderr.trim() || 'git exited ' + r.status).split('\n')[0]))

/** Pure. Whether a key is a test file: a test, tests or __tests__ segment, or a .test. or .spec. name. */
export function isTestKey(key) {
  return /(^|\/)(test|tests|__tests__)\//.test(key) || /\.(test|spec)\.[^/]+$/.test(key)
}

const baseOf = (part) => (isGlob(part) ? globOf(part).base : part)
/** Pure. Whether `key` lies inside one of `scope`'s parts: '.', a directory, a file or a glob. */
const inScope = (key, scope) => scope.some((part) => within(key, part))
/** Pure. Whether a grep path lies inside the scope: a literal path inside it, or a glob whose literal base is inside it or holds a scope part. */
const pathInScope = (p, scope) => {
  const part = pathKey(p)
  if (!isGlob(part)) return inScope(part, scope)
  const base = baseOf(part)
  return base === '.' || inScope(base, scope) || scope.some((s) => within(baseOf(pathKey(s)), base))
}
const namesNodeModules = (parts) => parts.some((p) => pathKey(p).split('/').includes('node_modules'))

/** The initialised submodules of the tree: the gitlinks of its index whose checkout is there. */
function submodulesOf(root) {
  const r = spawnSync('git', ['-C', root, 'ls-files', '-z', '--stage'], { encoding: 'utf8', windowsHide: true, env: GIT_PROCESS_ENV })
  if (r.status !== 0) return []
  return r.stdout.split('\0').filter((l) => l.startsWith('160000 ')).map((l) => l.split('\t')[1])
    .filter((sub) => existsSync(join(root, sub, '.git')))
}

/** A path as a key of this tree, or why not. */
export function keyOf(tree, path) {
  const given = String(path ?? '')
  if (given === '' || given.includes('\0')) return no('not_canonical', 'an empty path or one holding a NUL byte')
  let real
  let rootReal
  try {
    rootReal = realpathSync.native(tree.root)
    real = realpathSync.native(isAbsolute(given) ? given : resolve(tree.root, given))
  } catch {
    return no('not_canonical', given + ' is not a file of the tree')
  }
  const rel = relative(rootReal, real)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return no('not_canonical', given + ' is outside the tree')
  if (!statSync(real).isFile()) return no('not_canonical', given + ' is not a file')
  const key = toKey(rel)
  if (Buffer.from(key, 'utf8').toString('utf8') !== key) return no('not_canonical', given + ' is not a UTF-8 name')
  if (fenced(key)) return no('not_canonical', given + ' is in the store or a worktree')
  const parts = key.split('/')
  if (parts.includes('.git')) return no('not_canonical', given + ' is inside .git')
  const subs = submodulesOf(rootReal)
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/')
    if (!existsSync(join(rootReal, dir, '.git'))) continue
    if (subs.includes(dir)) {
      // inside an initialised submodule: anything deeper with its own .git is a repository of its own
      for (let k = i + 1; k < parts.length; k++) {
        if (existsSync(join(rootReal, parts.slice(0, k).join('/'), '.git'))) return no('not_canonical', given + ' is inside a nested repository')
      }
      return { ok: true, key }
    }
    return no('not_canonical', given + ' is inside a nested repository or another worktree')
  }
  return { ok: true, key }
}

/**
 * Where one search runs: the tree itself, then each initialised submodule in reach, each with the
 * parts of `parts` inside it; a part git reports ignored runs on its own with the standard
 * excludes off.
 */
function targetsOf(root, parts) {
  const subs = submodulesOf(root)
  const keys = parts.map(pathKey)
  const out = []
  const plain = []
  const ignored = []
  for (const p of keys) {
    const base = baseOf(p)
    if (subs.some((sub) => base === sub || base.startsWith(sub + '/'))) continue
    if (base !== '.' && spawnSync('git', ['-C', root, 'check-ignore', '-q', '--', base], { windowsHide: true, env: GIT_PROCESS_ENV }).status === 0) ignored.push(p)
    else plain.push(p)
  }
  if (plain.length) out.push({ cwd: root, prefix: '', parts: plain, all: false })
  if (ignored.length) out.push({ cwd: root, prefix: '', parts: ignored, all: true })
  for (const sub of subs) {
    const inside = keys.flatMap((p) => {
      const base = baseOf(p)
      if (base === '.' || sub === base || sub.startsWith(base + '/')) return ['.']
      if (base.startsWith(sub + '/')) return [p.slice(sub.length + 1)]
      return []
    })
    if (inside.length) out.push({ cwd: join(root, sub), prefix: sub + '/', parts: [...new Set(inside)], all: false })
  }
  return out
}

/** One query's argv for one target: the standard excludes off for an ignored part, node_modules kept out unless named. */
function argvFor(target, query, mode, extra = []) {
  const argv = grepArgv(query, mode)
  const at = argv.indexOf('--untracked') + 1
  argv.splice(at, 0, ...(target.all ? ['--no-exclude-standard'] : []), ...extra)
  if (!namesNodeModules(target.parts)) argv.push(':(exclude,glob)**/node_modules/**')
  return argv
}

/** Every target's output for one query, or the first refusal. */
async function runAll(targets, make, mode, extra) {
  const outs = []
  for (const t of targets) {
    const q = make(t.parts)
    if (!q.ok) return { refusal: q }
    const r = await git(t.cwd, argvFor(t, q, mode, extra))
    if (r.status === 1) continue
    if (r.status !== 0) return { refusal: gitRefusal(r) }
    outs.push({ prefix: t.prefix, stdout: r.stdout })
  }
  return { outs }
}

const pagesOf = (total) => Math.ceil(total / PAGE_LINES)
const pageOf = (list, page) => list.slice((page - 1) * PAGE_LINES, page * PAGE_LINES)
const pastEnd = (total, page) => !Number.isInteger(page) || page < 1 || (page > 1 && page > pagesOf(total))

export async function grep(tree, { pattern, fixed = false, ignore_case = false, paths = [], page = 1 }, { scope = ['.'] } = {}) {
  const braced = paths.find(isAlternation)
  if (braced !== undefined) return no('unsupported_syntax', braced + ': ' + ALTERNATION)
  const outside = paths.find((p) => !pathInScope(p, scope))
  if (outside !== undefined) return no('outside_scope', outside + ' is outside the asks\' scope')
  const parts = paths.length ? paths : scope
  const query = queryOf({ pattern, fixed, ignore_case, paths: parts })
  if (!query.ok) return { ...query, query_key: '' }
  const reached = query.filters === null ? () => true : (key) => parts.some((p) => within(key, p))
  const ran = await runAll(targetsOf(tree.root, parts), (ps) => queryOf({ pattern, fixed, ignore_case, paths: ps }), 'lines')
  if (ran.refusal) return { ...ran.refusal, query_key: query.key }
  const lines = []
  for (const { prefix, stdout } of ran.outs) {
    for (const row of stdout.split('\n')) {
      if (!row) continue
      const [path, n, ...rest] = row.split('\0')
      const key = prefix + toKey(path)
      if (!fenced(key) && inScope(key, scope) && reached(key)) lines.push({ key, line: Number(n), text: rest.join('\0').replace(/\r$/, '') })
    }
  }
  lines.sort((a, b) => (a.key === b.key ? a.line - b.line : a.key < b.key ? -1 : 1))
  if (pastEnd(lines.length, page)) return { ...no('past_eof', 'page ' + page + ' of ' + pagesOf(lines.length)), query_key: query.key }
  return {
    ok: true, query_key: query.key, total: lines.length, files: new Set(lines.map((l) => l.key)).size,
    page, pages: pagesOf(lines.length), lines: pageOf(lines, page),
  }
}

export async function read(tree, { path, from = 1, to = 0 }, { scope = ['.'] } = {}) {
  const k = keyOf(tree, path)
  if (!k.ok) return k
  if (!inScope(k.key, scope)) return no('outside_scope', k.key + ' is outside the asks\' scope')
  const text = readFileSync(join(tree.root, k.key), 'utf8')
  const all = text.split(/\r?\n/)
  if (all.at(-1) === '') all.pop()
  const total_lines = all.length
  if (!Number.isInteger(from) || from < 1 || (total_lines > 0 && from > total_lines)) return no('past_eof', k.key + ' has ' + total_lines + ' line(s)')
  if (to !== 0 && (!Number.isInteger(to) || to < from)) return no('past_eof', 'to ' + to + ' is before from ' + from)
  const last = Math.min(to === 0 ? total_lines : to, total_lines, from + PAGE_LINES - 1)
  const lines = all.slice(from - 1, last).map((t, i) => ({ line: from + i, text: t }))
  return { ok: true, key: k.key, from, to: total_lines === 0 ? 0 : last, total_lines, lines }
}

export async function files(tree, { glob, page = 1 }, { scope = ['.'] } = {}) {
  const g = String(glob ?? '')
  if (g === '' || g.includes('\0')) return no('not_canonical', 'an empty glob or one holding a NUL byte')
  if (isAlternation(g)) return no('unsupported_syntax', g + ': ' + ALTERNATION)
  const { re, base } = globOf(pathKey(g))
  const subs = submodulesOf(tree.root)
  const listing = [
    ...(subs.some((sub) => base.startsWith(sub + '/')) ? [] : [{ cwd: tree.root, prefix: '', spec: base }]),
    ...subs.flatMap((sub) => {
      if (base === '.' || sub === base || sub.startsWith(base + '/')) return [{ cwd: join(tree.root, sub), prefix: sub + '/', spec: '.' }]
      return base.startsWith(sub + '/') ? [{ cwd: join(tree.root, sub), prefix: sub + '/', spec: base.slice(sub.length + 1) }] : []
    }),
  ]
  const keys = new Set()
  for (const l of listing) {
    const r = await git(l.cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ':(literal)' + l.spec])
    if (r.status !== 0) return gitRefusal(r)
    for (const p of r.stdout.split('\0')) {
      if (!p || p.endsWith('/')) continue
      const key = l.prefix + toKey(p)
      if (!re.test(key) || fenced(key) || !inScope(key, scope)) continue
      if (key.split('/').includes('node_modules') && !namesNodeModules(scope)) continue
      let st = null
      try { st = statSync(join(tree.root, key)) } catch { st = null }
      if (st && st.isFile()) keys.add(key)
    }
  }
  const sorted = [...keys].sort()
  if (pastEnd(sorted.length, page)) return no('past_eof', 'page ' + page + ' of ' + pagesOf(sorted.length))
  return { ok: true, total: sorted.length, page, pages: pagesOf(sorted.length), keys: pageOf(sorted, page) }
}

export async function refs(tree, { symbol }, { scope = ['.'] } = {}) {
  const ran = await runAll(targetsOf(tree.root, scope), (ps) => queryOf({ pattern: symbol, fixed: true, paths: ps }), 'count', ['-w'])
  if (ran.refusal) return ran.refusal
  const found = []
  for (const { prefix, stdout } of ran.outs) {
    for (const row of stdout.split('\n')) {
      if (!row) continue
      const [path, n] = row.split('\0')
      const key = prefix + toKey(path)
      if (fenced(key) || !inScope(key, scope)) continue
      found.push({ key, count: Number(n), test: isTestKey(key) })
    }
  }
  found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return { ok: true, total: found.reduce((n, f) => n + f.count, 0), files: found }
}

const LOG_MODES = { G: (p) => ['-G' + p], S: (p) => ['-S' + p], grep: (p) => ['-E', '--grep=' + p] }

export async function log(tree, { mode, pattern, paths = [], page = 1 }) {
  if (!Object.hasOwn(LOG_MODES, mode)) return no('unsupported_syntax', 'log mode ' + JSON.stringify(mode) + ' is not G, S or grep')
  const query = queryOf({ pattern, fixed: mode === 'S', paths })
  if (!query.ok) return query
  const r = await git(tree.root, ['log', '-z', '--format=%x1e%H%x1f%cI%x1f%s', '--name-only', ...LOG_MODES[mode](query.pattern), '--', ...query.pathspecs])
  if (r.status !== 0) return gitRefusal(r)
  const reached = query.filters === null ? () => true : (key) => paths.some((p) => within(key, p))
  const commits = []
  for (const chunk of r.stdout.split('\x1e').slice(1)) {
    const head = chunk.slice(0, chunk.indexOf('\0') < 0 ? chunk.length : chunk.indexOf('\0'))
    const [sha, date, subject] = head.split('\x1f')
    const named = chunk.slice(head.length + 1).split('\0').map((s) => s.replace(/^\n/, '')).filter(Boolean).map(toKey)
    const keys = named.filter((key) => !fenced(key) && reached(key))
    if (named.length > 0 && keys.length === 0) continue
    commits.push({ sha, date, subject, keys })
  }
  if (pastEnd(commits.length, page)) return no('past_eof', 'page ' + page + ' of ' + pagesOf(commits.length))
  return { ok: true, total: commits.length, page, pages: pagesOf(commits.length), commits: pageOf(commits, page) }
}

/** The full sha of the commit `commit` names in the tree, or a not_canonical refusal. */
export async function commitOf(tree, commit) {
  const c = String(commit ?? '')
  if (c === '' || c.startsWith('-') || c.includes('\0')) return no('not_canonical', 'no commit named ' + JSON.stringify(c))
  const resolved = await git(tree.root, ['rev-parse', '--verify', '--quiet', c + '^{commit}'])
  if (resolved.status !== 0) return no('not_canonical', c + ' is not a commit of this tree')
  return { ok: true, sha: resolved.stdout.trim() }
}

export async function show(tree, { commit, path = '' }) {
  const c = await commitOf(tree, commit)
  if (!c.ok) return c
  const sha = c.sha
  const r = await git(tree.root, ['show', '--no-color', '--format=fuller', sha, ...(path ? ['--', ':(literal)' + path] : [])])
  if (r.status !== 0) return gitRefusal(r)
  const all = r.stdout.split(/\r?\n/)
  if (all.at(-1) === '') all.pop()
  return { ok: true, sha, lines: all.map((text, i) => ({ line: i + 1, text })) }
}

/** The snapshot of one URL key in `file`, or null when absent, unreadable or not a snapshot. */
function snapshotOf(file, key) {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'))
    return s && s.key === key && Array.isArray(s.lines) && Number.isInteger(s.status) && Number.isInteger(s.bytes) ? s : null
  } catch {
    return null
  }
}

/** The lines of the page pinned for `url` under `pages`, or null when none is. */
export function pinnedPage(pages, url) {
  const key = canonicalUrl(String(url))
  const s = snapshotOf(join(pages, fnv1a(key) + '.json'), key)
  return s ? s.lines : null
}

/** The body of a response read up to `bytes`: `{text}`, or `{seen}` when it passes the bound. */
async function boundedBody(res, bytes) {
  const chunks = []
  let seen = 0
  const reader = res.body?.getReader()
  for (let part = await reader?.read(); part && !part.done; part = await reader.read()) {
    seen += part.value.length
    if (seen > bytes) {
      await reader.cancel()
      return { seen }
    }
    chunks.push(part.value)
  }
  return { text: Buffer.concat(chunks).toString('utf8'), seen }
}

/**
 * Fetch one page of a URL. The first body of a URL in a search is pinned under `pages`, so every
 * page and every relaunch reads the same body; a body past `bytes` (FETCH_BYTES) is refused too_large.
 */
export async function fetchUrl({ url, page = 1 }, { pages, bytes = FETCH_BYTES }) {
  let key
  try {
    const u = new URL(String(url))
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return no('not_canonical', String(url) + ' is not an http or https URL')
    key = canonicalUrl(String(url))
  } catch {
    return no('not_canonical', String(url) + ' is not a URL')
  }
  const file = join(pages, fnv1a(key) + '.json')
  let pinned = snapshotOf(file, key)
  if (!pinned) {
    try {
      const res = await fetch(String(url), { redirect: 'follow' })
      const got = await boundedBody(res, bytes)
      if (got.text === undefined) return no('too_large', 'the body is at least ' + got.seen + ' bytes, past the ' + bytes + ' byte bound')
      const all = got.text.split(/\r?\n/)
      if (all.at(-1) === '') all.pop()
      pinned = { key, status: res.status, bytes: got.seen, lines: all }
      writeWhole(file, pinned)
    } catch (err) {
      return no('expander_error', String((err && err.cause && err.cause.code) || (err && err.message) || err))
    }
  }
  const all = pinned.lines
  if (pastEnd(all.length, page)) return no('past_eof', 'page ' + page + ' of ' + pagesOf(all.length))
  const lines = pageOf(all, page).map((t, i) => ({ line: (page - 1) * PAGE_LINES + i + 1, text: t }))
  return { ok: true, key, status: pinned.status, page, pages: pagesOf(all.length), lines, bytes: pinned.bytes }
}
