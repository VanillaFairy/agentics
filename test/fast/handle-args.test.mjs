// test/fast/handle-args.test.mjs — pins the one check every lib CLI a skill calls runs over its
// arguments: a handle, a path or a named free text of its bound, nothing else, and the walk that
// tells a flag from its value.
//
// Design: docs/DESIGN.md#p2--code-does-what-is-deterministic-models-only-judge.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HANDLE_MAX, PATH_MAX, TEXT_MAX, argProblem, handleArgs, textFlag, textFlags } from '../../lib/store.mjs'

const KINDS = { '--repo': 'path', '--effort': 'handle', '--node': 'handle', '--text': 'text', '--json': 'switch' }
const WITH_FILE = { ...KINDS, '--text-file': 'path' }

test('a handle is one token: an id, a sha, an enum, a number, a ref, a folder id', () => {
  for (const v of ['e1', 'a/b/c', '0123abcd', 'merge', '42', 'origin/main', 'snapshot:deadbeef', 'e1.20260101-120000', 'I0a1b2c3d,I00000001']) {
    assert.equal(argProblem(v, 'handle'), '', v)
  }
  assert.equal(argProblem('x'.repeat(HANDLE_MAX), 'handle'), '')
})

test('a handle with a space, a quote, a backtick, a line break or past its length is refused, saying why', () => {
  for (const [v, why] of [['a b', /space/], ['a"b', /quote/], ['a`b', /backtick/], ['a\nb', /line break/], ['a\tb', /control/],
    ['x'.repeat(HANDLE_MAX + 1), new RegExp(String(HANDLE_MAX))]]) {
    assert.match(argProblem(v, 'handle'), why, JSON.stringify(v))
  }
})

test('a path may hold spaces, a list of paths commas, and is refused past its length or over a line break', () => {
  assert.equal(argProblem('C:/My Repo/.agentics/e1/DESIGN.md', 'path'), '')
  assert.equal(argProblem('src,lib/a b,test', 'path'), '')
  assert.match(argProblem('x'.repeat(PATH_MAX + 1), 'path'), new RegExp(String(PATH_MAX)))
  assert.match(argProblem('src\nlib', 'path'), /line break/)
  assert.match(argProblem('src/"x"', 'path'), /quote/)
})

test('a named free text is one line, quotes and all, of at most TEXT_MAX characters', () => {
  assert.equal(argProblem('the "loader" is untested — see `load()`, twice', 'text'), '')
  assert.equal(argProblem('x'.repeat(TEXT_MAX), 'text'), '')
  assert.match(argProblem('x'.repeat(TEXT_MAX + 1), 'text', '--about-file'), /pass its path with --about-file/)
  assert.doesNotMatch(argProblem('x'.repeat(TEXT_MAX + 1), 'text'), /file/, 'no file flag is named where there is none')
  assert.match(argProblem('x'.repeat(TEXT_MAX + 1), 'text'), /shorten it/)
  assert.match(argProblem('one\ntwo', 'text'), /line break/)
  assert.match(argProblem('one\r\ntwo', 'text'), /line break/)
})

test('every flag a CLI takes, of its kind, passes', () => {
  const argv = ['note', '--repo', 'C:/My Repo', '--effort', 'e1', '--node', 'a/b', '--text', 'it stopped: the suite was red', '--json']
  assert.equal(handleArgs(argv, KINDS), null)
})

test('a flag the CLI does not take is refused unknown_flag, naming it', () => {
  assert.deepEqual(handleArgs(['note', '--effort', 'e1', '--execution', 'x'], KINDS),
    { kind: 'unknown_flag', message: 'no flag --execution', token: '--execution' })
})

test('a flag where a value was due is read as a flag, and named when the CLI does not take it', () => {
  assert.equal(handleArgs(['note', '--node', '--execution', '20260101-120000'], KINDS).token, '--execution')
  assert.equal(handleArgs(['note', '--node', '--effort', 'e1'], KINDS), null)
})

test('a value that starts with -- but is no flag token is a value', () => {
  assert.equal(handleArgs(['note', '--text', '--force is wrong'], KINDS), null)
})

test('a value not of its kind is refused args_unreadable, naming its flag', () => {
  for (const [argv, flag] of [
    [['note', '--node', 'a b'], '--node'],
    [['note', '--text', 'one\ntwo'], '--text'],
    [['note', '--text', 'x'.repeat(TEXT_MAX + 1)], '--text'],
    [['note', '--repo', 'C:/r\n'], '--repo'],
  ]) {
    const out = handleArgs(argv, KINDS)
    assert.equal(out.kind, 'args_unreadable', argv.join(' '))
    assert.equal(out.token, flag)
    assert.ok(out.message.startsWith(flag + ' '), out.message)
  }
})

test('a text past its line is refused naming the file flag the CLI declares beside it, and only then', () => {
  const long = ['note', '--text', 'x'.repeat(TEXT_MAX + 1)]
  assert.match(handleArgs(long, WITH_FILE).message, /pass its path with --text-file/)
  assert.doesNotMatch(handleArgs(long, KINDS).message, /file/)
  assert.match(handleArgs(['slug', 'x'.repeat(TEXT_MAX + 1)], { _: 'text' }, { positionalFile: '--about-file' }).message, /with --about-file/)
})

test('a switch followed by a value-shaped token is refused as a stray positional (a regression pin: it held at the head)', () => {
  const out = handleArgs(['note', '--json', 'stray'], KINDS)
  assert.equal(out.kind, 'args_unreadable')
  assert.equal(out.token, 'stray')
})

test('the stray positional a CLI does not take is named in at most 40 characters, as a bad positional is', () => {
  assert.equal(handleArgs(['note', 'y'.repeat(100)], KINDS).token.length, 40)
})

/** A writer of named files in a directory removed after the test. */
const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-textflag-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return (name, text) => {
    const path = join(dir, name)
    writeFileSync(path, text)
    return path
  }
}

test('free text comes from its flag or from the file its -file twin names: whole, trimmed, line ends as \\n', (t) => {
  const write = scratch(t)
  const long = ['the first line', 'x'.repeat(TEXT_MAX * 3), 'the "last" line, with `ticks`'].join('\n')
  assert.deepEqual(textFlag(['open', '--about', 'one line'], 'about'), { ok: true, value: 'one line' })
  const file = write('a.txt', '\n' + long.replace(/\n/g, '\r\n') + '\r\n\r\n')
  assert.deepEqual(textFlag(['open', '--about-file', file], 'about'), { ok: true, value: long })
  assert.deepEqual(textFlag(['open'], 'about'), { ok: true, value: '' }, 'absent is empty')
})

test('a text given by its flag and by its file is refused bad_args, and a file that is none unknown_file', (t) => {
  const write = scratch(t)
  const both = textFlag(['open', '--about', 'x', '--about-file', write('a.txt', 'y')], 'about')
  assert.deepEqual([both.ok, both.error.kind], [false, 'bad_args'])
  const none = textFlag(['open', '--about-file', join(tmpdir(), 'agentics-no-such-file.txt')], 'about')
  assert.deepEqual([none.ok, none.error.kind], [false, 'unknown_file'])
})

test('a repeated free text reads every one of its flags and files', (t) => {
  const write = scratch(t)
  const out = textFlags(['cite', '--gap', 'one', '--gap-file', write('g.txt', 'two\nlines'), '--gap', 'three'], 'gap')
  assert.equal(out.ok, true)
  assert.deepEqual([...out.values].sort(), ['one', 'three', 'two\nlines'])
  assert.equal(textFlags(['cite', '--gap-file', join(tmpdir(), 'agentics-no-such-file.txt')], 'gap').error.kind, 'unknown_file')
})

test('a positional is refused where none is taken, and checked by its kind where one is', () => {
  assert.equal(handleArgs(['note', 'stray'], KINDS).kind, 'args_unreadable')
  assert.equal(handleArgs(['open', 'C:/My Repo', 'e1'], { _: 'path' }), null)
  assert.equal(handleArgs(['slug', 'the change, in the user\'s words'], { _: 'text' }), null)
  assert.equal(handleArgs(['slug', 'one\ntwo'], { _: 'text' }).kind, 'args_unreadable')
})

test('the walk starts where it is told: from the first token for a CLI with no verb', () => {
  assert.equal(handleArgs(['--effort', 'e1'], KINDS, { from: 0 }), null)
  assert.equal(handleArgs(['--effort', 'e 1'], KINDS, { from: 0 }).kind, 'args_unreadable')
})
