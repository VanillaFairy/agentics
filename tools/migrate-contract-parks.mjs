// tools/migrate-contract-parks.mjs — the one-shot clearing of `contract_changed` parks that 6.14.2 and
// earlier raised on an edit that never touched the contract, run once after upgrading, on the user's go.
//
// Design: docs/DESIGN.md#a-changed-spec (a consumer parks only when what defines its contract changed).
//
// Up to 6.14.2 any re-approval or preparation of a provider's spec parked every consumer of every
// contract it provides. For each node whose open stop is such a park, this reads the provider
// spec's two kept texts on either side of it — the compile that raised it and the one before — and
// when `contractDefinition` gives both the same, clears the park with `replanned {reason:
// contract_unchanged, by: migration}`: no plan starts again, the node goes on where it stood. A park
// whose texts are not both kept, or whose contract did change, is listed and left. The default is a
// dry run; `--yes` writes. A second run finds nothing open to clear.
//
// `contractDefinition` below is a frozen copy of what lib/spec.mjs read as a contract's definition
// when these parks were raised, so the migration keeps its meaning whatever the live reader becomes.

import { pathToFileURL } from 'node:url'

import { append, readLog } from '../lib/ledger.mjs'
import { parseSpec, specFolderOf } from '../lib/spec.mjs'
import { flagOf, mainCheckout, posix, specCopyPath } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const RAISED = /^the spec (\S+) that provides (\S+) changed — /

// The frozen reader, as lib/spec.mjs had it.
const FENCE = /^\s*(```|~~~)/
const normalise = (text) => String(text ?? '').replace(/^﻿/, '').replace(/\r\n/g, '\n')

/** Pure. A Design body's `### ` parts, in order: each its heading's text and the part, heading line included. A heading inside a fence is prose. */
function designParts(body) {
  const parts = []
  let fence = false
  for (const line of normalise(body).split('\n')) {
    if (FENCE.test(line)) fence = !fence
    const heading = fence ? null : /^###\s+(.*)$/.exec(line)
    if (heading) parts.push({ heading: heading[1].trim(), lines: [line] })
    else if (parts.length) parts[parts.length - 1].lines.push(line)
  }
  return parts.map((p) => ({ heading: p.heading, text: p.lines.join('\n').trim() }))
}

/** A declaration a line of code makes: the type or function it names. */
const DECLARED = /\b(?:interface|class|type|enum|function)\s+([A-Za-z_$][\w$]*)/g

/**
 * Pure. The Design's blocks — each paragraph, and each fenced block line by line — as
 * \`{fence, lines}\`, in order. A heading is a paragraph of its own.
 */
function designBlocks(design) {
  const blocks = []
  let at = null
  for (const line of normalise(design).split('\n')) {
    if (FENCE.test(line)) {
      if (at && at.fence) {
        blocks.push(at)
        at = null
      } else {
        if (at) blocks.push(at)
        at = { fence: true, lines: [] }
      }
      continue
    }
    if (at && at.fence) at.lines.push(line)
    else if (line.trim() === '' || /^#{1,6}\s/.test(line)) {
      if (at) blocks.push(at)
      at = line.trim() === '' ? null : { fence: false, lines: [line] }
      if (at) {
        blocks.push(at)
        at = null
      }
    } else (at ||= { fence: false, lines: [] }).lines.push(line)
  }
  if (at) blocks.push(at)
  return blocks
}

/** Pure. The lines of a fenced block that state \`terms\`: each line naming one, and the whole declaration of each declared term, by its braces. */
function fencedLines(lines, words, declared) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const decl = [...lines[i].matchAll(DECLARED)].some((m) => declared.has(m[1]))
    if (decl) {
      let depth = 0
      let j = i
      for (; j < lines.length; j++) {
        depth += (lines[j].match(/{/g) || []).length - (lines[j].match(/}/g) || []).length
        out.push(lines[j])
        if (depth <= 0 && j > i - 1 && (lines[j].includes('}') || !lines[i].includes('{'))) break
      }
      i = j
    } else if (words(lines[i])) out.push(lines[i])
  }
  return out
}

/**
 * Pure. What defines contract \`name\` in a spec, as one string to compare across two texts of it:
 * every entry that provides it with its paths, and what the Design says of it — each `### ` part
 * whose heading names it, whole; elsewhere the declarations on any line naming the contract or one
 * of its files, and every paragraph or line of code that names the contract, one of those files or
 * one of those declarations. Nothing named, the whole
 * Design. Text about other contracts, a plan edit, a paragraph beside the declaration, moves no consumer.
 */
function contractDefinition(spec, name) {
  const providers = spec.entries.flatMap((e) => e.provides.filter((c) => c.name === name).map((c) => ({ entry: e.name, paths: [...c.paths].sort() })))
    .sort((a, b) => (a.entry < b.entry ? -1 : 1))
  const design = spec.sections && spec.sections.Design ? spec.sections.Design.body.trim() : ''
  // A directory names a whole module, never one contract: only a file is a name.
  const names = [name, ...providers.flatMap((p) => p.paths).map((x) => posix(x)).filter((x) => /\.\w+$/.test(x))]
  const naming = (line) => names.some((n) => line.includes(n))
  // A `### ` part whose heading names the contract is its definition whole; elsewhere, what names it.
  const headed = designParts(design).filter((pt) => naming(pt.heading))
  const rest = headed.reduce((t, pt) => t.replace(pt.text, ''), design)
  const blocks = designBlocks(rest)
  const declared = new Set(blocks.flatMap((bl) => bl.lines.filter(naming).flatMap((l) => [...l.matchAll(DECLARED)].map((m) => m[1]))))
  const words = (line) => naming(line) || [...declared].some((d) => new RegExp('\\b' + d.replace(/\$/g, '\\$') + '\\b').test(line))
  const text = [...headed.map((pt) => pt.text), ...blocks.flatMap((bl) => (bl.fence
    ? fencedLines(bl.lines, words, declared)
    : bl.lines.some(words) ? [bl.lines.join('\n')] : []))]
  return JSON.stringify({ providers, text: text.length ? text : [design] })
}

/** The text compile kept for `folder` at `hash`, parsed, or null. */
function kept(repo, effort, folder, hash) {
  try {
    return parseSpec(readFileSync(specCopyPath(repo, effort, folder, hash), 'utf8'))
  } catch {
    return null
  }
}

/**
 * What the migration would do in `effort`: `cleared[{node, contract, provider}]`, the parks whose
 * contract the edit left as it was, and `left[{node, why}]`, every other open compile-raised park.
 */
export function plan(repo, effort) {
  const tree = readTree(repo, effort)
  const compiled = readLog(repo, effort, 'ledger').entries.filter((l) => l.kind === 'compiled')
  const cleared = []
  const left = []
  for (const [node, s] of tree.status) {
    const park = s.status === 'parked' && s.last && s.last.return === 'contract_changed' ? s.last : null
    const raised = park && RAISED.exec(String(park.question || ''))
    if (!raised) continue
    const [, file, contract] = raised
    const of = specFolderOf(repo, join(mainCheckout(repo), file))
    if (!of || of.effort !== effort) {
      left.push({ node, why: 'the provider ' + file + ' is no spec of this effort' })
      continue
    }
    // Compile parks first and records `compiled` after: the compile that raised the park is the first
    // one after it, and the text it was measured against is the one compiled before that.
    const lines = compiled.filter((l) => l.folder === of.folder)
    const at = lines.findIndex((l) => (l.seq || 0) > park.seq)
    const newerAt = at >= 0 ? at : lines.length - 1
    const [older, newer] = [lines[newerAt - 1], lines[newerAt]]
    const a = older && kept(repo, effort, of.folder, older.hash)
    const b = newer && kept(repo, effort, of.folder, newer.hash)
    if (!a || !b) left.push({ node, why: 'the texts of ' + file + ' on either side of the park are not both kept' })
    else if (contractDefinition(a, contract) !== contractDefinition(b, contract)) left.push({ node, why: contract + ' changed in ' + file })
    else cleared.push({ node, contract, provider: file })
  }
  return { cleared, left }
}

const isMain = import.meta.main ?? (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  const argv = process.argv.slice(2)
  const repo = flagOf(argv, 'repo') || '.'
  const effort = flagOf(argv, 'effort')
  const out = plan(repo, effort)
  if (argv.includes('--yes') && out.cleared.length) {
    const r = append(repo, effort, 'events', out.cleared.map((c) => ({ kind: 'replanned', node: c.node, execution: '', reason: 'contract_unchanged', by: 'migration' })))
    if (!r.ok) {
      console.log(JSON.stringify({ ok: false, error: r.error }))
      process.exit(1)
    }
  }
  console.log(JSON.stringify({ ok: true, written: argv.includes('--yes'), ...out }, null, 1))
}
