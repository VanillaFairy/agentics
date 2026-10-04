// lib/roles.mjs — the role table: each role's kind, tools, commands, schemas, tier and system prompt.
//
// Design: docs/DESIGN.md#roles.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fnv1a } from './plan-digest.mjs'
import { SCHEMAS } from './schemas.mjs'
import { mkdirState } from './store.mjs'

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))

export const ROLE_NAMES = ['scout', 'historian', 'doc-researcher', 'analyst', 'ruler', 'reviewer', 'auditor',
  'planner', 'implementer', 'test-author', 'investigator']
export const ROLE_KINDS = ['producer', 'searcher', 'judge']

export const roleFile = (name, root = PLUGIN_ROOT) => join(root, 'roles', name + '.md')

const listOf = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean)

/** Pure. One role file's text read into a role, or the reason it cannot be. */
export function parseRole(text, name) {
  const no = (message) => ({ ok: false, error: { kind: 'role_unreadable', message: 'roles/' + name + '.md: ' + message } })
  const lines = String(text).replace(/\r\n/g, '\n')
  const m = lines.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return no('no frontmatter')
  const fields = Object.fromEntries(m[1].split('\n').map((l) => l.match(/^([a-z]+):\s*(.*)$/)).filter(Boolean).map((x) => [x[1], x[2].trim()]))
  if (fields.name !== name) return no('names itself ' + JSON.stringify(fields.name || ''))
  if (!ROLE_KINDS.includes(fields.kind)) return no('kind ' + JSON.stringify(fields.kind || '') + ' is not one of ' + ROLE_KINDS.join(', '))
  const tools = listOf(fields.tools)
  if (tools.length === 0) return no('no tools')
  const schemas = listOf(fields.schemas)
  if (schemas.length === 0) return no('no schemas')
  const unknown = schemas.find((s) => !Object.hasOwn(SCHEMAS, s))
  if (unknown) return no('schema ' + JSON.stringify(unknown) + ' is not in lib/schemas.mjs')
  if (!fields.model) return no('no model')
  const prompt = m[2].trim()
  if (prompt === '') return no('an empty prompt')
  return {
    ok: true,
    role: { name, kind: fields.kind, tools, commands: listOf(fields.commands), schemas, tier: { model: fields.model, effort: fields.effort || '' }, prompt },
  }
}

/** Read roles/<name>.md under `root`. */
export function loadRole(name, { root = PLUGIN_ROOT } = {}) {
  let text
  try {
    text = readFileSync(roleFile(name, root), 'utf8')
  } catch {
    return { ok: false, error: { kind: 'role_unreadable', message: 'roles/' + name + '.md cannot be read' } }
  }
  return parseRole(text, name)
}

/** The gates: the roles that run the stronger model whatever their kind (docs/DESIGN.md#model-tier). */
export const GATES = ['analyst', 'ruler', 'reviewer', 'auditor', 'planner']
const EFFORTS = ['low', 'medium', 'high', 'xhigh']
const INTELLIGENCE = ['low', 'normal', 'max']

/** Pure. A dispatch's tier from its role and the user's dial (docs/DESIGN.md#model-tier). */
export function tierFor(role, { intelligence = 'normal', base = '' } = {}) {
  const dial = INTELLIGENCE.includes(intelligence) ? intelligence : 'normal'
  if (!GATES.includes(role.name)) return { model: role.tier.model, effort: base || role.tier.effort }
  if (dial !== 'low') return { model: 'opus', effort: dial === 'max' ? 'high' : 'medium' }
  const from = Math.max(EFFORTS.indexOf(base || role.tier.effort), 0)
  return { model: 'sonnet', effort: EFFORTS[Math.min(from + 1, EFFORTS.length - 1)] }
}

/**
 * Write a role's system prompt — its body, frontmatter dropped — under dir once; its absolute path.
 * The name carries the prompt's digest, so a file found there already holds this prompt; it is
 * renamed into place whole, so a cut-off write never leaves a partial prompt under that name.
 */
export function promptFile(role, dir) {
  const path = resolve(dir, 'roles', role.name + '-' + fnv1a(role.prompt) + '.md')
  if (existsSync(path)) return path
  mkdirState(dirname(path))
  const staged = path + '.' + process.pid + '.tmp'
  writeFileSync(staged, role.prompt, 'utf8')
  renameSync(staged, path)
  return path
}
