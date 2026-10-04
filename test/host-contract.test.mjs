// test/host-contract.test.mjs — the host behaviours lib/runner.mjs and lib/host.mjs rest on, checked
// against the real claude CLI. Runs only with AGENTICS_HOST=1.
//
// Design: docs/DESIGN.md#self-checks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { answersIn, projectsDir, resolveCli, transcriptOf } from '../lib/host.mjs'
import { buildArgs, classifyCall, cleanEnv, parseStream, spawner } from '../lib/runner.mjs'

const ON = process.env.AGENTICS_HOST === '1'
const skip = ON ? false : 'set AGENTICS_HOST=1 to run against the real claude CLI'
const SCHEMA = { type: 'object', additionalProperties: false, properties: { x: { type: 'integer' } }, required: ['x'] }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-host-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'role.md'), 'Answer exactly what you are asked, in the schema.')
  return dir
}
const cli = () => { const r = resolveCli(); assert.ok(r.ok, r.error && r.error.message); return spawner(r.path) }
const call = async (dir, { prompt, session, resume = false, model = 'haiku', effort = '', tools = [], allowed = [], disallowed = [], schema = SCHEMA, cwd = dir }) => {
  const args = buildArgs({ systemPromptFile: join(dir, 'role.md'), tools, allowed, disallowed, model, effort, schema, session, resume })
  const out = await cli()(args, { stdin: prompt, env: cleanEnv(process.env), cwd })
  const parsed = parseStream(out.stdout)
  return { out, parsed, cls: classifyCall({ code: out.code, stderr: out.stderr, parsed }) }
}

test('the final stream event carries the validated return', { skip, timeout: 180000 }, async (t) => {
  const dir = scratch(t)
  const { cls, parsed } = await call(dir, { prompt: 'Return x = 7.', session: randomUUID() })
  assert.equal(cls.status, 'returned')
  assert.equal(parsed.structured.x, 7)
  assert.equal(typeof parsed.costTotal, 'number')
  assert.ok(parsed.usage && typeof parsed.usage.input_tokens === 'number')
})

test('a long brief on stdin and many rules start', { skip, timeout: 180000 }, async (t) => {
  const dir = scratch(t)
  const deny = Array.from({ length: 300 }, (_, i) => 'Write(path/' + i + '/f.ts)')
  const brief = 'Filler. '.repeat(8000) + '\nReturn x = 1.'
  const { cls } = await call(dir, { prompt: brief, session: randomUUID(), disallowed: deny })
  assert.equal(cls.status, 'returned')
})

test('effort changes the thinking spent', { skip, timeout: 300000 }, async (t) => {
  const dir = scratch(t)
  const thinking = async (effort) => (await call(dir, { prompt: 'Compute 1234 * 5678 - 999; return x.', session: randomUUID(), model: 'sonnet', effort }))
    .parsed.usage.output_tokens_details?.thinking_tokens ?? 0
  assert.ok(await thinking('low') < await thinking('high'))
})

test('a session resumes from another folder and on another model, and its cost accumulates', { skip, timeout: 300000 }, async (t) => {
  const dir = scratch(t)
  const other = join(dir, 'elsewhere'); mkdirSync(other)
  const session = randomUUID()
  const first = await call(dir, { prompt: 'Remember the number 41. Return x = 41.', session })
  const again = await call(dir, { prompt: 'Return x = the number you were asked to remember.', session, resume: true, model: 'sonnet', cwd: other })
  assert.equal(again.parsed.structured.x, 41)
  assert.ok(again.parsed.costTotal >= first.parsed.costTotal)
  assert.ok(transcriptOf(session) !== '', 'the host keeps the session where lib/host.mjs looks')
})

test("a session's tool shell sees its own session id", { skip, timeout: 180000 }, async (t) => {
  const dir = scratch(t)
  writeFileSync(join(dir, 'sid.mjs'), "import { writeFileSync } from 'node:fs'\nwriteFileSync('sid.txt', process.env.CLAUDE_CODE_SESSION_ID || '')\n")
  const session = randomUUID()
  await call(dir, { prompt: 'Run exactly: node sid.mjs . Then return x = 1.', session, tools: ['Bash'], allowed: ['Bash(node:*)'] })
  assert.equal(readFileSync(join(dir, 'sid.txt'), 'utf8'), session)
})

test('an answered question lands where answersIn reads it', { skip }, (t) => {
  const root = projectsDir()
  if (!existsSync(root)) return t.skip('the host keeps no transcripts here')
  const files = readdirSync(root).flatMap((d) => {
    try { return readdirSync(join(root, d)).filter((f) => f.endsWith('.jsonl')).map((f) => join(root, d, f)) } catch { return [] }
  }).map((f) => ({ f, at: statSync(f).mtimeMs })).sort((a, b) => b.at - a.at).slice(0, 50)
  const asked = files.map(({ f }) => readFileSync(f, 'utf8')).filter((text) => text.includes('"name":"AskUserQuestion"'))
  if (asked.length === 0) return t.skip('none of the 50 newest transcripts asked the user a question')
  assert.ok(asked.some((text) => answersIn(text).length > 0), 'transcripts that asked questions record no answer answersIn reads')
})

test('a path with a space is allowed by its rule', { skip, timeout: 180000 }, async (t) => {
  const dir = scratch(t)
  mkdirSync(join(dir, 'my folder'))
  const { parsed } = await call(dir, {
    prompt: 'Write my folder/a.txt containing A, then return x = 1.', session: randomUUID(), tools: ['Write'], allowed: ['Write(my folder/**)'],
  })
  assert.equal(existsSync(join(dir, 'my folder', 'a.txt')), true)
})

test('a missing session is refused as missing', { skip, timeout: 120000 }, async (t) => {
  const dir = scratch(t)
  const { cls } = await call(dir, { prompt: 'Return x = 1.', session: randomUUID(), resume: true })
  assert.equal(cls.status, 'failed')
  assert.equal(cls.cause, 'session_missing')
})

test('writes outside the allowed paths and compound commands are denied and reported', { skip, timeout: 240000 }, async (t) => {
  const dir = scratch(t)
  mkdirSync(join(dir, 'sub')); mkdirSync(join(dir, 'other'))
  const { parsed } = await call(dir, {
    prompt: 'Do each step even if one fails: 1) write sub/a.txt containing A; 2) write other/b.txt containing B; ' +
      '3) run exactly: git status && echo x > other/c.txt . Then return x = the number of steps that succeeded.',
    session: randomUUID(), tools: ['Write', 'Bash'], allowed: ['Write(sub/**)', 'Bash(git status:*)'],
  })
  assert.equal(existsSync(join(dir, 'sub', 'a.txt')), true)
  assert.equal(existsSync(join(dir, 'other', 'b.txt')), false)
  assert.equal(existsSync(join(dir, 'other', 'c.txt')), false)
  assert.ok(parsed.denials.length >= 2)
})

test('a detached program outlives the session that started it', { skip, timeout: 240000 }, async (t) => {
  const dir = scratch(t)
  writeFileSync(join(dir, 'beat.mjs'), "import { appendFileSync, existsSync, writeFileSync } from 'node:fs'\nlet n = 0\n" +
    "const t = setInterval(() => {\n  appendFileSync('beat.txt', 'b\\n')\n  if (++n >= 60 || existsSync('stop.txt')) { clearInterval(t); writeFileSync('done.txt', 'done') }\n}, 1000)\n")
  writeFileSync(join(dir, 'launch.mjs'), "import { spawn } from 'node:child_process'\nspawn(process.execPath, ['beat.mjs'], { detached: true, stdio: 'ignore' }).unref()\n")
  await call(dir, { prompt: 'Run exactly: node launch.mjs . Then return x = 1.', session: randomUUID(), tools: ['Bash'], allowed: ['Bash(node:*)'] })
  const count = () => (existsSync(join(dir, 'beat.txt')) ? readFileSync(join(dir, 'beat.txt'), 'utf8').split('\n').length : 0)
  const before = count()
  await sleep(3000)
  const after = count()
  // The heartbeat runs in the scratch folder, which Windows will not remove while it runs: stop it before cleanup.
  writeFileSync(join(dir, 'stop.txt'), 'stop')
  for (let i = 0; i < 20 && !existsSync(join(dir, 'done.txt')); i++) await sleep(500)
  await sleep(500)
  assert.ok(after > before, 'the heartbeat stopped when the session ended')
})
