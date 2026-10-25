// tools/migrate-messages.mjs — the one-shot withdrawal of every message a release dropped the kind
// of, run once after upgrading, on the user's go.
//
// Design: docs/DESIGN.md#conversations (a version that drops a message kind ships the migration
// that withdraws every message of that kind).
//
// For each effort of the repository, every `message` this version has no template for and no
// `withdrawn` event names yet is withdrawn: one `withdrawn` event per node and execution, naming
// their seqs, so no session is told them again and preflight no longer refuses the execution
// holding them. A message no `dispatched` carried is listed as undelivered. The default is a dry
// run; `--yes` writes. A second run finds nothing to withdraw, and writes nothing.

import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { renders, withdrawnEvent } from '../lib/conversation.mjs'
import { append, readLog } from '../lib/ledger.mjs'
import { effortsRoot, mainCheckout, safeSlug } from '../lib/store.mjs'

const dirsOf = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/** Pure. The `withdrawn` events `events` still needs, one per node and execution, each with its kinds and undelivered seqs. */
export function withdrawalsOf(events) {
  const done = new Set(events.filter((e) => e.kind === 'withdrawn').flatMap((e) => e.messages || []))
  const carried = new Set(events.filter((e) => e.kind === 'dispatched').flatMap((e) => e.carries || []))
  const groups = new Map()
  for (const m of events.filter((e) => e.kind === 'message' && !renders(e.msg) && !done.has(e.seq))) {
    const key = JSON.stringify([m.node || '', m.execution || ''])
    if (!groups.has(key)) groups.set(key, { node: m.node || '', execution: m.execution || '', messages: [], kinds: new Set(), undelivered: [] })
    const g = groups.get(key)
    g.messages.push(m.seq)
    g.kinds.add(m.msg)
    if (!carried.has(m.seq)) g.undelivered.push(m.seq)
  }
  return [...groups.values()].map((g) => {
    const kinds = [...g.kinds].sort()
    const event = withdrawnEvent({ ...g, why: 'migrate-messages: this version has no template for ' + kinds.join(', ') })
    return { event, kinds, undelivered: g.undelivered }
  })
}

/** What the migration does to `repo`, and with `yes`, does it. */
export function migrate(repo, { yes = false } = {}) {
  const root = mainCheckout(resolve(String(repo)))
  const out = { withdrawn: [], refused: [] }
  for (const effort of dirsOf(effortsRoot(root)).filter(safeSlug).sort()) {
    for (const w of withdrawalsOf(readLog(root, effort, 'events').entries)) {
      const { node, execution, messages } = w.event
      out.withdrawn.push({ effort, node, execution, messages, kinds: w.kinds, undelivered: w.undelivered })
      if (!yes) continue
      const c = append(root, effort, 'events', [w.event])
      if (!c.ok) out.refused.push({ effort, node, why: 'the withdrawal could not be recorded: ' + c.error })
    }
  }
  return out
}

function reportOf(r, yes) {
  const lines = []
  for (const w of r.withdrawn) {
    lines.push((yes ? 'withdrew ' : 'would withdraw ') + w.messages.length + ' message(s) of ' + w.kinds.join(', ') + ' to ' +
      w.effort + ' ' + (w.node || '(root)') + (w.execution ? ' in execution ' + w.execution : '') +
      (w.undelivered.length ? '; never delivered: ' + w.undelivered.join(', ') : ''))
  }
  for (const x of r.refused) lines.push('refused ' + x.effort + ' ' + x.node + ': ' + x.why)
  const n = r.withdrawn.reduce((s, w) => s + w.messages.length, 0)
  lines.push(n + ' message(s)' + (yes ? ' withdrawn' : ' to withdraw; nothing written (run again with --yes)'))
  return lines.join('\n')
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  const argv = process.argv.slice(2)
  const at = argv.indexOf('--repo')
  const rest = argv.filter((a, i) => a !== '--yes' && i !== at && (at < 0 || i !== at + 1))
  if (rest.length > 0 || (at >= 0 && !argv[at + 1])) {
    console.error('usage: node tools/migrate-messages.mjs [--repo <path>] [--yes]')
    process.exitCode = 2
  } else {
    const yes = argv.includes('--yes')
    const r = migrate(at >= 0 ? argv[at + 1] : '.', { yes })
    console.log(reportOf(r, yes))
    process.exitCode = r.refused.length ? 1 : 0
  }
}
