// lib/watch.mjs — the runner's watch on the user's checkout: what moved and what changed while
// one call ran, the framework's own refs and folders left out.
//
// Design: docs/DESIGN.md#the-agent-runner.

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { git } from './store.mjs'

const OWN_REF = /^refs\/heads\/agentics\//
const OWN_PATH = /^\.(agentics|claude)\//

/** A git call whose failure is the watch's failure: a snapshot built on it would read as a clean checkout. Throws. */
function mustGit(repo, args, input) {
  const r = git(repo, args, input)
  if (!r.ok) throw new Error(`git ${args[0]} failed in ${repo}: ${r.stderr.trim()}`)
  return r
}

export function snapshotCheckout(repo) {
  const refs = {}
  for (const line of mustGit(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']).stdout.split('\n')) {
    const [name, sha] = line.trim().split(' ')
    if (name && !OWN_REF.test(name)) refs[name] = sha
  }
  return { ...headAndStatus(repo), refs }
}

/**
 * HEAD's sha ('' when unborn), the branch it is on ('' when detached), and each path `git status`
 * reports with its content's blob id ('' when gone), so an edit to an already dirty file shows.
 * One `git status --porcelain=v2 --branch` answers all three.
 */
function headAndStatus(repo) {
  const fields = mustGit(repo, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']).stdout.split('\0')
  let head = ''
  let branch = ''
  const paths = []
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    if (f.startsWith('# branch.oid ')) { const oid = f.slice('# branch.oid '.length); head = oid === '(initial)' ? '' : oid; continue }
    if (f.startsWith('# branch.head ')) { const name = f.slice('# branch.head '.length); branch = name === '(detached)' ? '' : 'refs/heads/' + name; continue }
    // v2 entries: '1 XY sub mH mI mW hH hI <path>', '2 XY sub mH mI mW hH hI Xscore <path>' then the
    // original path as the next field, 'u XY sub m1 m2 m3 mW h1 h2 h3 <path>', '? <path>'.
    const at = { 1: 8, 2: 9, u: 10, '?': 1 }[f[0]]
    if (at === undefined || f[1] !== ' ') continue
    const path = f.split(' ').slice(at).join(' ')
    if (f[0] === '2') i++ // a rename's original path is the next field
    if (!OWN_PATH.test(path)) paths.push(path)
  }
  return { head, branch, status: contentOf(repo, paths) }
}

function contentOf(repo, paths) {
  const present = paths.filter((p) => existsSync(join(repo, p)) && statSync(join(repo, p)).isFile())
  const ids = present.length ? mustGit(repo, ['hash-object', '--stdin-paths'], present.join('\n') + '\n').stdout.split('\n') : []
  const status = Object.fromEntries(paths.map((p) => [p, '']))
  present.forEach((p, i) => { status[p] = (ids[i] || '').trim() })
  return status
}

/** Pure. */
export function compareCheckout(before, after) {
  const moved = []
  if (before.head !== after.head || before.branch !== after.branch) moved.push({ ref: 'HEAD', from: before.branch + '@' + before.head, to: after.branch + '@' + after.head })
  for (const name of new Set([...Object.keys(before.refs), ...Object.keys(after.refs)])) {
    if (before.refs[name] !== after.refs[name]) moved.push({ ref: name, from: before.refs[name] || '', to: after.refs[name] || '' })
  }
  const paths = new Set([...Object.keys(before.status), ...Object.keys(after.status)])
  return { moved, changed: [...paths].filter((p) => before.status[p] !== after.status[p]).sort() }
}

export const checkoutWatch = (repo) => ({
  before: () => snapshotCheckout(repo),
  after: (snapshot) => compareCheckout(snapshot, snapshotCheckout(repo)),
})
