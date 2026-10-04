// lib/host.mjs — everything that knows the host CLI's layout: where the CLI is, where a session's
// transcript lives, what the user answered, and whether an act of the user's was confirmed.
//
// Design: docs/DESIGN.md#the-users-word.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

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

/** The base name of a live pid's executable, or '' when the pid is gone or the listing fails. */
function imageOf(pid) {
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    const row = r.status === 0 ? String(r.stdout).match(/^"([^"]*)","(\d+)"/m) : null
    return row && Number(row[2]) === pid ? row[1] : ''
  }
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' })
  return r.status === 0 ? String(r.stdout).trim() : ''
}

/**
 * A process port over the host CLI: alive and kill only for a pid whose image is `cli`'s executable.
 * `list(pid)` names a pid's executable, '' when it is gone. A pid the system reused for another
 * program reads as not alive, so it is never killed.
 */
export function hostProcess(cli, { list = imageOf } = {}) {
  const want = imageName(cli)
  const alive = (pid) => Number.isInteger(pid) && pid > 0 && want !== '' && imageName(list(pid)) === want
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

/** Pure. Every AskUserQuestion answer a transcript's text records, oldest first. */
export function answersIn(text) {
  const out = []
  for (const line of String(text).split(/\r?\n/)) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const result = entry && entry.toolUseResult
    const answers = result && result.questions && result.answers
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) continue
    for (const [question, answer] of Object.entries(answers)) out.push({ question, answer: String(answer) })
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

/** Whether the user's latest answer to a question containing `token` chose `option`. */
export function verifyAnswer({ token, option, env = process.env, read = readFileSync, list, isFile } = {}) {
  const session = env.CLAUDE_CODE_SESSION_ID
  if (!session) return refuse('answer_unverifiable', 'no CLAUDE_CODE_SESSION_ID: this call was not made from a session')
  const file = transcriptOf(session, { env, list, isFile })
  if (!file) return refuse('answer_unverifiable', 'the transcript of session ' + session + ' cannot be found')
  let text
  try {
    text = read(file, 'utf8')
  } catch (err) {
    return refuse('answer_unverifiable', 'the transcript cannot be read: ' + err.message)
  }
  const asked = answersIn(text).filter((a) => holdsToken(a.question, token))
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

/** The one entry an act calls. */
export async function confirmAct({ token, option, env = process.env, stdinIsTTY = false, ask, ...lookup } = {}) {
  const actor = actorOf({ env, stdinIsTTY })
  if (actor === 'session') return verifyAnswer({ token, option, env, ...lookup })
  if (actor === 'terminal') return terminalAct({ token, ask })
  return refuse('answer_unverifiable', 'not a session and not an interactive console: nobody can confirm ' + token)
}
