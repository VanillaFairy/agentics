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

import { pathToFileURL } from 'node:url'

import { append, readLog } from '../lib/ledger.mjs'
import { contractDefinition, parseSpec, specFolderOf } from '../lib/spec.mjs'
import { flagOf, mainCheckout, specCopyPath } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const RAISED = /^the spec (\S+) that provides (\S+) changed — /

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
    const lines = compiled.filter((l) => l.folder === of.folder && (l.seq || 0) < park.seq)
    const [older, newer] = lines.slice(-2)
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
