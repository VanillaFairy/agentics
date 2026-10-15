// tools/migrate-glob-literal.mjs — the one-shot that keeps stored evidence scopes meaning what they
// meant when brackets turned literal in the search glob dialect, run once after upgrading to 5.5.0.
//
// Design: docs/DESIGN.md#migration-from-4x.
//
// A query scope stored before 5.5.0 was read by git's `:(glob)` pathspec, where `[...]` is a character
// class. The search dialect has no classes (`lib/search/query.mjs`), so a stored part holding one would
// silently mean another path. This is the only place that still knows the old reading, and git is its
// reference: a positive class (`[ab]`, `[a-c]`) becomes one literal part per character it holds; a
// negated class or a POSIX class (`[!x]`, `[[:digit:]]`) has its whole segment replaced by each concrete
// segment value the old part matched among the files at the item's anchor commit (HEAD when that commit
// is gone), listed by `git ls-files -- ':(glob)<part>'` over a scratch index of that commit. An escaped
// or unclosed bracket is already literal in git and stays. A part is rewritten only when its new parts,
// read in the new dialect, match exactly the files the old part matched at the anchor; a part that
// cannot be (a class holding `*` or `?`, which the new dialect cannot spell as a literal, or a result
// that would read as a class again) is left as it is and listed. A part the old reading matched nothing
// of is left too: it matches nothing now either, and dropping it could widen a scope.
//
// The evidence store's items file is rewritten whole under the store's lock, each line as it was but
// for the scopes; a line it cannot read is kept byte for byte. `apply` re-reads the file and writes a
// plan's scope only where the stored scope is still the one the plan saw, so a plan applied late, or
// beside a writer, changes nothing it should not. The default is a dry run; `--yes` applies; the exit
// is 1 while a scope is malformed or a part was left.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { within } from '../lib/search/query.mjs'
import { evidenceItemsPath, git, mainCheckout, posix, projectStateDir, revParse, withLock, writeWhole } from '../lib/store.mjs'

const SHA = /^[0-9a-f]{40}$/
const UNSPELLABLE = /[*?]/

/** The POSIX classes, over ASCII as git's wildmatch reads them. */
const POSIX_CLASSES = {
  alnum: /[A-Za-z0-9]/, alpha: /[A-Za-z]/, blank: /[ \t]/, cntrl: /[\x00-\x1f\x7f]/, digit: /[0-9]/, graph: /[\x21-\x7e]/,
  lower: /[a-z]/, print: /[\x20-\x7e]/, punct: /[!-/:-@[-`{-~]/, space: /[ \t\n\v\f\r]/, upper: /[A-Z]/, xdigit: /[0-9A-Fa-f]/,
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i])

// ------------------------------------------------------------------ the old dialect

/** Pure. The class opening at `chars[start]` as wildmatch reads it, with the index of its `]`; null when it never closes. */
function classAt(chars, start) {
  const cls = { negated: false, ranges: [], posix: [] }
  let i = start + 1
  if (chars[i] === '!' || chars[i] === '^') {
    cls.negated = true
    i++
  }
  for (let first = true; ; first = false) {
    if (i >= chars.length) return null
    let c = chars[i]
    if (c === ']' && !first) return { token: { cls, raw: chars.slice(start, i + 1).join('') }, end: i }
    if (c === '[' && chars[i + 1] === ':') {
      const close = chars.indexOf(']', i + 2)
      if (close < 0) return null
      if (close > i + 2 && chars[close - 1] === ':') {
        const name = chars.slice(i + 2, close - 1).join('')
        if (!Object.hasOwn(POSIX_CLASSES, name)) return null
        cls.posix.push(name)
        i = close + 1
        continue
      }
    }
    if (c === '\\') {
      if (++i >= chars.length) return null
      c = chars[i]
    }
    let hi = c
    if (chars[i + 1] === '-' && i + 2 < chars.length && chars[i + 2] !== ']') {
      i += 2
      hi = chars[i]
      if (hi === '\\') {
        if (++i >= chars.length) return null
        hi = chars[i]
      }
    }
    cls.ranges.push([c.codePointAt(0), hi.codePointAt(0)])
    i++
  }
}

/**
 * Pure. One segment of an old-dialect part: `{globstar}` for a whole `**`, else its tokens
 * (`lit`, `one`, `star`, `cls`, each with its `raw` text), `classed` when it holds a class and `resolve`
 * when one is negated or POSIX. Null when a `[` in it never closes: git aborts on such a part.
 */
function segmentOf(text) {
  if (text === '**') return { globstar: true, text }
  const chars = Array.from(text)
  const tokens = []
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    if (c === '\\' && i + 1 < chars.length) {
      tokens.push({ lit: chars[i + 1], raw: c + chars[i + 1] })
      i++
    } else if (c === '[') {
      const found = classAt(chars, i)
      if (!found) return null
      tokens.push(found.token)
      i = found.end
    } else if (c === '?') {
      tokens.push({ one: true, raw: c })
    } else if (c === '*') {
      tokens.push({ star: true, raw: c })
    } else {
      tokens.push({ lit: c, raw: c })
    }
  }
  const classes = tokens.filter((t) => t.cls)
  return { tokens, classed: classes.length > 0, resolve: classes.some((t) => t.cls.negated || t.cls.posix.length > 0) }
}

const classHas = ({ negated, ranges, posix: named }, ch) => {
  const cp = ch.codePointAt(0)
  const hit = ranges.some(([lo, hi]) => cp >= lo && cp <= hi) || named.some((n) => POSIX_CLASSES[n].test(ch))
  return hit !== negated
}

/** Pure. Whether one file-name segment matches a segment's tokens. */
function matches(tokens, name) {
  const s = Array.from(name)
  const from = (ti, si) => {
    if (ti === tokens.length) return si === s.length
    const t = tokens[ti]
    if (t.star) {
      for (let k = si; k <= s.length; k++) if (from(ti + 1, k)) return true
      return false
    }
    if (si >= s.length) return false
    const ok = t.lit !== undefined ? t.lit === s[si] : t.one ? true : classHas(t.cls, s[si])
    return ok && from(ti + 1, si + 1)
  }
  return from(0, 0)
}

/**
 * Pure. Every way the old segments match a file's segments, as the file-name segments the `resolve`
 * segments took in each. A `**` crosses any number of directories; a final one crosses at least one.
 */
function alignments(pattern, names) {
  const out = []
  const walk = (p, f, took) => {
    if (p === pattern.length) {
      if (f === names.length) out.push(took)
      return
    }
    const seg = pattern[p]
    if (seg.globstar) {
      for (let n = p === pattern.length - 1 ? 1 : 0; f + n <= names.length; n++) walk(p + 1, f + n, took)
    } else if (f < names.length && matches(seg.tokens, names[f])) {
      walk(p + 1, f + 1, seg.resolve ? [...took, names[f]] : took)
    }
  }
  walk(0, 0, [])
  return out
}

// ------------------------------------------------------------------ the new parts

/** Pure. The characters a positive class holds; null when it holds one the new dialect cannot spell as a literal. */
function membersOf(cls) {
  const chars = new Set()
  for (const [lo, hi] of cls.ranges) {
    for (let cp = lo; cp <= hi; cp++) {
      const c = String.fromCodePoint(cp)
      if (c !== '/') chars.add(c)
    }
  }
  return [...chars].some((c) => UNSPELLABLE.test(c)) ? null : [...chars]
}

/** Pure. The strings a segment without a negated or POSIX class stands for; null when it needs a character the new dialect cannot spell. */
function spellings(seg) {
  if (seg.globstar) return ['**']
  let out = ['']
  for (const t of seg.tokens) {
    const options = t.cls ? membersOf(t.cls) : [t.raw]
    if (!options) return null
    out = out.flatMap((head) => options.map((o) => head + o))
  }
  return out
}

/** Pure. Every part whose i-th segment is one of `options[i]`. */
const combos = (options) => options.reduce((heads, opts) => heads.flatMap((h) => opts.map((o) => (h === null ? o : h + '/' + o))), [null])

/** Pure. Whether a part holds a class the old reading would expand: a rerun would rewrite it again. */
const holdsClass = (part) => part.split('/').some((s) => segmentOf(s)?.classed)

const CANNOT_SPELL = 'a class holds * or ?, which the new dialect cannot spell as a literal'

/**
 * One old-dialect part as `{same}` (nothing to rewrite), `{parts}` (the literal parts of the same
 * meaning) or `{left}` (why it is left). `at()` is the anchor's reference, read only when a negated or
 * POSIX class needs it.
 */
function expandPart(part, at) {
  const segs = part.split('/').map(segmentOf)
  if (segs.includes(null) || !segs.some((s) => s.classed)) return { same: true }
  const options = segs.map((s) => (s.resolve ? null : spellings(s)))
  if (options.some((o, i) => o === null && !segs[i].resolve)) return { left: CANNOT_SPELL }

  let parts
  if (!segs.some((s) => s.resolve)) {
    parts = combos(options)
  } else {
    const reference = at()
    const files = reference.matched(part)
    const tuples = new Map()
    for (const file of files) for (const took of alignments(segs, file.split('/'))) tuples.set(JSON.stringify(took), took)
    if ([...tuples.values()].flat().some((v) => UNSPELLABLE.test(v))) return { left: 'a file name holds * or ?, which the new dialect cannot spell as a literal' }
    parts = [...tuples.values()].flatMap((took) => {
      let k = 0
      return combos(segs.map((s, i) => (s.resolve ? [took[k++]] : options[i])))
    })
    const covered = reference.all().filter((f) => parts.some((p) => within(f, p)))
    if (JSON.stringify(covered.sort()) !== JSON.stringify([...files].sort())) {
      return { left: 'its literal parts would not match the files the class matched at the anchor' }
    }
  }
  parts = [...new Set(parts)]
  if (parts.length === 0) return { same: true }
  if (parts.some(holdsClass)) return { left: 'a literal part would read as a class again' }
  return { parts }
}

// ------------------------------------------------------------------ git as the reference

/** The files of a commit, and those an old `:(glob)` part matched, through one scratch index per commit. */
function referenceOf(root) {
  let dir = null
  const indexes = new Map()
  const listing = (rev, pathspecs) => {
    if (!indexes.has(rev)) {
      dir ??= mkdtempSync(join(tmpdir(), 'agentics-glob-index-'))
      const env = { GIT_INDEX_FILE: join(dir, String(indexes.size)) }
      indexes.set(rev, git(root, ['read-tree', rev], undefined, { env }).ok ? env : null)
    }
    const env = indexes.get(rev)
    return env ? git(root, ['ls-files', '-z', '--', ...pathspecs], undefined, { env }).stdout.split('\0').filter(Boolean) : []
  }
  return {
    at: (rev) => ({ matched: (part) => listing(rev, [':(glob)' + part]), all: () => listing(rev, []) }),
    close: () => dir && rmSync(dir, { recursive: true, force: true, maxRetries: 3 }),
  }
}

/** The commit an item entry is anchored at: a span's `at`, else its latest judgement's, that this repository holds; else HEAD. */
function anchorOf(entry, judged, held) {
  const spans = Array.isArray(entry.item.spans) ? entry.item.spans.map((s) => isObject(s) && s.at) : []
  const latest = judged.get(entry.item.id)
  for (const at of [...spans, latest && latest.at]) {
    if (typeof at === 'string' && SHA.test(at) && held(at)) return at
  }
  return 'HEAD'
}

// ------------------------------------------------------------------ plan and apply

const parsed = (line) => {
  try {
    const v = JSON.parse(line)
    return isObject(v) ? v : null
  } catch {
    return null
  }
}

/**
 * What the evidence store needs, without writing anything: `items`, one per query scope to rewrite
 * (`{index, seq, id, claim, query, before, after}`, `index` the line of the items file); `unchanged`,
 * the well-formed scopes that need nothing; `malformed` and `left`, what it cannot rewrite; and
 * `unreadable`, the lines it keeps untouched.
 */
export function plan(repo) {
  const root = posix(mainCheckout(resolve(String(repo))))
  const file = evidenceItemsPath(root)
  const out = { root, file, items: [], unchanged: 0, malformed: [], left: [], unreadable: [] }
  const lines = (existsSync(file) ? readFileSync(file, 'utf8') : '').split('\n')
  const entries = lines.map((line) => (line.trim() === '' ? null : parsed(line)))
  lines.forEach((line, index) => {
    if (line.trim() !== '' && !entries[index]) out.unreadable.push({ index })
  })

  const judged = new Map()
  for (const e of entries) {
    if (e && e.kind === 'judged' && Number.isInteger(e.seq) && (!judged.has(e.id) || e.seq > judged.get(e.id).seq)) judged.set(e.id, e)
  }
  const holds = new Map()
  const held = (sha) => {
    if (!holds.has(sha)) holds.set(sha, revParse(root, sha) !== '')
    return holds.get(sha)
  }
  const reference = referenceOf(root)
  try {
    entries.forEach((entry, index) => {
      if (!entry || entry.kind !== 'item' || !isObject(entry.item) || !Array.isArray(entry.item.queries)) return
      const who = { index, seq: entry.seq, id: entry.item.id, claim: entry.item.claim }
      let at = null
      const anchor = () => (at ??= reference.at(anchorOf(entry, judged, held)))
      entry.item.queries.forEach((q, query) => {
        if (!isObject(q) || !Array.isArray(q.scope) || q.scope.some((p) => typeof p !== 'string')) {
          out.malformed.push({ ...who, query, why: 'the scope is not a list of paths' })
          return
        }
        const results = q.scope.map((part) => expandPart(part, anchor))
        let stuck = false
        results.forEach((r, i) => {
          if (r.left) {
            stuck = true
            out.left.push({ ...who, query, part: q.scope[i], why: r.left })
          }
        })
        if (!results.some((r) => r.parts)) {
          if (!stuck) out.unchanged++
          return
        }
        const after = [...new Set(results.flatMap((r, i) => r.parts ?? [q.scope[i]]))]
        out.items.push({ ...who, query, before: q.scope, after })
      })
    })
  } finally {
    reference.close()
  }
  return out
}

/**
 * Perform what the plan lists: `{applied, error}`, `applied` the number of scopes rewritten. The items
 * file is read again under the store's lock, and a scope is written only where the stored one is still
 * the `before` the plan saw; every other line stays as it is.
 */
export function apply(p) {
  if (p.items.length === 0) return { applied: 0, error: '' }
  try {
    const applied = withLock(join(projectStateDir(p.root), '.lock'), () => {
      const lines = (existsSync(p.file) ? readFileSync(p.file, 'utf8') : '').split('\n')
      let count = 0
      for (const [index, line] of lines.entries()) {
        const planned = p.items.filter((i) => i.index === index)
        const entry = planned.length ? parsed(line) : null
        if (!entry || !isObject(entry.item) || !Array.isArray(entry.item.queries)) continue
        let changed = false
        for (const it of planned) {
          const q = entry.item.queries[it.query]
          if (entry.seq === it.seq && isObject(q) && sameList(q.scope, it.before)) {
            q.scope = it.after
            changed = true
            count++
          }
        }
        if (changed) lines[index] = JSON.stringify(entry)
      }
      if (count > 0) writeWhole(p.file, lines.join('\n'))
      return count
    })
    return { applied, error: '' }
  } catch (err) {
    return { applied: 0, error: String(err && err.message ? err.message : err) }
  }
}

// ------------------------------------------------------------------ the command

const named = (x) => `${x.id} ${JSON.stringify(x.claim)} (line ${x.index + 1}, query ${x.query})`

function reportOf(p, done, yes) {
  const out = []
  for (const i of p.items) out.push(`rewrite ${named(i)}: ${JSON.stringify(i.before)} -> ${JSON.stringify(i.after)}`)
  for (const m of p.malformed) out.push(`malformed ${named(m)}: ${m.why}; left as it is`)
  for (const l of p.left) out.push(`left ${named(l)}: part ${JSON.stringify(l.part)}: ${l.why}`)
  for (const u of p.unreadable) out.push(`unreadable line ${u.index + 1} of the items file: kept as it is`)
  out.push(`${p.items.length} scope(s) to rewrite, ${p.unchanged} unchanged`)
  if (done.error) out.push('error: ' + done.error)
  else out.push(yes ? `rewrote ${done.applied} scope(s)` : p.items.length ? 'dry run: nothing written; run again with --yes to apply' : 'nothing to migrate')
  return out.join('\n')
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  const argv = process.argv.slice(2)
  const at = argv.indexOf('--repo')
  const rest = argv.filter((a, i) => a !== '--yes' && i !== at && (at < 0 || i !== at + 1))
  if (rest.length > 0 || (at >= 0 && !argv[at + 1])) {
    console.error('usage: node tools/migrate-glob-literal.mjs [--repo <path>] [--yes]')
    process.exitCode = 2
  } else {
    const p = plan(at >= 0 ? argv[at + 1] : '.')
    const yes = argv.includes('--yes')
    const done = yes ? apply(p) : { applied: 0, error: '' }
    console.log(reportOf(p, done, yes))
    process.exitCode = done.error || p.malformed.length || p.left.length ? 1 : 0
  }
}
