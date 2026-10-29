// tools/rules/role-frontmatter.mjs — a role file's frontmatter, judged when it is committed.
//
// Design: docs/DESIGN.md#roles and docs/DESIGN.md#self-checks. `lib/roles.mjs` refuses a bad role
// file when a dispatch loads it; this rule refuses it at commit, so a typo never waits for the
// first run that needs the role. It reads the frontmatter as the loader does — flat `key: value`
// lines between a leading `---` and the next — and judges each value against the tables the loader
// and the tiers use: `ROLE_NAMES`, `ROLE_KINDS`, `MODELS` and `EFFORTS` in lib/roles.mjs, and the
// schemas lib/schemas.mjs exports.

import { EFFORTS, MODELS, ROLE_KINDS, ROLE_NAMES } from '../../lib/roles.mjs'
import { SCHEMAS } from '../../lib/schemas.mjs'

export const id = 'role-frontmatter'

export const applies = /^roles\/[^/]+\.md$/

/** The keys the loader reads; `commands` alone may be left out. */
const KEYS = ['name', 'kind', 'tools', 'commands', 'schemas', 'model', 'effort']
const REQUIRED = KEYS.filter((k) => k !== 'commands')

const listOf = (value) => value.split(',').map((s) => s.trim()).filter(Boolean)

/** Pure. Each frontmatter key with its value and 1-based line, or null when no block opens and closes. */
function frontmatter(source) {
  const lines = source.split('\n')
  if (lines[0] !== '---') return null
  const end = lines.indexOf('---', 1)
  if (end === -1) return null
  const fields = new Map()
  for (let i = 1; i < end; i++) {
    const m = lines[i].match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (m) fields.set(m[1], { value: m[2].trim(), line: i + 1 })
  }
  return fields
}

export function check(source, filePath) {
  const fields = frontmatter(source)
  if (!fields) return [{ line: 0, message: 'no frontmatter block: a role file opens with `---`, its keys, and `---`' }]
  const out = []
  const value = (key) => (fields.has(key) ? fields.get(key).value : '')
  const flag = (key, message) => out.push({ line: fields.has(key) ? fields.get(key).line : 0, message })

  for (const key of fields.keys()) {
    if (!KEYS.includes(key)) flag(key, 'unknown key `' + key + '`: the loader reads only ' + KEYS.join(', '))
  }
  for (const key of REQUIRED) {
    if (value(key) === '') flag(key, 'no `' + key + '`: lib/roles.mjs refuses a role without it')
  }

  const stem = filePath.split('/').pop().replace(/\.md$/, '')
  if (value('name') !== '' && value('name') !== stem) {
    flag('name', 'name `' + value('name') + '` is not the file name `' + stem + '`: the runner loads a role by its file name')
  }
  if (!ROLE_NAMES.includes(stem)) {
    flag('name', '`' + stem + '` is no role in ROLE_NAMES (lib/roles.mjs), so no dispatch can load this file')
  }
  if (value('kind') !== '' && !ROLE_KINDS.includes(value('kind'))) {
    flag('kind', 'kind `' + value('kind') + '` is not one of ' + ROLE_KINDS.join(', '))
  }
  for (const schema of listOf(value('schemas'))) {
    if (!Object.hasOwn(SCHEMAS, schema)) flag('schemas', 'schema `' + schema + '` is not exported by lib/schemas.mjs')
  }
  if (value('model') !== '' && !MODELS.includes(value('model'))) {
    flag('model', 'model `' + value('model') + '` is not one of ' + MODELS.join(', '))
  }
  if (value('effort') !== '' && !EFFORTS.includes(value('effort'))) {
    flag('effort', 'effort `' + value('effort') + '` is not one of ' + EFFORTS.join(', '))
  }
  if (listOf(value('commands')).length > 0 && !listOf(value('tools')).includes('Bash')) {
    flag('commands', 'commands without Bash among the tools: a role runs a command only through Bash')
  }
  return out
}
