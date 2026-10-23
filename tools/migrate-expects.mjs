// tools/migrate-expects.mjs — the one-shot rename of a task's `locus:` field to `expects:` in every
// spec of a repository's efforts, run once after upgrading to 6.0.0, on the user's go.
//
// Design: docs/DESIGN.md#migration-from-4x (a format change ships a one-shot migration, never a
// permanent second reader).
//
// For each spec holding a `· locus:` field: the field keyword is rewritten, nothing else. Code checks
// that the two texts differ by that keyword alone; where the spec's hash before the rewrite was its
// signed one, its latest `approved` or `prepared` line is stated again at the new hash, every field
// kept and `carried_from` naming the hash it was given at, so the signature stands for the same
// words and no reader learns a new kind. Then each effort it touched is
// compiled, so its node records carry `expects`. Every `needs_locus` message, a kind 6.0.0 has no
// template for, is withdrawn (a `withdrawn` event naming it), so no planner's conversation renders
// it again. It lists, for the user to `retry` or replan, every leaf not merged whose open stop is
// `locus_held` or `verify_oscillating`, whose latest close routed a `needs_locus`, or whose
// leaf-close recorded a `breach_reverted`: the 6.0.0 design has none of these, and what each left
// behind is the user's to clear; a merged leaf left nothing. The default is a dry run; `--yes` writes.
// A second run finds no `locus:` field and no message to withdraw, and writes nothing.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { approvalState } from '../lib/approval.mjs'
import { compileEffort } from '../lib/compile.mjs'
import { withdrawnEvent } from '../lib/conversation.mjs'
import { append, readLog } from '../lib/ledger.mjs'
import { hashSpec } from '../lib/spec.mjs'
import { ROOT_ID, SPEC_FILE, effortDir, effortsRoot, executionsRoot, mainCheckout, posix, readJson, safeSlug } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'

const FIELD = /(·\s*)locus:/g
const STALE_STOPS = ['locus_held', 'verify_oscillating']

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

/** Pure. The text with every `locus:` field renamed, and whether the two differ by that keyword alone. */
export function rename(text) {
  const next = text.replace(FIELD, '$1expects:')
  const blank = (t) => t.replace(/(·\s*)(locus|expects):/g, '$1\u0000:')
  return { next, changed: next !== text, formatOnly: blank(next) === blank(text) }
}

/** The `withdrawn` events `effort`'s `needs_locus` messages still need, one per node and execution. */
function withdrawalsOf(repo, effort) {
  const events = readLog(repo, effort, 'events').entries
  const done = new Set(events.filter((e) => e.kind === 'withdrawn').flatMap((e) => e.messages || []))
  const groups = new Map()
  for (const m of events.filter((e) => e.kind === 'message' && e.msg === 'needs_locus' && !done.has(e.seq))) {
    const key = JSON.stringify([m.node || '', m.execution || ''])
    if (!groups.has(key)) groups.set(key, { node: m.node || '', execution: m.execution || '', messages: [] })
    groups.get(key).messages.push(m.seq)
  }
  return [...groups.values()].map((g) => withdrawnEvent({ ...g, why: 'migrate-expects: 6.0.0 has no needs_locus' }))
}

/** The leaves of `effort` the user must retry or replan, each with why; a merged one has nothing left to clear. */
function staleLeaves(repo, effort) {
  const tree = readTree(repo, effort)
  const out = []
  const open = (x) => (tree.status.get(x.node) || {}).status !== 'merged'
  for (const [id, s] of tree.status) {
    const last = s.last || {}
    if (s.status === 'escalated' && STALE_STOPS.includes(last.reason)) out.push({ effort, node: id, why: 'open stop ' + last.reason })
  }
  const root = executionsRoot(repo, effort)
  for (const stamp of dirsOf(root)) {
    for (const e of readLog(repo, effort, 'state:' + stamp).entries) {
      if (e.kind === 'breach_reverted') out.push({ effort, node: e.node, why: 'breach_reverted in ' + stamp + ': its held mutations may name a file the revert took out' })
    }
    const closes = join(root, stamp, 'closes')
    for (const file of existsSync(closes) ? readdirSync(closes).filter((f) => f.endsWith('.json')) : []) {
      const close = readJson(join(closes, file))
      const routed = close && close.decision && close.decision.next === 'route' && (close.status === 'needs_locus' || close.decision.reason === 'needs_locus')
      if (routed) out.push({ effort, node: close.node, why: 'its close in ' + stamp + ' routed needs_locus' })
    }
  }
  return out.filter(open)
}

/** What the migration does to `repo`, and with `yes`, does it. */
export function migrate(repo, { yes = false } = {}) {
  const root = mainCheckout(resolve(String(repo)))
  const out = { specs: [], carried: [], refused: [], compiled: [], withdrawn: [], retry: [] }
  for (const effort of dirsOf(effortsRoot(root)).filter(safeSlug).sort()) {
    let touched = false
    for (const folder of foldersOf(root, effort)) {
      const path = join(effortDir(root, effort), ...(folder === ROOT_ID ? [] : folder.split('/')), SPEC_FILE)
      const text = readFileSync(path, 'utf8')
      const r = rename(text)
      if (!r.changed) continue
      const file = posix(relative(root, path))
      if (!r.formatOnly) {
        out.refused.push({ effort, folder, file, why: 'the rewrite would change more than the field keyword' })
        continue
      }
      const before = approvalState(root, effort, folder)
      const signed = before.state === 'approved' || before.state === 'prepared'
      out.specs.push({ effort, folder, file })
      if (signed) out.carried.push({ effort, folder, from: before.hash, hash: hashSpec(r.next) })
      if (!yes) continue
      writeFileSync(path, r.next, 'utf8')
      touched = true
      if (signed) {
        const line = readLog(root, effort, 'ledger').entries
          .filter((l) => l.folder === folder && (l.kind === 'approved' || l.kind === 'prepared'))
          .reduce((best, l) => (!best || (l.seq || 0) > (best.seq || 0) ? l : best), null)
        const fields = { ...line }
        delete fields.seq
        const c = append(root, effort, 'ledger', [{ ...fields, hash: hashSpec(r.next), carried_from: before.hash }])
        if (!c.ok) out.refused.push({ effort, folder, file, why: 'the signature could not be carried: ' + c.error })
      }
    }
    if (yes && touched) {
      const c = compileEffort(root, effort)
      out.compiled.push({ effort, ok: c.ok, problems: c.problems.map((p) => p.problem) })
    }
    for (const w of withdrawalsOf(root, effort)) {
      out.withdrawn.push({ effort, node: w.node, execution: w.execution, messages: w.messages })
      if (!yes) continue
      const c = append(root, effort, 'events', [w])
      if (!c.ok) out.refused.push({ effort, folder: w.node, file: 'events', why: 'the withdrawal could not be recorded: ' + c.error })
    }
    out.retry.push(...staleLeaves(root, effort))
  }
  return out
}

function reportOf(r, yes) {
  const lines = []
  for (const s of r.specs) lines.push((yes ? 'renamed ' : 'would rename ') + s.file)
  for (const c of r.carried) lines.push((yes ? 'carried ' : 'would carry ') + 'the signature of ' + c.effort + ' ' + c.folder + ' from ' + c.from.slice(0, 8) + ' to ' + c.hash.slice(0, 8))
  for (const w of r.withdrawn) lines.push((yes ? 'withdrew ' : 'would withdraw ') + w.messages.length + ' needs_locus message(s) to ' + w.effort + ' ' + w.node)
  for (const c of r.compiled) lines.push('compiled ' + c.effort + (c.ok ? '' : ': ' + c.problems.join('; ')))
  for (const x of r.refused) lines.push('refused ' + x.file + ': ' + x.why)
  for (const x of r.retry) lines.push('retry or replan ' + x.effort + ' ' + x.node + ': ' + x.why)
  lines.push(r.specs.length + ' spec(s), ' + r.retry.length + ' leaf(s) to retry' + (yes ? '' : '; nothing written (run again with --yes)'))
  return lines.join('\n')
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  const argv = process.argv.slice(2)
  const at = argv.indexOf('--repo')
  const rest = argv.filter((a, i) => a !== '--yes' && i !== at && (at < 0 || i !== at + 1))
  if (rest.length > 0 || (at >= 0 && !argv[at + 1])) {
    console.error('usage: node tools/migrate-expects.mjs [--repo <path>] [--yes]')
    process.exitCode = 2
  } else {
    const yes = argv.includes('--yes')
    const r = migrate(at >= 0 ? argv[at + 1] : '.', { yes })
    console.log(reportOf(r, yes))
    process.exitCode = r.refused.length || r.compiled.some((c) => !c.ok) ? 1 : 0
  }
}
