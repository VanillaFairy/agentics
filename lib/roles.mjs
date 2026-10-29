// lib/roles.mjs — the role table: each role's kind, tools, commands, schemas, tier and system prompt.
//
// Design: docs/DESIGN.md#roles.

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fnv1a } from './plan-digest.mjs'
import { SCHEMAS } from './schemas.mjs'
import { textOf, writeWhole } from './store.mjs'
import { isYardstick } from './tree.mjs'

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))

export const ROLE_NAMES = ['scout', 'historian', 'doc-researcher', 'analyst', 'ruler', 'reviewer', 'auditor',
  'planner', 'implementer', 'test-author', 'investigator']
export const ROLE_KINDS = ['producer', 'searcher', 'judge']

export const roleFile = (name, root = PLUGIN_ROOT) => join(root, 'roles', name + '.md')

const listOf = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean)

/** Pure. One role file's text read into a role, or the reason it cannot be. */
export function parseRole(text, name) {
  const no = (message) => ({ ok: false, error: { kind: 'role_unreadable', message: 'roles/' + name + '.md: ' + message } })
  const lines = textOf(text)
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
/** The models and efforts a tier may name, each weakest first. */
export const MODELS = ['haiku', 'sonnet', 'opus', 'fable']
export const EFFORTS = ['low', 'medium', 'high', 'xhigh']
const INTELLIGENCE = ['low', 'normal', 'max']

/** The context window every tier is planned against, in tokens. */
export const MODEL_WINDOW = 200000
/** The share of the window a call's first read — its system prompt and brief — may take; the rest is its turns. */
const BRIEF_SHARE = 0.5
/**
 * Bytes per token of a first read: the fewest measured over large briefs, each brief's bytes against
 * the tokens its call's first model turn read (`opened`), so an estimate from it errs high.
 */
export const BYTES_PER_TOKEN = 2.2
/** The most a call's first read may hold: in tokens, and in the bytes code checks before a call. */
export const BRIEF_TOKENS = MODEL_WINDOW * BRIEF_SHARE
export const BRIEF_BYTES = Math.floor(BRIEF_TOKENS * BYTES_PER_TOKEN)

/** The dial is set at program entry (docs/DESIGN.md#model-tier); a tier without it is a caller's bug. */
const dialOf = (intelligence, who) => {
  if (intelligence === undefined) throw new Error(who + ' needs the intelligence dial')
  return intelligence
}

const deeper = (effort) => EFFORTS[Math.min(EFFORTS.indexOf(effort) + 1, EFFORTS.length - 1)]

/** Pure. A dispatch's tier from its role and the user's dial (docs/DESIGN.md#model-tier). Throws on an effort outside EFFORTS. */
export function tierFor(role, { intelligence, base = '' } = {}) {
  dialOf(intelligence, 'tierFor')
  const effort = base || role.tier.effort
  if (!EFFORTS.includes(effort)) throw new Error('effort ' + JSON.stringify(effort) + ' for ' + role.name + ' is not one of ' + EFFORTS.join(', '))
  const dial = INTELLIGENCE.includes(intelligence) ? intelligence : 'normal'
  if (!GATES.includes(role.name)) return { model: role.tier.model, effort }
  if (dial !== 'low') return { model: 'opus', effort: dial === 'max' ? 'high' : 'medium' }
  return { model: 'sonnet', effort: deeper(effort) }
}

/**
 * Pure. A leaf producer's tier: the author's `dispatch.producer`, else opus at the role's effort for
 * a yardstick leaf, else the role's own tier; then the dial as a ceiling, `low` capping the model at
 * sonnet and `max` one effort step deeper (docs/DESIGN.md#model-tier).
 */
export function producerTier(leaf, role, { intelligence } = {}) {
  dialOf(intelligence, 'producerTier')
  const given = (leaf.dispatch && leaf.dispatch.producer) || (isYardstick(leaf) ? { model: 'opus', effort: role.tier.effort } : role.tier)
  const capped = intelligence === 'low' && MODELS.indexOf(given.model) > MODELS.indexOf('sonnet') ? 'sonnet' : given.model
  return { model: capped, effort: intelligence === 'max' ? deeper(given.effort) : given.effort }
}

/** Pure. A leaf reviewer's tier: the author's `dispatch.reviewer` as given, else `tierFor` under the dial. */
export function reviewerTier(leaf, role, { intelligence } = {}) {
  dialOf(intelligence, 'reviewerTier')
  const given = leaf.dispatch && leaf.dispatch.reviewer
  return given ? { model: given.model, effort: given.effort } : tierFor(role, { intelligence })
}

/** Pure. The tier one raise above `tier`, past the dial: haiku to sonnet, sonnet to opus at medium, else one effort step deeper. */
export function raiseTier({ model, effort }) {
  if (model === 'haiku') return { model: 'sonnet', effort }
  if (model === 'sonnet') return { model: 'opus', effort: 'medium' }
  return { model, effort: deeper(effort) }
}

/**
 * Pure. The commands a role may run in a repository whose established commands are `commands`
 * (`{build, typecheck, suite, suite_fast, test_one}`, each a string or absent): `<build>`,
 * `<typecheck>` and `<test>` replaced by them, each cut before `{file}`, an empty one dropped; an
 * implementer also runs its leaf's criterion checks and the project commands its entry `runs`.
 */
export function roleCommands(role, commands, leaf = null) {
  const PLACEHOLDERS = { '<build>': ['build'], '<typecheck>': ['typecheck'], '<test>': ['suite', 'suite_fast', 'test_one'] }
  const established = (name) => String(commands[name] || '').split('{file}')[0].trim()
  const out = role.commands.flatMap((c) => (PLACEHOLDERS[c] ? PLACEHOLDERS[c].map(established) : [c])).filter(Boolean)
  if (role.name !== 'implementer' || !leaf) return out
  return [...out, ...leaf.acceptance.map((a) => a.check.trim()).filter(Boolean), ...(leaf.runs || [])]
}

/**
 * Write a role's system prompt — its body, frontmatter dropped, then the dispatch's charge when it
 * has one — under dir once; its absolute path. The name carries the content's digest, so a file
 * found there already holds this prompt; it is renamed into place whole, so a cut-off write never
 * leaves a partial prompt under that name.
 */
export function promptFile(role, dir, charge = '') {
  const content = charge ? role.prompt + '\n\n' + charge : role.prompt
  const path = resolve(dir, 'roles', role.name + '-' + fnv1a(content) + '.md')
  if (existsSync(path)) return path
  writeWhole(path, content)
  return path
}
