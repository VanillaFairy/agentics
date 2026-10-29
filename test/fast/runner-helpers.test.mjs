// test/fast/runner-helpers.test.mjs — pins the runner's pure helpers: the arguments of one host call,
// the child's environment, how a stream-json output reads, and what a finished call amounts to.
//
// Design: docs/DESIGN.md#the-agent-runner and docs/DESIGN.md#host-stops.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { KEPT_HOST_VARIABLES, LEAN_FLAGS, PERMISSION_FLAGS, buildArgs, classifyCall, cleanEnv, dispatchedEntry, parseStream, returnedEntry } from '../../lib/runner.mjs'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'runner')
const SUCCESS = readFileSync(join(fixtures, 'stream-success.jsonl'), 'utf8')
const SCHEMA_FAILED = readFileSync(join(fixtures, 'stream-schema-failed.jsonl'), 'utf8')
const events = (text) => text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
const SUCCESS_RESULT = events(SUCCESS).find((e) => e.type === 'result')
const SESSION = SUCCESS_RESULT.session_id

const SCHEMA = { type: 'object', properties: { status: { enum: ['done', 'blocked'] }, text: { type: 'string' } }, required: ['status'] }
const call = (over = {}) => ({
  systemPromptFile: 'C:/plugin/agents/executor.md', tools: ['Read', 'Bash', 'Edit'], model: 'opus',
  schema: SCHEMA, session: SESSION, ...over,
})

/** The index of `flag`, asserting it occurs exactly once. */
function at(args, flag) {
  const i = args.indexOf(flag)
  assert.ok(i >= 0, `${flag} missing from ${JSON.stringify(args)}`)
  assert.equal(args.lastIndexOf(flag), i, `${flag} occurs more than once`)
  return i
}

/** The index where `seq` occurs contiguously in `args`, or -1. */
function seqAt(args, seq) {
  for (let i = 0; i + seq.length <= args.length; i++) if (seq.every((s, k) => args[i + k] === s)) return i
  return -1
}

const resultLine = (fields) => JSON.stringify({ type: 'result', session_id: SESSION, num_turns: 1, total_cost_usd: 0.001, ...fields })
const stream = (...lines) => [SUCCESS.split('\n')[0], ...lines].join('\n') + '\n'

test('a call prints its stream', () => {
  const args = buildArgs(call())
  assert.equal(args[0], '-p')
  const o = at(args, '--output-format')
  assert.equal(args[o + 1], 'stream-json')
  assert.ok(at(args, '--verbose') > o)
  assert.ok(args.every((a) => typeof a === 'string'), 'every argument is a string')
})

test('a call names its role file and tools', () => {
  const c = call()
  const args = buildArgs(c)
  const f = at(args, '--system-prompt-file')
  assert.equal(args[f + 1], c.systemPromptFile)
  const t = at(args, '--tools')
  assert.equal(args[t + 1], c.tools.join(','))
  assert.ok(f > at(args, '--verbose'), 'the role file follows the stream flags')
  assert.ok(t > f, 'the tools follow the role file')
})

const MCP_CONFIG = 'C:/run/searches/probe~a/mcp-0a1b2c3d.json'

test("an mcp tool reaches the host through its server's config, never through --tools", () => {
  const tools = ['mcp__search__grep', 'mcp__search__read']
  const args = buildArgs(call({ tools, allowed: tools, mcpConfig: MCP_CONFIG }))
  assert.equal(args[at(args, '--tools') + 1], '', 'a role of mcp tools only runs with no host tools')
  assert.equal(args[at(args, '--mcp-config') + 1], MCP_CONFIG)
  const l = seqAt(args, LEAN_FLAGS)
  assert.ok(at(args, '--mcp-config') >= l + LEAN_FLAGS.length, 'the config follows the lean flags, --strict-mcp-config among them')
  assert.ok(at(args, '--mcp-config') < at(args, '--model'), 'and precedes the model')
  assert.deepEqual(args.slice(at(args, '--allowedTools') + 1, at(args, '--allowedTools') + 1 + tools.length), tools, 'the mcp tools are allowed by name')
})

test('a role mixing host and mcp tools passes only the host ones to --tools', () => {
  const args = buildArgs(call({ tools: ['WebSearch', 'mcp__search__fetch'], mcpConfig: MCP_CONFIG }))
  assert.equal(args[at(args, '--tools') + 1], 'WebSearch')
})

test('no --mcp-config without a config', () => {
  assert.equal(buildArgs(call()).indexOf('--mcp-config'), -1)
  assert.equal(buildArgs(call({ mcpConfig: '' })).indexOf('--mcp-config'), -1)
  assert.equal(buildArgs(call())[at(buildArgs(call()), '--tools') + 1], call().tools.join(','), 'host tools are passed as before')
})

test('allowed rules go on the command line, and only when there are some', () => {
  const allowed = ['Bash(npm test:*)', 'Bash(git status:*)', 'Edit(/C:/w/src/**)']
  const args = buildArgs(call({ allowed }))
  const a = at(args, '--allowedTools')
  assert.deepEqual(args.slice(a + 1, a + 1 + allowed.length), allowed)
  assert.ok(a > at(args, '--tools'))
  assert.ok(a + allowed.length < seqAt(args, PERMISSION_FLAGS), 'the rules precede the permission flags')
  assert.equal(buildArgs(call({ allowed: [] })).indexOf('--allowedTools'), -1)
  assert.equal(buildArgs(call()).indexOf('--allowedTools'), -1)
})

test('disallowed rules go on the command line, and only when there are some', () => {
  const allowed = ['Bash(npm test:*)']
  const disallowed = ['Read(/C:/w/src/green/**)', 'Bash(git push:*)']
  const args = buildArgs(call({ allowed, disallowed }))
  const d = at(args, '--disallowedTools')
  assert.deepEqual(args.slice(d + 1, d + 1 + disallowed.length), disallowed)
  assert.ok(d > at(args, '--allowedTools') + allowed.length, 'disallowed follows the allowed rules')
  assert.ok(d + disallowed.length < seqAt(args, PERMISSION_FLAGS), 'the rules precede the permission flags')
  const alone = buildArgs(call({ disallowed }))
  assert.equal(alone.indexOf('--allowedTools'), -1)
  assert.ok(at(alone, '--disallowedTools') > at(alone, '--tools'))
  assert.equal(buildArgs(call({ disallowed: [] })).indexOf('--disallowedTools'), -1)
  assert.equal(buildArgs(call()).indexOf('--disallowedTools'), -1)
})

test('a call is confined and lean', () => {
  for (const [flag, value] of [['--permission-mode', 'dontAsk'], ['--permission-prompts', 'none']]) {
    assert.equal(PERMISSION_FLAGS[PERMISSION_FLAGS.indexOf(flag) + 1], value)
  }
  assert.equal(LEAN_FLAGS[LEAN_FLAGS.indexOf('--setting-sources') + 1], '')
  for (const f of ['--strict-mcp-config', '--disable-slash-commands']) assert.ok(LEAN_FLAGS.includes(f))

  const args = buildArgs(call({ allowed: ['Bash(npm test:*)'], disallowed: ['Bash(git push:*)'], effort: 'high' }))
  for (const entry of [...PERMISSION_FLAGS, ...LEAN_FLAGS]) assert.ok(args.includes(entry), `${JSON.stringify(entry)} missing`)
  assert.equal(args[at(args, '--setting-sources') + 1], '')
  const p = seqAt(args, PERMISSION_FLAGS)
  const l = seqAt(args, LEAN_FLAGS)
  assert.ok(p > at(args, '--disallowedTools'), 'permission flags follow the rules')
  assert.ok(l > p, 'lean flags follow the permission flags')
  assert.ok(l + LEAN_FLAGS.length <= at(args, '--model'), 'the model follows the lean flags')
})

test('the tier sets the model, and the effort when there is one', () => {
  const args = buildArgs(call({ model: 'sonnet', effort: 'medium' }))
  const m = at(args, '--model')
  assert.equal(args[m + 1], 'sonnet')
  const e = at(args, '--effort')
  assert.equal(args[e + 1], 'medium')
  assert.ok(e > m, 'the effort follows the model')
  assert.ok(e < at(args, '--json-schema'), 'the effort precedes the schema')

  for (const without of [buildArgs(call({ model: 'haiku' })), buildArgs(call({ model: 'haiku', effort: '' }))]) {
    assert.equal(without[at(without, '--model') + 1], 'haiku')
    assert.equal(without.indexOf('--effort'), -1)
  }
})

test('the schema travels as JSON', () => {
  const args = buildArgs(call())
  const s = at(args, '--json-schema')
  assert.equal(typeof args[s + 1], 'string')
  assert.deepEqual(JSON.parse(args[s + 1]), SCHEMA)
  assert.ok(s > at(args, '--model'), 'the schema follows the model')
})

test('a first call names its session; a resumed one resumes it', () => {
  const first = buildArgs(call())
  assert.deepEqual(first.slice(-2), ['--session-id', SESSION])
  assert.equal(first.indexOf('--resume'), -1)
  assert.ok(at(first, '--session-id') > at(first, '--json-schema'))

  const explicit = buildArgs(call({ resume: false }))
  assert.deepEqual(explicit.slice(-2), ['--session-id', SESSION])

  const resumed = buildArgs(call({ resume: true }))
  assert.deepEqual(resumed.slice(-2), ['--resume', SESSION])
  assert.equal(resumed.indexOf('--session-id'), -1)
  assert.ok(at(resumed, '--resume') > at(resumed, '--json-schema'))
})

test('a call without a schema is refused', () => {
  assert.throws(() => buildArgs(call({ schema: undefined })))
  const { schema, ...noSchema } = call()
  assert.throws(() => buildArgs(noSchema))
})

const SESSION_OWNED = ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ACCOUNT_UUID', 'CLAUDE_CODE_ORGANIZATION_UUID', 'CLAUDE_CODE_OAUTH_SCOPES', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_DESKTOP_APP_VERSION', 'CLAUDE_CODE_A_FUTURE_HOST_MARKER']
const ENV = {
  ...Object.fromEntries(SESSION_OWNED.map((k) => [k, 'x'])),
  ...Object.fromEntries(KEPT_HOST_VARIABLES.map((k) => [k, 'kept'])),
  CLAUDECODE: '1', AI_AGENT: 'claude-code',
  CLAUDE_CONFIG_DIR: 'C:/Users/u/.claude', PATH: 'C:/bin;C:/tools', HOME: 'C:/Users/u',
  ANTHROPIC_MODEL: 'opus', CLAUDE_PLUGIN_ROOT: 'C:/plugin', CLAUDECODE_EXTRA: 'x', MY_CLAUDE_CODE_NOTE: 'y',
}
const DROPPED = (k) => (k.startsWith('CLAUDE_CODE_') && !KEPT_HOST_VARIABLES.includes(k)) || k === 'CLAUDECODE' || k === 'AI_AGENT'

test("the launching session's variables are dropped", () => {
  const out = cleanEnv({ ...ENV })
  const dropped = Object.keys(ENV).filter(DROPPED)
  assert.ok(dropped.length >= SESSION_OWNED.length + 2)
  for (const k of dropped) assert.ok(!(k in out), `${k} kept`)
})

test('a session-owned CLAUDE_CODE_ variable is dropped, and so is one no one listed', () => {
  const out = cleanEnv({ ...ENV, CLAUDE_CODE_NEXT_RELEASE_MARKER: '1' })
  for (const k of [...SESSION_OWNED, 'CLAUDE_CODE_NEXT_RELEASE_MARKER']) assert.ok(!(k in out), `${k} kept`)
})

test("the user's CLAUDE_CODE_ settings are kept", () => {
  assert.ok(KEPT_HOST_VARIABLES.length > 0)
  for (const k of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_GIT_BASH_PATH']) {
    assert.ok(KEPT_HOST_VARIABLES.includes(k), `${k} is listed`)
  }
  for (const k of SESSION_OWNED) assert.ok(!KEPT_HOST_VARIABLES.includes(k), `${k} is the session's own`)
  const out = cleanEnv({ ...ENV })
  for (const k of KEPT_HOST_VARIABLES) assert.equal(out[k], 'kept', `${k} not kept as is`)
})

test('the host configuration and the rest are kept', () => {
  const out = cleanEnv({ ...ENV })
  for (const k of Object.keys(ENV).filter((k) => !DROPPED(k))) assert.equal(out[k], ENV[k], `${k} not kept as is`)
  assert.equal(out.CLAUDE_CONFIG_DIR, ENV.CLAUDE_CONFIG_DIR)
  assert.equal(out.PATH, ENV.PATH)
})

test('cleanEnv leaves its input alone', () => {
  const input = { ...ENV }
  const out = cleanEnv(input)
  assert.notEqual(out, input)
  assert.deepEqual(input, ENV)
  out.PATH = 'changed'
  assert.equal(input.PATH, ENV.PATH)
})

test('a successful stream reads whole', () => {
  const p = parseStream(SUCCESS)
  assert.equal(p.result.subtype, SUCCESS_RESULT.subtype)
  assert.equal(p.result.is_error, false)
  assert.deepEqual(p.structured, SUCCESS_RESULT.structured_output)
  for (const [k, v] of Object.entries(SUCCESS_RESULT.usage)) assert.equal(p.usage[k], v, `usage.${k}`)
  assert.equal(p.costTotal, SUCCESS_RESULT.total_cost_usd)
  assert.equal(p.denials.length, SUCCESS_RESULT.permission_denials.length)
  const denial = JSON.stringify(p.denials)
  assert.ok(denial.includes('Write') && denial.includes('C:/w/other/b.ts'), `denials ${denial}`)
  assert.equal(p.sessionId, SESSION)
  assert.equal(p.malformed, 0, 'a trailing newline is not a torn line')
})

test('the stream says how far the call got', () => {
  const p = parseStream(SUCCESS)
  assert.equal(p.turns, events(SUCCESS).filter((e) => e.type === 'assistant').length)
  assert.notEqual(p.turns, SUCCESS_RESULT.num_turns, 'turns are counted, not copied from num_turns')
  const last = JSON.stringify(p.lastTool)
  assert.ok(last.includes('Bash') && last.includes('npm test'), `lastTool ${last}`)
  assert.ok(!last.includes('a.ts'), 'the last tool call, not the first')

  const cut = parseStream(SUCCESS.split('\n').slice(0, 2).join('\n') + '\n')
  assert.equal(cut.turns, 1)
  const first = JSON.stringify(cut.lastTool)
  assert.ok(first.includes('Read') && first.includes('C:/w/src/a.ts'), `lastTool ${first}`)
  assert.equal(cut.result ?? null, null)
})

test('a torn line is counted, not thrown on', () => {
  const lines = SUCCESS.split('\n')
  const torn = [lines[0], '{"type":"assistant","message":{"con', lines[1], 'not json at all', ...lines.slice(2)].join('\n')
  const p = parseStream(torn)
  assert.equal(p.malformed, 2)
  assert.deepEqual(p.structured, SUCCESS_RESULT.structured_output)
  assert.equal(p.costTotal, SUCCESS_RESULT.total_cost_usd)
  assert.equal(p.sessionId, SESSION)
  assert.equal(p.turns, events(SUCCESS).filter((e) => e.type === 'assistant').length)
})

const CONTEXT = readFileSync(join(fixtures, 'stream-context.jsonl'), 'utf8')
const sizeOf = (u) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
const lastTurnUsage = (text) => events(text).filter((e) => e.type === 'assistant' && e.message && e.message.usage).at(-1).message.usage

test("the context is the last model turn's, and usage stays the whole call's", () => {
  const p = parseStream(CONTEXT)
  const result = events(CONTEXT).find((e) => e.type === 'result')
  assert.equal(p.context, sizeOf(lastTurnUsage(CONTEXT)))
  assert.deepEqual(p.usage, result.usage, 'usage is the result event\'s, summed over every turn')
  assert.notEqual(p.context, sizeOf(result.usage), 'the fixture\'s whole-call usage differs from its last turn')
})

test('an assistant event without usage leaves the context of the last one that had it', () => {
  const lines = CONTEXT.split('\n').filter((l) => l.trim())
  const bare = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'and one more' }] } })
  const p = parseStream([...lines.slice(0, -1), bare, lines.at(-1)].join('\n') + '\n')
  assert.equal(p.context, sizeOf(lastTurnUsage(CONTEXT)))
})

test('a stream whose assistant events carry no usage has no context', () => {
  assert.equal(parseStream(SUCCESS).context, null, 'the result event\'s usage is not a context')
  assert.equal(parseStream('').context, null)
})

test('a returned record carries its context, null when none was measured', () => {
  const c = { dispatch: 'd' }
  assert.equal(returnedEntry(c, { session: 's', status: 'returned' }).context, null)
  assert.equal(returnedEntry(c, { session: 's', status: 'returned', context: 2002 }).context, 2002)
})

const COMPACT = readFileSync(join(fixtures, 'stream-compact.jsonl'), 'utf8')

test('parseStream lists WebSearch inputs', () => {
  assert.deepEqual(parseStream(COMPACT).webSearches, [{ query: 'a' }, { query: 'b' }])
  assert.deepEqual(parseStream(SUCCESS).webSearches, [])
})

const ROLE_FILE = 'C:/run/roles/doc-researcher-0a1b2c3d.md'
const dispatchedCall = (over = {}) => ({
  dispatch: 'd', node: 'n', round: 1, thread: { key: 't' }, role: { name: 'doc-researcher', systemPromptFile: ROLE_FILE },
  tier: { model: 'opus' }, brief: 'b', cwd: 'C:/work/tree', ...over,
})

test('dispatched records what the call was denied reading, and nothing when it was denied nothing', () => {
  assert.deepEqual(dispatchedEntry(dispatchedCall({ denyRead: ['src/r.mjs'] }), { pid: 1, session: 's' }).deny_read, ['src/r.mjs'])
  for (const denyRead of [undefined, []]) assert.ok(!('deny_read' in dispatchedEntry(dispatchedCall({ denyRead }), { pid: 1, session: 's' })))
})

test('dispatched records the prompt digest and cwd', () => {
  const entry = dispatchedEntry(dispatchedCall(), { pid: 1, session: 's' })
  assert.equal(entry.prompt, '0a1b2c3d', 'the digest in the system-prompt file name, not the role name')
  assert.equal(entry.cwd, 'C:/work/tree')
  const other = dispatchedEntry(dispatchedCall({ role: { name: 'doc-researcher', systemPromptFile: 'C:/other/dir/roles/doc-researcher-ffffffff.md' } }), { pid: 1, session: 's' })
  assert.equal(other.prompt, 'ffffffff', 'the digest is the name\'s, wherever the file lies')
})

test('an empty stream reads as nothing', () => {
  const p = parseStream('')
  assert.equal(p.result ?? null, null)
  assert.equal(p.structured ?? null, null)
  assert.equal(p.usage ?? null, null)
  assert.equal(p.costTotal, null)
  assert.ok(!p.denials || p.denials.length === 0, `denials ${JSON.stringify(p.denials)}`)
  assert.equal(p.turns, 0)
  assert.equal(p.malformed, 0)
})

const NOTHING = () => parseStream('')

test('a success with structured output returned', () => {
  assert.equal(classifyCall({ code: 0, stderr: '', parsed: parseStream(SUCCESS) }).status, 'returned')
  assert.equal(classifyCall({ code: 0, parsed: parseStream(SUCCESS) }).status, 'returned')
})

/** Asserts a failed class with its message. */
function failed(got, cause) {
  assert.equal(got.status, 'failed', JSON.stringify(got))
  assert.equal(got.cause, cause, JSON.stringify(got))
  assert.equal(typeof got.message, 'string')
}

/** Asserts a stopped class with its reset time. */
function stopped(got, cause) {
  assert.equal(got.status, 'stopped', JSON.stringify(got))
  assert.equal(got.cause, cause, JSON.stringify(got))
  assert.equal(typeof got.until, 'string')
}

test('a missing session is its own class', () => {
  failed(classifyCall({ code: 1, stderr: `No conversation found with session ID: ${SESSION}\n`, parsed: NOTHING() }), 'session_missing')
})

test('a return that never fit the schema failed the schema', () => {
  failed(classifyCall({ code: 1, stderr: '', parsed: parseStream(SCHEMA_FAILED) }), 'schema_failed')
})

test('a success without structured output failed the schema', () => {
  const { structured_output, ...bare } = SUCCESS_RESULT
  const p = parseStream(stream(resultLine(bare)))
  failed(classifyCall({ code: 0, stderr: '', parsed: p }), 'schema_failed')
})

test('a too-long prompt is context_exceeded', () => {
  failed(classifyCall({ code: 1, stderr: 'Prompt is too long\n', parsed: NOTHING() }), 'context_exceeded')
})

test('a context-limit result is context_exceeded', () => {
  const p = parseStream(stream(resultLine({ subtype: 'success', is_error: true, result: 'input length and max_tokens exceed context limit: 190000 + 32000 > 200000' })))
  failed(classifyCall({ code: 1, stderr: '', parsed: p }), 'context_exceeded')
})

test('a rate limit stops the call', () => {
  const p = parseStream(stream(resultLine({ subtype: 'success', is_error: true, api_error_status: 429 })))
  stopped(classifyCall({ code: 1, stderr: '', parsed: p }), 'rate_limit')
})

test('a usage limit stops the call until its reset', () => {
  const got = classifyCall({ code: 1, stderr: 'Claude usage limit reached. Your limit will reset at 5pm\n', parsed: NOTHING() })
  stopped(got, 'usage_limit')
  assert.equal(got.until, '5pm')
})

test('an overloaded host stops the call', () => {
  const p = parseStream(stream(resultLine({ subtype: 'success', is_error: true, api_error_status: 529 })))
  stopped(classifyCall({ code: 1, stderr: '', parsed: p }), 'overloaded')
})

test('a network failure stops the call', () => {
  stopped(classifyCall({ code: 1, stderr: 'Error: read ECONNRESET\n    at TLSWrap.onStreamRead', parsed: NOTHING() }), 'network')
})

test('a 503 status stops the call as unavailable', () => {
  const p = parseStream(stream(resultLine({ subtype: 'success', is_error: true, api_error_status: 503 })))
  stopped(classifyCall({ code: 1, stderr: '', parsed: p }), 'unavailable')
})

test('text saying the service is unavailable stops the call as unavailable', () => {
  stopped(classifyCall({ code: 1, stderr: 'API Error: Service Unavailable\n', parsed: NOTHING() }), 'unavailable')
})

test('text naming a 503 stops the call as unavailable', () => {
  stopped(classifyCall({ code: 1, stderr: 'API Error: 503 {"type":"error"}\n', parsed: NOTHING() }), 'unavailable')
})

test('a longer number holding 503 is not unavailable', () => {
  failed(classifyCall({ code: 1, stderr: 'exit 15030\n', parsed: NOTHING() }), 'host_error')
})

const EFFORT_WARNING = "Warning: Unknown --effort value 'ultra' — ignoring it"

test('an exit-0 call whose effort the CLI rejected is a host error carrying the warning', () => {
  for (const stderr of [EFFORT_WARNING + '\n', 'Loading settings\n' + EFFORT_WARNING + '\nDone\n']) {
    const got = classifyCall({ code: 0, stderr, parsed: parseStream(SUCCESS) })
    failed(got, 'host_error')
    assert.equal(got.message, EFFORT_WARNING)
  }
})

test("a model's own words naming a limit or the network are no host stop", () => {
  const said = 'the rate limit was hit, then the network failed; the service is overloaded'
  const p = parseStream(stream(resultLine({ subtype: 'success', is_error: false, result: said, structured_output: { status: 'done' } })))
  failed(classifyCall({ code: 1, stderr: '', parsed: p }), 'host_error')
})

test('anything else is a host error', () => {
  const got = classifyCall({ code: 1, stderr: 'boom', parsed: NOTHING() })
  failed(got, 'host_error')
  assert.ok(got.message.length > 0)
})

test('buildArgs passes --max-budget-usd when a budget is given, and nothing when it is not', () => {
  const args = buildArgs(call({ maxBudgetUsd: 0.25 }))
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '0.25')
  assert.equal(buildArgs(call()).indexOf('--max-budget-usd'), -1)
})

test('a result stopped at the budget is the terminal class budget', () => {
  const cls = classifyCall({ code: 1, parsed: { result: { subtype: 'error_max_budget_usd', is_error: true, errors: ['Reached maximum budget ($1)'] }, structured: null } })
  assert.equal(cls.status, 'failed')
  assert.equal(cls.cause, 'budget')
})
