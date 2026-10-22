// test/render.test.mjs — the landing view, rendered from a real spec and real events on disk.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createSubEffortFolder, renameSubEffort } from '../lib/effort.mjs'
import { checkAnchors, itemsFor, recordCites, recordItems, recordJudgement } from '../lib/evidence.mjs'
import { append, readLog } from '../lib/ledger.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'
import { renderEvidence, renderLanding } from '../lib/render.mjs'
import { EVIDENCE_RENDER, evidenceItemsPath, executionDir, folderDir, returnPath, specPath, writeJson } from '../lib/store.mjs'

const STAMP = '20260926-100000'
const CRITERIA = ['Starting design never needs an id or a flag.', 'Every command ends with a Next line.']

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-render-'))
  execFileSync('git', ['init', '-q', dir])
  return dir
}

const rootSpec = (intent) => [
  '# The change', '', '## Intent', '', ...intent, '',
  '## Decisions', '', '| id | decision | why |', '|---|---|---|', '| D1 | do it | asked for |', '',
  '## Design', '', 'As planned.', '', '## Plan', '',
  '- **x** — task · realises: D1 · rigor: tdd · locus: src/x.mjs', '  Add x.', '  - [ ] x works — check: `node --test`', '',
  '## Open questions', '', '## Evidence', '', 'None gathered.', '',
].join('\n')

const WITH_CRITERIA = ['For the maintainer.', '', '**Success criteria.**', '', ...CRITERIA.map((c, i) => (i + 1) + '. ' + c), '', 'Out of scope: the viewer.']

function writeRoot(r, text) {
  const path = specPath(r, 'e1', '.')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const claims = (r, list, head = 'h1', extra = {}) =>
  assert.equal(append(r, 'e1', 'events', { kind: 'claims', node: '.', execution: STAMP, head_sha: head, claims: list, ...extra }).ok, true)

const criteriaLines = (view) => view.split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, ''))
const rowOf = (view, text) => view.split('\n').findIndex((l) => l.startsWith('|') && l.includes(text))

// Loss first, as the spec orders the verdicts: what did not hold leads, what could not be decided
// follows it, and `met` comes last.
const LOSS_FIRST = ['under', 'over', 'deviates', 'spec_defect', 'cant_tell', 'equivalent', 'accepted', 'met']

test('the success criteria stand beside the verdicts, loss first', () => {
  const r = repo()
  writeRoot(r, rootSpec(WITH_CRITERIA))
  const list = [
    { claim: 'it builds', ruling: 'met', evidence: 'ci' },
    { claim: 'latency stays flat', ruling: 'cant_tell', evidence: 'no benchmark' },
    { claim: 'the api matches the spec', ruling: 'deviates', evidence: 'src/api.js:4' },
    { claim: 'the spec asks for two things at once', ruling: 'spec_defect', evidence: 'DESIGN.md:12' },
    { claim: 'memory stays bounded', ruling: 'cant_tell', evidence: 'no load test' },
    { claim: 'logging is scoped', ruling: 'over', evidence: 'src/log.js:2' },
    { claim: 'retries are bounded', ruling: 'under', evidence: 'src/r.js:9' },
    { claim: 'the parser is named Reader', ruling: 'equivalent', evidence: 'src/p.js:1' },
    { claim: 'the cache key is shorter', ruling: 'accepted', evidence: 'src/c.js:3' },
  ]
  claims(r, list)
  const view = renderLanding(r, 'e1')
  assert.deepEqual(criteriaLines(view), CRITERIA)

  const rows = view.split('\n').filter((l) => /^\| (?!verdict \|)\w/.test(l))
  assert.equal(rows.length, list.length, 'every claim has its row')
  const rank = (v) => LOSS_FIRST.indexOf(v)
  assert.deepEqual(rows.map((l) => l.split('|')[1].trim()), list.map((c) => c.ruling).sort((a, b) => rank(a) - rank(b)))

  const count = (pass) => list.filter((c) => pass(c.ruling)).length
  const passes = ['met', 'equivalent', 'accepted']
  const met = count((v) => passes.includes(v))
  const undecided = count((v) => v === 'cant_tell')
  const notMet = count((v) => !passes.includes(v) && v !== 'cant_tell')
  assert.ok(view.includes(list.length + ' claim(s): ' + met + ' met, ' + notMet + ' not met, ' + undecided + ' it could not decide.'),
    'a cant_tell is counted as neither met nor not met; an equivalent or accepted claim is met')
})

test('no recorded verdicts: the criteria stand alone, with no table', () => {
  const r = repo()
  writeRoot(r, rootSpec(WITH_CRITERIA))
  const view = renderLanding(r, 'e1')
  assert.deepEqual(criteriaLines(view), CRITERIA)
  assert.equal(view.split('\n').filter((l) => l.startsWith('|')).length, 0)
})

test('the latest claims event on the root is the one rendered', () => {
  const r = repo()
  writeRoot(r, rootSpec(WITH_CRITERIA))
  claims(r, [{ claim: 'an old claim', ruling: 'under', evidence: 'x' }], 'h1')
  claims(r, [{ claim: 'the new claim', ruling: 'met', evidence: 'y' }], 'h2')
  const view = renderLanding(r, 'e1')
  assert.ok(rowOf(view, 'the new claim') !== -1)
  assert.equal(rowOf(view, 'an old claim'), -1)
})

test('a claim holding a pipe still renders two columns', () => {
  const r = repo()
  writeRoot(r, rootSpec(WITH_CRITERIA))
  claims(r, [{ claim: 'a | b stays one claim', ruling: 'deviates', evidence: 'src/a.js:1' }])
  const view = renderLanding(r, 'e1')
  const row = view.split('\n')[rowOf(view, 'stays one claim')]
  assert.equal(row.split(/(?<!\\)\|/).length, 4, row)
})

test('CRLF and LF specs list the same criteria', () => {
  const lf = repo()
  const crlf = repo()
  writeRoot(lf, rootSpec(WITH_CRITERIA))
  writeRoot(crlf, rootSpec(WITH_CRITERIA).replace(/\n/g, '\r\n'))
  assert.deepEqual(criteriaLines(renderLanding(crlf, 'e1')), criteriaLines(renderLanding(lf, 'e1')))
})

test('an Intent with no success-criteria list is rendered whole', () => {
  const r = repo()
  writeRoot(r, rootSpec(['Make the queue durable across restarts.']))
  assert.ok(renderLanding(r, 'e1').includes('Make the queue durable across restarts.'))
})

// ------------------------------------------------------------------ evidence.md
//
// A folder cites the items it rests on; its evidence.md is rendered from its latest citation and
// the items' states at render time. Nothing in it is typed by hand, and nothing reads it back.

const evGit = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
const evLines = (n) => Array.from({ length: n }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n'
const EFFORT = 'e1'
const FOLDER = 'foundations'

function evRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-render-evidence-'))
  evGit(dir, 'init', '-q', '.')
  evGit(dir, 'config', 'user.email', 't@t')
  evGit(dir, 'config', 'user.name', 't')
  evGit(dir, 'config', 'core.autocrlf', 'false')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.js'), evLines(30))
  evGit(dir, 'add', '-A')
  evGit(dir, 'commit', '-qm', 'init')
  return dir
}

const evItem = (topic, claim, start, end) => ({
  question: 'how does loading work', topic, ground: ['src'], kind: 'behaviour', claim,
  spans: [{ path: 'src/a.js', start, end, at: '' }], queries: [], sources: [], rests_on: [],
})

/**
 * Five items over two topics. FOLDER cited two of them first, then replaced that citation with
 * three: one stale by verdict, one suspect by edit. One item nobody ever cited.
 */
function citedFixture() {
  const repo = evRepo()
  const out = recordItems(repo, '20260926-100000-survey', [
    evItem('loader', 'the loader reads one file', 2, 4),
    evItem('loader', 'the loader never retries', 10, 12),
    evItem('cache', 'nothing is cached', 20, 22),
    evItem('cache', 'an uncited claim', 25, 26),
    evItem('cache', 'a claim cited once, then no more', 27, 28),
  ])
  assert.equal(out.ok, true, JSON.stringify(out))
  const [reads, retries, cached, uncited, superseded] = out.ids
  // Cited while standing, then judged: a stale item nobody cited could not be cited any more.
  assert.equal(recordCites(repo, EFFORT, FOLDER, { items: [reads, superseded], gaps: ['an old gap'] }).ok, true)
  assert.equal(recordCites(repo, EFFORT, FOLDER, { items: [reads, retries, cached, reads], gaps: ['git history was not searched'] }).ok, true)
  recordJudgement(repo, retries, 'fails')
  writeFileSync(join(repo, 'src', 'a.js'), evLines(30).replace('line 21\n', 'line twenty-one\n'))
  return { repo, reads, retries, cached, uncited, superseded }
}

test('evidence.md lists exactly the cited items by topic, each in the state derived at render time', () => {
  const { repo, reads, retries, cached } = citedFixture()
  const path = renderEvidence(repo, EFFORT, FOLDER)
  assert.equal(path, join(folderDir(repo, EFFORT, FOLDER), EVIDENCE_RENDER).split('\\').join('/'))
  const text = readFileSync(path, 'utf8')

  assert.match(text, /^# Evidence: foundations\n/)
  const claims = {
    [reads]: 'the loader reads one file', [retries]: 'the loader never retries', [cached]: 'nothing is cached',
  }
  for (const [id, claim] of Object.entries(claims)) {
    const lines = text.split('\n').filter((l) => l.includes(claim))
    assert.equal(lines.length, 1, claim + ' appears once, however often it is cited')
    const { state } = checkAnchors(repo, [id])[0]
    assert.ok(lines[0].startsWith('- **' + state + '**'), lines[0])
  }
  assert.doesNotMatch(text, /an uncited claim/)
  assert.doesNotMatch(text, /cited once, then no more/, 'the latest citation is the whole citation')
  assert.doesNotMatch(text, /an old gap/)
  assert.ok(text.indexOf('## loader') < text.indexOf('the loader reads one file'))
  assert.ok(text.indexOf('## cache') < text.indexOf('nothing is cached'))
  assert.match(text, /src\/a\.js:2-4/)
  assert.match(text, /## Coverage gaps\n\n- git history was not searched/)
  assert.doesNotMatch(text, /## Not in the store/)

  assert.equal(recordCites(repo, EFFORT, '.', { items: [cached] }).ok, true)
  assert.match(readFileSync(renderEvidence(repo, EFFORT, '.'), 'utf8'), new RegExp('^# Evidence: ' + EFFORT + '\n'), 'the root folder is titled with the effort')
})

test('a folder with no gaps says so, and rendering twice writes the same bytes', () => {
  const { repo, cached } = citedFixture()
  assert.equal(recordCites(repo, EFFORT, 'runtime', { items: [cached] }).ok, true)
  const path = renderEvidence(repo, EFFORT, 'runtime')
  const first = readFileSync(path, 'utf8')
  assert.match(first, /## Coverage gaps\n\n\(none\)/)
  assert.equal(readFileSync(renderEvidence(repo, EFFORT, 'runtime'), 'utf8'), first)
  writeFileSync(path, 'edited by hand\n')
  assert.equal(readFileSync(renderEvidence(repo, EFFORT, 'runtime'), 'utf8'), first, 'a render is never merged with the disk')
})

test('a citation of gaps alone is recorded and rendered', () => {
  const { repo } = citedFixture()
  assert.equal(recordCites(repo, EFFORT, 'unsurveyed', { items: [], gaps: ['nothing here is anchored yet'] }).ok, true)
  const text = readFileSync(renderEvidence(repo, EFFORT, 'unsurveyed'), 'utf8')
  assert.match(text, /## Coverage gaps\n\n- nothing here is anchored yet/)
  assert.doesNotMatch(text, /^## (?!Coverage gaps)/m, 'no topic, and nothing missing')
})

test('a cited id the store does not hold is listed as not in the store', () => {
  const { repo, cached } = citedFixture()
  // recordCites refuses an unknown id, so the line is written the way a store that lost its log would leave it.
  assert.equal(append(repo, EFFORT, 'cites', { kind: 'cites', folder: 'lost', items: [cached, 'I00000000'], gaps: [] }).ok, true)
  const text = readFileSync(renderEvidence(repo, EFFORT, 'lost'), 'utf8')
  assert.match(text, /## Not in the store\n\n- I00000000\n/)
  assert.match(text, /nothing is cached/)
})

test('a cites line with a repeated id is rendered once, whatever wrote the line', () => {
  const { repo, cached } = citedFixture()
  // recordCites already de-duplicates before it writes; append the line directly so the render's
  // own de-duplication (a line no recordCites wrote could still carry a repeat) is what is tested.
  assert.equal(append(repo, EFFORT, 'cites', { kind: 'cites', folder: 'dup', items: [cached, cached], gaps: [] }).ok, true)
  const text = readFileSync(renderEvidence(repo, EFFORT, 'dup'), 'utf8')
  const lines = text.split('\n').filter((l) => l.includes('nothing is cached'))
  assert.equal(lines.length, 1, 'a repeated id renders once')
})

test('recordCites refuses an unknown item, a bad folder id and an empty citation, and writes nothing', () => {
  const { repo, reads } = citedFixture()
  const before = readLog(repo, EFFORT, 'cites').entries.length
  assert.match(recordCites(repo, EFFORT, FOLDER, { items: [reads, 'I00000000'] }).error, /I00000000/)
  assert.equal(recordCites(repo, EFFORT, 'Not A Folder', { items: [reads] }).ok, false)
  assert.equal(recordCites(repo, EFFORT, FOLDER, {}).ok, false)
  assert.equal(readLog(repo, EFFORT, 'cites').entries.length, before)

  const [line] = readLog(repo, EFFORT, 'cites').entries
  assert.equal(line.kind, 'cites')
  assert.equal(line.folder, FOLDER)
  assert.ok(Array.isArray(line.items) && Array.isArray(line.gaps))
})

test('the CLI cites and renders, each printing an envelope', () => {
  const { repo, cached } = citedFixture()
  const run = (script, ...args) => {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../lib/' + script, import.meta.url)), ...args], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const out = JSON.parse(r.stdout)
    assert.equal(out.payload_digest, fnv1a(canonical(out.payload)))
    return out.payload
  }
  const cited = run('evidence.mjs', 'cite', '--repo', repo, '--effort', EFFORT, '--folder', 'cli', '--items', cached, '--gap', 'docs were not read')
  assert.equal(cited.ok, true)
  const rendered = run('render.mjs', 'evidence', '--repo', repo, '--effort', EFFORT, '--folder', 'cli')
  assert.match(readFileSync(rendered.path, 'utf8'), /nothing is cached[\s\S]*docs were not read/)
})

test('a stale item cited by no live folder\'s latest line leaves the pool, and the log keeps its lines', () => {
  const { repo, retries, uncited, superseded } = citedFixture()
  const more = recordItems(repo, '20260926-110000-survey', [
    evItem('loader', 'another effort rests on this', 5, 6),
    evItem('loader', 'only a retired folder rests on this', 7, 8),
  ])
  assert.equal(more.ok, true, JSON.stringify(more))
  const [elsewhere, retiredOnly] = more.ids
  assert.equal(recordCites(repo, 'e2', 'x', { items: [elsewhere] }).ok, true)
  assert.equal(recordCites(repo, 'e2', 'gone', { items: [retiredOnly] }).ok, true)
  assert.equal(append(repo, 'e2', 'nodes', { kind: 'node', node: { id: 'gone', kind: 'composite', title: 'gone', retired: true } }).ok, true)
  for (const id of [elsewhere, retiredOnly, uncited, superseded]) recordJudgement(repo, id, 'fails')

  const stale = itemsFor(repo, { ground: ['src'], states: ['stale'] }).map((i) => i.id)
  assert.ok(stale.includes(retries), "in this effort's latest citation: still in the pool")
  assert.ok(stale.includes(elsewhere), 'cited by another effort: still in the pool')
  assert.ok(!stale.includes(uncited), 'stale and cited nowhere: pruned')
  assert.ok(!stale.includes(superseded), 'cited only by a line its folder has since replaced: pruned')
  assert.ok(!stale.includes(retiredOnly), 'cited only by a folder compile retired: pruned')
  assert.ok(!itemsFor(repo, { ground: ['src'], states: ['standing', 'suspect', 'stale'] }).some((i) => i.id === uncited))

  const before = readLog(repo, EFFORT, 'cites').entries.length
  assert.match(recordCites(repo, EFFORT, 'late', { items: [uncited] }).error, new RegExp(uncited))
  assert.equal(readLog(repo, EFFORT, 'cites').entries.length, before)
  assert.ok(readFileSync(evidenceItemsPath(repo), 'utf8').includes(uncited), 'the append-only log keeps it')
})

test('after a rename, the folder\'s evidence renders under its new id, approved or not', () => {
  const { repo, cached } = citedFixture()
  writeRoot(repo, rootSpec(WITH_CRITERIA))
  assert.equal(createSubEffortFolder(repo, EFFORT, 'x', { title: 'x' }).ok, true)
  assert.equal(recordCites(repo, EFFORT, 'x', { items: [cached], gaps: ['docs were not read'] }).ok, true)
  const before = readLog(repo, EFFORT, 'cites').entries

  const out = renameSubEffort(repo, EFFORT, 'x', 'y')
  assert.equal(out.ok, true, out.error)
  assert.deepEqual(out.cited, ['y'])
  const text = readFileSync(renderEvidence(repo, EFFORT, 'y'), 'utf8')
  assert.match(text, /nothing is cached/)
  assert.match(text, /## Coverage gaps\n\n- docs were not read/)
  assert.deepEqual(readLog(repo, EFFORT, 'cites').entries.slice(0, before.length), before, 'append-only')
})

test('the landing view gives what the review said from its stored return, and says so when there is none', () => {
  const r = repo()
  writeRoot(r, rootSpec(WITH_CRITERIA))
  const dispatch = 'root.reviewer.integration-.-1.r1'
  const notes = 'The criteria hold: every command ends with a Next line.'
  writeJson(returnPath(executionDir(r, 'e1', STAMP), dispatch), { units: [], findings: [], fix_rulings: [], claims: [], notes })
  claims(r, [{ claim: 'it builds', ruling: 'met' }], 'h1', { said: dispatch })
  assert.ok(renderLanding(r, 'e1').includes('\n' + notes + '\n'), 'the reviewer\'s words, whole')
  claims(r, [{ claim: 'it builds', ruling: 'met' }], 'h2', { said: 'gone.reviewer.r1' })
  assert.match(renderLanding(r, 'e1'), /evidence was not written down: the return of gone\.reviewer\.r1 is missing\./)
  claims(r, [{ claim: 'it builds', ruling: 'met' }], 'h3')
  assert.match(renderLanding(r, 'e1'), /evidence was not written down\.\n$/)
})

test('the render CLI refuses a value that is not a handle, and a flag it does not take', () => {
  const refusal = (...args) => {
    try {
      execFileSync(process.execPath, [fileURLToPath(new URL('../lib/render.mjs', import.meta.url)), ...args], {
        encoding: 'utf8', stdio: 'pipe', env: { ...process.env, NODE_TEST_CONTEXT: '' }, timeout: 30_000,
      })
      return [0, '']
    } catch (err) {
      return [err.status, JSON.parse(err.stdout).kind]
    }
  }
  assert.deepEqual(refusal('evidence', '--repo', '.', '--effort', 'e1', '--folder', 'a b'), [1, 'args_unreadable'])
  assert.deepEqual(refusal('evidence', '--repo', '.', '--effort', 'e1', '--text', 'x'), [1, 'unknown_flag'])
})
