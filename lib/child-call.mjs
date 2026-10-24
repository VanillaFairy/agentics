// lib/child-call.mjs — a synchronous lib function run in an awaited child process, so the caller's
// event loop (the run's heartbeat, every live call's stream) keeps turning while the function spawns
// git one call after another.
//
// Design: docs/DESIGN.md#the-process-model.

import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF = fileURLToPath(import.meta.url)

/**
 * Call `name` of the lib module `module` (a path relative to `lib/`) with `args` in a child and await
 * its value. Arguments and value cross as JSON. Resolves `{ok: true, value}` or `{ok: false, error}`;
 * never rejects.
 */
export function childCall(module, name, args) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let proc
    try {
      proc = spawn(process.execPath, [SELF], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      resolve({ ok: false, error: 'the child could not be started: ' + e.message })
      return
    }
    proc.stdout.setEncoding('utf8').on('data', (d) => { out += d })
    proc.stderr.setEncoding('utf8').on('data', (d) => { err += d })
    proc.on('error', (e) => resolve({ ok: false, error: 'the child could not be started: ' + e.message }))
    proc.on('close', (code) => {
      let said = null
      try { said = JSON.parse(out.trim().split('\n').pop() || 'null') } catch { said = null }
      if (code === 0 && said && said.ok === true) return resolve({ ok: true, value: said.value })
      resolve({ ok: false, error: (said && said.error) || name + ' exited ' + code + ': ' + (out + err).trim().split('\n').slice(-5).join('\n') })
    })
    proc.stdin.on('error', () => {}) // a child that died first closes its input; `close` reports it
    proc.stdin.end(JSON.stringify({ module, name, args }))
  })
}

const isMain = import.meta.main ?? (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  let input = ''
  process.stdin.setEncoding('utf8').on('data', (d) => { input += d })
  process.stdin.on('end', async () => {
    try {
      const { module, name, args } = JSON.parse(input)
      const mod = await import(new URL(String(module), import.meta.url).href)
      if (typeof mod[name] !== 'function') throw new Error(module + ' exports no function ' + name)
      const value = await mod[name](...(Array.isArray(args) ? args : []))
      process.stdout.write(JSON.stringify({ ok: true, value: value === undefined ? null : value }) + '\n')
      process.exit(0)
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n')
      process.exit(1)
    }
  })
}
