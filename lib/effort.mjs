// lib/effort.mjs — the effort store: one directory for everything a single piece of work
// produces, across the phases it takes to produce it.
//
// Design: docs/DESIGN.md#efforts.
//
// Why this exists. A change moves through design, survey, probe and one or more runs, and each
// phase wrote its output somewhere different or nowhere at all. Run state went to
// `.claude/vfa/runs/`, the knowledge base to `.claude/vfa/kb/`, designs to the source tree —
// and a survey's findings and a probe's findings went NOWHERE. The only record of a probe was a
// harness temp file, session-scoped and swept. Since the design skill recommends that the
// design pass and the develop pass be separate sessions, everything the first one learned that
// did not reach the design document was gone before the second one opened.
//
// What this is NOT. It is durable scratch, not evidence, and nothing it holds ever reaches the
// knowledge base's null-survey gate. That gate reads exactly one field —
// `entries.filter((e) => e.state === 'fresh')` — and no kind and no provenance, so anything
// reaching it is admitted on freshness alone; a store whose contents could reach it would launder
// an unverified note into a skipped phase, which is the one failure IRON LAW §4 exists against.
//
// ONE thing here can stand in for a later survey, and only by arithmetic: a survey recorded
// with its ANCHOR — the commit it was taken at and the ground its topics searched — that
// `standingSurvey` finds untouched. No commit since the anchor reaches that ground, no
// uncommitted edit sits on it, and the survey itself reported complete coverage. That is the same
// git-event test a knowledge-base entry's freshness uses, applied to a whole survey, so a design
// pass's survey is not bought a second time by the develop pass that follows it. Whether the
// change's SHAPE is settled stays the caller's judgment; this answers only whether the ground
// moved. A survey recorded without an anchor never stands, and never reads as though it might.
//
// Nothing else is minted. A phase's return is stored exactly as it was returned — there is no
// `about` to derive and no source to stamp; the anchor is a sidecar beside it, never a field
// added to it — and the writer
// is the SESSION that ran the phase, using the shell it already has. No agent was added to the
// roster for this and no capability changed.

import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { safePath } from './kb.mjs'
import { canonical, fnv1a } from './plan-digest.mjs'

/** The store's root inside the target repository, and the identity file inside one effort. */
export const EFFORTS_DIR = '.claude/vfa/efforts'
export const IDENTITY_FILE = 'effort.json'
export const LINKS_FILE = 'links.jsonl'

/** The phase returns an effort stores, and the directory each lands in. */
export const KINDS = ['survey', 'probe']

/** What a link can point at: a run of this effort, or the design document it was built from. */
export const LINK_KINDS = ['run', 'design']

const posix = (p) => String(p == null ? '' : p).split('\\').join('/')

/**
 * Pure. A directory name from free text — the effort's identifier, entire.
 *
 * There is no `slug` field anywhere in the store, on the same reasoning the programme layer
 * gives for its own directory: a field restating the directory name can only ever disagree
 * with it. So this is the one place a name is decided, and it has to be stable enough that the
 * same change asked for twice lands in the same directory.
 *
 * @param {string} about  the question or change the effort is about
 * @param {string} today  YYYY-MM-DD, supplied so this stays pure and testable
 */
export function slugFor(about, today) {
  const words = String(about || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .slice(0, 6)
    .join('-')

  return (String(today || '').trim() || 'undated') + '-' + (words || 'effort')
}

/**
 * Pure. A directory name this file will accept, or null.
 *
 * The whole path discipline lives here: an effort name arrives from a caller rather than being
 * computed from content the way a knowledge-base node is, so it is the one entrance a traversal
 * could take. One segment, no separators, no dots that could climb.
 */
export function safeSlug(value) {
  if (typeof value !== 'string') return null
  const slug = value.trim()
  if (slug === '' || slug.length > 120) return null
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) return null
  if (slug.includes('..')) return null
  return slug
}

const storeRoot = (repo) => join(repo, ...EFFORTS_DIR.split('/'))
const effortDir = (repo, slug) => join(storeRoot(repo), slug)

/** Whether this repository has an effort store at all — computed, like every other state here. */
export const storePresent = (repo) => existsSync(storeRoot(repo))

/**
 * A UTC stamp, to the second, in the shape a runstamp already uses.
 *
 * Two returns recorded inside the same second would collide, so the caller disambiguates with
 * the counter below rather than trusting the clock to separate them.
 */
export function stampNow(now) {
  const d = now instanceof Date ? now : new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ opening

/**
 * Open an effort, or report the one that is already open under that name.
 *
 * Idempotent by construction: the identity file is written once and never rewritten, so a
 * second phase opening the same effort adopts what the first recorded instead of restating it
 * in its own words. `about` is what the effort is FOR, and a phase that disagrees with an
 * earlier phase about that is describing a different effort and should open one.
 */
export function openEffort(repo, { slug, about, roots, now }) {
  const name = safeSlug(slug)
  if (!name) {
    return { ok: false, error: 'the effort name ' + JSON.stringify(slug) + ' is not a usable ' +
      'directory name — letters, digits, dot, dash and underscore, one segment' }
  }

  const dir = effortDir(repo, name)
  const identity = join(dir, IDENTITY_FILE)

  if (existsSync(identity)) {
    const held = readJson(identity) || {}
    return {
      ok: true, effort: name, path: posix(dir), created: false,
      about: typeof held.about === 'string' ? held.about : '',
      notes: 'this effort was already open; its identity is what the phase that opened it recorded',
    }
  }

  const record = {
    about: String(about || '').trim(),
    roots: (Array.isArray(roots) ? roots : String(roots || '').split(/[,;\n]/))
      .map((r) => posix(r).trim()).filter(Boolean),
    opened_at: (now instanceof Date ? now : new Date()).toISOString(),
  }

  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(identity, JSON.stringify(record, null, 2) + '\n', 'utf8')
  } catch (err) {
    return { ok: false, error: 'the effort could not be opened: ' + err.message }
  }

  return { ok: true, effort: name, path: posix(dir), created: true, about: record.about }
}

// ------------------------------------------------------------------ recording

/**
 * Store one phase's return, verbatim, under its own stamp.
 *
 * `payload` is written exactly as it arrived. Nothing is summarised, nothing is graded and no
 * field is added: a stored survey is the survey's own result object, so the next pass reads
 * what the last pass actually returned rather than somebody's account of it.
 */
export function recordReturn(repo, slug, kind, payload, now) {
  const name = safeSlug(slug)
  if (!name) return { ok: false, error: 'the effort name ' + JSON.stringify(slug) + ' is not usable' }
  if (!KINDS.includes(kind)) {
    return { ok: false, error: 'kind must be one of ' + KINDS.join(', ') }
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'a stored return must be a JSON object — it is the phase\'s own result' }
  }
  if (!existsSync(join(effortDir(repo, name), IDENTITY_FILE))) {
    return { ok: false, error: 'no effort named ' + name + ' is open under ' + EFFORTS_DIR +
      ' — open it before recording into it' }
  }

  const dir = join(effortDir(repo, name), kind + 's')
  const base = stampNow(now)

  try {
    mkdirSync(dir, { recursive: true })
    // A second return inside the same second is a real case — a design pass records a survey
    // and a probe back to back — and overwriting the first would lose the phase this store
    // exists to keep.
    let file = join(dir, base + '.json')
    let n = 1
    while (existsSync(file)) file = join(dir, base + '-' + ++n + '.json')

    writeFileSync(file, JSON.stringify(payload) + '\n', 'utf8')

    // A survey is anchored where it is recorded: the commit it was taken at, and the ground its
    // topics searched. Written beside the return rather than into it, so the return stays
    // verbatim. An anchor with no commit — a repository git cannot read — is written all the
    // same, and `standingSurvey` refuses it by construction.
    let anchor = null
    if (kind === 'survey') {
      anchor = { observed_at: gitOut(repo, ['rev-parse', 'HEAD']), ground: groundOf(payload) }
      writeFileSync(file.replace(/\.json$/, ANCHOR_EXT), JSON.stringify(anchor) + '\n', 'utf8')
    }

    return {
      ok: true, effort: name, kind, path: posix(file), digest: fnv1a(canonical(payload)),
      ...(anchor ? { anchor } : {}),
    }
  } catch (err) {
    return { ok: false, error: 'the ' + kind + ' could not be recorded: ' + err.message }
  }
}

/**
 * Append a pointer: a run of this effort, or the design document it was built from.
 *
 * Append-only, and pointers rather than nesting. A run's own state stays exactly where every
 * other part of this plugin already reads and writes it — `.claude/vfa/runs/<runstamp>/` — so
 * `lib/run-status.mjs`, the resume ladder's path arithmetic and the `runs` skill are untouched
 * and a run recorded before this store existed stays findable. A design document stays in the
 * source tree, because it is source.
 */
export function linkTo(repo, slug, kind, value, now) {
  const name = safeSlug(slug)
  if (!name) return { ok: false, error: 'the effort name ' + JSON.stringify(slug) + ' is not usable' }
  if (!LINK_KINDS.includes(kind)) {
    return { ok: false, error: 'a link kind must be one of ' + LINK_KINDS.join(', ') }
  }
  const target = String(value || '').trim()
  if (target === '') return { ok: false, error: 'a ' + kind + ' link with no value points at nothing' }
  if (!existsSync(join(effortDir(repo, name), IDENTITY_FILE))) {
    return { ok: false, error: 'no effort named ' + name + ' is open under ' + EFFORTS_DIR }
  }

  const line = { kind, value: posix(target), at: (now instanceof Date ? now : new Date()).toISOString() }
  try {
    appendFileSync(join(effortDir(repo, name), LINKS_FILE), JSON.stringify(line) + '\n', 'utf8')
  } catch (err) {
    return { ok: false, error: 'the link could not be appended: ' + err.message }
  }
  return { ok: true, effort: name, ...line }
}

// ------------------------------------------------------------------ reading

const listStamps = (dir) => {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => ({ stamp: e.name.slice(0, -5), bytes: statSync(join(dir, e.name)).size }))
    .sort((a, b) => a.stamp < b.stamp ? -1 : 1)
}

/**
 * What one effort holds, DERIVED on every read.
 *
 * Nothing here is a stored status. The runs an effort owns are the links appended to it, the
 * surveys it holds are the files in its directory, and `latest` is whichever stamp sorts last —
 * so an effort whose files were swept by hand reports what is actually there rather than what
 * something once wrote down about it.
 *
 * @param {string} repo
 * @param {string} slug
 * @param {string} latestKind  'survey' | 'probe' | '' — include that kind's newest return in full
 */
export function readEffort(repo, slug, latestKind) {
  const name = safeSlug(slug)
  if (!name) return { error: 'the effort name ' + JSON.stringify(slug) + ' is not usable' }

  const dir = effortDir(repo, name)
  const identity = readJson(join(dir, IDENTITY_FILE))
  if (!identity) {
    return {
      effort: name, path: posix(dir), exists: false,
      about: '', roots: [], opened_at: '',
      surveys: [], probes: [], runs: [], designs: [], latest: null,
      notes: 'no effort named ' + name + ' is open under ' + EFFORTS_DIR + ' in this repository',
    }
  }

  const links = []
  try {
    for (const line of readFileSync(join(dir, LINKS_FILE), 'utf8').split('\n')) {
      if (line.trim() === '') continue
      const parsed = (() => {
        try { return JSON.parse(line) } catch { return null }
      })()
      if (parsed && LINK_KINDS.includes(parsed.kind)) links.push(parsed)
    }
  } catch {
    // No links file is the ordinary state of an effort that has only been surveyed.
  }

  const surveys = listStamps(join(dir, 'surveys'))
  const probes = listStamps(join(dir, 'probes'))

  const wanted = KINDS.includes(latestKind) ? latestKind : ''
  const pool = wanted === 'survey' ? surveys : wanted === 'probe' ? probes : []
  const newest = pool.length > 0 ? pool[pool.length - 1] : null
  const latest = newest
    ? {
        kind: wanted,
        stamp: newest.stamp,
        payload: readJson(join(dir, wanted + 's', newest.stamp + '.json')),
      }
    : null

  return {
    effort: name,
    path: posix(dir),
    exists: true,
    about: typeof identity.about === 'string' ? identity.about : '',
    roots: Array.isArray(identity.roots) ? identity.roots : [],
    opened_at: typeof identity.opened_at === 'string' ? identity.opened_at : '',
    surveys,
    probes,
    runs: [...new Set(links.filter((l) => l.kind === 'run').map((l) => l.value))],
    designs: [...new Set(links.filter((l) => l.kind === 'design').map((l) => l.value))],
    latest,
    notes: 'DURABLE SCRATCH. Everything here is what an earlier pass returned, unverified — ' +
      'prior context for the next pass, and it proves nothing by being here. The one exception ' +
      'is computed rather than read: `standing` checks whether the newest survey\'s anchored ' +
      'ground is untouched, and only that answer can stand a survey in for a later one.',
  }
}

// ------------------------------------------------------------------ standing

const ANCHOR_EXT = '.anchor'
const VFA_STATE = '.claude/vfa'

function gitOut(repo, args) {
  const run = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  return !run.error && run.status === 0 ? (run.stdout || '').trim() : ''
}

/** The ground a survey return names, as the repo-relative paths git is asked about. */
function groundOf(payload) {
  const raw = Array.isArray(payload && payload.ground) ? payload.ground : []
  const paths = raw.map((p) => {
    const s = posix(p).trim().replace(/^\.\//, '').replace(/\/+$/, '')
    return s === '' || s === '.' ? '.' : safePath(s)
  })
  return paths.includes(null) ? [] : [...new Set(paths)]
}

/**
 * Uncommitted paths on the ground, or null when git could not answer. Untracked files are listed
 * one by one: a collapsed `?? .claude/` would otherwise hide whether anything beside this store
 * sits in it.
 */
function dirtyOn(repo, ground) {
  const run = spawnSync('git', ['-C', repo, 'status', '--porcelain', '-z', '--untracked-files=all',
    '--', ...ground, ':(exclude)' + VFA_STATE], { encoding: 'utf8' })
  if (run.error || run.status !== 0) return null

  const out = []
  const fields = (run.stdout || '').split('\0').filter((f) => f !== '')
  for (let i = 0; i < fields.length; i++) {
    out.push(posix(fields[i].slice(3)))
    // A rename record is followed by its original path as its own field.
    if (/^[RC]/.test(fields[i].slice(0, 2))) out.push(posix(fields[++i] || ''))
  }
  return out.filter(Boolean)
}

/**
 * Whether this effort's newest survey still stands as evidence — computed, never recorded.
 *
 * It stands only when every one of these holds, and the first that fails is named in `why`:
 * a survey is recorded; it carries an anchor with a commit; it names its ground; it reported
 * complete coverage; its commit is still an ancestor of HEAD; no commit since reaches the ground;
 * and no uncommitted edit sits on it. That is the git-event half of a knowledge-base entry's
 * freshness, applied to the survey's whole ground.
 */
export function standingSurvey(repo, slug) {
  const name = safeSlug(slug)
  const refuse = (why, extra = {}) => ({
    standing: false, why, effort: name || '', survey_path: '', stamp: '', observed_at: '',
    head: '', ground: [], commits_since: [], dirty: [], ...extra,
  })
  if (!name) return refuse('the effort name ' + JSON.stringify(slug) + ' is not usable')

  const dir = join(effortDir(repo, name), 'surveys')
  const stamps = listStamps(dir)
  if (stamps.length === 0) return refuse('this effort holds no recorded survey')

  const stamp = stamps[stamps.length - 1].stamp
  const at = { stamp, survey_path: posix(join(dir, stamp + '.json')) }

  const anchor = readJson(join(dir, stamp + ANCHOR_EXT))
  if (!anchor || !anchor.observed_at) {
    return refuse('the newest survey carries no anchor commit — recorded before anchoring ' +
      'existed, or where git could not answer — so nothing can say its ground is unmoved', at)
  }

  const ground = Array.isArray(anchor.ground) ? anchor.ground : []
  const anchored = { ...at, observed_at: anchor.observed_at, ground }
  if (ground.length === 0) {
    return refuse('the newest survey names no ground, so there is nothing to check it against',
      anchored)
  }

  const payload = readJson(join(dir, stamp + '.json'))
  if (!payload || !payload.coverage || payload.coverage.complete !== true) {
    return refuse('the newest survey did not report complete coverage — a partial survey is ' +
      'not evidence enough to skip one', anchored)
  }

  const head = gitOut(repo, ['rev-parse', 'HEAD'])
  const withHead = { ...anchored, head }
  const ancestor = spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', anchor.observed_at, 'HEAD'])
  if (!head || ancestor.error || ancestor.status !== 0) {
    return refuse('the survey\'s commit ' + anchor.observed_at + ' is not an ancestor of HEAD — ' +
      'history moved under it, so no log can say what changed since', withHead)
  }

  // The pipeline's own state under .claude/vfa/ is not ground: this very store sits there, and
  // a survey's own recording would otherwise be the edit that un-stands it.
  const since = gitOut(repo, ['log', '--format=%H', anchor.observed_at + '..HEAD', '--', ...ground,
    ':(exclude)' + VFA_STATE])
  const commits = since === '' ? [] : since.split('\n')
  if (commits.length > 0) {
    return refuse(commits.length + ' commit(s) since the survey touch its ground', {
      ...withHead, commits_since: commits,
    })
  }

  const onGround = dirtyOn(repo, ground)
  if (onGround === null) return refuse('git could not report the working tree\'s state', withHead)
  if (onGround.length > 0) {
    return refuse(onGround.length + ' uncommitted edit(s) sit on the survey\'s ground', {
      ...withHead, dirty: onGround,
    })
  }

  return {
    standing: true,
    why: 'no commit since ' + anchor.observed_at + ' and no uncommitted edit reaches the ' +
      'survey\'s ground, and it reported complete coverage',
    effort: name, ...withHead, commits_since: [], dirty: [],
  }
}

/** Every effort in the repository, newest name first — the picker's payload. */
export function listEfforts(repo) {
  let entries
  try {
    entries = readdirSync(storeRoot(repo), { withFileTypes: true })
  } catch {
    return {
      repo: posix(repo), efforts: [], store_present: false,
      notes: 'no effort store exists at ' + EFFORTS_DIR + ' in this repository; the first phase ' +
        'that opens one creates it',
    }
  }

  const efforts = entries
    .filter((e) => e.isDirectory() && safeSlug(e.name))
    .map((e) => {
      const read = readEffort(repo, e.name, '')
      return {
        effort: e.name,
        about: read.about,
        opened_at: read.opened_at,
        surveys: read.surveys.length,
        probes: read.probes.length,
        runs: read.runs,
        designs: read.designs,
      }
    })
    .filter((e) => e.opened_at !== '' || e.surveys > 0 || e.probes > 0)
    .sort((a, b) => a.effort < b.effort ? 1 : -1)

  return {
    repo: posix(repo), efforts, store_present: true,
    notes: 'listed ' + efforts.length + ' effort(s) under ' + EFFORTS_DIR,
  }
}

// ------------------------------------------------------------------ the CLI

/** Everything after `--name`, or '' when the flag is absent. */
const flag = (argv, name) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : ''
}

/**
 * A phase's return, from a FILE rather than from an argv token.
 *
 * A survey's result object is as large as the survey was interesting, and a command line is
 * finite — Windows caps a process's at 8191 characters. So the payload is written to a file and
 * the PATH is passed, which is short whatever the return weighs. It is also the safe direction:
 * the bytes reach this process off a disk instead of through an argument list.
 */
function payloadFrom(path) {
  if (!path) return { value: null, error: 'no --file was given, so there is no return to record' }
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    return { value: null, error: 'the return file ' + path + ' could not be read: ' + err.message }
  }
  try {
    return { value: JSON.parse(text), error: '' }
  } catch (err) {
    return { value: null, error: 'the return file ' + path + ' is not JSON (' + err.message + ')' }
  }
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  const usage = 'usage:\n' +
    '  effort.mjs open <repo> <slug> --about <text> [--roots <csv>]\n' +
    '  effort.mjs slug <about> \n' +
    '  effort.mjs record <repo> <slug> survey|probe --file <path to the return as JSON>\n' +
    '  effort.mjs link <repo> <slug> run|design --value <runstamp or path>\n' +
    '  effort.mjs read <repo> <slug> [--latest survey|probe]\n' +
    '  effort.mjs standing <repo> <slug>\n' +
    '  effort.mjs list <repo>'

  try {
    const argv = process.argv.slice(2)
    const [command, ...rest] = argv

    // The one command that touches no repository: it turns free text into the directory name
    // the other commands take, so a session names an effort the same way twice.
    if (command === 'slug') {
      const today = new Date().toISOString().slice(0, 10)
      console.log(JSON.stringify({ ok: true, slug: slugFor(rest.filter((a) => !a.startsWith('--')).join(' '), today) }))
      process.exit(0)
    }

    const repo = posix(rest[0] || '')
    if (!command || !repo) throw new Error(usage)

    // Writers print the ledger's shape — {"ok":...} — because their caller reads an accepted or
    // refused write. Readers print the run-verdict envelope, because theirs is a payload that
    // may be carried.
    if (command === 'open') {
      const out = openEffort(repo, {
        slug: rest[1], about: flag(argv, 'about'), roots: flag(argv, 'roots') || repo,
      })
      console.log(JSON.stringify(out))
      process.exit(out.ok ? 0 : 1)
    }

    if (command === 'record') {
      const held = payloadFrom(flag(argv, 'file'))
      if (held.error) {
        console.log(JSON.stringify({ ok: false, error: held.error }))
        process.exit(1)
      }
      const out = recordReturn(repo, rest[1], rest[2], held.value)
      console.log(JSON.stringify(out))
      process.exit(out.ok ? 0 : 1)
    }

    if (command === 'link') {
      const out = linkTo(repo, rest[1], rest[2], flag(argv, 'value'))
      console.log(JSON.stringify(out))
      process.exit(out.ok ? 0 : 1)
    }

    const payload = command === 'read' ? readEffort(repo, rest[1], flag(argv, 'latest'))
      : command === 'standing' ? standingSurvey(repo, rest[1])
        : command === 'list' ? listEfforts(repo)
        : null

    if (!payload) throw new Error('unknown command ' + JSON.stringify(command) + '\n' + usage)

    console.log(JSON.stringify({ payload, payload_digest: fnv1a(canonical(payload)) }))
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
