// test/leaf-brief.test.mjs — pins a leaf round's thread brief: its sections in order, a digest per
// section, the same text from the same records, and nothing in it that moves from round to round.
//
// Design: docs/DESIGN.md#briefs-and-returns.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { leafBrief, measuresFor } from '../lib/brief.mjs'
import { oversizedPart, sectionsOf as partsOf } from '../lib/briefs/size.mjs'
import { PART_BYTES } from '../lib/roles.mjs'
import { recordItems } from '../lib/evidence.mjs'
import { writeGotcha } from '../lib/gotchas.mjs'
import { fnv1a } from '../lib/plan-digest.mjs'
import { append } from '../lib/ledger.mjs'
import { hashSpec } from '../lib/spec.mjs'
import { branchOf, configPath, specCopyPath } from '../lib/store.mjs'
import { normalizeNode, readTree } from '../lib/tree.mjs'
import { seedTree } from './harness/seed-tree.mjs'

const E = 'e1'
const HEADINGS = ['Task', 'Acceptance criteria', 'Decisions realised', 'Expected files and reads', 'Evidence', 'Gotchas',
  'Measures', 'Commands', 'Worktree', 'Repository guidance']

/** A repository with a seeded effort, its guidance files, and a red → green cycle beside a plain leaf. */
function effort(t, files = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-leaf-brief-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  const added = seedTree(repo, E, [
    { id: '.', kind: 'composite', title: 'Parse configs', intent: 'configs load from disk',
      defines: [{ id: 'D1', text: 'Keys are case-insensitive.' }, { id: 'D2', text: 'Unknown keys are an error.' }] },
    { id: 'parse', kind: 'leaf', title: 'Parse keys', intent: 'keys parse case-insensitively', rigor: 'tdd',
      expects: ['src/api/parse.js', 'test/parse.test.mjs'], reads: ['src/api/types.js'], decisions: ['D1'],
      acceptance: [{ text: 'Key lookup ignores case', check: 'node --test test/parse.test.mjs', decisions: ['D1'] }],
      context: 'Use the existing tokenizer.', ground: ['src/api'] },
    { id: 'red', kind: 'leaf', title: 'Pin unknown keys', rigor: 'tdd-pair', role: 'red', decisions: ['D2'],
      expects: ['test/unknown.test.mjs'], acceptance: [{ text: 'An unknown key fails', check: 'node --test test/unknown.test.mjs', decisions: ['D2'] }] },
    { id: 'green', kind: 'leaf', title: 'Refuse unknown keys', rigor: 'tdd-pair', role: 'green', deps: ['red'], decisions: ['D2'],
      expects: ['src/api/unknown.js'], acceptance: [{ text: 'Every test red wrote passes', check: 'node --test test/unknown.test.mjs', decisions: ['D2'] }] },
    { id: 'spec', kind: 'leaf', title: 'Document keys', rigor: 'tdd', expects: ['src/doc.js'], ground: ['docs/spec'],
      acceptance: [{ text: 'Docs list keys', check: 'node --test test/doc.test.mjs' }] },
  ])
  assert.equal(added.ok, true, JSON.stringify(added.problems))
  return repo
}

const brief = (repo, node = 'parse', opts = {}) => leafBrief(repo, E, node, { worktree: join(repo, 'wt'), ...opts })

/** Each heading's section, as the text holds it: from its `## ` line to the next heading's. */
function sectionsOf(text) {
  const at = HEADINGS.map((h) => text.indexOf('## ' + h + '\n'))
  return Object.fromEntries(HEADINGS.map((h, i) => [h, text.slice(at[i], i + 1 < at.length ? at[i + 1] : text.length).replace(/\n+$/, '')]))
}

const pitfall = (trigger, roles, paths = []) => ({
  kind: 'pitfall', roles, paths, trigger, action: 'pass the flag',
  evidence: { command: 'node --test', output: 'boom' },
})

test('the sections come in order, each under its heading', (t) => {
  const { text } = brief(effort(t))
  const at = HEADINGS.map((h) => text.indexOf('## ' + h + '\n'))
  assert.equal(at[0], 0, 'the brief opens on its first section')
  assert.ok(at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1])), JSON.stringify(at))
  assert.deepEqual(text.match(/^## .*$/gm).map((l) => l.slice(3)), HEADINGS)
})

test('parts holds one digest per heading, each the fnv1a of its section', (t) => {
  const { text, parts } = brief(effort(t))
  assert.deepEqual(Object.keys(parts), HEADINGS)
  for (const [h, section] of Object.entries(sectionsOf(text))) assert.equal(parts[h], fnv1a(section), h)
})

test('digest is the fnv1a of the text', (t) => {
  const b = brief(effort(t))
  assert.equal(b.digest, fnv1a(b.text))
})

test('the same records give the same text twice', (t) => {
  const repo = effort(t)
  assert.deepEqual(brief(repo), brief(repo))
})

test('a gotcha written changes the Gotchas part alone', (t) => {
  const repo = effort(t)
  const before = brief(repo)
  writeGotcha(repo, E, pitfall('for implementers in api', ['implementer'], ['src/api/']), {})
  const after = brief(repo)
  assert.notEqual(after.digest, before.digest)
  assert.deepEqual(HEADINGS.filter((h) => after.parts[h] !== before.parts[h]), ['Gotchas'])
})

test('the task section carries the title, the intent and the context', (t) => {
  const task = sectionsOf(brief(effort(t)).text).Task
  for (const s of ['parse — Parse keys', 'keys parse case-insensitively', 'Use the existing tokenizer.', 'implementer']) assert.ok(task.includes(s), s)
})

test('the criteria and the decisions realised are listed', (t) => {
  const s = sectionsOf(brief(effort(t)).text)
  assert.ok(s['Acceptance criteria'].includes('- Key lookup ignores case — check: `node --test test/parse.test.mjs` [D1]'))
  assert.ok(s['Decisions realised'].includes('- D1 (defined at .): Keys are case-insensitive.'))
  assert.ok(!s['Decisions realised'].includes('Unknown keys are an error'), 'a decision the leaf does not realise')
})

test('the expected files and the reads are listed', (t) => {
  const s = sectionsOf(brief(effort(t)).text)['Expected files and reads']
  for (const p of ['src/api/parse.js', 'test/parse.test.mjs', 'src/api/types.js']) assert.ok(s.includes('- ' + p), p)
})

test("the part of its spec's Design a task's cites declares is handed in the brief, the whole Design for cites: Design, nothing for prose", (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-leaf-brief-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const task = (name, cites, context) => ['- **' + name + '** — task · realises: D1 · rigor: trivial', '  · expects: src/ports.ts',
    ...(cites ? ['  · cites: ' + cites] : []), '  Declare the ports', '  ' + context, '  - [ ] it typechecks — check: `tsc`'].join('\n')
  mkdirSync(join(repo, '.agentics/e1'), { recursive: true })
  writeFileSync(join(repo, '.agentics/e1/DESIGN.md'), ['# Ports', '', '## Intent', '', 'Ports.', '', '## Decisions', '',
    '| id | decision | why |', '|---|---|---|', '| D1 | Ports are typed. | Callers check. |', '', '## Design', '',
    '### Ports (`ports.ts`)', '', '```ts', 'interface Carries { payload(): Carried }', '### not a heading: inside the fence',
    'PORTS_TOKEN interface Proximity { tileOf(): Tile }', '```', '', '### Save', '', 'SAVE_TOKEN', '',
    '## Plan', '', task('named', '"Ports"', 'Bring `ports.ts` to its block.'), task('whole', 'Design', 'Declare them as stated.'),
    task('none', '', 'Bring `ports.ts` to the Design\'s "Ports" block, as this spec\'s Design states.'), '',
    '## Open questions', '', '## Evidence', ''].join('\n'))
  const leaf = (id) => ({ id, kind: 'leaf', title: 'Declare the ports', rigor: 'trivial', expects: ['src/ports.ts'], decisions: ['D1'],
    acceptance: [{ text: 'it typechecks', check: 'tsc', decisions: ['D1'] }] })
  const added = seedTree(repo, E, [{ id: '.', kind: 'composite', title: 'Ports', defines: [{ id: 'D1', text: 'Ports are typed.' }] },
    leaf('named'), leaf('whole'), leaf('none')])
  assert.equal(added.ok, true, JSON.stringify(added.problems))
  const section = (id) => {
    const { text, parts } = brief(repo, id)
    const at = text.indexOf('## Spec Design\n')
    if (at < 0) return null
    assert.ok(parts['Spec Design'])
    assert.ok(at > text.indexOf('## Expected files and reads\n') && at < text.indexOf('## Evidence\n'), 'after the reads, before the evidence')
    return text.slice(at, text.indexOf('## Evidence\n'))
  }
  const named = section('named')
  assert.ok(named.includes('### Design › Ports (`ports.ts`)') && named.includes('PORTS_TOKEN'), 'the cited part')
  assert.ok(!named.includes('SAVE_TOKEN'), 'no part it does not cite')
  assert.ok(named.includes('.agentics/e1/DESIGN.md') && /never at its path/.test(named), 'names the spec, and says the worktree lacks it')
  const whole = section('whole')
  assert.ok(whole.includes('PORTS_TOKEN') && whole.includes('SAVE_TOKEN'), 'the whole Design')
  assert.equal(section('none'), null, 'prose naming the Design cites nothing')
})

test("each consumed contract's declared part is handed under Consumes, from the provider's spec as compile kept it", (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-leaf-brief-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const spec = (den) => ['# Ports', '', '## Intent', '', 'Ports.', '', '## Decisions', '', '## Design', '',
    '### Ports', '', '#### Den', '', den, '', '#### Proximity', '', 'PROX_TOKEN', '', '## Plan', '',
    '- **burrow** — task · rigor: trivial · provides: den-port (src/den.ts) "Den"', '  Build the den', '  - [ ] it builds — check: `tsc`',
    '- **lair** — task · rigor: trivial · provides: lair-port (src/lair.ts)', '  Build the lair', '  - [ ] it builds — check: `tsc`', '',
    '## Open questions', '', '## Evidence', ''].join('\n')
  mkdirSync(join(repo, '.agentics/e1'), { recursive: true })
  writeFileSync(join(repo, '.agentics/e1/DESIGN.md'), spec('DEN_NOW'))
  const kept = spec('DEN_KEPT')
  mkdirSync(dirname(specCopyPath(repo, E, '.', hashSpec(kept))), { recursive: true })
  writeFileSync(specCopyPath(repo, E, '.', hashSpec(kept)), kept)
  assert.equal(append(repo, E, 'ledger', [{ kind: 'compiled', folder: '.', hash: hashSpec(kept) }]).ok, true)
  const leaf = (id, extra) => ({ id, kind: 'leaf', title: 'Build ' + id, rigor: 'trivial', expects: ['src/' + id + '.ts'], decisions: ['D1'],
    acceptance: [{ text: 'it builds', check: 'tsc', decisions: ['D1'] }], ...extra })
  const added = seedTree(repo, E, [{ id: '.', kind: 'composite', title: 'Ports', defines: [{ id: 'D1', text: 'Ports are typed.' }] },
    leaf('burrow', { provides: [{ name: 'den-port', paths: ['src/den.ts'] }] }), leaf('lair', { provides: [{ name: 'lair-port', paths: ['src/lair.ts'] }] }),
    leaf('user', { deps: ['burrow', 'lair'], consumes: [{ name: 'den-port', paths: ['src/den.ts'] }, { name: 'lair-port', paths: ['src/lair.ts'] }] }),
    leaf('plain', { deps: ['lair'], consumes: [{ name: 'lair-port', paths: ['src/lair.ts'] }] })])
  assert.equal(added.ok, true, JSON.stringify(added.problems))
  const { text, parts } = brief(repo, 'user')
  const at = text.indexOf('## Consumes\n')
  assert.ok(parts.Consumes)
  assert.ok(at > text.indexOf('## Expected files and reads\n') && at < text.indexOf('## Evidence\n'), 'after the reads, before the evidence')
  const section = text.slice(at, text.indexOf('## Evidence\n'))
  assert.ok(section.includes('### den-port (src/den.ts) — .agentics/e1/DESIGN.md, Design › Den'), section)
  assert.ok(section.includes('DEN_KEPT') && !section.includes('DEN_NOW'), 'the text compile kept')
  assert.ok(!section.includes('PROX_TOKEN') && !section.includes('lair-port'), 'only the declared part, and no contract that declares none')
  assert.ok(!brief(repo, 'plain').text.includes('## Consumes'), 'no section when no consumed contract declares a part')
})

test("the effort store's files a leaf reads or cites are handed in the brief, its records never", (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-leaf-brief-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  for (const [path, text] of Object.entries({
    '.agentics/e1/area/DESIGN.md': '# Area\n\nREAD_SPEC_TOKEN the rulings\n',
    '.agentics/e1/notes.md': 'CITED_NOTE_TOKEN\n',
    '.agentics/e1/.state/events.jsonl': 'STATE_TOKEN\n',
  })) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  const added = seedTree(repo, E, [
    { id: '.', kind: 'composite', title: 'Docs', defines: [{ id: 'D1', text: 'Docs say it.' }] },
    { id: 'docs', kind: 'leaf', title: 'Write the docs', rigor: 'trivial', expects: ['docs/kb.md'], reads: ['.agentics/e1/area/DESIGN.md'],
      decisions: ['D1'], acceptance: [{ text: 'Docs say it', check: 'grep -q it docs/kb.md', decisions: ['D1'] }],
      context: 'Copy the rows .agentics/e1/notes.md lists; .agentics/e1/.state/events.jsonl and .agentics/e1/gone.md are not for you.' },
  ])
  assert.equal(added.ok, true, JSON.stringify(added.problems))
  const { text, parts } = brief(repo, 'docs')
  const at = text.indexOf('## Effort files\n')
  assert.ok(at > text.indexOf('## Expected files and reads\n') && at < text.indexOf('## Evidence\n'), 'after the reads, before the evidence')
  const section = text.slice(at, text.indexOf('## Evidence\n'))
  assert.ok(section.includes('### .agentics/e1/area/DESIGN.md') && section.includes('READ_SPEC_TOKEN'), 'a read under the store')
  assert.ok(section.includes('### .agentics/e1/notes.md') && section.includes('CITED_NOTE_TOKEN'), 'a store file the context cites')
  assert.ok(!text.includes('STATE_TOKEN') && !section.includes('gone.md'), 'neither the records nor a path that is no file')
  assert.ok(parts['Effort files'])
})

test("a green's test round lists the test files the red's branch changed, whatever the red expected", (t) => {
  const repo = effort(t)
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.email=a@b.c', '-c', 'user.name=n', 'commit', '-q', '--allow-empty', '-m', 'base')
  git('branch', branchOf(E, '.'))
  git('checkout', '-q', '-b', branchOf(E, 'red'))
  mkdirSync(join(repo, 'test'), { recursive: true })
  writeFileSync(join(repo, 'test', 'unknown-keys.test.mjs'), "test('x', () => {})\n")
  mkdirSync(join(repo, 'src', 'api'), { recursive: true })
  writeFileSync(join(repo, 'src', 'api', 'unknown.js'), "export const refuse = () => { throw new Error('not implemented') }\n")
  git('add', '-A')
  git('-c', 'user.email=a@b.c', '-c', 'user.name=n', 'commit', '-q', '-m', 'pin unknown keys')
  const s = sectionsOf(brief(repo, 'green', { role: 'test-author' }).text)['Expected files and reads']
  assert.ok(s.includes('- test/unknown-keys.test.mjs'), 'the test the red committed')
  assert.ok(s.includes('never a source file'), s)
  assert.ok(!s.slice(0, s.indexOf('Expected to change')).includes('src/api/unknown.js'), 'a stub the red wrote is no cycle test')
  assert.ok(!sectionsOf(brief(repo, 'green').text)['Expected files and reads'].includes('never a source file'), 'the implementer writes the source')
})

test('the measures are measuresFor the leaf and the role', (t) => {
  const repo = effort(t)
  const green = readTree(repo, E).nodes.get('green')
  for (const role of ['implementer', 'test-author']) {
    const s = sectionsOf(brief(repo, 'green', { role }).text).Measures
    for (const m of measuresFor(green, role)) assert.ok(s.includes('- ' + m), role + ': ' + m)
  }
})

test('no round number, no findings, no report or progress contract is in it', (t) => {
  const repo = effort(t)
  for (const [node, role] of [['parse', 'implementer'], ['red', 'test-author'], ['green', 'implementer'], ['green', 'test-author']]) {
    const { text } = brief(repo, node, { role })
    for (const banned of ['- round:', 'Fix round', 'Report path', 'Progress path', '```agentics-', 'Return only one typed status']) {
      assert.ok(!text.includes(banned), node + '/' + role + ' holds ' + JSON.stringify(banned))
    }
  }
})

test('gotchas reach the brief for its role and expected files only', (t) => {
  const repo = effort(t)
  writeGotcha(repo, E, pitfall('for implementers in api', ['implementer'], ['src/api/']), {})
  writeGotcha(repo, E, pitfall('for implementers in docs', ['implementer'], ['docs/']), {})
  writeGotcha(repo, E, pitfall('for test authors', ['test-author']), {})
  const impl = sectionsOf(brief(repo).text).Gotchas
  assert.match(impl, /When for implementers in api, do pass the flag\./)
  assert.doesNotMatch(impl, /for implementers in docs/)
  assert.doesNotMatch(impl, /for test authors/)
  assert.match(sectionsOf(brief(repo, 'parse', { role: 'test-author' }).text).Gotchas, /When for test authors/)
})

test("a leaf's evidence and gotchas are code's, bounded as the brief is built and what they left out declared", (t) => {
  const repo = effort(t)
  const many = Math.ceil((PART_BYTES * 2) / 1000)
  for (let i = 0; i < many; i++) writeGotcha(repo, E, pitfall('case ' + i + ' ' + 'y'.repeat(1000), ['implementer'], ['src/api/']), {})
  const evidence = Array.from({ length: many }, (_, i) => ({ topic: 't', kind: 'code', claim: 'claim ' + i + ' ' + 'z'.repeat(1000), anchors: [] }))
  const text = brief(repo, 'parse', { evidence }).text
  const over = oversizedPart(partsOf(text), Infinity)
  assert.ok(!over || over.owner !== 'code', over && over.message)
  const at = sectionsOf(text)
  assert.match(at.Evidence, /left out to fit this brief: \d+ more evidence items/)
  assert.match(at.Gotchas, /left out to fit this brief: the gotchas /)
  assert.ok(Buffer.byteLength(at.Evidence) <= PART_BYTES && Buffer.byteLength(at.Gotchas) <= PART_BYTES)
})

test('standing evidence whose ground meets the leaf is excerpted', (t) => {
  const repo = effort(t)
  const external = (claim, ground) => ({
    question: 'how are configs parsed', topic: 'parsing', ground, kind: 'external', claim,
    spans: [], queries: [], rests_on: [], sources: [{ url: 'https://example.invalid/parsing', version: '1.0.0', retrieved: '' }],
  })
  const out = recordItems(repo, '20260901-000000-survey', [
    external('The tokenizer already lower-cases.', ['src/api']),
    external('The UI never reads configs.', ['src/ui']),
  ])
  assert.equal(out.ok, true, JSON.stringify(out))
  const s = sectionsOf(brief(repo).text).Evidence
  assert.match(s, /\[parsing, external\] The tokenizer already lower-cases\./)
  assert.doesNotMatch(s, /UI never reads configs/)
})

test("the guidance is the CLAUDE.md files of the expected files' directories", (t) => {
  const repo = effort(t, { 'CLAUDE.md': 'root rules\n', 'src/api/CLAUDE.md': 'api rules\n', 'src/ui/CLAUDE.md': 'ui rules\n' })
  const s = sectionsOf(brief(repo).text)['Repository guidance']
  assert.ok(s.includes('### CLAUDE.md\n\n~~~~\nroot rules\n~~~~'))
  assert.ok(s.includes('### src/api/CLAUDE.md\n\n~~~~\napi rules\n~~~~'))
  assert.ok(!s.includes('ui rules'), 'a directory no expected file sits in')
  assert.ok(s.indexOf('### CLAUDE.md') < s.indexOf('### src/api/CLAUDE.md'), 'root first')
})

test('no guidance reads as none', (t) => {
  assert.equal(sectionsOf(brief(effort(t)).text)['Repository guidance'], '## Repository guidance\n\n(none)')
})

test("the worktree is named by its absolute path", (t) => {
  const repo = effort(t)
  const wt = join(repo, 'wt')
  assert.equal(sectionsOf(brief(repo, 'parse', { worktree: wt }).text).Worktree, '## Worktree\n\n' + wt)
  assert.equal(sectionsOf(brief(repo, 'parse', { worktree: 'wt' }).text).Worktree, '## Worktree\n\n' + resolve('wt'))
})

test('the established commands are listed, an absent one left out', (t) => {
  const repo = effort(t)
  const commands = { build: 'npm run build', typecheck: '', suite: 'npm test', test_one: 'node --test {file}' }
  const s = sectionsOf(brief(repo, 'parse', { commands }).text).Commands
  assert.ok(s.includes('- build: `npm run build`'))
  assert.ok(s.includes('- suite: `npm test`'))
  assert.ok(s.includes('- test_one: `node --test {file}`'))
  assert.ok(!s.includes('typecheck'))
  assert.equal(sectionsOf(brief(repo).text).Commands, '## Commands\n\n(none established yet)')
})

test('an unknown node is refused', (t) => {
  assert.throws(() => brief(effort(t), 'nope'), /no live node/)
})

test('measuresFor names the yardstick per rigor and role', () => {
  const m = (extra) => measuresFor(normalizeNode({ kind: 'leaf', ...extra })).join(' | ')
  assert.match(m({ rigor: 'verify' }), /nothing is written/)
  assert.match(m({ rigor: 'tdd-pair', role: 'red' }), /fail now and fail at the base/)
  assert.match(m({ rigor: 'tdd-pair', role: 'green' }), /red leaf's tests pass now/)
  assert.match(m({ rigor: 'tdd-triad', role: 'audit' }), /no new tests are expected/)
  assert.match(m({ rigor: 'tests-only' }), /at least one declaration is required/)
})

test('standing evidence on the ground of the leaf alone is excerpted', (t) => {
  const repo = effort(t)
  const out = recordItems(repo, '20260901-000000-survey', [{
    question: 'what does the spec say', topic: 'spec', ground: ['docs/spec'], kind: 'external', claim: 'The spec lists every key.',
    spans: [], queries: [], rests_on: [], sources: [{ url: 'https://example.invalid/spec', version: '1.0.0', retrieved: '' }],
  }])
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.match(sectionsOf(brief(repo, 'spec').text).Evidence, /\[spec, external\] The spec lists every key\./)
})

test('the guidance files the repository config lists are shown', (t) => {
  const repo = effort(t, { 'docs/style.md': 'style rules\n' })
  mkdirSync(dirname(configPath(repo)), { recursive: true })
  writeFileSync(configPath(repo), JSON.stringify({ guidance: ['docs/style.md'] }))
  assert.ok(sectionsOf(brief(repo).text)['Repository guidance'].includes('### docs/style.md\n\n~~~~\nstyle rules\n~~~~'))
})
