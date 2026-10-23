// test/spec-dispatch.test.mjs — pins the spec check's refusal of a task `dispatch` that names a model
// or an effort the runner does not know, at the file and line that wrote it.
//
// Design: docs/DESIGN.md#model-tier.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { EFFORTS, MODELS } from '../lib/roles.mjs'
import { checkFolder } from '../lib/spec.mjs'
import { specPath } from '../lib/store.mjs'

const SPEC = (dispatch) => [
  '# Dispatch', '', '## Intent', '', 'A task names the tier it runs at.', '', '## Decisions', '',
  '| id | decision | why |', '|---|---|---|', '| D1 | The runner runs what the plan lists. | The author holds the context. |',
  '', '## Design', '', 'Nothing more.', '', '## Plan', '',
  '- **runner** — task · realises: D1 · rigor: tdd · expects: src/a/X.ts · dispatch: ' + dispatch, '  Build the runner',
  '  - [ ] it runs — check: `node --test src/a/X.test.mjs`', '', '## Open questions', '', '## Evidence', '',
].join('\n')

/** An effort `e1` whose root spec's one task carries `dispatch`; its checkFolder result and the dispatch's line. */
function checked(t, dispatch) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-spec-dispatch-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const text = SPEC(dispatch)
  mkdirSync(dirname(specPath(repo, 'e1', '.')), { recursive: true })
  writeFileSync(specPath(repo, 'e1', '.'), text)
  return { out: checkFolder(repo, 'e1', '.'), line: text.split('\n').findIndex((l) => l.includes('· dispatch: ')) + 1 }
}

test('a dispatch naming known models and efforts passes', (t) => {
  const { out } = checked(t, 'producer=' + MODELS[1] + '/' + EFFORTS[1] + ', reviewer=' + MODELS[2] + '/' + EFFORTS[3])
  assert.deepEqual(out.problems, [])
})

test('a dispatch naming an unknown model is refused with its file and line', (t) => {
  const { out, line } = checked(t, 'producer=gpt5/medium')
  assert.equal(out.problems.length, 1, JSON.stringify(out.problems))
  assert.equal(out.problems[0].file, out.file)
  assert.equal(out.problems[0].line, line)
  assert.match(out.problems[0].problem, /gpt5/)
  assert.match(out.problems[0].problem, /model/)
})

test('a dispatch naming an unknown effort is refused with its file and line', (t) => {
  const { out, line } = checked(t, 'reviewer=opus/ultra')
  assert.equal(out.problems.length, 1, JSON.stringify(out.problems))
  assert.equal(out.problems[0].file, out.file)
  assert.equal(out.problems[0].line, line)
  assert.match(out.problems[0].problem, /ultra/)
  assert.match(out.problems[0].problem, /effort/)
})
