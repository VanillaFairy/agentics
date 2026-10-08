// tools/suite-reporter.mjs — the spec report on stdout, plus one JSON line per failed test
// appended to the file named by AGENTICS_TEST_FAILURES.
//
// tools/suite.mjs reads that file to learn which tests failed, so it never parses a
// human-formatted report. One reporter does both jobs because node warns of a listener leak
// when a rerun-failures run has two. A parent that failed only because a child did is not
// recorded: the child is the failure.

import { appendFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { spec } from 'node:test/reporters'

async function* recording(source) {
  const failures = process.env.AGENTICS_TEST_FAILURES
  for await (const event of source) {
    if (failures && event.type === 'test:fail' && event.data.details?.error?.failureType !== 'subtestsFailed') {
      const { name, file, line, column } = event.data
      appendFileSync(failures, JSON.stringify({ name, file, line, column }) + '\n')
    }
    yield event
  }
}

export default async function* reporter(source) {
  yield* Readable.from(recording(source)).pipe(new spec())
}
