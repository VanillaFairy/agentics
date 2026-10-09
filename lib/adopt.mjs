// lib/adopt.mjs — adopting work done outside an execution on the user's word: the mapping the
// session wrote, checked against git and the records, the token the user confirms, and the
// records an act writes.
//
// Design: docs/DESIGN.md#outside-work.

import { readFileSync } from 'node:fs'

import { actToken } from './approval.mjs'
import { openExecutions } from './boundaries/execution.mjs'
import { rootBase, unaccountedOf } from './integration.mjs'
import { append, runState } from './ledger.mjs'
import { admits } from './locus.mjs'
import { canonical, fnv1a } from './plan-digest.mjs'
import { ROOT_ID, branchOf, executionRunId, git, isAncestorOrSelf } from './store.mjs'
import { cycleOf, isHuman, ownerOf, readTree } from './tree.mjs'

const list = (v) => (Array.isArray(v) ? v : [])
const SECTIONS = ['done', 'outside', 'handover']
const SHA = /^[0-9a-f]{4,64}$/i
const refusal = (entry, kind, message) => ({ entry, kind, message })
const text = (v) => (typeof v === 'string' ? v.trim() : '')
const shaList = (v) => (Array.isArray(v) && v.every((s) => typeof s === 'string') ? v.map((s) => s.trim()) : null)

// ------------------------------------------------------------------ the mapping

/** Pure. The mapping file's text, read; see shared/interfaces.md for its shape. */
export function parseMapping(raw) {
  let doc
  try {
    doc = JSON.parse(String(raw).replace(/^﻿/, ''))
  } catch (err) {
    return { ok: false, refusals: [refusal('', 'bad_mapping', 'the mapping is not JSON: ' + err.message)] }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, refusals: [refusal('', 'bad_mapping', 'the mapping is one JSON object of done, outside and handover')] }
  }
  const refusals = []
  for (const key of Object.keys(doc)) if (!SECTIONS.includes(key)) refusals.push(refusal('', 'bad_mapping', 'no section ' + JSON.stringify(key) + ': done, outside or handover'))
  for (const key of SECTIONS) if (key in doc && !Array.isArray(doc[key])) refusals.push(refusal('', 'bad_mapping', key + ' is a list'))
  if (refusals.length) return { ok: false, refusals }

  const mapping = { done: [], outside: [], handover: [] }
  for (const [i, e] of list(doc.done).entries()) {
    const at = 'done[' + i + ']'
    if (!e || typeof e !== 'object' || !text(e.node)) { refusals.push(refusal(at, 'bad_mapping', 'a done entry names its node')); continue }
    if (('commits' in e) === ('branch' in e)) { refusals.push(refusal(at, 'bad_mapping', 'a done entry names commits or a branch, exactly one')); continue }
    if ('branch' in e) {
      if (!text(e.branch)) { refusals.push(refusal(at, 'bad_mapping', 'branch is a branch name')); continue }
      mapping.done.push({ node: text(e.node), commits: null, branch: text(e.branch) })
      continue
    }
    const commits = shaList(e.commits)
    if (!commits) { refusals.push(refusal(at, 'bad_mapping', 'commits is a list of shas')); continue }
    if (commits.length === 0) { refusals.push(refusal(at, 'empty_entry', 'the entry names no commit')); continue }
    mapping.done.push({ node: text(e.node), commits, branch: '' })
  }
  for (const [i, e] of list(doc.outside).entries()) {
    const at = 'outside[' + i + ']'
    const commits = e && typeof e === 'object' ? shaList(e.commits) : null
    if (!commits) { refusals.push(refusal(at, 'bad_mapping', 'an outside entry is {commits: [sha…]}')); continue }
    if (commits.length === 0) { refusals.push(refusal(at, 'empty_entry', 'the entry names no commit')); continue }
    mapping.outside.push({ commits })
  }
  for (const [i, e] of list(doc.handover).entries()) {
    const at = 'handover[' + i + ']'
    if (!e || typeof e !== 'object' || !text(e.node) || !text(e.branch)) { refusals.push(refusal(at, 'bad_mapping', 'a handover entry is {node, branch}')); continue }
    mapping.handover.push({ node: text(e.node), branch: text(e.branch) })
  }
  if (refusals.length) return { ok: false, refusals }
  if (!mapping.done.length && !mapping.outside.length && !mapping.handover.length) {
    return { ok: false, refusals: [refusal('', 'empty_mapping', 'the mapping adopts nothing')] }
  }
  return { ok: true, mapping }
}

// ------------------------------------------------------------------ what git says

/** What git and the records say about one mapping (see shared/interfaces.md, Facts). Reads; writes nothing. */
export function adoptFacts(repo, effort, folder, mapping, { run = git, live } = {}) {
  const tree = readTree(repo, effort)
  const facts = {
    effort, folder, folderBranch: branchOf(effort, folder), folderHead: '', tree, live: [],
    shas: {}, onFolder: {}, order: {}, mergedAt: {}, files: {}, doneBranches: {}, handoverBranches: {}, canonical: {},
  }
  const node = tree.nodes.get(folder)
  if (!node || ['leaf', 'group'].includes(node.kind)) return facts
  const isLive = live || ((stamp) => runState(repo, executionRunId(effort, stamp)).state === 'live')
  facts.live = openExecutions({ repo, effort, execution: '' })
    .filter((e) => (isAncestorOrSelf(e.root, folder) || isAncestorOrSelf(folder, e.root)) && isLive(e.stamp))
  const lines = (r) => (r.ok ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [])
  const rev = (ref) => {
    const r = run(repo, ['rev-parse', '--verify', '--quiet', ref + '^{commit}'])
    return r.ok ? r.stdout.trim() : ''
  }
  const holds = (b, a) => a !== '' && b !== '' && run(repo, ['merge-base', '--is-ancestor', a, b]).ok
  const head = rev('refs/heads/' + facts.folderBranch)
  facts.folderHead = head
  if (!head) return facts

  const parentHead = folder === ROOT_ID ? '' : rev('refs/heads/' + branchOf(effort, ownerOf(tree.nodes, folder)))
  const base = folder === ROOT_ID ? rootBase(repo, effort) : { base_branch: '', base_sha: '' }
  const baseHead = base.base_branch ? rev('refs/heads/' + base.base_branch) : ''
  let cut = base.base_sha || ''
  if (parentHead) {
    const mb = run(repo, ['merge-base', head, parentHead])
    cut = mb.ok ? mb.stdout.trim() : ''
  }
  const span = [cut, baseHead].filter(Boolean).map((c) => '^' + c)
  const cutHolds = (sha) => holds(cut, sha) || holds(baseHead, sha)
  lines(run(repo, ['rev-list', '--topo-order', '--reverse', head, ...span])).forEach((sha, i) => { facts.order[sha] = i })
  const firstParent = lines(run(repo, ['rev-list', '--first-parent', '--reverse', head, ...span]))
  // Holding a commit is monotone along the first-parent line: the first holder is found by halving.
  const firstHolder = (sha) => {
    let lo = 0
    let hi = firstParent.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (holds(firstParent[mid], sha)) hi = mid
      else lo = mid + 1
    }
    return lo < firstParent.length ? firstParent[lo] : ''
  }
  const note = (sha) => {
    if (sha in facts.onFolder) return
    facts.onFolder[sha] = holds(head, sha) && !cutHolds(sha)
    facts.mergedAt[sha] = facts.onFolder[sha] ? firstHolder(sha) : ''
    facts.files[sha] = lines(run(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]))
  }
  const resolve = (given) => {
    if (!(given in facts.shas)) facts.shas[given] = SHA.test(given) ? rev(given) : ''
    return facts.shas[given]
  }

  for (const e of [...mapping.done, ...mapping.outside]) {
    for (const given of list(e.commits)) {
      const full = resolve(given)
      if (full) note(full)
    }
  }
  for (const e of mapping.done) {
    if (!e.branch || e.branch in facts.doneBranches) continue
    const tip = rev('refs/heads/' + e.branch)
    const at = tip && holds(head, tip) && !cutHolds(tip) ? firstHolder(tip) : ''
    const ff = at !== '' && at === tip
    const before = at && !ff ? rev(at + '^1') : ''
    const commits = before ? lines(run(repo, ['rev-list', '--topo-order', '--reverse', tip, '^' + before, ...span])) : []
    facts.doneBranches[e.branch] = { head: tip, mergedAt: at, ff, commits }
    for (const c of commits) note(c)
  }
  for (const e of mapping.handover) {
    if (!(e.branch in facts.handoverBranches)) {
      const tip = rev('refs/heads/' + e.branch)
      const mb = tip ? run(repo, ['merge-base', tip, head]) : { ok: false, stdout: '' }
      const from = mb.ok ? mb.stdout.trim() : ''
      facts.handoverBranches[e.branch] = {
        head: tip, commits: tip ? lines(run(repo, ['rev-list', '--topo-order', '--reverse', tip, ...(from ? ['^' + from] : [])])) : [],
      }
    }
  }
  for (const e of [...mapping.done, ...mapping.handover]) facts.canonical[e.node] = rev('refs/heads/' + branchOf(effort, e.node))
  return facts
}

// ------------------------------------------------------------------ the check

/** Pure. The refusals, the report parts that need no git, and the mapping normalized (see shared/interfaces.md). */
export function checkAdoption(mapping, facts) {
  const { nodes, status, events } = facts.tree
  const refusals = []
  const normalized = { done: [], outside: [], handover: [] }
  const report = { outside_locus: [], clears_stops: [], deps_open: [], criteria: [] }
  const folderNode = nodes.get(facts.folder)
  if (!folderNode || ['leaf', 'group'].includes(folderNode.kind)) {
    return { refusals: [refusal('', 'not_a_folder', JSON.stringify(facts.folder) + ' is no composite, design node or root of ' + facts.effort)], normalized, report }
  }
  if (!facts.folderHead) {
    return { refusals: [refusal('', 'no_folder_branch', facts.folderBranch + ' does not exist: nothing is on it to adopt')], normalized, report }
  }
  for (const e of facts.live) refusals.push(refusal('', 'run_live', 'execution ' + e.stamp + ' (root ' + e.root + ') is running: adopt once it has stopped'))

  const statusOf = (id) => (status.get(id) || {}).status || 'planned'
  const byOrder = (shas) => [...shas].sort((a, b) => (facts.order[a] ?? -1) - (facts.order[b] ?? -1))
  const recorded = new Set(events.flatMap((e) => {
    if (e.kind === 'outside') return list(e.commits)
    return e.kind === 'merged' ? [...list(e.commits), e.merged_sha, e.head_sha] : []
  }).filter((s) => typeof s === 'string' && s))
  const doneIds = new Set(mapping.done.map((e) => e.node))
  const claimedBy = new Map()
  const namedBy = new Map()

  const leafProblem = (at, id) => {
    if (!nodes.has(id)) return refusal(at, 'unknown_node', 'no live node ' + JSON.stringify(id))
    if (nodes.get(id).kind !== 'leaf') return refusal(at, 'not_a_leaf', id + ' is a ' + nodes.get(id).kind + ': leaves are adopted, and their folder follows')
    if (ownerOf(nodes, id) !== facts.folder) return refusal(at, 'not_in_folder', id + ' merges into ' + ownerOf(nodes, id) + ', not ' + facts.folder)
    if (statusOf(id) === 'merged') return refusal(at, 'already_merged', id + ' is merged already')
    if (namedBy.has(id)) return refusal(at, 'claimed_twice', id + ' is named by ' + namedBy.get(id) + ' too')
    namedBy.set(id, at)
    return null
  }
  const cycleProblem = (at, id) => {
    const cycle = cycleOf(nodes, id)
    const k = cycle.indexOf(id)
    if (k <= 0) return null
    const pred = cycle[k - 1]
    if (statusOf(pred) === 'merged' || doneIds.has(pred)) return null
    return refusal(at, 'cycle_order', id + "'s " + nodes.get(pred).role + ' ' + pred + ' is neither merged nor adopted in this batch')
  }
  const claim = (at, shas) => {
    const twice = []
    for (const sha of shas) {
      if (recorded.has(sha)) twice.push(sha.slice(0, 8) + ' (a record names it already)')
      else if (claimedBy.has(sha)) twice.push(sha.slice(0, 8) + ' (' + claimedBy.get(sha) + ' names it too)')
      else claimedBy.set(sha, at)
    }
    return twice.length ? refusal(at, 'claimed_twice', 'named twice: ' + twice.join(', ')) : null
  }
  const commitsOf = (at, given) => {
    const unknown = given.filter((g) => !facts.shas[g])
    if (unknown.length) return { refused: refusal(at, 'unknown_commit', 'no commit ' + unknown.join(', ')) }
    const full = [...new Set(given.map((g) => facts.shas[g]))]
    const off = full.filter((s) => !facts.onFolder[s])
    if (off.length) {
      return { refused: refusal(at, 'not_on_folder_branch', off.map((s) => s.slice(0, 8)).join(', ') + ' is no work of ' + facts.folderBranch + ': the branch lacks it, or it came with the branch\'s cut') }
    }
    return { full: byOrder(full) }
  }

  for (const [i, e] of mapping.done.entries()) {
    const at = 'done[' + i + ']'
    const bad = leafProblem(at, e.node)
    if (bad) { refusals.push(bad); continue }
    let full
    if (e.branch) {
      const b = facts.doneBranches[e.branch] || { head: '', mergedAt: '', ff: false, commits: [] }
      if (!b.head) { refusals.push(refusal(at, 'unknown_branch', 'no branch ' + e.branch)); continue }
      if (!b.mergedAt) {
        refusals.push(refusal(at, 'not_on_folder_branch', facts.folderBranch + ' has not merged ' + e.branch + ' as work of its own: it is unmerged, or came with the branch\'s cut'))
        continue
      }
      if (b.ff || b.commits.length === 0) {
        refusals.push(refusal(at, 'empty_entry', e.branch + "'s tip is on " + facts.folderBranch + "'s first-parent line, so git shows no fork point: list its commits under commits"))
        continue
      }
      full = byOrder(b.commits)
    } else {
      const got = commitsOf(at, e.commits)
      if (got.refused) { refusals.push(got.refused); continue }
      full = got.full
    }
    const twice = claim(at, full)
    if (twice) { refusals.push(twice); continue }
    const order = cycleProblem(at, e.node)
    if (order) { refusals.push(order); continue }
    normalized.done.push({ node: e.node, branch: e.branch, commits: full })
  }
  for (const [i, e] of mapping.outside.entries()) {
    const at = 'outside[' + i + ']'
    const got = commitsOf(at, e.commits)
    if (got.refused) { refusals.push(got.refused); continue }
    const twice = claim(at, got.full)
    if (twice) { refusals.push(twice); continue }
    normalized.outside.push({ commits: got.full })
  }
  for (const [i, e] of mapping.handover.entries()) {
    const at = 'handover[' + i + ']'
    const bad = leafProblem(at, e.node)
    if (bad) { refusals.push(bad); continue }
    const b = facts.handoverBranches[e.branch] || { head: '', commits: [] }
    if (!b.head) { refusals.push(refusal(at, 'unknown_branch', 'no branch ' + e.branch)); continue }
    if (b.commits.length === 0) { refusals.push(refusal(at, 'empty_entry', e.branch + ' holds nothing ' + facts.folderBranch + ' lacks')); continue }
    const canon = facts.canonical[e.node] || ''
    if (canon && canon !== b.head) {
      refusals.push(refusal(at, 'branch_exists', branchOf(facts.effort, e.node) + ' exists at ' + canon.slice(0, 8) + ', not at ' + e.branch + "'s " + b.head.slice(0, 8)))
      continue
    }
    const order = cycleProblem(at, e.node)
    if (order) { refusals.push(order); continue }
    normalized.handover.push({ node: e.node, branch: e.branch, head: b.head })
  }

  for (const d of normalized.done) {
    const leaf = nodes.get(d.node)
    const tests = leaf.role !== 'green' && leaf.role !== 'audit'
    const touched = [...new Set(d.commits.flatMap((c) => list(facts.files[c])))]
    const paths = touched.filter((p) => !admits({ locus: leaf.locus, path: p, tests }))
    if (paths.length) report.outside_locus.push({ node: d.node, paths })
    const s = status.get(d.node) || {}
    if (['escalated', 'parked'].includes(s.status)) report.clears_stops.push({ node: d.node, kind: s.status, reason: (s.last && (s.last.reason || s.last.return)) || '' })
    const deps = leaf.deps.filter((x) => statusOf(x) !== 'merged' && !doneIds.has(x))
    if (deps.length) report.deps_open.push({ node: d.node, deps })
    report.criteria.push({ node: d.node, criteria: leaf.acceptance.filter((c) => !isHuman(c)).map((c) => c.text) })
  }
  return { refusals, normalized, report }
}

/** Pure. The digest the user's token names: the normalized mapping and the folder head it was checked at. */
export const adoptDigest = (normalized, folderHead) => fnv1a(canonical({ mapping: normalized, head: folderHead }))

/** Pure. The events an act appends in one batch, and the canonical branches a handover creates. */
export function adoptRecords(normalized, facts, by) {
  const events = []
  for (const d of normalized.done) {
    const head = d.commits[d.commits.length - 1]
    events.push({ kind: 'merged', node: d.node, execution: '', into: facts.folderBranch, merged_sha: facts.mergedAt[head] || head, head_sha: head, by, commits: d.commits })
  }
  for (const o of normalized.outside) events.push({ kind: 'outside', node: facts.folder, execution: '', commits: o.commits, by })
  const branches = []
  const doneHead = new Map(normalized.done.map((d) => [d.node, d.commits[d.commits.length - 1]]))
  for (const h of normalized.handover) {
    events.push({ kind: 'noted', node: h.node, execution: '', by, text: 'handed over from ' + h.branch + ' at ' + h.head + ': a person started this work by hand; carry its series on' })
    // leaf-open cuts a cycle member from its predecessor's branch, so an adopted predecessor needs one.
    const cycle = cycleOf(facts.tree.nodes, h.node)
    const pred = cycle[cycle.indexOf(h.node) - 1]
    if (doneHead.has(pred) && !facts.canonical[pred]) branches.push({ node: pred, branch: branchOf(facts.effort, pred), head: doneHead.get(pred) })
    branches.push({ node: h.node, branch: branchOf(facts.effort, h.node), head: h.head })
  }
  return { events, branches }
}

// ------------------------------------------------------------------ the call

/**
 * The adopt call. `check` reports and writes nothing; `act` recomputes the check, refuses on any
 * refusal and on a digest other than `askedDigest` (the one the user's token named), then creates
 * each handover's canonical branch, and its adopted cycle predecessor's when that has none (an
 * existing one at the same head is left as it is), and appends every record in one batch. See shared/interfaces.md for the result.
 */
export function adopt(repo, effort, folder, mapFile, action, { by = 'user', askedDigest, run = git, live } = {}) {
  const base = {
    action, effort, folder, folder_branch: branchOf(effort, folder), folder_head: '', digest: '', refusals: [],
    outside_locus: [], clears_stops: [], deps_open: [], unaccounted: [], criteria: [], token: '',
  }
  if (action !== 'check' && action !== 'act') {
    return { ...base, ok: false, error: { kind: 'bad_arg', message: 'unknown action ' + JSON.stringify(action) + ' — check or act' } }
  }
  let raw
  try {
    raw = readFileSync(mapFile, 'utf8')
  } catch (err) {
    return { ...base, ok: false, refusals: [refusal('', 'bad_mapping', 'the mapping file cannot be read: ' + err.message)] }
  }
  const parsed = parseMapping(raw)
  if (!parsed.ok) return { ...base, ok: false, refusals: parsed.refusals }
  const facts = adoptFacts(repo, effort, folder, parsed.mapping, { run, live })
  const { refusals, normalized, report } = checkAdoption(parsed.mapping, facts)
  const digest = adoptDigest(normalized, facts.folderHead)
  const out = { ...base, folder_head: facts.folderHead, digest, refusals, ...report }
  if (refusals.length) return { ...out, ok: false }
  const records = adoptRecords(normalized, facts, by)
  const after = unaccountedOf(repo, effort, folder, { nodes: facts.tree.nodes, events: [...facts.tree.events, ...records.events], base: rootBase(repo, effort) }, run)
  const left = after && (after.error || after.commits.length) ? [{ branch: after.branch, commits: after.commits, ...(after.error ? { error: after.error } : {}) }] : []
  const checked = { ...out, ok: true, unaccounted: left, token: actToken({ act: 'adopt', folder, hash: digest }) }
  if (action === 'check') return checked

  if (askedDigest !== undefined && askedDigest !== digest) {
    return { ...checked, ok: false, error: { kind: 'head_moved', message: facts.folderBranch + ' or what the mapping names moved since the user was asked (' +
      String(askedDigest).slice(0, 8) + ' then, ' + digest.slice(0, 8) + ' now): check and ask again' } }
  }
  const created = []
  for (const b of records.branches) {
    const now = run(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + b.branch + '^{commit}'])
    if (now.ok && now.stdout.trim() === b.head) continue
    const made = run(repo, ['branch', b.branch, b.head])
    if (!made.ok) return { ...checked, ok: false, created, error: { kind: 'branch_failed', message: 'could not create ' + b.branch + ': ' + String(made.stderr || '').trim() } }
    created.push(b.branch)
  }
  const written = append(repo, effort, 'events', records.events)
  if (!written.ok) return { ...checked, ok: false, created, error: { kind: 'append_failed', message: written.error } }
  return { ...checked, ok: true, recorded: written.seqs, created }
}
