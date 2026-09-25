// lib/boundary.mjs — the five boundaries of an execution, plus landing: every deterministic step
// an execution takes, fused per boundary into one entry point run by one courier.
//
// Design: docs/DESIGN.md#boundaries.
//
// Why fused. A workflow script has no filesystem, so every step that touches disk is a courier
// dispatch, and every courier is a round trip on the critical path. The count of BOUNDARIES, not
// of facts, sets the floor — so each boundary does everything that happens there in one process:
// leaf-open takes the slot and the locus locks, cuts the branches, attaches the worktree, writes
// the brief and appends `dispatched`; leaf-close commits a shell-less author's files, measures,
// journals, writes gotchas and decides what comes next.
//
// Why idempotent. A courier can die after the program finished and before anyone saw the output.
// So each step first asks whether its effect already exists — a merge already in the branch, a
// record already in the log, a worktree already attached — and a re-run converges on the same
// state. That is what licenses re-dispatching a boundary whose outcome was not observed.
//
// Why detached. A host's shell call has a time limit and a build plus a suite can outlast it. So
// leaf-close and merge-batch run their work in a detached child keyed by their arguments and poll
// it; a poll that reaches the limit returns `pending`, and the workflow re-dispatches the same
// boundary, which finds the same job and keeps polling. The shell limit can end a courier, never
// the work.
//
// What it never does: decide a verdict it did not compute from observations, touch the user's
// branch (except `land`, which only the session runs, on the user's go), or repair a record.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { checkAtomicity, coupledOf } from './atomicity.mjs'
import { assembleBrief } from './brief.mjs'
import { commandsOf, deleteGotcha, extractReportBlocks, writeGotcha } from './gotchas.mjs'
import {
  attach, changedFiles, contains, effortBase, ensureIntegration, ensureLeaf, mergeUnits, readText,
  resetTo, treeOf, worktrees,
} from './integration.mjs'
import { acquire, maxParallel, releaseLocus, releaseSlots, withBranchLock } from './locks.mjs'
import { append, readLog } from './ledger.mjs'
import { canonical, fnv1a } from './plan-digest.mjs'
import { resumeLeaves } from './resume.mjs'
import { standingSurvey } from './effort.mjs'
import { todoFor } from './status.mjs'
import {
  ROOT_ID, STAMP, branchExists, branchOf, decodeArgs, effortDir, envelope, executionDir, flagOf,
  git, isAncestorOrSelf, nodeBranchGlob, parentOf, posix, readJson, reportPath, revParse, safeSlug,
  sleepMs, worktreeOf,
} from './store.mjs'
import { trace } from './traceability.mjs'
import {
  childrenOf, cycleOf, executorRole, isHuman, ownReview, readTree, subtreeOf,
} from './tree.mjs'
import { closeDecision, measurementOk } from './verdict.mjs'
import { verify } from './verify.mjs'

const SELF = fileURLToPath(import.meta.url)

/** How long one boundary call polls a detached job before answering `pending`. */
const pollLimit = () => Number.parseInt(process.env.AGENTICS_BOUNDARY_WAIT_MS || '', 10) || 8 * 60 * 1000

// ------------------------------------------------------------------ context

function contextOf(repo, effort, execution) {
  if (!safeSlug(effort)) throw new Error('not an effort name: ' + JSON.stringify(effort))
  if (!STAMP.test(execution || '')) throw new Error('not an execution stamp: ' + JSON.stringify(execution))
  const dir = executionDir(repo, effort, execution)
  return { repo: posix(repo), effort, execution, dir, envelopePath: join(dir, 'execution.json') }
}

const readEnvelope = (ctx) => readJson(ctx.envelopePath)

const fail = (boundary, kind, message, extra = {}) =>
  ({ boundary, ok: false, error: { kind, message }, todos: [], notes: [], ...extra })

// ------------------------------------------------------------------ records

/** The key two appends of the same decision share, so a re-sent record lands once. */
function recordKey(file, e) {
  if (file === 'state' && e.kind === 'dispatch') return 'dispatch:' + e.label
  return [file, e.kind, e.node || '', e.execution || '', e.head_sha || '', e.round ?? '', e.reason || '', e.return || ''].join('|')
}

/**
 * Append the workflow's decisions (approvals, escalations, parks, dispatch cost lines), each
 * at most once. Events carry this execution's stamp.
 */
function appendRecords(ctx, records) {
  const list = Array.isArray(records) ? records : []
  if (list.length === 0) return { written: 0, skipped: 0 }
  const seen = new Set()
  for (const e of readLog(ctx.repo, ctx.effort, 'events').entries) seen.add(recordKey('events', e))
  for (const e of readLog(ctx.repo, ctx.effort, 'state:' + ctx.execution).entries) seen.add(recordKey('state', e))
  const events = []
  const state = []
  for (const r of list) {
    if (!r || typeof r.entry !== 'object' || !r.entry.kind) continue
    const file = r.file === 'state' ? 'state' : 'events'
    const entry = file === 'events' ? { execution: ctx.execution, ...r.entry } : r.entry
    const key = recordKey(file, entry)
    if (seen.has(key)) continue
    seen.add(key)
    ;(file === 'events' ? events : state).push(entry)
  }
  if (events.length) {
    const r = append(ctx.repo, ctx.effort, 'events', events)
    if (!r.ok) throw new Error('events refused: ' + r.error)
  }
  if (state.length) {
    const r = append(ctx.repo, ctx.effort, 'state:' + ctx.execution, state)
    if (!r.ok) throw new Error('state refused: ' + r.error)
  }
  return { written: events.length + state.length, skipped: list.length - events.length - state.length }
}

// ------------------------------------------------------------------ todos

/** Todo moves for the named nodes, from derived status; `override` sets one node's stage. */
function todos(ctx, args, ids, override = {}) {
  if (args.progress === false) return []
  const tree = readTree(ctx.repo, ctx.effort)
  const env = readEnvelope(ctx) || {}
  const known = args.task_ids && typeof args.task_ids === 'object' ? args.task_ids : {}
  const out = []
  for (const id of ids) {
    if (!tree.nodes.has(id)) continue
    const item = { ...todoFor(tree.nodes, tree.status, tree.events, id, { executionRootId: env.root || ROOT_ID }), ...(override[id] || {}) }
    const task = known[item.key] || ''
    out.push({ op: task ? 'update' : 'create', key: item.key, task_id: task, subject: item.subject, activeForm: item.activeForm, status: item.status })
  }
  return out
}

// ------------------------------------------------------------------ rows

const coversGround = (survey, ground) => survey.standing && ground.length > 0 &&
  ground.every((p) => survey.ground.some((g) => g === '.' || p === g || p.startsWith(g.replace(/\/?$/, '/'))))

function integrationOf(ctx, id) {
  const branch = branchOf(ctx.effort, id)
  if (!branchExists(ctx.repo, branch)) return null
  const head = revParse(ctx.repo, 'refs/heads/' + branch)
  let base = ''
  if (id === ROOT_ID) base = effortBase(ctx.repo, ctx.effort).base_sha
  else {
    const mb = git(ctx.repo, ['merge-base', branch, branchOf(ctx.effort, parentOf(id))])
    base = mb.ok ? mb.stdout.trim() : ''
  }
  return { branch, worktree: worktreeOf(ctx.repo, ctx.effort, id), head, base }
}

/** A node as the workflow sees it: every scheduling fact, no prose. */
function rowOf(ctx, tree, id, survey) {
  const n = tree.nodes.get(id)
  const s = tree.status.get(id)
  return {
    id, title: n.title, kind: n.kind, level: n.level, rigor: n.rigor, role: n.role,
    deps: n.deps, locus: n.locus, reads: n.reads, provides: n.provides, consumes: n.consumes,
    decisions: n.decisions, dispatch: n.dispatch, ground_known: n.ground_known,
    evidence: coversGround(survey, n.ground) ? 'standing' : 'none',
    status: s ? s.status : 'planned',
    children: childrenOf(tree.nodes, id),
    acceptance_n: n.acceptance.length,
    human: n.acceptance.filter(isHuman).map((a) => a.text),
    own_review: n.kind === 'leaf' && ownReview(n),
    coupled: n.kind === 'leaf' && coupledOf(tree.nodes, id),
    integration: n.kind === 'leaf' ? null : integrationOf(ctx, id),
  }
}

// ------------------------------------------------------------------ preflight

/** Executions of this effort that never closed, other than this one. */
function openExecutions(ctx) {
  const dir = join(effortDir(ctx.repo, ctx.effort), 'executions')
  if (!existsSync(dir)) return []
  const out = []
  for (const stamp of readdirSafe(dir)) {
    if (stamp === ctx.execution || !STAMP.test(stamp)) continue
    const env = readJson(join(dir, stamp, 'execution.json'))
    if (!env) continue
    const closed = readLog(ctx.repo, ctx.effort, 'state:' + stamp).entries.some((e) => e.kind === 'closed')
    if (!closed) out.push({ stamp, root: env.root || ROOT_ID })
  }
  return out
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

export function preflight(ctx, args) {
  const tree = readTree(ctx.repo, ctx.effort)
  if (tree.error) return fail('preflight', 'unreadable', tree.error)
  const root = typeof args.root === 'string' && args.root ? args.root : ROOT_ID
  if (!tree.nodes.has(root)) return fail('preflight', 'no_such_node', 'node ' + root + ' is not in effort ' + ctx.effort)
  if (root === ROOT_ID && tree.nodes.get(root).kind === 'leaf') {
    return fail('preflight', 'root_is_leaf', 'the effort root must be a composite or design node')
  }
  const notes = []
  const records = appendRecords(ctx, args.records)

  let env = readEnvelope(ctx)
  const resumed = Boolean(env)
  if (!env) {
    const ref = args.base_ref || ''
    const base_branch = ref || git(ctx.repo, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
    const base_sha = revParse(ctx.repo, ref || 'HEAD')
    if (!base_sha) return fail('preflight', 'no_base', 'could not resolve ' + (ref || 'HEAD') + ' in ' + ctx.repo)
    env = {
      stamp: ctx.execution, root, base_branch, base_sha, dial: args.dial || 'normal', pace: args.pace || 'balanced',
      commands: args.commands || null,
    }
    if (!args.reload) {
      mkdirSync(ctx.dir, { recursive: true })
      writeFileSync(ctx.envelopePath, JSON.stringify(env, null, 1) + '\n')
    }
  } else if (env.root !== root) {
    return fail('preflight', 'wrong_root', 'execution ' + ctx.execution + ' runs ' + env.root + ', not ' + root)
  }

  let checkpoint = null
  const stale = []
  const freed = []
  const dirty = []
  if (!args.reload) {
    const overlapping = openExecutions(ctx).filter((e) => isAncestorOrSelf(e.root, root) || isAncestorOrSelf(root, e.root))
    if (overlapping.length && !args.confirmed_duplicate) {
      checkpoint = { reason: 'existing_execution', detail: overlapping.map((e) => e.stamp + ' (root ' + e.root + ')').join(', '), executions: overlapping }
    }

    const retry = (Array.isArray(args.retry_escalated) ? args.retry_escalated : []).filter((id) => tree.nodes.has(id))
    if (retry.length) {
      const r = append(ctx.repo, ctx.effort, 'events', retry.map((id) => ({ kind: 'replanned', node: id, execution: ctx.execution, reason: 'retry_escalated', by: 'session' })))
      if (!r.ok) notes.push('retry_escalated could not be recorded: ' + r.error)
    }

    if (resumed && !checkpoint) {
      const now = revParse(ctx.repo, env.base_branch || 'HEAD')
      if (now && env.base_sha && now !== env.base_sha) {
        const moved = new Set(changedFiles(ctx.repo, env.base_sha, now))
        for (const id of subtreeOf(tree.nodes, root)) {
          const n = tree.nodes.get(id)
          if (n.kind !== 'leaf' || (tree.status.get(id) || {}).status === 'merged') continue
          const writes = n.locus.filter((p) => moved.has(p))
          const reads = n.reads.filter((p) => moved.has(p))
          if (writes.length || reads.length) stale.push({ node: id, writes, reads })
        }
        if (stale.length && !args.confirmed_stale) checkpoint = { reason: 'stale', detail: stale.length + ' leaf/leaves declare files the base branch moved', stale }
      }
    }

    const { gaps, untraced } = trace(tree.nodes, root)
    if (!checkpoint && gaps.length && !args.confirmed_gaps) {
      checkpoint = { reason: 'blocking_gaps', detail: gaps.map((g) => g.decision + ' (' + g.why + ')').join('; '), gaps }
    }
    if (!checkpoint && args.plan_only) checkpoint = { reason: 'parked', detail: 'plan_only: the plan is on disk and nothing was dispatched' }

    releaseSlots(ctx.repo, { effort: ctx.effort, execution: ctx.execution })
    // Leftover checkouts of this effort's branches away from their canonical path: git refuses a
    // branch in two worktrees, so a dead invocation's leftover would bring the next one up
    // detached. Clean ones are removed; a dirty one is never forced.
    const prefix = 'agentics/' + ctx.effort
    for (const [path, w] of worktrees(ctx.repo)) {
      if (!(w.branch === prefix || w.branch.startsWith(prefix + '--'))) continue
      const id = w.branch === prefix ? ROOT_ID : w.branch.slice(prefix.length + 2).split('.').join('/')
      if (worktreeOf(ctx.repo, ctx.effort, id) === path) continue
      if (git(path, ['status', '--porcelain']).stdout.trim()) {
        dirty.push(path)
        continue
      }
      if (git(ctx.repo, ['worktree', 'remove', path]).ok) freed.push(path)
    }
    git(ctx.repo, ['worktree', 'prune'])
  }

  const fresh = readTree(ctx.repo, ctx.effort)
  const survey = standingSurvey(ctx.repo, ctx.effort)
  const ids = subtreeOf(fresh.nodes, root)
  const nodes = [...fresh.nodes.keys()].map((id) => rowOf(ctx, fresh, id, survey))
  const leafIds = ids.filter((id) => fresh.nodes.get(id).kind === 'leaf')
  const parentHeads = {}
  for (const id of leafIds) {
    const p = parentOf(id)
    if (!(p in parentHeads)) parentHeads[p] = revParse(ctx.repo, 'refs/heads/' + branchOf(ctx.effort, p))
  }
  const leaves = resumeLeaves(ctx.repo, ctx.effort, ctx.execution, fresh.nodes, parentHeads)
    .filter((l) => leafIds.includes(l.id))
    .map((l) => ({ ...l, rounds: roundsOf(fresh.events, l.id) }))
  const { gaps, untraced } = trace(fresh.nodes, root)
  const atomicity = leafIds.flatMap((id) => checkAtomicity(fresh.nodes, id, { repo: ctx.repo, status: fresh.status }))

  if (checkpoint) {
    append(ctx.repo, ctx.effort, 'state:' + ctx.execution, { kind: 'checkpoint', reason: checkpoint.reason })
  }

  return {
    boundary: 'preflight', ok: true, error: null, checkpoint,
    envelope: { ...env, resumed },
    nodes, leaves, gaps, untraced, atomicity,
    coupled: leafIds.filter((id) => coupledOf(fresh.nodes, id)),
    stale, freed, dirty_worktrees: dirty,
    commands: { ...(env.commands || {}), ...compact(commandsOf(ctx.repo, ctx.effort)) },
    max_parallel: maxParallel(ctx.repo),
    records,
    todos: checkpoint ? [] : todos(ctx, args, ids),
    notes,
  }
}

const compact = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== '' && v != null))
const roundsOf = (events, id) => events.filter((e) => e.kind === 'dispatched' && e.node === id).reduce((m, e) => Math.max(m, Number.isInteger(e.round) ? e.round : 0), 0)

// ------------------------------------------------------------------ leaf-open

const STAGE = { implementer: 'implementing', 'test-author': 'writing tests', auditor: 'auditing', '': 'checking' }

function leafOpen(ctx, args) {
  const records = appendRecords(ctx, args.records)
  const tree = readTree(ctx.repo, ctx.effort)
  const id = args.node
  const leaf = tree.nodes.get(id)
  if (!leaf || leaf.kind !== 'leaf') return fail('leaf-open', 'not_a_leaf', JSON.stringify(id) + ' is not a live leaf')
  const env = readEnvelope(ctx)
  if (!env) return fail('leaf-open', 'no_execution', 'execution ' + ctx.execution + ' has no envelope — run preflight first')
  const role = typeof args.role === 'string' ? args.role : executorRole(leaf)
  const round = Number.isInteger(args.round) && args.round > 0 ? args.round : 1

  const got = acquire(ctx.repo, {
    effort: ctx.effort, execution: ctx.execution, node: id,
    locus: leaf.locus, waitMs: Number.isInteger(args.wait_ms) ? args.wait_ms : undefined,
  })
  if (!got.ok) {
    return { boundary: 'leaf-open', ok: true, error: got.reason === 'invalid' ? { kind: 'invalid', message: got.error } : null, status: got.reason, held_by: got.held_by, stuck: got.stuck === true, max_parallel: maxParallel(ctx.repo), records, todos: [], notes: got.notes || [] }
  }

  const parent = parentOf(id)
  const integ = ensureIntegration(ctx.repo, ctx.effort, parent, env)
  if (!integ.ok) return fail('leaf-open', 'integration', integ.error, { status: 'refused' })

  // Where a new branch is cut: the cycle predecessor's head for green and audit (green is coded on
  // red's tests; red is held, never merged alone), the parent's integration head otherwise.
  let from = integ.head
  const cycle = cycleOf(tree.nodes, id)
  const at = cycle.indexOf(id)
  if (at > 0) {
    const pred = revParse(ctx.repo, 'refs/heads/' + branchOf(ctx.effort, cycle[at - 1]))
    if (!pred) return fail('leaf-open', 'no_predecessor', cycle[at - 1] + ' has no branch to cut ' + id + ' from', { status: 'refused' })
    from = pred
  }
  const made = ensureLeaf(ctx.repo, ctx.effort, id, { from, parentBranch: integ.branch, refresh: args.refresh === true })
  if (!made.ok) return fail('leaf-open', 'branch', made.error, { status: 'refused' })

  const brief = assembleBrief(ctx.repo, ctx.effort, ctx.execution, id, {
    role: role || 'none', round, fix: Array.isArray(args.fix) ? args.fix : [],
  })
  const tier = args.dispatch && typeof args.dispatch === 'object' ? args.dispatch : {}
  appendRecords(ctx, [{ file: 'events', entry: { kind: 'dispatched', node: id, role, round, model: tier.model || '', effort: tier.effort || '' } }])

  const report = reportPath(ctx.repo, ctx.effort, ctx.execution, id, role || 'none', round)
  mkdirSync(dirname(report), { recursive: true })
  const stage = round > 1 && role ? 'fix round ' + round : STAGE[role] || 'checking'
  return {
    boundary: 'leaf-open', ok: true, error: null, status: 'opened',
    branch: made.branch, worktree: made.worktree, base_sha: made.base, head_sha: made.head, rebased: made.rebased,
    brief_path: brief.path, brief_digest: brief.digest, report_path: report,
    slot: got.slot, max_parallel: maxParallel(ctx.repo), records,
    todos: todos(ctx, args, [id], { [id]: { status: 'in_progress', activeForm: stage } }),
    notes: [...(got.notes || []), ...integ.created.map((b) => 'created ' + b), ...integ.refreshed.map((b) => 'refreshed ' + b)],
  }
}

// ------------------------------------------------------------------ leaf-close

/** The commands verification runs, from `command` gotchas an investigator wrote, else the envelope. */
function commandsFor(ctx) {
  const env = readEnvelope(ctx) || {}
  const given = env.commands || {}
  const found = commandsOf(ctx.repo, ctx.effort)
  const pick = (name) => found[name] || given[name] || ''
  const absent = (name) => Boolean((found.absent && found.absent[name]) || (given.absent && given.absent[name]))
  return {
    build: pick('build'), typecheck: pick('typecheck'), suite: pick('suite'), testOne: pick('test_one'),
    buildAbsent: absent('build'), typecheckAbsent: absent('typecheck'), suiteAbsent: absent('suite'),
  }
}

/**
 * Commit what a shell-less author wrote inside its locus; anything outside it is left out of the
 * commit, reverted, and reported — the series check would call it a breach, and a file nobody
 * committed must not silently ride into the next measurement.
 */
function commitAuthor(ctx, leaf, worktree, subject) {
  const st = git(worktree, ['status', '--porcelain', '--untracked-files=all'])
  const changed = st.stdout.split('\n').filter(Boolean).map((l) => posix(l.slice(3).trim().replace(/^"|"$/g, '')))
  const inLocus = changed.filter((p) => leaf.locus.includes(p))
  const outside = changed.filter((p) => !leaf.locus.includes(p))
  for (const p of outside) {
    if (git(worktree, ['ls-files', '--error-unmatch', p]).ok) git(worktree, ['checkout', '--', p])
    else rmSync(join(worktree, p), { force: true })
  }
  if (inLocus.length === 0) return { committed: false, outside, sha: '' }
  git(worktree, ['add', '--', ...inLocus])
  const c = git(worktree, ['commit', '-m', subject])
  if (!c.ok) return { committed: false, outside, sha: '', error: c.stderr.trim() }
  return { committed: true, outside, sha: revParse(worktree, 'HEAD') }
}

function leafClose(ctx, args) {
  const tree = readTree(ctx.repo, ctx.effort)
  const id = args.node
  const leaf = tree.nodes.get(id)
  if (!leaf || leaf.kind !== 'leaf') return fail('leaf-close', 'not_a_leaf', JSON.stringify(id) + ' is not a live leaf')
  const role = typeof args.role === 'string' ? args.role : executorRole(leaf)
  const round = Number.isInteger(args.round) && args.round > 0 ? args.round : 1
  const worktree = worktreeOf(ctx.repo, ctx.effort, id)
  const branch = branchOf(ctx.effort, id)
  const notes = []

  const report = readText(reportPath(ctx.repo, ctx.effort, ctx.execution, id, role || 'none', round))
  const blocks = extractReportBlocks(report)
  if (blocks.problems.length) notes.push(...blocks.problems.map((p) => 'report: ' + p))

  let committed = false
  const breaches = []
  if (role === 'test-author' || role === 'auditor') {
    const c = commitAuthor(ctx, leaf, worktree, blocks.commit || 'test(' + id + '): ' + leaf.title)
    committed = c.committed
    if (c.error) notes.push('commit refused: ' + c.error)
    for (const p of c.outside) breaches.push({ sha: '', check: 'locus-breach', message: role + ' wrote ' + p + ', outside the locus; not committed and reverted', blocking: role === 'test-author' })
    if (c.committed) {
      append(ctx.repo, ctx.effort, 'journal:' + ctx.execution, {
        kind: 'series-done', node: id, branch, head_sha: c.sha,
        commits: [{ sha: c.sha, subject: blocks.commit || 'test(' + id + '): ' + leaf.title }],
      })
    }
  }

  const checks = leaf.rigor === 'verify' ? leaf.acceptance.filter((a) => !isHuman(a) && a.check.trim()).map((a) => a.check) : []
  // A green is measured on its red's tests: the cycle's test files, which sit outside its locus.
  const cycle = cycleOf(tree.nodes, id)
  const tests = leaf.role === 'green' && cycle.length ? tree.nodes.get(cycle[0]).locus : []
  const cmd = commandsFor(ctx)
  const m = verify({
    worktree, mode: 'order', base: args.base_sha || '', locus: leaf.locus,
    ...cmd, mutations: blocks.mutations, rigor: leaf.rigor, role: leaf.role, checks, tests,
    repo: ctx.repo, effort: ctx.effort, execution: ctx.execution, node: id, branch,
  })
  if (breaches.length) m.series_findings = [...(m.series_findings || []), ...breaches]
  const history = readLog(ctx.repo, ctx.effort, 'journal:' + ctx.execution).entries
    .filter((e) => e.kind === 'verify-observed' && e.node === id)
  const decision = closeDecision(m, leaf, history.slice(0, -1))

  const head = revParse(worktree, 'HEAD')
  const written = []
  const deleted = []
  for (const g of blocks.gotchas) {
    const w = writeGotcha(ctx.repo, ctx.effort, g, { observed_at: head, source: { node: id, role } })
    if (w.ok) written.push(w.id)
    else notes.push('gotcha refused: ' + w.error)
  }
  for (const gid of blocks.stale) if (deleteGotcha(ctx.repo, ctx.effort, gid).deleted) deleted.push(gid)

  const stage = {
    review: { status: 'in_progress', activeForm: 'in review' },
    approve: { status: 'in_progress', activeForm: 'awaiting merge' },
    fix: { status: 'in_progress', activeForm: 'fix round ' + (round + 1) },
    command_unknown: { status: 'in_progress', activeForm: 'establishing commands' },
    escalate: { status: 'pending', activeForm: 'escalated: ' + (decision.reason || '') },
    finding: { status: 'pending', activeForm: 'finding for ' + parentOf(id) },
  }[decision.next] || {}
  return {
    boundary: 'leaf-close', ok: true, error: null, status: 'done', node: id, head_sha: head,
    measurement: m, decision, gotchas_written: written, gotchas_deleted: deleted,
    mutations: blocks.mutations, committed,
    todos: todos(ctx, args, [id], { [id]: stage }), notes,
  }
}

// ------------------------------------------------------------------ merge-batch

/** Order a batch so a child merges after any sibling it depends on. */
function dependencyOrder(nodes, ids) {
  const out = []
  const visit = (id, seen = new Set()) => {
    if (out.includes(id) || seen.has(id)) return
    seen.add(id)
    for (const d of (nodes.get(id) || { deps: [] }).deps) if (ids.includes(d)) visit(d, seen)
    out.push(id)
  }
  for (const id of ids) visit(id)
  return out
}

const integrationOk = (m) => m && m.stop_reason === 'completed' && m.build !== 'failed' && m.typecheck !== 'failed' && m.suite !== 'failed'
const integrationFailures = (m) => {
  const out = []
  if (!m || m.stop_reason !== 'completed') out.push({ check: 'environment', claim: (m && m.error && m.error.message) || 'the merged head could not be measured', evidence: '' })
  for (const k of ['build', 'typecheck', 'suite']) if (m && m[k] === 'failed') out.push({ check: k, claim: 'the ' + k + ' fails on the merged head', evidence: k === 'suite' ? (m.suite_output_tail || '') : (m.notes || '') })
  return out
}

/**
 * Pure. What a landed diff touched that a pending node was designed against: the landed files
 * intersected with the `consumes` path prefixes of every node not yet merged. A contract the
 * landed work itself provides is expected to move and is not drift; a node with no contracts to
 * check against is reported as unexamined, because "no flag" and "nothing to check" differ.
 */
export function driftOf(tree, landedIds, files) {
  const landedSet = new Set(landedIds.flatMap((id) => subtreeOf(tree.nodes, id)))
  const providedHere = new Set([...landedSet].flatMap((id) => tree.nodes.get(id).provides.map((c) => c.name)))
  const under = (file, prefix) => file === prefix || file.startsWith(prefix.replace(/\/?$/, '/'))
  const drift = []
  const unexamined = []
  for (const [id, n] of tree.nodes) {
    if (landedSet.has(id)) continue
    const s = (tree.status.get(id) || {}).status
    if (['merged', 'landed', 'integrated'].includes(s)) continue
    if (n.consumes.length === 0) {
      if (n.kind === 'design' && childrenOf(tree.nodes, id).length === 0) unexamined.push(id)
      continue
    }
    for (const c of n.consumes) {
      if (providedHere.has(c.name)) continue
      const hit = files.filter((f) => c.paths.some((p) => under(f, p)))
      if (hit.length) drift.push({ node: id, contract: c.name, files: hit })
    }
  }
  return { drift, unexamined }
}

function mergeBatch(ctx, args) {
  const tree = readTree(ctx.repo, ctx.effort)
  const target = args.target
  if (!tree.nodes.has(target) || tree.nodes.get(target).kind === 'leaf') return fail('merge-batch', 'not_a_composite', JSON.stringify(target) + ' is not a composite in this effort')
  const env = readEnvelope(ctx)
  if (!env) return fail('merge-batch', 'no_execution', 'no envelope for ' + ctx.execution)
  const children = (Array.isArray(args.children) ? args.children : []).filter((c) => c && tree.nodes.has(c.id))
  const cycles = Array.isArray(args.cycles) ? args.cycles : []

  // Units: a cycle merges through its tip, which carries every member's commits.
  const inCycle = new Map()
  for (const cycle of cycles) for (const m of cycle) inCycle.set(m, cycle)
  const units = []
  const done = new Set()
  for (const id of dependencyOrder(tree.nodes, children.map((c) => c.id))) {
    if (done.has(id)) continue
    const cycle = inCycle.get(id)
    const ids = cycle ? cycle.filter((m) => children.some((c) => c.id === m)) : [id]
    ids.forEach((m) => done.add(m))
    const tip = ids[ids.length - 1]
    const given = children.find((c) => c.id === tip)
    const branch = branchOf(ctx.effort, tip)
    units.push({ ids, branch, head: (given && given.head_sha) || revParse(ctx.repo, 'refs/heads/' + branch) })
  }

  return withBranchLock(ctx.repo, ctx.effort, branchOf(ctx.effort, target), () => {
    const integ = ensureIntegration(ctx.repo, ctx.effort, target, env)
    if (!integ.ok) return fail('merge-batch', 'integration', integ.error)
    const wt = integ.worktree
    const pre = revParse(wt, 'HEAD')
    const cmd = commandsFor(ctx)
    const measure = () => verify({ worktree: wt, mode: 'integration', ...cmd, repo: ctx.repo, effort: ctx.effort, execution: ctx.execution, node: target, branch: integ.branch })

    let out = mergeUnits(ctx.repo, wt, units)
    let merged = out.merged
    let measurement = null
    let verified = null
    const failedAlone = []
    let combination = []

    const fresh = merged.filter((m) => !m.already)
    if (fresh.length > 0) {
      const only = fresh.length === 1 ? units.find((u) => u.ids === fresh[0].ids) : null
      if (only && treeOf(ctx.repo, revParse(wt, 'HEAD')) === treeOf(ctx.repo, only.head)) {
        verified = true
      } else {
        measurement = measure()
        verified = integrationOk(measurement)
      }
      if (!verified) {
        // Bisect: back to the last green head, each unit alone, then the ones that pass together.
        resetTo(wt, pre)
        const passers = []
        for (const u of units.filter((x) => fresh.some((f) => f.ids === x.ids))) {
          const alone = mergeUnits(ctx.repo, wt, [u])
          const m = alone.conflict ? null : measure()
          if (m && integrationOk(m)) passers.push(u)
          else failedAlone.push({ id: u.ids[u.ids.length - 1], ids: u.ids, failures: m ? integrationFailures(m) : [{ check: 'merge', claim: alone.conflict.reason, evidence: '' }] })
          resetTo(wt, pre)
        }
        out = mergeUnits(ctx.repo, wt, passers)
        merged = out.merged
        if (passers.length > 1) {
          measurement = measure()
          verified = integrationOk(measurement)
          if (!verified) {
            combination = passers.flatMap((u) => u.ids)
            resetTo(wt, pre)
            merged = []
          }
        } else {
          verified = passers.length === 1
        }
      }
    }

    const head = revParse(wt, 'HEAD')
    const landed = merged.flatMap((m) => m.ids.map((id) => ({ id, merged_sha: m.merged_sha })))
    if (landed.length) {
      appendRecords(ctx, landed.map((l) => ({ file: 'events', entry: { kind: 'merged', node: l.id, into: integ.branch, merged_sha: l.merged_sha, head_sha: (units.find((u) => u.ids.includes(l.id)) || {}).head || '' } })))
      append(ctx.repo, ctx.effort, 'journal:' + ctx.execution, landed.map((l) => ({ kind: 'merge-observed', node: l.id, branch: branchOf(ctx.effort, l.id), into: integ.branch, merged_sha: l.merged_sha, head_sha: head })))
      const leafIds = landed.map((l) => l.id).filter((id) => tree.nodes.get(id).kind === 'leaf')
      const under = landed.map((l) => l.id).filter((id) => tree.nodes.get(id).kind !== 'leaf')
        .flatMap((c) => subtreeOf(tree.nodes, c)).filter((id) => tree.nodes.get(id).kind === 'leaf')
      releaseLocus(ctx.repo, ctx.effort, [...leafIds, ...under])
    }
    const conflict = out.conflict ? { node: out.conflict.ids[out.conflict.ids.length - 1], nodes: out.conflict.ids, paths: out.conflict.paths, reason: out.conflict.reason } : null
    append(ctx.repo, ctx.effort, 'state:' + ctx.execution, {
      kind: 'batch', target, merged: landed.map((l) => l.id), head_sha: head, verified,
      failed_alone: failedAlone.map((f) => f.id), combination, conflict: conflict ? conflict.node : '',
    })

    const where = integrationOf(ctx, target)
    const { drift, unexamined } = landed.length ? driftOf(tree, landed.map((l) => l.id), changedFiles(ctx.repo, pre, head)) : { drift: [], unexamined: [] }
    return {
      boundary: 'merge-batch', ok: true, error: null, status: 'done', target,
      target_branch: integ.branch, target_worktree: wt, target_base: where ? where.base : '',
      merged: landed, conflict, head_sha: head, verified, measurement,
      failed_alone: failedAlone, combination, drift, unexamined,
      todos: todos(ctx, args, landed.map((l) => l.id)), notes: [],
    }
  })
}

// ------------------------------------------------------------------ postflight

export function postflight(ctx, args) {
  const records = appendRecords(ctx, args.records)
  releaseSlots(ctx.repo, { effort: ctx.effort, execution: ctx.execution })
  const tree = readTree(ctx.repo, ctx.effort)
  const env = readEnvelope(ctx) || { root: ROOT_ID }
  const cleanup = []
  for (const id of subtreeOf(tree.nodes, env.root || ROOT_ID)) {
    if (id === ROOT_ID) continue
    const s = tree.status.get(id)
    const branch = branchOf(ctx.effort, id)
    if (!branchExists(ctx.repo, branch)) continue
    cleanup.push({ node: id, branch, worktree: worktreeOf(ctx.repo, ctx.effort, id), merged: Boolean(s && s.status === 'merged') })
  }
  const closed = args.status === 'done'
  if (closed && !readLog(ctx.repo, ctx.effort, 'state:' + ctx.execution).entries.some((e) => e.kind === 'closed')) {
    append(ctx.repo, ctx.effort, 'state:' + ctx.execution, { kind: 'closed', status: 'done' })
  }
  return {
    boundary: 'postflight', ok: true, error: null, cleanup: cleanup.filter((c) => c.merged), unmerged: cleanup.filter((c) => !c.merged).map((c) => c.node),
    closed, records, todos: todos(ctx, args, subtreeOf(tree.nodes, env.root || ROOT_ID)), notes: [],
  }
}

// ------------------------------------------------------------------ land (the session's act)

/**
 * Landing: the one ask. `check` reports what the user needs to decide; `merge` merges the effort
 * branch into the user's checked-out branch, refusing over an open escalation, a parked node or a
 * dirty tree; `cleanup` removes merged node branches and their clean worktrees.
 */
export function land(repo, effort, action) {
  const tree = readTree(repo, effort)
  const effortBranch = branchOf(effort, ROOT_ID)
  const open = [...tree.status].filter(([, s]) => s.status === 'escalated' || s.status === 'parked')
  const human = [...tree.nodes.values()].filter((n) => n.kind === 'leaf').flatMap((n) => n.acceptance.filter(isHuman).map((a) => ({ node: n.id, text: a.text })))
  const base = effortBase(repo, effort)
  const head = revParse(repo, 'HEAD')
  const into = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
  const effortHead = revParse(repo, 'refs/heads/' + effortBranch)

  const report = () => {
    const userCommits = base.base_sha && head ? git(repo, ['log', '--oneline', base.base_sha + '..' + head]).stdout.split('\n').filter(Boolean) : []
    const userFiles = base.base_sha && head ? changedFiles(repo, base.base_sha, head) : []
    const effortFiles = base.base_sha && effortHead ? changedFiles(repo, base.base_sha, effortHead) : []
    return {
      action, effort, into, effort_branch: effortBranch, effort_head: effortHead,
      open_escalations: open.filter(([, s]) => s.status === 'escalated').map(([id, s]) => ({ node: id, reason: (s.last && s.last.reason) || '' })),
      parked: open.filter(([, s]) => s.status === 'parked').map(([id, s]) => ({ node: id, question: (s.last && s.last.question) || '' })),
      human,
      drift: { base_sha: base.base_sha, base_moved: userCommits.length > 0, commits: userCommits, overlap: effortFiles.filter((f) => userFiles.includes(f)) },
      root_status: (tree.status.get(ROOT_ID) || {}).status || 'planned',
    }
  }

  if (action === 'check') return { ...report(), ok: true }

  if (action === 'merge') {
    const r = report()
    if (!effortHead) return { ...r, ok: false, error: 'there is no effort branch ' + effortBranch }
    if (r.open_escalations.length || r.parked.length) return { ...r, ok: false, error: 'never lands over an open escalation or a parked node' }
    const dirty = git(repo, ['status', '--porcelain']).stdout.split('\n').filter((l) => l && !l.slice(3).startsWith('.claude/'))
    if (dirty.length) return { ...r, ok: false, error: 'the working tree is dirty: ' + dirty.slice(0, 5).join(', ') }
    if (contains(repo, head, effortHead)) return { ...r, ok: true, merged_sha: head, already: true }
    const m = git(repo, ['merge', '--no-ff', '--no-edit', '-m', 'Merge agentics effort ' + effort, effortBranch])
    if (!m.ok) {
      git(repo, ['merge', '--abort'])
      return { ...r, ok: false, error: 'the merge failed and was aborted: ' + (m.stderr || m.stdout).trim() }
    }
    const sha = revParse(repo, 'HEAD')
    append(repo, effort, 'events', { kind: 'landed', node: ROOT_ID, execution: '', into, merged_sha: sha })
    return { ...r, ok: true, merged_sha: sha }
  }

  if (action === 'cleanup') {
    if (!effortHead || !contains(repo, head, effortHead)) return { action, ok: false, error: 'run cleanup from the checkout that took the landing merge' }
    const removed = []
    const kept = []
    const listed = git(repo, ['branch', '--list', effortBranch, nodeBranchGlob(effort), '--format=%(refname:short)']).stdout.split('\n').filter(Boolean)
    const known = worktrees(repo)
    for (const branch of listed) {
      const tip = revParse(repo, 'refs/heads/' + branch)
      if (!contains(repo, head, tip)) {
        kept.push({ branch, why: 'not merged into ' + into })
        continue
      }
      const wt = [...known.values()].find((w) => w.branch === branch)
      if (wt) {
        if (git(wt.path, ['status', '--porcelain']).stdout.trim()) {
          kept.push({ branch, why: 'its worktree ' + wt.path + ' is dirty' })
          continue
        }
        git(repo, ['worktree', 'remove', wt.path])
      }
      if (git(repo, ['branch', '-d', branch]).ok) removed.push(branch)
      else kept.push({ branch, why: 'git branch -d refused' })
    }
    return { action, ok: true, removed, kept }
  }
  return { action, ok: false, error: 'unknown action ' + JSON.stringify(action) + ' — check, merge or cleanup' }
}

// ------------------------------------------------------------------ jobs

const COMPUTE = { 'leaf-close': leafClose, 'merge-batch': mergeBatch }

const jobKey = (name, args) => {
  const { records, task_ids: _t, progress: _p, ...rest } = args
  return fnv1a(canonical({ name, ...rest }))
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/**
 * Run a long boundary in a detached child and poll for its result; `pending` when the poll limit
 * is reached first. The same arguments find the same job: a finished one answers at once, a live
 * one is polled again, a dead one without a result is started afresh.
 */
function detached(ctx, name, args) {
  const dir = join(ctx.dir, 'jobs')
  mkdirSync(dir, { recursive: true })
  const key = name + '-' + jobKey(name, args)
  const result = join(dir, key + '.json')
  const pidFile = join(dir, key + '.pid')
  const argsFile = join(dir, key + '.args.json')

  if (!existsSync(result)) {
    const pid = Number.parseInt(readText(pidFile), 10)
    if (!(Number.isInteger(pid) && alive(pid))) {
      writeFileSync(argsFile, JSON.stringify(args))
      const child = spawn(process.execPath, [SELF, 'job', '--name', name, '--repo', ctx.repo, '--effort', ctx.effort,
        '--execution', ctx.execution, '--args-file', argsFile, '--out', result], { detached: true, stdio: 'ignore' })
      writeFileSync(pidFile, String(child.pid))
      child.unref()
    }
  }
  const until = Date.now() + pollLimit()
  while (Date.now() < until) {
    if (existsSync(result)) {
      const payload = readJson(result)
      if (payload) return payload
    }
    sleepMs(250)
  }
  return { boundary: name, ok: true, error: null, status: 'pending', job: key, todos: [], notes: ['still running detached; re-dispatch this boundary to collect it'] }
}

// ------------------------------------------------------------------ CLI

const BOUNDARIES = { preflight, 'leaf-open': leafOpen, postflight }

export function runBoundary(name, repo, effort, execution, args) {
  const ctx = contextOf(repo, effort, execution)
  if (COMPUTE[name]) {
    appendRecords(ctx, args.records)
    if (process.env.AGENTICS_INLINE_JOBS === '1') return COMPUTE[name](ctx, args)
    return detached(ctx, name, { ...args, records: [] })
  }
  if (BOUNDARIES[name]) return BOUNDARIES[name](ctx, args)
  throw new Error('unknown boundary ' + JSON.stringify(name))
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  const argv = process.argv.slice(2)
  const [name] = argv
  const repo = flagOf(argv, 'repo') || '.'
  const effort = flagOf(argv, 'effort')
  try {
    if (name === 'job') {
      const ctx = contextOf(repo, effort, flagOf(argv, 'execution'))
      const jobName = flagOf(argv, 'name')
      const args = JSON.parse(readFileSync(flagOf(argv, 'args-file'), 'utf8'))
      let payload
      try {
        payload = COMPUTE[jobName](ctx, args)
      } catch (err) {
        payload = fail(jobName, 'job_failed', err.message)
      }
      const out = flagOf(argv, 'out')
      writeFileSync(out + '.tmp', JSON.stringify(payload))
      renameSync(out + '.tmp', out)
      process.exit(0)
    }
    if (name === 'land') {
      let action = flagOf(argv, 'action')
      if (!action) {
        const { value } = decodeArgs(argv)
        action = value && value.action
      }
      console.log(JSON.stringify(land(repo, effort, action), null, 1))
      process.exit(0)
    }
    const { value, problem } = decodeArgs(argv)
    if (problem) {
      console.log(JSON.stringify(envelope(fail(name, problem.kind, problem.message))))
      process.exit(0)
    }
    const payload = runBoundary(name, repo, effort, flagOf(argv, 'execution'), value || {})
    console.log(JSON.stringify(envelope(payload)))
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
