// lib/answers.mjs — the user's answers, recorded in their own words: a question is opened with a
// token the session puts in the question's text, and the answer to it is read back from where the
// user gave it and kept on the effort's ledger. A changed spec is ruled against every answer given
// since it was last approved, so a choice the user made once is never put to them again.
//
// Design: docs/DESIGN.md#the-users-word, docs/DESIGN.md#a-changed-spec.

import { pathToFileURL } from 'node:url'

import { runCli } from './cli.mjs'
import { answerOf, askLine } from './host.mjs'
import { append, readLog } from './ledger.mjs'
import { canonical } from './plan-digest.mjs'
import { envelope, flagOf, handleArgs, resolveHandle } from './store.mjs'
import { readTree } from './tree.mjs'

const refuse = (kind, message) => ({ ok: false, error: { kind, message } })

/** Pure. The token a question's text carries, naming the `asked` line it was opened by. */
export const answerToken = (effort, seq) => 'answer ' + effort + '#' + seq

/**
 * Open a question: an `asked` line naming the nodes whose stop it settles, and the token the
 * question's text must carry. A node that is not in the effort's tree is refused.
 */
export function openQuestion(repo, effort, { nodes = [] } = {}) {
  const known = resolveHandle(repo, 'effort', effort)
  if (!known.ok) return known
  const tree = readTree(repo, effort)
  if (tree.error) return refuse('no_tree', tree.error)
  const unknown = nodes.filter((id) => !tree.nodes.has(id))
  if (unknown.length) return refuse('unknown_node', 'no node named ' + unknown.join(', ') + ' in effort ' + effort)
  const out = append(repo, effort, 'ledger', { kind: 'asked', nodes: [...new Set(nodes)] })
  if (!out.ok) return refuse('append_failed', String(out.error))
  return { ok: true, asked: out.seqs[0], token: answerToken(effort, out.seqs[0]) }
}

/**
 * Record what the user answered to the question `asked` opened: read from the session's transcript,
 * or typed at the console (`answerOf`), and kept as an `answered` line. The same batch recorded
 * again appends nothing; an answer to the question asked again replaces the earlier one.
 */
export async function recordAnswer(repo, effort, asked, { env = process.env, stdinIsTTY = false, ask, ...lookup } = {}) {
  const known = resolveHandle(repo, 'effort', effort)
  if (!known.ok) return known
  const ledger = readLog(repo, effort, 'ledger').entries
  const opened = ledger.find((l) => l.kind === 'asked' && l.seq === asked)
  if (!opened) return refuse('unknown_question', 'no question was opened at ' + asked + ' in effort ' + effort)
  const got = await answerOf({ token: answerToken(effort, asked), env, stdinIsTTY, ask, ...lookup })
  if (!got.ok) return got
  // The same batch read again is the line already kept; a batch asked again is a new answer.
  const at = Number.isInteger(got.at) ? { at: got.at } : {}
  const same = at.at !== undefined && ledger.find((l) => l.kind === 'answered' && l.asked === asked && l.at === at.at &&
    canonical(l.answers) === canonical(got.answers))
  if (same) return { ok: true, answered: same.seq, answers: same.answers, nodes: same.nodes }
  const out = append(repo, effort, 'ledger', { kind: 'answered', asked, nodes: opened.nodes, answers: got.answers, by: got.by, ...at })
  if (!out.ok) return refuse('append_failed', String(out.error))
  return { ok: true, answered: out.seqs[0], answers: got.answers, nodes: opened.nodes }
}

/**
 * Pure. The `answered` lines of `ledger` recorded after `seq`, oldest first: of a question answered
 * more than once, only its latest answer, which replaced the others.
 */
export function answersSince(ledger, seq) {
  const latest = new Map()
  for (const l of ledger) if (l.kind === 'answered' && (!latest.has(l.asked) || l.seq > latest.get(l.asked).seq)) latest.set(l.asked, l)
  return [...latest.values()].filter((l) => (l.seq || 0) > seq).sort((a, b) => a.seq - b.seq)
}

const FLAGS = { '--repo': 'path', '--effort': 'handle', '--node': 'handle', '--asked': 'handle' }

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  runCli(async () => {
    const argv = process.argv.slice(2)
    const bad = handleArgs(argv, FLAGS, { from: 1 })
    if (bad) return { error: bad.message, kind: bad.kind }
    const [command] = argv
    const repo = flagOf(argv, 'repo') || '.'
    const effort = flagOf(argv, 'effort')
    const run = {
      ask: () => openQuestion(repo, effort, { nodes: argv.filter((a, i) => argv[i - 1] === '--node') }),
      record: () => {
        const asked = Number(flagOf(argv, 'asked'))
        return Number.isInteger(asked) && asked > 0
          ? recordAnswer(repo, effort, asked, { stdinIsTTY: process.stdin.isTTY === true, ask: askLine })
          : refuse('bad_arg', '--asked names the seq the question was opened at')
      },
    }[command]
    if (!run) throw new Error('unknown command ' + JSON.stringify(command || '') + ' — expected ask or record')
    return envelope(await run())
  }, { code: (out) => (Object.hasOwn(out, 'payload') ? 0 : 1) })
}
