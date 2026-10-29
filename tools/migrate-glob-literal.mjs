// tools/migrate-glob-literal.mjs — the one-shot report on stored evidence scopes once brackets turned
// literal in the search glob dialect, run once after upgrading to 5.5.0. It writes nothing.
//
// Design: docs/DESIGN.md#migrations.
//
// Stored query scopes are read in the new dialect as they stand. An item whose stored query result
// differs from what its scope finds now is drifted: `checkAnchors` derives it `suspect` with a `query`
// change, and its judge re-rules it; a `holds` from `recordJudgement` records the fresh result. Writing
// fresh results here would erase that flag, so the tool only lists:
//   drifted    each changed query anchor of an item `checkAnchors` derives suspect;
//   bracketed  a scope part holding `[` whose exact text is a file at HEAD;
//   escaped    a part holding `\[`, with the files `git ls-files -- <part>` lists (what git used to read);
//   malformed  a scope that is not a list of strings, or a line it cannot read.
// It reads the latest revision of each item and finds the store through the main checkout. Exit 1 while
// anything is malformed, else 0: drift is the expected outcome.

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { checkAnchors } from '../lib/evidence.mjs'
import { evidenceItemsPath, git, mainCheckout, posix } from '../lib/store.mjs'

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isScope = (s) => Array.isArray(s) && s.every((p) => typeof p === 'string')

const parsed = (line) => {
  try {
    const v = JSON.parse(line)
    return isObject(v) ? v : null
  } catch {
    return null
  }
}

/** The files `git ls-files` lists for `pathspecs` (all when none), sorted. */
const listed = (root, pathspecs) => {
  const r = git(root, ['ls-files', '-z', '--', ...pathspecs])
  return r.ok ? r.stdout.split('\0').filter(Boolean).sort() : []
}

/** What the store's scopes need from their judges and the user, without writing anything. */
export function plan(repo) {
  const root = posix(mainCheckout(resolve(String(repo))))
  const file = evidenceItemsPath(root)
  const out = { drifted: [], bracketed: [], escaped: [], malformed: [], standing: 0 }
  const lines = (existsSync(file) ? readFileSync(file, 'utf8') : '').split('\n')

  const latest = new Map()
  lines.forEach((line, index) => {
    if (line.trim() === '') return
    const e = parsed(line)
    if (!e) {
      out.malformed.push({ id: null, claim: null, line: index + 1, why: 'the line cannot be read' })
      return
    }
    if (e.kind !== 'item' || !isObject(e.item) || typeof e.item.id !== 'string') return
    const prev = latest.get(e.item.id)
    if (!prev || e.seq > prev.entry.seq) latest.set(e.item.id, { entry: e, line: index + 1 })
  })

  const items = new Map()
  for (const [id, { entry, line }] of latest) {
    const { claim, queries } = entry.item
    if (!Array.isArray(queries) || !queries.every((q) => isObject(q) && isScope(q.scope))) {
      out.malformed.push({ id, claim, line, why: 'a query scope is not a list of strings' })
    } else {
      items.set(id, entry.item)
    }
  }

  const files = new Set(listed(root, []))
  for (const [id, { claim, queries }] of items) {
    queries.forEach((q, query) => {
      for (const part of q.scope) {
        if (part.includes('[') && files.has(part)) out.bracketed.push({ id, claim, query, part, file: part })
        if (part.includes('\\[')) out.escaped.push({ id, claim, query, part, read: listed(root, [part]) })
      }
    })
  }

  const ids = [...items.keys()].filter((id) => items.get(id).queries.length > 0).sort()
  for (const st of ids.length ? checkAnchors(root, ids) : []) {
    if (st.state === 'stale') continue
    const changed = st.changed.filter((c) => c.anchor === 'query')
    if (st.state === 'suspect' && changed.length) {
      for (const c of changed) out.drifted.push({ id: st.id, claim: items.get(st.id).claim, query: c.index, old: c.old, now: c.now })
    } else {
      out.standing++
    }
  }
  return out
}

// ------------------------------------------------------------------ the command

const named = (x) => `${x.id} ${JSON.stringify(x.claim)}`

function reportOf(p) {
  const out = []
  for (const d of p.drifted) out.push(`drifted ${named(d)} query ${d.query}: reads differently now; its judge re-rules it`)
  for (const b of p.bracketed) out.push(`bracketed ${named(b)} query ${b.query}: part ${JSON.stringify(b.part)} names the file ${b.file}`)
  for (const e of p.escaped) out.push(`escaped ${named(e)} query ${e.query}: part ${JSON.stringify(e.part)} git used to read as ${JSON.stringify(e.read)}`)
  for (const m of p.malformed) out.push(m.id ? `malformed ${named(m)} (line ${m.line}): ${m.why}` : `malformed line ${m.line}: ${m.why}`)
  out.push(`${p.drifted.length} drifted query anchor(s), ${p.standing} standing item(s); nothing written`)
  return out.join('\n')
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  const argv = process.argv.slice(2)
  const at = argv.indexOf('--repo')
  const rest = argv.filter((_, i) => i !== at && (at < 0 || i !== at + 1))
  if (argv.includes('--yes')) {
    console.error('--yes: this tool writes nothing; drifted items are re-ruled by their judges')
    process.exitCode = 2
  } else if (rest.length > 0 || (at >= 0 && !argv[at + 1])) {
    console.error('usage: node tools/migrate-glob-literal.mjs [--repo <path>]')
    process.exitCode = 2
  } else {
    const p = plan(at >= 0 ? argv[at + 1] : '.')
    console.log(reportOf(p))
    process.exitCode = p.malformed.length ? 1 : 0
  }
}
