// tools/migrate-effort-titles.mjs — the one-shot that gives each effort opened before efforts had a
// title the title a person picks it by, run once after upgrading, on the user's go.
//
// Design: docs/DESIGN.md#migrations.
//
// A title is judgment, so the session writes it: `--titles <file>` is a JSON object mapping each
// effort's name to `{title, about?}`, where `about`, when given, replaces a description that was the
// request pasted. The tool lists every effort under `.agentics/` whose `effort.json` has no title
// (`untitled`) and which of them the file covers; with `--yes` it writes each covered one, keeping
// every other field. An entry whose title is blank or past 80 characters is listed in `refused` and
// not written. A second run changes nothing.
//
// A frozen copy: the identity file's path and fields are spelled here as they were, and it imports
// from lib/ only `mainCheckout`.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { mainCheckout } from '../lib/store.mjs'

const TITLE_MAX = 80

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const identityOf = (store, effort) => join(store, effort, '.state', 'effort.json')

/** What the migration would do in `repo` with `titles`, and with `write` what it did. */
export function plan(repo, titles, { write = false } = {}) {
  const store = join(mainCheckout(resolve(repo)), '.agentics')
  const efforts = existsSync(store)
    ? readdirSync(store, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort()
    : []
  const untitled = []
  const written = []
  const refused = []
  for (const effort of efforts) {
    const file = identityOf(store, effort)
    const held = readJson(file)
    if (!held || (typeof held.title === 'string' && held.title !== '')) continue
    untitled.push(effort)
    const entry = titles[effort]
    if (!entry) continue
    const title = String(entry.title || '').replace(/\s+/g, ' ').trim()
    if (title === '' || title.length > TITLE_MAX) {
      refused.push({ effort, why: title === '' ? 'blank title' : 'title past ' + TITLE_MAX + ' characters' })
      continue
    }
    const about = typeof entry.about === 'string' && entry.about.trim() !== '' ? entry.about.trim() : held.about
    if (write) writeFileSync(file, JSON.stringify({ ...held, title, about }, null, 2) + '\n', 'utf8')
    written.push(effort)
  }
  return { untitled, [write ? 'written' : 'would_write']: written, refused }
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  const argv = process.argv.slice(2)
  const value = (flag) => (argv.indexOf(flag) >= 0 ? argv[argv.indexOf(flag) + 1] : undefined)
  const repo = value('--repo') || '.'
  const titlesFile = value('--titles')
  const titles = titlesFile ? readJson(titlesFile) : {}
  if (titles === null || typeof titles !== 'object' || Array.isArray(titles)) {
    console.error('--titles must name a JSON object of {"<effort>": {"title": "...", "about": "..."}}')
    process.exit(1)
  }
  console.log(JSON.stringify(plan(repo, titles, { write: argv.includes('--yes') }), null, 2))
}
