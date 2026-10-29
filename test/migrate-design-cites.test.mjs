// test/migrate-design-cites.test.mjs — tools/migrate-design-cites.mjs: the one-shot declaration of
// each task's Design citations as `cites:`, on specs written the way the prose reader read them.
//
// What is pinned here:
//
//   declare   `cites:` is written only where the old reader found an explicit citation; a task whose
//             only "Design" opens a sentence is listed and left; a declaration that would hand its
//             brief other text is refused; code says whether every brief stays the same
//   migrate   a dry run writes nothing; `--yes` writes, and carries a signature only over a spec
//             whose briefs code proved unchanged; a second run writes nothing
//
// Design: docs/DESIGN.md#migrations.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { approvalState } from '../lib/approval.mjs'
import { append, readLog } from '../lib/ledger.mjs'
import { compileEffort } from '../lib/compile.mjs'
import { citedDesign, designCitedBy, hashSpec, parseSpec } from '../lib/spec.mjs'
import { specPath } from '../lib/store.mjs'
import { declare, migrate, oldCited } from '../tools/migrate-design-cites.mjs'

const task = (name, title, context = '') => ['- **' + name + '** — task · realises: D1 · rigor: trivial', '  · expects: src/' + name + '.ts',
  '  ' + title, ...(context ? ['  ' + context] : []), '  - [ ] it builds — check: `tsc`']
const spec = (tasks, design = ['### Ports (`ports.ts`)', '', 'interface Den {}', '', '### Save', '', 'One file, one folder per area.']) => [
  '# Ports', '', '## Intent', '', 'Ports.', '', '## Decisions', '', '| id | decision | why |', '|---|---|---|',
  '| D1 | Ports are typed. | Callers check. |', '', '## Design', '', ...design, '', '## Plan', '', ...tasks.flat(), '',
  '## Open questions', '', '## Evidence', '',
].join('\n')

const NAMED = task('named', 'Bring the ports in', 'Match the Design\'s "Ports" block.')
const WHOLE = task('whole', 'Declare the ports', 'Declare them as this spec\'s Design states.')
const INSIDE = task('inside', 'Keep the areas', 'Keep the Design\'s "one folder per area" rule.')
const PLAIN = task('plain', 'Write the docs', 'Nothing cited.')
const IMPERATIVE = task('imperative', 'Design the save format', 'It is new. Design it small.')

/** What each task's brief carries of the Design, by entry, from a spec's text. */
const briefs = (text) => {
  const s = parseSpec(text)
  return Object.fromEntries(s.entries.map((e) => [e.name, citedDesign(s, e).parts.map((p) => [p.heading, p.text])]))
}
const oldBriefs = (text) => {
  const s = parseSpec(text)
  return Object.fromEntries(s.entries.map((e) => [e.name, oldCited(s, e).parts.map((p) => [p.heading, p.text])]))
}

test('cites is written where the old reader found an explicit citation, and every brief stays the same', () => {
  const text = spec([NAMED, WHOLE, INSIDE, PLAIN])
  const d = declare(text)
  assert.deepEqual(d.written, [
    { entry: 'named', cites: '"Ports (`ports.ts`)"' }, { entry: 'whole', cites: 'Design' }, { entry: 'inside', cites: 'Design' }])
  assert.deepEqual([d.initial, d.refused, d.unchanged], [[], [], true])
  assert.deepEqual(parseSpec(d.next).problems, [])
  assert.deepEqual(briefs(d.next), oldBriefs(text), 'each brief carries what it carried')
  assert.equal(d.next.split('\n').length, text.split('\n').length + 3, 'one line per declaration, nothing else')
  const again = declare(d.next)
  assert.deepEqual([again.written, again.unchanged, again.next], [[], true, d.next], 'a second run finds nothing to do')
  assert.ok(!declare(text.replace(/\n/g, '\r\n')).next.replace(/\r\n/g, '').includes('\n'), 'the endings it found')
})

test('a task whose only "Design" opens a sentence keeps the whole Design it had, listed for the user to trim', () => {
  const text = spec([NAMED, IMPERATIVE])
  const d = declare(text)
  assert.deepEqual(d.written, [{ entry: 'named', cites: '"Ports (`ports.ts`)"' }, { entry: 'imperative', cites: 'Design' }])
  assert.deepEqual(d.initial, [{ entry: 'imperative', line: parseSpec(d.next).entries.find((e) => e.name === 'imperative').line }])
  assert.equal(d.unchanged, true, 'a migration widens, never narrows')
  assert.deepEqual(briefs(d.next), oldBriefs(text))
  const mid = declare(spec([task('mid', 'Design the save format', 'Store it as the Design says.')]))
  assert.deepEqual(mid.written, [{ entry: 'mid', cites: 'Design' }], 'one "Design" inside a sentence is a citation')
})

test('a declaration that would hand its brief other text is refused, and not written', () => {
  const text = spec([NAMED], ['### Ports', '', 'interface Den {}', '', '# Aside', '', 'Read by the old part, not by the new one.'])
  const d = declare(text)
  assert.deepEqual(d.written, [])
  assert.match(d.refused[0].why, /would not hand its brief the Design text it had/)
  assert.equal(d.next, text)
})

test('a store is migrated once: dry run writes nothing, --yes declares and carries only a proven signature', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-migrate-cites-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const put = (folder, text) => {
    mkdirSync(dirname(specPath(repo, 'e1', folder)), { recursive: true })
    writeFileSync(specPath(repo, 'e1', folder), text)
    assert.equal(append(repo, 'e1', 'ledger', [{ kind: 'approved', folder, hash: hashSpec(text), decisions: parseSpec(text).decisions.map(({ id, text: t }) => ({ id, text: t })), by: 'user' }]).ok, true)
  }
  const proven = spec([WHOLE, PLAIN, IMPERATIVE])
  const lossy = spec([WHOLE, NAMED], ['### Ports', '', 'interface Den {}', '', '# Aside', '', 'Read by the old part, not by the new one.']).replace('# Ports', '# Lossy')
  put('.', proven)
  put('lossy', lossy)
  const pre = compileEffort(repo, 'e1')
  assert.equal(pre.ok, true, 'compiled before the upgrade: ' + JSON.stringify(pre.problems))
  const dry = migrate(repo)
  assert.deepEqual(dry.specs.map((s) => s.folder), ['.', 'lossy'])
  assert.equal(readFileSync(specPath(repo, 'e1', '.'), 'utf8'), proven, 'a dry run writes nothing')
  assert.deepEqual(dry.compiled, [], 'nor compiles')
  const ledger = readLog(repo, 'e1', 'ledger').entries

  const done = migrate(repo, { yes: true })
  assert.deepEqual(done.carried.map((c) => c.folder), ['.'])
  assert.deepEqual(done.uncarried.map((c) => c.folder), ['lossy'])
  assert.deepEqual(done.initial.map((x) => x.entry), ['imperative'])
  assert.equal(approvalState(repo, 'e1', '.').state, 'approved', 'its signature stands at the new hash')
  const carried = readLog(repo, 'e1', 'ledger').entries.find((l) => l.seq > ledger.at(-1).seq && l.kind === 'approved')
  assert.deepEqual([carried.folder, carried.carried_from, carried.hash], ['.', hashSpec(proven), hashSpec(readFileSync(specPath(repo, 'e1', '.'), 'utf8'))])
  assert.notEqual(approvalState(repo, 'e1', 'lossy').state, 'approved', 'a brief that changes is the user\'s to approve again')
  assert.deepEqual(done.compiled, [{ effort: 'e1', ok: true, problems: [] }])
  const design = parseSpec(proven).sections.Design.body.trim()
  for (const id of ['whole', 'imperative']) {
    assert.deepEqual(designCitedBy(repo, 'e1', id).parts.map((p) => p.text), [design], id + '\'s brief carries the Design it had, from the copy compile keeps')
  }

  const again = migrate(repo, { yes: true })
  assert.deepEqual([again.specs, again.carried], [[], []], 'a second run writes nothing')
})
