// test/fast/planner-caused.test.mjs — lib/boundaries/spec.mjs `plannerCaused`: a compile preview's
// problem goes back to the planner only when it vanishes with the planner's spec reverted.
//
// Design: docs/DESIGN.md#autonomous-review.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { plannerCaused } from '../../lib/boundaries/spec.mjs'

const problem = (file, text, line = 1) => ({ file, line, problem: text })

test("a problem that stands with the planner's spec reverted is not the planner's, wherever it sits; one its spec causes is", () => {
  const dropped = problem('.agentics/e/p/DESIGN.md', 'drops the contract api that p/x consumes', 4)
  const before = problem('.agentics/e/p/s/DESIGN.md', 'was approved, then deleted', 2)
  const inPlannersFile = problem('.agentics/e/p/DESIGN.md', 'names an entry twice', 9)
  const reverted = [{ ...before, line: 7 }, { ...inPlannersFile, line: 3 }]
  assert.deepEqual(plannerCaused([dropped, before, inPlannersFile], reverted), [dropped],
    'a moved line is the same problem; one in the planner\'s own file that stands without its edit is no revision of its')
  assert.deepEqual(plannerCaused([dropped], []), [dropped])
})
