// lib/host.mjs — everything that knows the host CLI and its session: where the CLI is, which
// running process is it (`hostProcess`, so a pid the system reused is never taken for it), where a
// session's transcript lives, what the user answered, whether an act of the user's was confirmed,
// and the one line a console asks for (`askLine`).
//
// Design: docs/DESIGN.md#the-users-word.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const refuse = (kind, message) => ({ ok: false, error: { kind, message } })

/** The host CLI: config.claude_cli, else `claude` (claude.exe on Windows) on PATH. */
export function resolveCli({ config = {}, env = process.env, isFile = existsSync } = {}) {
  if (config.claude_cli) {
    return isFile(config.claude_cli) ? { ok: true, path: config.claude_cli }
      : refuse('host_missing', 'claude_cli names ' + config.claude_cli + ', which does not exist')
  }
  const dirs = String(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const name of ['claude.exe', 'claude']) if (isFile(join(dir, name))) return { ok: true, path: join(dir, name) }
  }
  return refuse('host_missing', 'no claude CLI on the PATH, and .agentics/config.json names none in claude_cli')
}

/** Pure. An executable as a process listing names it: its base name, lower case, without `.exe`. */
const imageName = (path) => String(path || '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '')

/**
 * A live pid's executable and command line, `{image, args}` (`args` '' when it cannot be read), or
 * null when the pid is gone or the listing fails. `pid` is a positive integer: `hostProcess` checks
 * it before listing, so it is safe inside the PowerShell query.
 */
function processOf(pid) {
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    const row = r.status === 0 ? String(r.stdout).match(/^"([^"]*)","(\d+)"/m) : null
    if (!row || Number(row[2]) !== pid) return null
    const query = "(Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "').CommandLine"
    const c = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', windowsHide: true })
    return { image: row[1], args: c.status === 0 ? String(c.stdout).trim() : '' }
  }
  const ps = (field) => spawnSync('ps', ['-p', String(pid), '-o', field + '='], { encoding: 'utf8' })
  const comm = ps('comm')
  const image = comm.status === 0 ? String(comm.stdout).trim() : ''
  if (image === '') return null
  const args = ps('args')
  return { image, args: args.status === 0 ? String(args.stdout).trim() : '' }
}

const EDGES = new Set([undefined, ' ', '"', "'"])

/** Pure. Whether the command line `args` names `path` whole: bounded by its ends, a space or a quote. */
function namesPath(args, path) {
  for (let at = args.indexOf(path); at !== -1; at = args.indexOf(path, at + 1)) {
    if (EDGES.has(args[at - 1]) && EDGES.has(args[at + path.length])) return true
  }
  return false
}

/**
 * Whether `pid` is a node process running a `run.mjs`: a run's process, not a program the system
 * gave the pid to since. `list(pid)` gives a pid's `{image, args}`, null when it is gone.
 */
export function runProcess(pid, { list = processOf } = {}) {
  const p = Number.isInteger(pid) && pid > 0 ? list(pid) : null
  return Boolean(p) && imageName(p.image) === 'node' && /(^|[\s"'\\/])run\.mjs($|[\s"'])/.test(String(p.args || ''))
}

/**
 * A process port over the host CLI: alive and kill only for a pid that runs `cli` — its image is
 * `cli`'s executable, or its image is node and its command line names `cli` or `cli`'s real path
 * (a CLI that is a node script). `list(pid)` gives a pid's `{image, args}`, null when it is gone;
 * `realpath(cli)` may throw, and then `cli` alone is looked for. A pid the system reused for
 * another program reads as not alive, so it is never killed.
 */
export function hostProcess(cli, { list = processOf, realpath = realpathSync } = {}) {
  const want = imageName(cli)
  const paths = [String(cli || '')]
  try {
    paths.push(realpath(cli))
  } catch {
    // a CLI path that does not resolve is looked for as it is
  }
  const runsCli = (p) => Boolean(p) && (imageName(p.image) === want ||
    (imageName(p.image) === 'node' && paths.some((path) => namesPath(String(p.args || ''), path))))
  const alive = (pid) => Number.isInteger(pid) && pid > 0 && want !== '' && runsCli(list(pid))
  return {
    alive,
    kill(pid) {
      if (!alive(pid)) return
      try {
        process.kill(pid)
      } catch {
        // it ended between the check and the kill
      }
    },
  }
}

/** Pure. The folder of the host's per-project transcript folders. */
export const projectsDir = (env = process.env) => join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')

/** The transcript file of `sessionId`, or '' when the host holds none. */
export function transcriptOf(sessionId, { env = process.env, list = readdirSync, isFile = existsSync } = {}) {
  if (!UUID.test(String(sessionId || ''))) return ''
  const root = projectsDir(env)
  let folders
  try {
    folders = list(root)
  } catch {
    return ''
  }
  for (const folder of folders) {
    const file = join(root, folder, sessionId + '.jsonl')
    if (isFile(file)) return file
  }
  return ''
}

export const sessionExists = (sessionId, opts) => transcriptOf(sessionId, opts) !== ''

/** When the host last wrote `sessionId`'s transcript, in ms; 0 when it holds none. */
export function transcriptWrittenAt(sessionId, opts) {
  const file = transcriptOf(sessionId, opts)
  if (!file) return 0
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** Pure. Every AskUserQuestion answer a transcript's text records, oldest first; `at` numbers the line that holds it. */
export function answersIn(text) {
  const out = []
  for (const [at, line] of String(text).split(/\r?\n/).entries()) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const result = entry && entry.toolUseResult
    const answers = result && result.questions && result.answers
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) continue
    for (const [question, answer] of Object.entries(answers)) out.push({ question, answer: String(answer), at })
  }
  return out
}

/** Pure. Whether `text` holds `token` whole: followed by the end of the text or a character outside [0-9A-Za-z#]. */
function holdsToken(text, token) {
  for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + 1)) {
    if (!/[0-9A-Za-z#]/.test(text.charAt(at + token.length))) return true
  }
  return false
}

/** The answers the session's transcript records, or the refusal when there is none to read. */
function sessionAnswers({ env, read, list, isFile }) {
  const session = env.CLAUDE_CODE_SESSION_ID
  if (!session) return refuse('answer_unverifiable', 'no CLAUDE_CODE_SESSION_ID: this call was not made from a session')
  const file = transcriptOf(session, { env, list, isFile })
  if (!file) return refuse('answer_unverifiable', 'the transcript of session ' + session + ' cannot be found')
  try {
    return { ok: true, answers: answersIn(read(file, 'utf8')) }
  } catch (err) {
    return refuse('answer_unverifiable', 'the transcript cannot be read: ' + err.message)
  }
}

/**
 * What the user answered, in their own words, to the latest question naming `token`: every
 * question of that one AskUserQuestion result that holds the token, with its answer.
 */
export function answerTo({ token, env = process.env, read = readFileSync, list, isFile } = {}) {
  const got = sessionAnswers({ env, read, list, isFile })
  if (!got.ok) return got
  const asked = got.answers.filter((a) => holdsToken(a.question, token))
  if (asked.length === 0) return refuse('not_answered', 'the user was never asked a question naming ' + token)
  const at = asked[asked.length - 1].at
  return { ok: true, by: 'user', at, answers: asked.filter((a) => a.at === at).map(({ question, answer }) => ({ question, answer })) }
}

/** Whether the user's latest answer to a question containing `token` chose `option`. */
export function verifyAnswer({ token, option, env = process.env, read = readFileSync, list, isFile } = {}) {
  const got = sessionAnswers({ env, read, list, isFile })
  if (!got.ok) return got
  const asked = got.answers.filter((a) => holdsToken(a.question, token))
  if (asked.length === 0) return refuse('not_approved', 'the user was never asked a question naming ' + token)
  const latest = asked[asked.length - 1]
  return latest.answer === option ? { ok: true, by: 'user' }
    : refuse('not_approved', 'the user answered ' + JSON.stringify(latest.answer) + ' to the question naming ' + token)
}

/** Pure. Where an act's call comes from. */
export const actorOf = ({ env = process.env, stdinIsTTY = false } = {}) =>
  env.CLAUDE_CODE_SESSION_ID ? 'session' : stdinIsTTY ? 'terminal' : 'none'

/** At a terminal: the user types the token back. */
export async function terminalAct({ token, ask }) {
  const typed = String(await ask('Type ' + token + ' to confirm: ')).trim()
  return typed === token ? { ok: true, by: 'terminal' } : refuse('not_approved', 'the token typed back was not ' + token)
}

/** At a terminal: the user types their answer to the question the token names. */
export async function terminalAnswer({ token, ask }) {
  const typed = String(await ask('Your answer to ' + token + ': ')).trim()
  return typed ? { ok: true, by: 'terminal', answers: [{ question: token, answer: typed }] }
    : refuse('not_answered', 'nothing was typed in answer to ' + token)
}

/** The one entry recording an answer calls: the session's transcript, or a line typed at a console. */
export async function answerOf({ token, env = process.env, stdinIsTTY = false, ask, ...lookup } = {}) {
  if (!token) return refuse('no_token', 'there is no question to read the answer to: its token is empty')
  const actor = actorOf({ env, stdinIsTTY })
  if (actor === 'session') return answerTo({ token, env, ...lookup })
  if (actor === 'terminal') return terminalAnswer({ token, ask })
  return refuse('answer_unverifiable', 'not a session and not an interactive console: nobody can answer ' + token)
}

/** The one entry an act calls. An empty token names no act, and every question would hold it. */
export async function confirmAct({ token, option, env = process.env, stdinIsTTY = false, ask, ...lookup } = {}) {
  if (!token) return refuse('no_token', 'there is no act to confirm: its token is empty')
  const actor = actorOf({ env, stdinIsTTY })
  if (actor === 'session') return verifyAnswer({ token, option, env, ...lookup })
  if (actor === 'terminal') return terminalAct({ token, ask })
  return refuse('answer_unverifiable', 'not a session and not an interactive console: nobody can confirm ' + token)
}

/**
 * At a console: the prompt on stderr, one line read from stdin. The `ask` an act's CLI hands
 * `confirmAct`. Input that ends before a line answers '', which confirms nothing.
 */
export const askLine = (prompt) => new Promise((answer) => {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false })
  rl.on('close', () => answer(''))
  rl.question(prompt, (line) => {
    answer(line)
    rl.close()
  })
})
