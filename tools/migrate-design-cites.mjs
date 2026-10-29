// tools/migrate-design-cites.mjs — the one-shot declaration of each task's Design citations as a
// `cites:` field, in every spec of a repository's efforts, run once after upgrading, on the user's go.
//
// Design: docs/DESIGN.md#migration-from-4x (a format change ships a one-shot migration, never a
// permanent second reader).
//
// Up to this version a task's brief carried what its title and context seemed to cite of the
// Design; now it carries only what `cites:` declares. For each task, this reads the old citations
// with a frozen copy of the reader of the time (`oldCited`) and writes `cites:` wherever that reader
// found one. An entry whose only signal was a sentence-initial "Design" ("Design the save format")
// gets `cites: Design`, the whole Design it was given, and is listed for the user to trim: a
// migration widens, never narrows. Code then proves, entry by entry, that the rewritten spec hands
// every task's brief the same Design text it handed before; only then is a signed spec's latest
// `approved` or `prepared` line stated again at the new hash, every field kept and `carried_from`
// naming the hash it was given at. `provides` needs nothing: a contract with no declared part is defined by the whole Design. The default is a dry run; `--yes` writes. A second
// run finds every cited task declared and writes nothing.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { approvalState } from '../lib/approval.mjs'
import { append, readLog } from '../lib/ledger.mjs'
import { citedDesign, hashSpec, parseSpec } from '../lib/spec.mjs'
import { ROOT_ID, SPEC_FILE, effortDir, effortsRoot, mainCheckout, posix, safeSlug } from '../lib/store.mjs'
import { readTree, subtreeOf } from '../lib/tree.mjs'

// The frozen reader: what lib/spec.mjs took a task's title and context to cite before `cites:`.
const FENCE = /^\s*(```|~~~)/
const NAMED_CITE = /\bDesign(?:'s|’s)\s+(?:section\s+)?["“]([^"”\n]+)["”]|["“]([^"”\n]+)["”]\s+(?:block|section|subsection)\s+of\s+(?:the|this spec(?:'s|’s))\s+Design\b|\bDesign\s*›\s*([^)\]\n;,.`]+)/g
const citeKey = (s) => String(s).toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim()

function oldParts(body) {
  const parts = []
  let fence = false
  for (const line of String(body).replace(/\r\n/g, '\n').split('\n')) {
    if (FENCE.test(line)) fence = !fence
    const heading = fence ? null : /^###\s+(.*)$/.exec(line)
    if (heading) parts.push({ heading: heading[1].trim(), lines: [line] })
    else if (parts.length) parts[parts.length - 1].lines.push(line)
  }
  return parts.map((p) => ({ heading: p.heading, text: p.lines.join('\n').trim() }))
}

function oldPart(parts, name) {
  const key = citeKey(name)
  return parts.find((p) => citeKey(p.heading) === key) ||
    parts.find((p) => citeKey(p.heading).startsWith(key + ' ') || citeKey(p.heading).startsWith(key + '(')) || null
}

/** Pure. What the reader of the time took `entry` to cite: its parts, and whether the word "Design" alone (`word`) or a quoted name (`named`) made them. */
export function oldCited(spec, entry) {
  const design = spec.sections.Design ? spec.sections.Design.body.trim() : ''
  const t = [entry.title, entry.context].join('\n')
  const named = [...new Set([...t.matchAll(NAMED_CITE)].map((m) => (m[1] || m[2] || m[3]).trim()).filter(Boolean))]
  const word = named.length === 0 && /\bDesign\b/.test(t)
  const all = oldParts(design)
  const found = named.map((name) => ({ name, part: oldPart(all, name) }))
  const inside = found.filter((f) => !f.part && citeKey(design).includes(citeKey(f.name)))
  const whole = Boolean(design) && (word || inside.length > 0)
  const parts = whole ? [{ heading: '', text: design }] : [...new Set(found.filter((f) => f.part).map((f) => f.part))]
  return { parts, word, named: named.length > 0, unresolved: found.filter((f) => !f.part && !inside.includes(f)).map((f) => f.name) }
}

/** Pure. Whether every "Design" in the entry's title and in its context opens a sentence: an imperative, not a citation. */
export function onlyInitial(entry) {
  const at = [entry.title, entry.context].flatMap((text) => [...String(text || '').matchAll(/\bDesign\b/g)].map((m) => String(text).slice(0, m.index)))
  const opens = (before) => {
    const line = before.slice(before.lastIndexOf('\n') + 1)
    return before.trimEnd() === '' || /[.!?]["')\]]*\s*$/.test(before) || /^\s*(?:[-*]|\d+\.)\s*$/.test(line)
  }
  return at.length > 0 && at.every(opens)
}

const same = (a, b) => JSON.stringify(a.map((p) => [p.heading, p.text])) === JSON.stringify(b.map((p) => [p.heading, p.text]))

/**
 * Pure. The rewrite of one spec's text: `next`, with a `· cites:` line after each task's opening
 * line where the old reader found a citation; `written[{entry, cites}]`; `initial[{entry, line}]`,
 * the tasks whose only signal opened a sentence, written `cites: Design` for the user to trim;
 * `refused[{entry, why}]`; and `unchanged`,
 * true when every task's brief carries the same Design text from `next` as it did from `text`.
 */
export function declare(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''
  const lines = text.slice(bom.length).replace(/\r\n/g, '\n').split('\n')
  const spec = parseSpec(text)
  const tasks = spec.entries.filter((e) => e.kind === 'task')
  const before = new Map(tasks.map((e) => [e.name, oldCited(spec, e)]))
  const out = { written: [], initial: [], refused: [] }
  const inserts = []
  for (const e of tasks) {
    const old = before.get(e.name)
    if (e.given.includes('cites') || old.parts.length === 0) continue
    if (old.word && onlyInitial(e)) out.initial.push({ entry: e.name, line: e.line })
    const whole = old.parts.some((p) => p.heading === '')
    const quotes = old.parts.filter((p) => p.heading.includes('"'))
    if (quotes.length) {
      out.refused.push({ entry: e.name, why: 'the heading ' + JSON.stringify(quotes[0].heading) + ' holds a double quote, which a cites value cannot' })
      continue
    }
    const cites = whole ? 'Design' : old.parts.map((p) => '"' + p.heading + '"').join(', ')
    inserts.push({ at: e.line, entry: e.name, cites })
  }
  for (const i of [...inserts].sort((a, b) => b.at - a.at)) lines.splice(i.at, 0, '  · cites: ' + i.cites)
  let next = bom + lines.join(eol)
  const after = parseSpec(next)
  // A declaration that does not give its entry the text it had is not written.
  const kept = inserts.filter((i) => {
    const now = citedDesign(after, after.entries.find((x) => x.name === i.entry && x.kind === 'task'))
    const ok = now.problems.length === 0 && same(now.parts, before.get(i.entry).parts)
    if (!ok) out.refused.push({ entry: i.entry, why: 'cites: ' + i.cites + ' would not hand its brief the Design text it had' + (now.problems.length ? ': ' + now.problems[0] : '') })
    return ok
  })
  if (kept.length !== inserts.length) {
    const lines2 = text.slice(bom.length).replace(/\r\n/g, '\n').split('\n')
    for (const i of [...kept].sort((a, b) => b.at - a.at)) lines2.splice(i.at, 0, '  · cites: ' + i.cites)
    next = bom + lines2.join(eol)
  }
  out.written = kept.map((i) => ({ entry: i.entry, cites: i.cites }))
  const final = parseSpec(next)
  out.initial = out.initial.map((x) => ({ ...x, line: final.entries.find((n) => n.name === x.entry && n.kind === 'task').line }))
  out.unchanged = tasks.every((e) => {
    const now = final.entries.find((x) => x.name === e.name && x.kind === 'task')
    return Boolean(now) && same(citedDesign(final, now).parts, before.get(e.name).parts)
  })
  return { next, ...out }
}

const dirsOf = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/** Every folder of an effort that holds a spec, root first: the segment rule keeps `.state` and `.legacy` out. */
function foldersOf(repo, effort) {
  const out = []
  const walk = (dir, id) => {
    if (existsSync(join(dir, SPEC_FILE))) out.push(id)
    for (const name of dirsOf(dir).filter(safeSlug)) walk(join(dir, name), id === ROOT_ID ? name : id + '/' + name)
  }
  walk(effortDir(repo, effort), ROOT_ID)
  return out
}

/** What the migration does to `repo`, and with `yes`, does it. */
export function migrate(repo, { yes = false } = {}) {
  const root = mainCheckout(resolve(String(repo)))
  const out = { specs: [], carried: [], uncarried: [], initial: [], refused: [], parks: [] }
  for (const effort of dirsOf(effortsRoot(root)).filter(safeSlug).sort()) {
    const tree = readTree(root, effort)
    const dispatched = new Set(tree.events.filter((e) => e.kind === 'dispatched').map((e) => e.node))
    for (const folder of foldersOf(root, effort)) {
      const path = join(effortDir(root, effort), ...(folder === ROOT_ID ? [] : folder.split('/')), SPEC_FILE)
      const file = posix(relative(root, path))
      const d = declare(readFileSync(path, 'utf8'))
      for (const x of d.initial) out.initial.push({ effort, folder, file, ...x })
      for (const x of d.refused) out.refused.push({ effort, folder, file, ...x })
      if (!d.written.length) continue
      out.specs.push({ effort, folder, file, written: d.written })
      const st = approvalState(root, effort, folder)
      const signed = st.state === 'approved' || st.state === 'prepared'
      if (signed && d.unchanged) out.carried.push({ effort, folder, from: st.hash, hash: hashSpec(d.next) })
      else if (signed) out.uncarried.push({ effort, folder, file, why: 'a task\'s brief would carry other Design text: approve it again' })
      // Compile reads a signed spec at a new hash as changed, and parks a folder with work dispatched below it.
      if (signed && folder !== ROOT_ID && tree.nodes.has(folder) && subtreeOf(tree.nodes, folder).some((id) => dispatched.has(id))) {
        out.parks.push({ effort, folder, file })
      }
      if (!yes) continue
      writeFileSync(path, d.next, 'utf8')
      if (!(signed && d.unchanged)) continue
      const line = readLog(root, effort, 'ledger').entries
        .filter((l) => l.folder === folder && (l.kind === 'approved' || l.kind === 'prepared'))
        .reduce((best, l) => (!best || (l.seq || 0) > (best.seq || 0) ? l : best), null)
      const fields = { ...line }
      delete fields.seq
      const c = append(root, effort, 'ledger', [{ ...fields, hash: hashSpec(d.next), carried_from: st.hash }])
      if (!c.ok) out.refused.push({ effort, folder, file, entry: '', why: 'the signature could not be carried: ' + c.error })
    }
  }
  return out
}

function reportOf(r, yes) {
  const lines = []
  for (const s of r.specs) for (const w of s.written) lines.push((yes ? 'declared ' : 'would declare ') + s.file + ' ' + w.entry + ' · cites: ' + w.cites)
  for (const c of r.carried) lines.push((yes ? 'carried ' : 'would carry ') + 'the signature of ' + c.effort + ' ' + c.folder + ' from ' + c.from.slice(0, 8) + ' to ' + c.hash.slice(0, 8))
  for (const x of r.uncarried) lines.push('not carried ' + x.file + ': ' + x.why)
  for (const x of r.parks) lines.push('its next compile parks ' + x.effort + ' ' + x.folder + ' spec_changed: work under it was dispatched')
  for (const x of r.initial) lines.push('trim ' + x.file + ':' + x.line + ' ' + x.entry + ': its only "Design" opens a sentence, so it was given the whole Design; drop or narrow its cites if it cites less')
  for (const x of r.refused) lines.push('refused ' + x.file + (x.entry ? ' ' + x.entry : '') + ': ' + x.why)
  lines.push(r.specs.length + ' spec(s), ' + r.initial.length + ' entry(ies) to trim' + (yes ? '' : '; nothing written (run again with --yes)'))
  return lines.join('\n')
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  const argv = process.argv.slice(2)
  const at = argv.indexOf('--repo')
  const rest = argv.filter((a, i) => a !== '--yes' && i !== at && (at < 0 || i !== at + 1))
  if (rest.length > 0 || (at >= 0 && !argv[at + 1])) {
    console.error('usage: node tools/migrate-design-cites.mjs [--repo <path>] [--yes]')
    process.exitCode = 2
  } else {
    const yes = argv.includes('--yes')
    const r = migrate(at >= 0 ? argv[at + 1] : '.', { yes })
    console.log(reportOf(r, yes))
    process.exitCode = r.refused.length ? 1 : 0
  }
}
