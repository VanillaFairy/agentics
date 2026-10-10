// test/host-contract.test.mjs — the host behaviours lib/runner.mjs and lib/host.mjs rest on, checked
// against the real claude CLI. Runs only with AGENTICS_HOST=1.
//
// Design: docs/DESIGN.md#self-checks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { permissionsFor, readOnlyPermissions } from '../lib/locus.mjs'
import { answersIn, projectsDir, resolveCli, transcriptOf } from '../lib/host.mjs'
import { loadRole, roleCommands } from '../lib/roles.mjs'
import { buildArgs, classifyCall, cleanEnv, parseStream, spawner } from '../lib/runner.mjs'

const ON = process.env.AGENTICS_HOST === '1'
const skip = ON ? false : 'set AGENTICS_HOST=1 to run against the real claude CLI'
const netSkip = skip || (process.env.AGENTICS_HOST_NET === '1' ? false : 'set AGENTICS_HOST_NET=1 to fetch https://example.com')
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

/** What a Write-tool call did under the rules `permissionsFor` gives `locus`: the file's existence and why not, if it is absent. */
async function writeUnder(t, locus, file, { folders = [] } = {}) {
  const dir = scratch(t)
  for (const f of folders) mkdirSync(join(dir, f), { recursive: true })
  const { allowed, disallowed } = permissionsFor({ locus })
  const { parsed } = await call(dir, {
    prompt: 'Use the Write tool to create the file "' + file + '" containing A. Then return x = 1.',
    session: randomUUID(), tools: ['Write'], allowed, disallowed,
  })
  const denied = parsed.denials.map((d) => d.tool_name + ' ' + JSON.stringify(d.tool_input))
  return { wrote: existsSync(join(dir, file)), denied, why: 'denials: ' + JSON.stringify(denied) + ', last tool: ' + JSON.stringify(parsed.lastTool) }
}

test('a path with a space is allowed by its rule', { skip, timeout: 180000 }, async (t) => {
  const r = await writeUnder(t, ['my folder/'], 'my folder/a.txt', { folders: ['my folder'] })
  assert.deepEqual(r.denied, [], r.why)
  assert.equal(r.wrote, true, r.why)
})

// The rules a locus becomes allow exactly the listed file: the glob characters of a Next.js route and the
// root-level name are the cases a gitignore-style pattern reads differently from a plain path.
for (const [name, listed, allowedFile, otherFile, folders] of [
  ['brackets', 'app/[slug]/page.tsx', 'app/[slug]/page.tsx', 'app/s/page.tsx', ['app/[slug]', 'app/s']],
  ['parentheses', 'app/(auth)/login.tsx', 'app/(auth)/login.tsx', 'app/auth/login.tsx', ['app/(auth)', 'app/auth']],
  ['a root file', 'package.json', 'package.json', 'packages/x/package.json', ['packages/x']],
]) {
  test('a listed path with ' + name + ' is allowed, and only that path', { skip, timeout: 240000 }, async (t) => {
    const [mine, other] = await Promise.all([
      writeUnder(t, [listed], allowedFile, { folders }),
      writeUnder(t, [listed], otherFile, { folders }),
    ])
    assert.equal(mine.wrote, true, 'the listed path: ' + mine.why)
    assert.equal(other.wrote, false, 'another path the pattern might read as its own: ' + other.why)
    assert.ok(other.denied.length > 0, 'the other write was refused, not skipped: ' + other.why)
  })
}

// A role that writes nothing runs on bare allow rules for its read tools (readOnlyPermissions); each must
// work under dontAsk with no denial. Inside its working folder the host reads and greps with no rule at
// all; the bare rules are what reach a file outside it and the web.

/** The tools a call's stream shows it used, in order. */
const toolsUsed = (stdout) => stdout.split(/\r?\n/).flatMap((line) => {
  let e
  try {
    e = JSON.parse(line)
  } catch {
    return []
  }
  return e.type === 'assistant' ? ((e.message && e.message.content) || []).filter((c) => c.type === 'tool_use').map((c) => c.name) : []
})

/** One call under the rules readOnlyPermissions gives `tools`, with its denials and last tool for a failure's message. */
async function readOnly(dir, { tools, prompt, schema = SCHEMA, model = 'haiku', effort = '' }) {
  const { allowed, disallowed } = readOnlyPermissions({ tools })
  const r = await call(dir, { prompt, session: randomUUID(), tools, allowed, disallowed, schema, model, effort })
  const used = toolsUsed(r.out.stdout)
  const why = 'denials: ' + JSON.stringify(r.parsed.denials) + ', tools used: ' + JSON.stringify(used) + ', last tool: ' +
    JSON.stringify(r.parsed.lastTool) + ', stderr: ' + r.out.stderr.slice(-400)
  return { ...r, used, why }
}

test('a read role reads and greps a file in its folder with no denial', { skip, timeout: 180000 }, async (t) => {
  const dir = scratch(t)
  writeFileSync(join(dir, 'notes.txt'), '7\nalpha 1\nbeta 42\n')
  const schema = { type: 'object', additionalProperties: false, properties: { first: { type: 'integer' }, found: { type: 'integer' } }, required: ['first', 'found'] }
  const r = await readOnly(dir, {
    tools: ['Read', 'Grep', 'Glob'], schema,
    prompt: 'Use the Read tool to read notes.txt and set first to the number on its first line. Then use the Grep tool to search notes.txt for the word beta and set found to the number written after beta on the line it matches.',
  })
  assert.deepEqual(r.parsed.denials, [], r.why)
  assert.ok(r.used.includes('Read') && r.used.includes('Grep'), r.why)
  assert.equal(r.cls.status, 'returned', r.why)
  assert.deepEqual([r.parsed.structured.first, r.parsed.structured.found], [7, 42], r.why)
})

test('the bare Read rule reads a file outside the folder with no denial', { skip, timeout: 180000 }, async (t) => {
  const dir = scratch(t)
  const elsewhere = scratch(t)
  writeFileSync(join(elsewhere, 'secret.txt'), '1234\n')
  const r = await readOnly(dir, { tools: ['Read'], prompt: 'Use the Read tool to read the file ' + join(elsewhere, 'secret.txt') + ' and return x = the number in it.' })
  assert.deepEqual(r.parsed.denials, [], r.why)
  assert.ok(r.used.includes('Read'), r.why)
  assert.equal(r.cls.status, 'returned', r.why)
  assert.equal(r.parsed.structured.x, 1234, r.why)
})

test('the bare WebFetch rule fetches a page with no denial', { skip: netSkip, timeout: 180000 }, async (t) => {
  const dir = scratch(t)
  const schema = { type: 'object', additionalProperties: false, properties: { heading: { type: 'string' } }, required: ['heading'] }
  const r = await readOnly(dir, { tools: ['WebFetch'], schema, prompt: "Use the WebFetch tool to fetch https://example.com and return heading = the page's main heading, exactly as written." })
  assert.deepEqual(r.parsed.denials, [], r.why)
  assert.ok(r.used.includes('WebFetch'), r.why)
  assert.equal(r.cls.status, 'returned', r.why)
  assert.match(r.parsed.structured.heading, /example domain/i, r.why)
})

test('the CLI accepts --effort xhigh', { skip, timeout: 180000 }, async (t) => {
  const dir = scratch(t)
  const bogus = await readOnly(dir, { tools: ['Read'], model: 'sonnet', effort: 'bogus-effort', prompt: 'Return x = 1.' })
  assert.notEqual(bogus.cls.status, 'returned', 'the CLI refuses an effort it does not know: ' + bogus.why)
  const r = await readOnly(dir, { tools: ['Read'], model: 'sonnet', effort: 'xhigh', prompt: 'Return x = 1.' })
  assert.ok(!/unknown --effort/i.test(r.out.stderr), 'the CLI ignored the effort: ' + r.why)
  assert.deepEqual(r.parsed.denials, [], r.why)
  assert.equal(r.cls.status, 'returned', r.why)
  assert.equal(r.parsed.structured.x, 1, r.why)
})

test('a missing session is refused as missing', { skip, timeout: 120000 }, async (t) => {
  const dir = scratch(t)
  const { cls } = await call(dir, { prompt: 'Return x = 1.', session: randomUUID(), resume: true })
  assert.equal(cls.status, 'failed')
  assert.equal(cls.cause, 'session_missing')
})

/** A scratch folder that is a git repository with one commit. */
function repo(t) {
  const dir = scratch(t)
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q'); git('config', 'user.email', 'a@b.c'); git('config', 'user.name', 'n'); git('commit', '-q', '--allow-empty', '-m', 'init')
  return dir
}

test('a write outside the allowed paths is denied and reported', { skip, timeout: 180000 }, async (t) => {
  const dir = scratch(t)
  mkdirSync(join(dir, 'sub')); mkdirSync(join(dir, 'other'))
  const { allowed, disallowed } = permissionsFor({ locus: ['sub/'] })
  const { parsed } = await call(dir, {
    prompt: 'Use the Write tool to create the file "other/b.txt" containing B. Then return x = 1.',
    session: randomUUID(), tools: ['Write'], allowed, disallowed,
  })
  const why = 'denials: ' + JSON.stringify(parsed.denials) + ', last tool: ' + JSON.stringify(parsed.lastTool)
  assert.equal(existsSync(join(dir, 'other', 'b.txt')), false, why)
  assert.deepEqual(parsed.denials.map((d) => d.tool_name), ['Write'], why)
})

test('a compound command is denied whole under a rule for its first command', { skip, timeout: 180000 }, async (t) => {
  const dir = repo(t)
  mkdirSync(join(dir, 'other'))
  const { parsed } = await call(dir, {
    prompt: 'Use the Bash tool to run exactly this one command, then return x = 1: git status && echo x > other/c.txt',
    session: randomUUID(), tools: ['Bash'], allowed: ['Bash(git status:*)'],
  })
  const why = 'denials: ' + JSON.stringify(parsed.denials) + ', last tool: ' + JSON.stringify(parsed.lastTool)
  assert.equal(existsSync(join(dir, 'other', 'c.txt')), false, why)
  assert.deepEqual(parsed.denials.map((d) => d.tool_name), ['Bash'], why)
})

// The git denials hold wherever the option stands: an allow rule for `git diff` is a prefix rule, so a deny rule that is
// also a prefix rule misses `git diff HEAD --output=x`.
for (const [name, command, file] of [
  ['an option right after the subcommand', 'git diff --output=leading.txt HEAD', 'leading.txt'],
  ['an option after other arguments', 'git diff HEAD --output=trailing.txt', 'trailing.txt'],
  ['an option of git log', 'git log -p --output=logged.txt', 'logged.txt'],
]) {
  test('git --output is denied: ' + name, { skip, timeout: 180000 }, async (t) => {
    const dir = repo(t)
    const { allowed, disallowed } = permissionsFor({ locus: [], commands: ['git diff', 'git log', 'git commit'] })
    const { parsed } = await call(dir, {
      prompt: 'Use the Bash tool to run exactly this one command, then return x = 1: ' + command, session: randomUUID(), tools: ['Bash'], allowed, disallowed,
    })
    const why = 'denials: ' + JSON.stringify(parsed.denials) + ', last tool: ' + JSON.stringify(parsed.lastTool)
    assert.equal(existsSync(join(dir, file)), false, why)
    assert.ok(parsed.denials.length > 0, 'the call was refused, not skipped: ' + why)
  })
}

test('git commit --amend is denied after other arguments, and a plain commit is allowed', { skip, timeout: 240000 }, async (t) => {
  const { allowed, disallowed } = permissionsFor({ locus: [], commands: ['git commit', 'git log'] })
  const run = async (command) => {
    const dir = repo(t)
    const { parsed } = await call(dir, { prompt: 'Use the Bash tool to run exactly this one command, then return x = 1: ' + command, session: randomUUID(), tools: ['Bash'], allowed, disallowed })
    const count = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir }).toString().trim())
    return { denials: parsed.denials, count, why: 'denials: ' + JSON.stringify(parsed.denials) }
  }
  const [amend, plain] = await Promise.all([run('git commit -a --allow-empty --amend -m again'), run('git commit --allow-empty -m plain')])
  assert.ok(amend.denials.length > 0 && amend.count === 1, 'the amend: ' + amend.why + ', commits ' + amend.count)
  assert.deepEqual(plain.denials, [], 'the plain commit: ' + plain.why)
  assert.equal(plain.count, 2)
})

test("an implementer's rules let it delete a file its locus lists and commit the deletion", { skip, timeout: 240000 }, async (t) => {
  const dir = repo(t)
  writeFileSync(join(dir, 'gone.txt'), 'old\n')
  execFileSync('git', ['add', 'gone.txt'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'add gone'], { cwd: dir })
  const loaded = loadRole('implementer')
  assert.ok(loaded.ok, loaded.error && loaded.error.message)
  const { allowed, disallowed } = permissionsFor({ locus: ['gone.txt'], commands: roleCommands(loaded.role, {}, null) })
  const { parsed } = await call(dir, {
    prompt: 'Use the Bash tool to run exactly these two commands, one call each, then return x = 1: git rm -q gone.txt   and then   git commit -q -m "Drop gone"',
    session: randomUUID(), tools: ['Bash'], allowed, disallowed,
  })
  const why = 'denials: ' + JSON.stringify(parsed.denials)
  assert.deepEqual(parsed.denials, [], why)
  assert.equal(execFileSync('git', ['ls-files', 'gone.txt'], { cwd: dir }).toString().trim(), '', why)
  assert.equal(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: dir }).toString().trim(), 'Drop gone', why)
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
