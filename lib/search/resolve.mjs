// lib/search/resolve.mjs — what a search's material names, resolved on its tree with no model: the
// paths it cites, the identifiers it writes in code form and where each is defined and used, the
// documents it names, an effort's change, and the guidance the search is seeded with. Every row is
// observed; a row the tree lacks is kept and ranked last (D13).
//
// Design: docs/DESIGN.md#searches and docs/DESIGN.md#p2--code-does-what-is-deterministic-models-only-judge.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { pathKey } from './query.mjs'
import { files as listFiles, grep, keyOf, refs } from './tools.mjs'

const run = promisify(execFile)

const posix = (p) => String(p).split('\\').join('/')
/** Pure. A repo-relative posix path, or null when it is absolute or climbs out. */
function safePath(value) {
  const p = posix(value).trim().replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  if (p === '' || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null
  const segs = p.split('/').filter((s) => s !== '' && s !== '.')
  return segs.some((s) => s === '..') ? null : segs.join('/')
}

const URL_TOKEN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s`<>)\]]+/gi
const SPAN = /`([^`\n]+)`/g
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\(\))?$/
const BARE_FILE = /^[A-Za-z0-9_@-][A-Za-z0-9_.@-]*\.[A-Za-z](?:[A-Za-z0-9]{0,6}[A-Za-z])?$/
// The lookbehind keeps a scan from starting inside a path it would not take whole (`../x/a.ts`
// must not become `x/a.ts`); brackets are in the class for route segments (`app/[id]/page.tsx`).
const PATH = /(?<![A-Za-z0-9_.@[\]/\\-])((?:[A-Za-z0-9_.@[\]-]+[/\\])+[A-Za-z0-9_.@[\]-]*\.[A-Za-z](?:[A-Za-z0-9]{0,6}[A-Za-z])?)(?::\d+(?:-\d+)?)?(?![A-Za-z0-9_/\\-])/g
const DOC = /(?<![A-Za-z0-9_./\\-])([A-Za-z0-9_][A-Za-z0-9_.-]*\.md)(?![A-Za-z0-9_/\\-])/g
const SYMBOLS = [
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,          // SCREAMING_CASE
  /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g,      // CamelCase, two humps or more
  /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g,        // lowerCamel
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g,          // snake_case, two parts or more
]
const blank = (m) => ' '.repeat(m.length)

/** Pure. Mentions in material text: path-shaped strings, code-shaped identifiers (backticked,
 *  CamelCase, SCREAMING_CASE, snake_case of 2+ parts), document names (*.md). Deduped, in order. */
export function mentionsOf(text) {
  const found = []
  let src = String(text ?? '').replace(URL_TOKEN, blank)
  src = src.replace(SPAN, (m, inner, at) => {
    const t = inner.trim()
    if (IDENT.test(t)) {
      found.push([at, 'symbols', t.replace(/\(\)$/, '')])
      return blank(m)
    }
    if (BARE_FILE.test(t)) {
      found.push([at, t.endsWith('.md') ? 'docs' : 'paths', t])
      return blank(m)
    }
    return m
  })
  src = src.replace(PATH, (m, p, at) => {
    const path = safePath(p)
    if (path) found.push([at, 'paths', path])
    return blank(m)
  })
  src = src.replace(DOC, (m, d, at) => {
    found.push([at, 'docs', d])
    return blank(m)
  })
  for (const re of SYMBOLS) for (const m of src.matchAll(re)) found.push([m.index, 'symbols', m[0]])
  const out = { paths: [], symbols: [], docs: [] }
  for (const [, list, value] of found.sort((a, b) => a[0] - b[0])) if (!out[list].includes(value)) out[list].push(value)
  return out
}

// One grep per language over every symbol at once: `before` and `after` wrap the alternation of
// symbols for git grep -E (POSIX classes, no backslash-letter escapes, so `queryOf` passes them
// through), and `js`/`jsAfter` are the same shape as a JS RegExp, to say which symbol a line defines.
const DEFINITIONS = [
  { globs: ['*.js', '*.mjs', '*.cjs', '*.jsx', '*.ts', '*.tsx', '*.mts', '*.cts'],
    before: '(function[*]?|class|interface|type|enum|const|let|var|namespace)[[:space:]]+', js: '(?:function\\*?|class|interface|type|enum|const|let|var|namespace)\\s+' },
  { globs: ['*.py'], before: '(def|class)[[:space:]]+', js: '(?:def|class)\\s+' },
  { globs: ['*.go'], before: '(func|type|var|const)[[:space:]]+([(][^)]*[)][[:space:]]*)?', js: '(?:func|type|var|const)\\s+(?:\\([^)]*\\)\\s*)?' },
  { globs: ['*.rs'], before: '(fn|struct|enum|trait|type|const|static|mod)[[:space:]]+', js: '(?:fn|struct|enum|trait|type|const|static|mod)\\s+' },
  { globs: ['*.c', '*.h', '*.cc', '*.cpp', '*.hpp', '*.cs', '*.java', '*.kt', '*.swift'],
    before: '(class|struct|enum|interface|#define)[[:space:]]+', js: '(?:class|struct|enum|interface|#define)\\s+' },
  { globs: ['*.json', '*.yaml', '*.yml', '*.toml'],
    before: '^[[:space:]]*["\']?', after: '["\']?[[:space:]]*[:=]', js: '^\\s*["\']?', jsAfter: '["\']?\\s*[:=]' },
]
const END = '([^[:alnum:]_$]|$)'
const JS_END = '(?![A-Za-z0-9_$])'
const reEscape = (s) => s.replace(/[$]/g, '\\$')
const ereEscape = (s) => s.replace(/[$]/g, '[$]')

// The glob paths of a language inside the scope, in the search glob dialect: each part, then `**/`,
// then the language's file glob; for the part `.` the recursive glob alone.
const scopedGlobs = (scope, globs) => scope.flatMap((part) => globs.map((g) => {
  const p = pathKey(part)
  return p === '.' ? '**/' + g : p + '/**/' + g
}))

/** Every page of a paged tool call, concatenated; stops at the first refusal and says so. */
async function allPages(call, field) {
  const out = []
  for (let page = 1; ; page++) {
    const r = await call(page)
    if (!r.ok) return { ok: false, refusal: r.refusal, detail: r.detail, items: out }
    out.push(...r[field])
    if (page >= r.pages) return { ok: true, items: out }
  }
}

/** The mentions of every material item, merged in order, each once, with the union of the asks of the
 *  items that named it. */
function mergeMentions(material) {
  const merged = { paths: new Map(), symbols: new Map(), docs: new Map() }
  const add = (text, asks) => {
    const found = mentionsOf(text)
    for (const list of Object.keys(merged)) {
      for (const mention of found[list]) {
        if (!merged[list].has(mention)) merged[list].set(mention, [])
        const have = merged[list].get(mention)
        for (const a of asks) if (!have.includes(a)) have.push(a)
      }
    }
  }
  for (const item of material) add(item.text, item.asks ?? [])
  return merged
}

/** The files a diff names. */
async function diffNames(root, { base, head }) {
  const names = await run('git', ['-C', root, 'diff', '--name-only', '--no-renames', '-z', base, head, '--'], { maxBuffer: 1 << 30, windowsHide: true })
  return names.stdout.split('\0').filter((n) => n !== '')
}

/** The definition sites of every symbol at once, one grep per language. A refusal leaves that
 *  language's definitions out; it never throws. */
async function definitionsOf(tree, symbols, scope) {
  const defs = new Map(symbols.map((s) => [s, []]))
  if (symbols.length === 0) return defs
  for (const lang of DEFINITIONS) {
    const pattern = lang.before + '(' + symbols.map(ereEscape).join('|') + ')' + (lang.after || END)
    const found = await allPages((page) => grep(tree, { pattern, paths: scopedGlobs(scope, lang.globs), page }, { scope }), 'lines')
    const shapes = symbols.map((s) => [s, new RegExp(lang.js + reEscape(s) + (lang.jsAfter || JS_END))])
    for (const line of found.items) {
      for (const [symbol, shape] of shapes) {
        const sites = defs.get(symbol)
        if (shape.test(line.text) && !sites.some((d) => d.key === line.key && d.line === line.line)) sites.push({ key: line.key, line: line.line })
      }
    }
  }
  return defs
}

const makeRow = (kind, mention, key, exists, asks) => ({ kind, mention, key, exists, asks: [...asks], defs: [], refs: [], files: 0 })

// Existing rows by group (change, then path and document, then symbol), missing rows after them in
// the order they were made.
const GROUP = { change: 0, path: 1, doc: 1, symbol: 2 }
function ranked(rows) {
  const present = rows.filter((r) => r.exists)
  present.sort((a, b) => GROUP[a.kind] - GROUP[b.kind] || (a.kind === 'symbol' ? a.files - b.files : 0))
  return [...present, ...rows.filter((r) => !r.exists)]
}

/** The repository's guidance, and the INDEX.md and module .md beside each path that resolved. */
async function seedsOf(tree, rows, config) {
  const seeds = new Set()
  for (const glob of ['**/CLAUDE.md', '**/AGENTS.md', 'docs/**/*.md']) {
    const found = await allPages((page) => listFiles(tree, { glob, page }, { scope: ['.'] }), 'keys')
    for (const key of found.items) seeds.add(key)
  }
  const keep = (path) => {
    const k = keyOf(tree, path)
    if (k.ok) seeds.add(k.key)
  }
  for (const path of config.guidance ?? []) keep(path)
  for (const r of rows) {
    if (r.kind !== 'path' || !r.exists) continue
    const at = r.key.lastIndexOf('/')
    const dir = at < 0 ? '' : r.key.slice(0, at)
    keep(dir === '' ? 'INDEX.md' : dir + '/INDEX.md')
    if (dir !== '') keep(dir + '/' + dir.slice(dir.lastIndexOf('/') + 1) + '.md')
  }
  return [...seeds]
}

/** The files under `scope` on the tree, tracked and untracked, sorted: never a fenced key, never under node_modules
 *  unless a scope part names node_modules; each initialised submodule's files keyed under its path. The listing is
 *  the `files` tool's own, so its fence and submodule rules hold. */
export async function scopeFiles(tree, scope) {
  const keys = new Set()
  for (const part of scope) {
    const p = pathKey(part)
    for (const glob of p === '.' ? ['**'] : [p, p + '/**']) {
      const found = await allPages((page) => listFiles(tree, { glob, page }, { scope }), 'keys')
      for (const key of found.items) keys.add(key)
    }
  }
  return [...keys].sort()
}

export async function groundTable(tree, { material = [], scope = ['.'], diff = null, config = {} } = {}) {
  const changed = diff ? await diffNames(tree.root, diff) : []
  const merged = mergeMentions(material)
  const rows = []

  for (const name of changed) {
    const k = keyOf(tree, name)
    const key = k.ok ? k.key : name
    rows.push(makeRow('change', key, key, k.ok, merged.paths.get(key) ?? []))
  }
  for (const [mention, asks] of merged.paths) {
    const k = keyOf(tree, mention)
    rows.push(makeRow('path', mention, k.ok ? k.key : mention, k.ok, asks))
  }
  for (const [mention, asks] of merged.docs) {
    const found = await allPages((page) => listFiles(tree, { glob: '**/' + mention, page }, { scope: ['.'] }), 'keys')
    if (found.items.length === 0) rows.push(makeRow('doc', mention, mention, false, asks))
    for (const key of found.items) rows.push(makeRow('doc', mention, key, true, asks))
  }

  const symbols = [...merged.symbols.keys()]
  const defs = await definitionsOf(tree, symbols, scope)
  for (const symbol of symbols) {
    const r = makeRow('symbol', symbol, symbol, false, merged.symbols.get(symbol))
    r.defs = defs.get(symbol)
    const used = await refs(tree, { symbol }, { scope })
    if (used.ok) r.refs = used.files.map(({ key, count, test }) => ({ key, count, test }))
    r.files = r.refs.length
    r.exists = r.defs.length > 0 || r.refs.length > 0
    rows.push(r)
  }

  return { rows: ranked(rows), seeds: await seedsOf(tree, rows, config) }
}
