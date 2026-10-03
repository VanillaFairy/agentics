// lib/watch.mjs — the runner's watch on the user's checkout: what moved and what changed while
// one call ran, the framework's own refs and folders left out.
//
// Design: docs/DESIGN.md#the-agent-runner.

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { git } from './store.mjs'

const OWN_REF = /^refs\/heads\/agentics\//
const OWN_PATH = /^\.(agentics|claude)\//

export function snapshotCheckout(repo) {
  const head = git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']).stdout.trim()
  const branch = git(repo, ['symbolic-ref', '--quiet', 'HEAD']).stdout.trim()
  const refs = {}
  for (const line of git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']).stdout.split('\n')) {
    const [name, sha] = line.trim().split(' ')
    if (name && !OWN_REF.test(name)) refs[name] = sha
  }
  return { head, branch, refs, status: dirtyContent(repo) }
}

/** Each path `git status` reports, with its content's blob id ('' when gone), so an edit to an already dirty file shows. */
function dirtyContent(repo) {
  const fields = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout.split('\0')
  const paths = []
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    if (f.length < 4) continue
    if (/[RC]/.test(f.slice(0, 2))) i++ // a rename's or copy's other path is the next field
    if (!OWN_PATH.test(f.slice(3))) paths.push(f.slice(3))
  }
  const present = paths.filter((p) => existsSync(join(repo, p)) && statSync(join(repo, p)).isFile())
  const ids = present.length ? git(repo, ['hash-object', '--stdin-paths'], present.join('\n') + '\n').stdout.split('\n') : []
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
