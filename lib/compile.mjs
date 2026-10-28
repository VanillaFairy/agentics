// lib/compile.mjs — `compile-approved-specs-into-execution-tree`: approved and prepared specs in,
// node revisions out.
//
// Design: docs/DESIGN.md#specs-approval-and-compile.
//
// Compile is the only writer of nodes. It maps every entry of every approved or prepared spec in
// scope to a node and appends only what changed, through `addNodes` with `by: 'compile'`, so the
// IL4 guard admits a decision exactly as the ledger's approved copy states it. A spec edited since
// approval is left out and its nodes stay as they are: develop keeps the last approved graph until
// the user approves again. When a spec is approved again with other text, compile parks and flags
// what that change reaches across the effort — except a node the approval's ruling found
// unaffected (lib/respec.mjs), which it spares. Nothing is written when anything is refused.

import { existsSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

import { approvalState, recordCompiled } from './approval.mjs'
import { append, readLog } from './ledger.mjs'
import { canonical } from './plan-digest.mjs'
import { checkFolder, designOf, entryId, groupOf, leafOf, ownerEntry } from './spec.mjs'
import { ROOT_ID, ancestorsOf, envelope, flagOf, handleArgs, mkdirState, nodeIdProblem, safeSlug, specCopyPath } from './store.mjs'
import { addNodes, childrenOf, normalizeNode, promiserOf, readTree, subtreeOf } from './tree.mjs'

const INCLUDED = new Set(['approved', 'prepared'])
const DONE = new Set(['merged', 'reviewing', 'integrated', 'landed'])
const childId = (folder, name) => (folder === ROOT_ID ? name : folder + '/' + name)
const firstParagraph = (body) => String(body || '').split(/\n\s*\n/)[0].trim()
const withoutSeq = ({ seq, ...node }) => node
/** A plan's names — its entries' and its groups' — mapped to the node ids compile gives them, which
 * is what a bare name in `after` means. */
const namesOf = (folder, spec) => new Map([
  ...(spec.groups || []).map((g) => [g.name, childId(folder, g.name)]),
  ...spec.entries.map((e) => [e.name, entryId(folder, e)]),
])

/** What the parent entry naming a folder says of the folder's node; its own spec says the rest. */
const entryFields = (entry, promoted) => ({
  context: entry.context, author: promoted ? 'planner' : entry.author, decisions: entry.realises,
  acceptance: promoted ? entry.criteria.map((c) => ({ text: c.text, check: c.check, decisions: entry.realises })) : [],
  provides: entry.provides, consumes: entry.consumes, ground: entry.ground, ground_known: entry.ground.length > 0,
  shared: promoted ? [] : entry.shared, deps: entry.after, label: entry.label,
})
const ROOT_FIELDS = {
  context: '', author: 'you', decisions: [], acceptance: [], provides: [], consumes: [], ground: [], ground_known: false,
  shared: [], deps: [], label: '',
}

/** A folder's own node, from its spec and the parent entry naming it (none at the root). */
const compositeOf = (id, spec, entry, promoted) => ({
  id, kind: 'composite', title: spec.title,
  intent: firstParagraph(spec.sections.Intent && spec.sections.Intent.body),
  defines: spec.decisions.map(({ id: d, text }) => ({ id: d, text })),
  ...(entry ? entryFields(entry, promoted) : ROOT_FIELDS),
})

/**
 * Compile every approved or prepared spec at or below `folder`. With `preview`, the id of a
 * folder whose spec was edited since approval or never approved, that spec is read as if the user
 * had approved it as it stands and nothing is written: the result says what approving it would
 * write, retire, park and flag, and whether the tree would refuse it.
 */
export function compileEffort(repo, effort, { folder = ROOT_ID, preview } = {}) {
  const result = { ok: false, problems: [], written: [], retired: [], parked: [], spared: [], consumers: [], flagged: [], skipped: [], answered: [] }
  const refuse = (file, line, problem) => result.problems.push({ file, line, problem })
  if (!safeSlug(effort)) return (refuse('', 0, 'not an effort name: ' + JSON.stringify(effort)), result)
  if (folder !== ROOT_ID && nodeIdProblem(folder)) return (refuse('', 0, nodeIdProblem(folder)), result)

  const tree = readTree(repo, effort)
  if (tree.error) return (refuse('', 0, tree.error), result)
  const ledger = readLog(repo, effort, 'ledger').entries
  const signedLines = ledger.filter((l) => l.kind === 'approved' || l.kind === 'prepared')
  const built = new Map()      // id → node as compile maps it (deps and consumes resolved below)
  const origin = new Map()     // id → {file, line} of the entry (or spec) it came from
  const kept = new Set()       // folders an edited spec keeps as they are
  const folders = []           // every included folder: {id, c, st, entry, promoted}
  const freshBuilt = new Set() // ids compile builds fresh as a leaf or design node, in place of
                                // whatever composite or entry used to stand there
  const approved = new Map()
  const owned = new Set()
  const accepted = new Set()
  const scopeOf = new Map()    // id → the names its `after` resolves against: its folder's plan

  const visit = (id, entry, promoted) => {
    let st = approvalState(repo, effort, id)
    if (id === preview && (st.state === 'edited' || st.state === 'none') && st.hash !== '') {
      const spec = checkFolder(repo, effort, id).spec
      st = { ...st, state: 'approved', decisions: spec ? spec.decisions.map(({ id: d, text }) => ({ id: d, text })) : [] }
    }
    if (st.state === 'edited' && st.hash === '') {
      // The spec was approved, then the file itself is gone — not merely edited. A promoted task
      // falls back to the plain leaf its entry describes; anything else is refused by name: an
      // approved sub-effort or root spec does not silently vanish.
      if (promoted) return 'none'
      const file = checkFolder(repo, effort, id).file
      const at = origin.get(id) || { file, line: 0 }
      refuse(at.file, at.line, 'the spec ' + file + ' was approved, then deleted — restore it or drop the entry for ' + id)
      return 'refused'
    }
    if (st.state === 'edited') {
      result.skipped.push({ folder: id, why: 'edited since approval — approve it again to compile it' })
      kept.add(id)
      return 'kept'
    }
    if (!INCLUDED.has(st.state)) return 'none'
    const c = checkFolder(repo, effort, id)
    if (c.problems.length) {
      result.problems.push(...c.problems)
      return 'refused'
    }
    const signed = st.state === 'approved'
    folders.push({ id, c, st, entry, promoted })
    approved.set(id, signed ? st.decisions : [])
    built.set(id, compositeOf(id, c.spec, entry, promoted))
    if (!origin.has(id)) origin.set(id, { file: c.file, line: 1 })

    const names = namesOf(id, c.spec)
    for (const g of c.spec.groups) {
      const gid = childId(id, g.name)
      origin.set(gid, { file: c.file, line: g.line })
      scopeOf.set(gid, names)
      built.set(gid, groupOf(gid, g))
    }
    for (const e of c.spec.entries) {
      const cid = entryId(id, e)
      origin.set(cid, { file: c.file, line: e.line })
      scopeOf.set(cid, names)
      if (signed) owned.add(cid)
      if (e.kind === 'dropped') {
        if (signed) for (const d of e.realises) accepted.add(d)
        continue
      }
      if (e.kind === 'deferred') continue
      const below = visit(cid, e, e.kind === 'task')
      const fresh = below === 'none' || (below === 'kept' && !tree.nodes.has(cid))
      if (fresh) {
        built.set(cid, e.kind === 'task' ? leafOf(cid, e) : designOf(cid, e))
        freshBuilt.add(cid)
      } else if (below === 'kept') {
        // An edited spec keeps its own node, but what this entry says of it is this spec's to say.
        built.set(cid, { ...withoutSeq(tree.nodes.get(cid)), ...entryFields(e, e.kind === 'task') })
      }
      if (below === 'included' && e.kind === 'task') {
        // A promoted task: its spec's entries must realise every decision the task realised.
        const promotedSpec = folders.find((f) => f.id === cid).c
        const realised = new Set(promotedSpec.spec.entries.flatMap((x) => x.realises))
        const lost = e.realises.filter((d) => !realised.has(d))
        if (lost.length) {
          refuse(promotedSpec.file, (promotedSpec.spec.sections.Plan || { line: 1 }).line,
            'this promoted spec realises none of ' + lost.join(', ') + ' — the task ' + cid + ' realised them')
        }
      }
    }
    return 'included'
  }

  if (folder === ROOT_ID) {
    const top = visit(ROOT_ID, null, false)
    if (top === 'none') refuse(checkFolder(repo, effort, ROOT_ID).file, 0, 'the root spec is neither approved nor prepared')
  } else {
    const { folder: parent, entry } = ownerEntry(folder, (id) => checkFolder(repo, effort, id).spec)
    const pst = approvalState(repo, effort, parent)
    const pc = checkFolder(repo, effort, parent)
    if (!INCLUDED.has(pst.state) || !entry || !['sub-effort', 'task'].includes(entry.kind)) {
      refuse(pc.file, 0, 'the parent spec of ' + folder + ' must be approved or prepared and name it as a sub-effort or task')
    } else {
      origin.set(folder, { file: pc.file, line: entry.line })
      scopeOf.set(folder, namesOf(parent, pc.spec))
      const top = visit(folder, entry, entry.kind === 'task')
      if (top === 'none') refuse(checkFolder(repo, effort, folder).file, 0, folder + ' is neither approved nor prepared')
    }
  }

  // A live child of a compiled folder that no entry names any more is retired with its subtree —
  // unless work was dispatched or merged under it. Same for a live child of a node this compile
  // just built fresh as a leaf or design node, standing in for the composite that used to be there.
  const eventsOf = (id, kinds) => tree.events.some((e) => e.node === id && kinds.includes(e.kind))
  const retire = new Set()
  const retireChildrenOf = (parentId, file, line) => {
    for (const child of childrenOf(tree.nodes, parentId)) {
      if (built.has(child) || kept.has(child)) continue
      const gone = subtreeOf(tree.nodes, child)
      const busy = gone.filter((id) => eventsOf(id, ['dispatched', 'merged']))
      if (busy.length) {
        refuse(file, line, 'the entry for ' + child +
          ' was removed, but ' + busy.join(', ') + ' has dispatched or merged work — keep the entry, or mark it dropped once that work is accounted for')
      } else for (const id of gone) retire.add(id)
    }
  }
  for (const f of folders) retireChildrenOf(f.id, f.c.file, (f.c.spec.sections.Plan || { line: 1 }).line)
  for (const [id, n] of built) {
    if (n.kind !== 'group') continue
    const at = origin.get(id)
    retireChildrenOf(id, at.file, at.line)
    // A group takes no name that dispatched or merged work stood under: its status would inherit it.
    const was = tree.nodes.get(id)
    if (was && was.kind !== 'group' && eventsOf(id, ['dispatched', 'merged'])) {
      refuse(at.file, at.line, 'the group ' + id + ' takes the name of a ' + was.kind + ' with dispatched or merged work — name the group otherwise')
    }
  }
  for (const id of freshBuilt) {
    const at = origin.get(id) || { file: '', line: 0 }
    retireChildrenOf(id, at.file, at.line)
  }

  const kindAt = (id) => (built.get(id) || tree.nodes.get(id) || {}).kind
  /** The folder whose spec lists `id`: its nearest ancestor that is not a group. */
  const ownerIdOf = (id) => ancestorsOf(id).find((a) => kindAt(a) !== 'group') ?? null
  const live = (id) => (built.has(id) || (tree.nodes.has(id) && !retire.has(id)))
  const nodeAt = (id) => built.get(id) || (tree.nodes.has(id) && !retire.has(id) ? tree.nodes.get(id) : null)
  // A consumer builds against the promise: the shallowest provider, not a task delivering it below.
  const providerOf = (name) => promiserOf([...built.values(), ...[...tree.nodes.values()].filter((n) => !built.has(n.id))]
    .filter((n) => !retire.has(n.id)), name)
  for (const [id, n] of built) {
    const at = origin.get(id) || { file: '', line: 0 }
    const names = scopeOf.get(id) || new Map()
    n.deps = n.deps.map((a) => (a.startsWith('/') ? a.slice(1) : names.get(a) || childId(ownerIdOf(id) || ROOT_ID, a)))
    for (const dep of n.deps) if (!live(dep)) refuse(at.file, at.line, id + ' waits for ' + dep + ', which is not in the graph')
    n.consumes = n.consumes.map(({ name }) => {
      const provider = providerOf(name)
      if (!provider) refuse(at.file, at.line, id + ' consumes ' + name + ', which nothing in the graph provides')
      return { name, paths: provider ? provider.paths : [] }
    })
  }

  const status = tree.status
  const all = () => [...new Set([...built.keys(), ...tree.nodes.keys()])].filter((id) => !retire.has(id)).map(nodeAt)
  const parks = []
  // A retry's re-approval already raised this park: the events log holds a `parked` event for the
  // node with the same `return` at a `seq` above the owning folder's latest approval. Skip it —
  // otherwise a retry that only failed to record `compiled` would double the park.
  const latestSignedSeq = (id) => signedLines.filter((l) => l.folder === id).reduce((max, l) => Math.max(max, l.seq || 0), 0)
  const alreadyParked = (node, reason, ownerId) => {
    const bound = latestSignedSeq(ownerId)
    return tree.events.some((e) => e.kind === 'parked' && e.node === node && e.return === reason && (e.seq || 0) > bound)
  }
  const park = (node, reason, question, ownerId, unaffected) => {
    if (DONE.has((status.get(node) || {}).status)) return
    if (unaffected.has(node)) {
      if (!result.spared.some((p) => p.node === node && p.reason === reason)) result.spared.push({ node, reason })
      return
    }
    if (alreadyParked(node, reason, ownerId)) return
    if (!parks.some((p) => p.node === node && p.reason === reason)) parks.push({ node, reason, question })
  }
  const reasons = new Map()
  const flaggedSeen = new Set()

  for (const f of folders) {
    if (f.st.compiled_hash === '' || f.st.compiled_hash === f.st.hash) continue
    // Contracts this spec provides: its own node's and its entries', now and as they stood
    // before this compile — a name this re-approval drops or renames still parks who consumed it.
    const isMine = (n) => (n.id === f.id ? f.id !== ROOT_ID : ownerIdOf(n.id) === f.id)
    const mine = [...built.values()].filter(isMine)
    const wasMine = [...tree.nodes.values()].filter(isMine)
    const contracts = new Set([...mine, ...wasMine].flatMap((n) => n.provides.map((c) => c.name)))
    // The nodes this approval's ruling found unaffected, or settled by the user's answers, are
    // spared the parks below. The ruling is the `ruled` ledger line the approval names, so any
    // compile of this text honours it.
    const signedNow = signedLines.filter((l) => l.folder === f.id && l.hash === f.st.hash)
      .reduce((best, l) => (!best || (l.seq || 0) > (best.seq || 0) ? l : best), null)
    const ruledLine = signedNow && Number.isInteger(signedNow.ruled)
      ? ledger.find((l) => l.kind === 'ruled' && l.seq === signedNow.ruled && l.hash === f.st.hash) : null
    const unaffected = new Set(((ruledLine && ruledLine.rulings) || [])
      .filter((r) => r.ruling === 'unaffected' || r.ruling === 'answered').map((r) => r.node))
    for (const n of all()) {
      if (n.id === f.id || ownerIdOf(n.id) === f.id) continue
      const hit = n.consumes.find((c) => contracts.has(c.name))
      if (!hit) continue
      result.consumers.push({ node: n.id, contract: hit.name })
      park(n.id, 'contract_changed', 'the spec ' + f.c.file + ' that provides ' + hit.name + ' changed — re-spec this node against it, approve it again and recompile', f.id, unaffected)
    }
    // Decisions whose text changed, or which the spec no longer states. A retry reads the decisions
    // the folder was last compiled from out of the ledger, not the node it may have already
    // overwritten in a failed attempt, so a partial write still leaves something to compare against.
    const compiledLine = ledger.filter((l) => l.kind === 'approved' && l.folder === f.id && l.hash === f.st.compiled_hash)
      .reduce((best, l) => (!best || (l.seq || 0) > (best.seq || 0) ? l : best), null)
    const before = compiledLine && Array.isArray(compiledLine.decisions)
      ? compiledLine.decisions
      : (tree.nodes.get(f.id) || { defines: [] }).defines
    const now = new Map(f.c.spec.decisions.map((d) => [d.id, d.text]))
    const changed = before.filter((d) => now.get(d.id) !== d.text).map((d) => d.id)
    for (const n of all()) {
      for (const d of n.decisions.filter((x) => changed.includes(x))) {
        const key = n.id + '\u0000' + d
        if (flaggedSeen.has(key)) continue
        flaggedSeen.add(key)
        result.flagged.push({ node: n.id, decision: d })
        reasons.set(n.id, 'decision_changed')
      }
    }
    // Work already dispatched below a changed spec goes back to the planner.
    if (f.id !== ROOT_ID && subtreeOf(tree.nodes, f.id).some((id) => eventsOf(id, ['dispatched']))) {
      park(f.id, 'spec_changed', 'the spec ' + f.c.file + ' changed after work under it was dispatched — the planner re-derives what is below it', f.id, unaffected)
    }
  }

  // A parked node whose owning spec was approved or prepared after the park is answered.
  const included = new Set(folders.map((f) => f.id))
  for (const [id, s] of status) {
    if (s.status !== 'parked' || !s.last || retire.has(id)) continue
    const owners = [ownerIdOf(id), (nodeAt(id) || {}).kind === 'composite' ? id : null].filter((x) => x !== null && included.has(x))
    if (signedLines.some((l) => owners.includes(l.folder) && (l.seq || 0) > (s.last.seq || 0))) {
      result.answered.push(id)
      if (!reasons.has(id)) reasons.set(id, 'answered')
    }
  }

  if (result.problems.length) return result

  const batch = []
  for (const [id, n] of built) {
    const was = tree.nodes.get(id)
    if (!was || canonical(normalizeNode(n)) !== canonical(withoutSeq(was)) || reasons.has(id)) batch.push(n)
  }
  for (const id of reasons.keys()) if (!built.has(id)) batch.push(withoutSeq(tree.nodes.get(id)))
  for (const id of retire) {
    batch.push({ ...withoutSeq(tree.nodes.get(id)), retired: true })
    reasons.set(id, 'retired')
  }

  if (preview !== undefined) {
    if (batch.length) {
      const dry = addNodes(repo, effort, batch, { by: 'compile', reason: 'compiled', reasons, approved, owned, accepted, dry: true })
      for (const p of dry.problems) {
        const at = origin.get(p.node) || { file: folders.length ? folders[0].c.file : '', line: 0 }
        refuse(at.file, at.line, p.problem)
      }
      if (!dry.ok) return result
    }
    result.written = batch.filter((n) => !n.retired).map((n) => n.id)
    result.retired = [...retire]
    result.parked = parks.map(({ node, reason }) => ({ node, reason }))
    result.ok = true
    return result
  }

  if (batch.length) {
    const out = addNodes(repo, effort, batch, { by: 'compile', reason: 'compiled', reasons, approved, owned, accepted })
    if (!out.ok) {
      for (const p of out.problems) {
        const at = origin.get(p.node) || { file: folders.length ? folders[0].c.file : '', line: 0 }
        refuse(at.file, at.line, p.problem)
      }
      return result
    }
  }
  result.written = batch.filter((n) => !n.retired).map((n) => n.id)
  result.retired = [...retire]
  result.parked = parks.map(({ node, reason }) => ({ node, reason }))

  if (parks.length) {
    const parkOut = append(repo, effort, 'events', parks.map((p) => ({ kind: 'parked', node: p.node, execution: '', return: p.reason, question: p.question })))
    if (!parkOut.ok) {
      // The parks didn't land — leave every folder's compiled hash stale so a retry repeats them,
      // instead of recording `compiled` here and losing them for good.
      refuse('', 0, 'the parked events were not recorded: ' + parkOut.error)
      return result
    }
  }
  for (const f of folders) {
    if (f.st.compiled_hash === f.st.hash) continue
    const out = recordCompiled(repo, effort, f.id, f.st.hash)
    if (!out.ok) refuse(f.c.file, 0, 'the compiled ledger line was not recorded: ' + out.error)
  }
  // The text each folder was built from is kept by its hash: the next change to it is diffed
  // against this copy, and the copies are the record of what was ever approved.
  for (const f of folders) {
    const copy = specCopyPath(repo, effort, f.id, f.st.hash)
    if (existsSync(copy)) continue
    mkdirState(dirname(copy))
    writeFileSync(copy, f.c.text, 'utf8')
  }

  result.ok = result.problems.length === 0
  return result
}

/** The flags this CLI takes, each by its kind: a skill's session passes handles only (`handleArgs`). */
const FLAGS = {
  '--repo': 'path', '--effort': 'handle', '--folder': 'handle',
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  try {
    const argv = process.argv.slice(2)
    const bad = handleArgs(argv, FLAGS, { from: 0 })
    if (bad) {
      console.log(JSON.stringify({ error: bad.message, kind: bad.kind }))
      process.exit(1)
    }
    const out = compileEffort(flagOf(argv, 'repo') || '.', flagOf(argv, 'effort'), { folder: flagOf(argv, 'folder') || ROOT_ID })
    console.log(JSON.stringify(envelope(out)))
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
