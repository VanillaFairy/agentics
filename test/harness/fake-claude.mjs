// test/harness/fake-claude.mjs — stands in for claude.exe: plays the next call of the scenario file
// FAKE_CLAUDE_SCENARIO names, and logs what it was given to FAKE_CLAUDE_LOG.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const scenario = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SCENARIO, 'utf8'))
const counter = process.env.FAKE_CLAUDE_SCENARIO + '.n'
const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0
writeFileSync(counter, String(n + 1))
const call = scenario.calls[n] || { stdout: [], stderr: 'no scripted call ' + n, code: 9 }
let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => { stdin += d })
process.stdin.on('end', () => {
  if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\n')
  setTimeout(() => {
    for (const line of call.stdout || []) process.stdout.write(line + '\n')
    if (call.stderr) process.stderr.write(call.stderr)
    process.exitCode = call.code || 0
  }, call.delay_ms || 0)
})
