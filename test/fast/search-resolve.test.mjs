// test/fast/search-resolve.test.mjs — what a piece of material names, found with no model: the
// paths it cites, the identifiers it writes in code form, the documents it names.
//
// Design: docs/DESIGN.md#p2--code-does-what-is-deterministic-models-only-judge.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mentionsOf } from '../../lib/search/resolve.mjs'

const DESIGN = [
  '## Drop stall',
  '',
  'The stall (`src/drop/stall.ts`) offers `ITEM_STAND` through StallOffer, and `seatDay()` decides the',
  'order. See lib/kb.mjs:61 and app/[id]/page.tsx, plus CLAUDE.md and docs/kb/GOTCHAS.md. The',
  'ground_known flag stays; QUEST_WORDS feed the clips. Version 1.13.0, e.g. and/or read/write, see',
  'https://github.com/pmndrs/zustand/blob/main/src/vanilla.ts for the store.',
].join('\n')

test('mentionsOf finds what design prose names: paths, identifiers and documents, in order', () => {
  assert.deepEqual(mentionsOf(DESIGN), {
    paths: ['src/drop/stall.ts', 'lib/kb.mjs', 'app/[id]/page.tsx', 'docs/kb/GOTCHAS.md'],
    symbols: ['ITEM_STAND', 'StallOffer', 'seatDay', 'ground_known', 'QUEST_WORDS'],
    docs: ['CLAUDE.md'],
  })
})

test('a cited line or range is not part of the path', () => {
  assert.deepEqual(mentionsOf('see `lib/kb.mjs:61` and src/drop/stall.ts:12-30.').paths, ['lib/kb.mjs', 'src/drop/stall.ts'])
})

test('a Windows path, a leading ./ and a plain path are one posix path', () => {
  assert.deepEqual(mentionsOf('src\\core\\a.ts and ./src/core/a.ts and src/core/a.ts:4').paths, ['src/core/a.ts'])
})

test('an absolute path, a climb out of the repository, a URL, a version, e.g. and and/or are not paths', () => {
  const m = mentionsOf('../../etc/passwd.txt /etc/hosts.txt C:\\Users\\x\\a.txt https://x.io/a/b.js 1.13.0 e.g. and/or read/write')
  assert.deepEqual(m.paths, [])
})

test('a bare file name is a path only in backticks, and a bare .md name is a document', () => {
  const m = mentionsOf('`eslint.config.js` and eslint.config.js, `INDEX.md` and GOTCHAS.md')
  assert.deepEqual(m.paths, ['eslint.config.js'])
  assert.deepEqual(m.docs, ['INDEX.md', 'GOTCHAS.md'])
})

test('a backticked identifier is a symbol, its trailing () dropped, and a code span is scanned for more', () => {
  const m = mentionsOf('`null` and `pets`, `showOffer()`, and `offer(stall, BAZ_QUX)`')
  assert.deepEqual(m.symbols, ['null', 'pets', 'showOffer', 'BAZ_QUX'])
})

test('plain words, capitalised words, acronyms and one-part lowercase words are not symbols', () => {
  assert.deepEqual(mentionsOf('The scout reads files. However API JSON CRLF L2 and data stay words.').symbols, [])
})

test('a token inside a path or a URL is not also a symbol', () => {
  const m = mentionsOf('src/stall_offer/StallView.ts and https://x.io/utm_source/ItemStand')
  assert.deepEqual(m.symbols, [])
  assert.deepEqual(m.paths, ['src/stall_offer/StallView.ts'])
})

test('mentions are deduped and kept in the order they first appear', () => {
  const m = mentionsOf('`ITEM_STAND` then ITEM_STAND, src/a.ts then src/a.ts:3, CLAUDE.md twice CLAUDE.md, then `seatDay`')
  assert.deepEqual(m, { paths: ['src/a.ts'], symbols: ['ITEM_STAND', 'seatDay'], docs: ['CLAUDE.md'] })
})

test('mentionsOf is pure and takes no text as no mentions', () => {
  assert.deepEqual(mentionsOf(DESIGN), mentionsOf(DESIGN))
  assert.deepEqual(mentionsOf(''), { paths: [], symbols: [], docs: [] })
  assert.deepEqual(mentionsOf(undefined), { paths: [], symbols: [], docs: [] })
})

// ---- added by the test author: invariants the cases above leave to chance ----

const pathsOf = (text) => mentionsOf(text).paths
const symbolsOf = (text) => mentionsOf(text).symbols
const docsOf = (text) => mentionsOf(text).docs

test('the punctuation and markup around a path are not part of it', () => {
  const text = 'see src/a.ts. And (lib/b.mjs), "docs/c.md"; **src/d.ts** <lib/e.ts> | src/f.ts |, src/g.ts,src/h.ts and lib/kb.mjs:61.'
  assert.deepEqual(pathsOf(text), ['src/a.ts', 'lib/b.mjs', 'docs/c.md', 'src/d.ts', 'lib/e.ts', 'src/f.ts', 'src/g.ts', 'src/h.ts', 'lib/kb.mjs'])
})

test('a path keeps every character a segment may hold: dots, @, - , _ and [ ]', () => {
  const text = '.github/workflows/ci.yml node_modules/@types/node/index.d.ts packages/my-lib/src/a_b.test.ts app/[id]/page.tsx'
  assert.deepEqual(pathsOf(text), ['.github/workflows/ci.yml', 'node_modules/@types/node/index.d.ts', 'packages/my-lib/src/a_b.test.ts', 'app/[id]/page.tsx'])
})

test('a leading ./ is dropped from a Windows spelling too, and every spelling of one file is one mention', () => {
  const m = pathsOf('.\\src\\core\\a.ts, ./src/core/a.ts, src/core/a.ts:4, src\\core\\a.ts:4-9 and `src/core/a.ts`')
  assert.deepEqual(m, ['src/core/a.ts'])
})

test('the extension is letters ending in a letter, at most eight characters', () => {
  assert.deepEqual(pathsOf('lib/a.abcdefgh'), ['lib/a.abcdefgh'])
  assert.deepEqual(pathsOf('lib/a.abcdefghi'), [], 'nine characters is no extension, and no eight-character prefix of it is a path')
  assert.deepEqual(pathsOf('lib/b.mp3 and lib/c.'), [])
})

test('an absolute path is not a path, and no relative tail of it is mistaken for one', () => {
  assert.deepEqual(pathsOf('/home/u/repo/src/a.ts and /etc/x.txt and C:/x/a.txt and C:\\Work\\repo\\src\\a.ts'), [])
  assert.deepEqual(pathsOf('/home/u/repo/src/a.ts then src/ok.ts'), ['src/ok.ts'])
})

test('a path that climbs out is not a path, and no tail of it is mistaken for one', () => {
  assert.deepEqual(pathsOf('../src/a.ts and ../../etc/passwd.txt and ..\\src\\b.ts'), [])
  assert.deepEqual(pathsOf('../src/a.ts then src/ok.ts'), ['src/ok.ts'])
})

test('nothing inside a URL is a mention: no path, no document, no identifier, whatever it carries', () => {
  const m = mentionsOf('https://x.io/a?file=src/b.ts#lib/c.mjs http://localhost:3000/src/a.ts https://x.io/docs/README.md https://x.io/get_user/getUser/GET_USER')
  assert.deepEqual(m, { paths: [], symbols: [], docs: [] })
  assert.deepEqual(pathsOf('see https://x.io/a.js and src/ok.ts'), ['src/ok.ts'])
})

test('versions, ratios and slashed words are not paths', () => {
  assert.deepEqual(pathsOf('node/20.11.0 and 1/2 and TCP/IP, yes/no, w/o'), [])
})

test('Windows line endings do not leak into a mention', () => {
  const m = mentionsOf('see `src/a.ts`\r\nand lib/b.mjs\r\nplus CLAUDE.md\r\nand `seatDay`\r\n')
  assert.deepEqual(m, { paths: ['src/a.ts', 'lib/b.mjs'], symbols: ['seatDay'], docs: ['CLAUDE.md'] })
})

test('a directory-qualified .md is a path and not a document; a bare one is a document and not a path, backticked or not', () => {
  const m = mentionsOf('docs/README.md and README.md. Also `NOTES.md`, my-notes.md and `docs/kb/INDEX.md`')
  assert.deepEqual(m.paths, ['docs/README.md', 'docs/kb/INDEX.md'])
  assert.deepEqual(m.docs, ['README.md', 'NOTES.md', 'my-notes.md'])
})

test('SCREAMING_CASE and snake_case of three parts are symbols, as is lowerCamel or CamelCase beside punctuation', () => {
  assert.deepEqual(symbolsOf('MAX_RETRY_COUNT and load_all_files'), ['MAX_RETRY_COUNT', 'load_all_files'])
  assert.deepEqual(symbolsOf('(ITEM_STAND), seatDay. **ground_known**: StallOffer; "QUEST_WORDS"'), ['ITEM_STAND', 'seatDay', 'ground_known', 'StallOffer', 'QUEST_WORDS'])
})

test('a hyphenated word and a one-hump capitalised word are not symbols', () => {
  assert.deepEqual(symbolsOf('A well-known read-only Stall Offer Item, Version Two.'), [])
})

test('a code span that is no identifier names no symbol by its words', () => {
  assert.deepEqual(symbolsOf('run `git status` then `npm run build` and `a b c`'), [])
})

test('a backticked name with () and nothing else is the name', () => {
  assert.deepEqual(symbolsOf('`render()` and `Foo`'), ['render', 'Foo'])
})

test('one identifier written three ways is one mention, at the place it first appeared', () => {
  assert.deepEqual(symbolsOf('showOffer then `showOffer()` then showOffer and `showOffer`'), ['showOffer'])
  assert.deepEqual(symbolsOf('BB_CC then `aB` then AA_BB then BB_CC'), ['BB_CC', 'aB', 'AA_BB'])
})

test('a path, a document or a URL is never also a symbol', () => {
  const m = mentionsOf('`lib/get_user.mjs` and src/stall_offer/StallView.ts and README.md and https://x.io/ground_known')
  assert.deepEqual(m.symbols, [])
})

test('a stray backtick neither swallows the rest nor throws', () => {
  const m = mentionsOf('a stray ` then src/a.ts and ITEM_STAND')
  assert.deepEqual(m.paths, ['src/a.ts'])
  assert.deepEqual(m.symbols, ['ITEM_STAND'])
})

test('each call returns fresh arrays: changing one result never changes the next', () => {
  const first = mentionsOf('')
  first.paths.push('x/y.ts'); first.symbols.push('X_Y'); first.docs.push('X.md')
  assert.deepEqual(mentionsOf(''), { paths: [], symbols: [], docs: [] })
  const a = mentionsOf(DESIGN)
  a.paths.length = 0
  assert.equal(mentionsOf(DESIGN).paths.length, 4)
})

test('null and non-string text are no mentions and never throw', () => {
  assert.deepEqual(mentionsOf(null), { paths: [], symbols: [], docs: [] })
})

test('a long document and hostile text are scanned in bounded time', () => {
  const prose = 'The stall (`src/drop/stall.ts`) offers `ITEM_STAND` through StallOffer. '.repeat(3000)
  const hostile = ['a/'.repeat(3000) + '!', 'a.'.repeat(3000) + '/', '`'.repeat(3000), '_'.repeat(3000) + ' ', 'aB'.repeat(3000) + '.', 'a/b.'.repeat(1500) + '-',
    '[' .repeat(3000), 'https://' + 'a/'.repeat(3000), '.'.repeat(3000) + '/x', 'A_'.repeat(3000) + '.md']
  const start = performance.now()
  const m = mentionsOf(prose)
  for (const h of hostile) mentionsOf(h)
  const took = performance.now() - start
  assert.deepEqual(m, { paths: ['src/drop/stall.ts'], symbols: ['ITEM_STAND', 'StallOffer'], docs: [] })
  assert.ok(took < 5000, 'took ' + Math.round(took) + ' ms')
})
