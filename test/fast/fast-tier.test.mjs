// test/fast/fast-tier.test.mjs — pins the rule that keeps test/fast/ free of spawning tests.
//
// The mistake it catches is a test that starts a process landing in the tier meant to run in
// seconds, by importing child_process or by importing a helper from test/ outside the tier.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { lintPlugin } from '../../tools/lint.mjs'
import { id, applies, check } from '../../tools/rules/fast-tier.mjs'

const TEST = 'test/fast/x.test.mjs'
const HELPER = 'test/fast/harness/h.mjs'

test('it applies to every module under test/fast and nothing else', () => {
  assert.equal(id, 'fast-tier')
  assert.ok(applies.test(TEST))
  assert.ok(applies.test(HELPER))
  assert.ok(!applies.test('test/x.test.mjs'))
  assert.ok(!applies.test('test/harness/seeded-repo.mjs'))
  assert.ok(!applies.test('lib/store.mjs'))
})

test('child_process is flagged in every import form, with its line', () => {
  const forms = [
    "import { spawnSync } from 'node:child_process'",
    "import cp from 'child_process'",
    "import * as cp from \"node:child_process\"",
    "import 'node:child_process'",
    "export { execFile } from 'node:child_process'",
    "export * from 'node:child_process'",
    "const cp = await import('node:child_process')",
    "const cp = require('child_process')",
  ]
  for (const form of forms) {
    const found = check(`// header\n${form}\n`, TEST)
    assert.equal(found.length, 1, form)
    assert.equal(found[0].line, 2, form)
    assert.match(found[0].message, /spawns nothing/)
  }
})

test('a multi-line import is reported at its specifier', () => {
  const found = check("import {\n  spawn,\n  execFileSync,\n} from 'node:child_process'\n", TEST)
  assert.deepEqual(found.map((v) => v.line), [4])
})

test('an import from test/ outside the tier is flagged, wherever the importer sits', () => {
  const flagged = [
    [TEST, '../harness/seeded-repo.mjs'],
    [TEST, '../foo.test.mjs'],
    [TEST, './../harness/x.mjs'],
    [HELPER, '../../harness/x.mjs'],
    [HELPER, '../../fixtures/x.mjs'],
  ]
  for (const [file, specifier] of flagged) {
    const found = check(`import { x } from '${specifier}'\n`, file)
    assert.equal(found.length, 1, `${file} -> ${specifier}`)
    assert.match(found[0].message, /outside test\/fast/)
  }
  const forms = [
    `const m = await import('../harness/x.mjs')`,
    `export { x } from '../harness/x.mjs'`,
    `export * from '../harness/x.mjs'`,
    `const m = require('../harness/x.mjs')`,
  ]
  for (const form of forms) assert.equal(check(form, TEST).length, 1, form)
})

test('imports that stay in the tier, or leave test/ for lib and tools, pass', () => {
  const allowed = [
    [TEST, './harness/workflow-host.mjs'],
    [TEST, './other.test.mjs'],
    [TEST, '../../lib/store.mjs'],
    [TEST, '../../tools/rules/fast-tier.mjs'],
    [HELPER, '../../../lib/runner.mjs'],
    [HELPER, '../h2.mjs'],
    [TEST, 'node:fs'],
    [TEST, 'node:test'],
    [TEST, 'node:assert/strict'],
  ]
  for (const [file, specifier] of allowed) {
    assert.deepEqual(check(`import { x } from '${specifier}'\n`, file), [], `${file} -> ${specifier}`)
  }
})

test('text that merely looks like an import is not one', () => {
  const src = [
    "// import { spawnSync } from 'node:child_process'",
    "/* const m = require('child_process') */",
    "const fixture = \"import { x } from '../harness/y.mjs'\"",
    "const prose = `an import of child_process from '../harness/z.mjs'`",
    "const letters = Array.from('abc')",
    'if (import.meta.main) run()',
  ].join('\n')
  assert.deepEqual(check(src, TEST), [])
})

test('every offence in a file is reported, not only the first', () => {
  const src = [
    "import { spawnSync } from 'node:child_process'",
    "import { seededRepo } from '../harness/seeded-repo.mjs'",
  ].join('\n')
  assert.deepEqual(check(src, TEST).map((v) => v.line), [1, 2])
})

test('lintPlugin reaches test/fast and still skips the rest of test/', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fast-tier-'))
  try {
    const bad = "import { spawnSync } from 'node:child_process'\n"
    for (const dir of ['test/fast/harness', 'test/fixtures', 'lib']) mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, 'test/fast/a.test.mjs'), bad)
    writeFileSync(join(root, 'test/fast/harness/h.mjs'), bad)
    writeFileSync(join(root, 'test/fixtures/b.mjs'), bad)
    writeFileSync(join(root, 'test/c.test.mjs'), bad)
    writeFileSync(join(root, 'lib/d.mjs'), bad)

    // A rule that applies to every .mjs, so the walk alone decides which files are judged.
    const findings = await lintPlugin(root, [{ id, applies: /\.mjs$/, check }])
    assert.deepEqual(
      findings.map((f) => f.file).sort(),
      ['lib/d.mjs', 'test/fast/a.test.mjs', 'test/fast/harness/h.mjs'].sort(),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
