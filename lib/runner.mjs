// lib/runner.mjs — the one way anything in agentics starts an agent: a headless Claude Code
// session per call, confined, schema-checked, resumed by id, and recorded as it goes.
//
// Design: docs/DESIGN.md#the-agent-runner.

export const PERMISSION_FLAGS = ['--permission-mode', 'dontAsk', '--permission-prompts', 'none']
export const LEAN_FLAGS = ['--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands']

/** Pure. The CLI arguments of one call. */
export function buildArgs({ systemPromptFile, tools, allowed = [], disallowed = [], model, effort = '', schema, session, resume = false }) {
  if (!schema || typeof schema !== 'object') throw new Error('every call returns structured output: no schema given')
  return [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--system-prompt-file', systemPromptFile,
    '--tools', tools.join(','),
    ...(allowed.length ? ['--allowedTools', ...allowed] : []),
    ...(disallowed.length ? ['--disallowedTools', ...disallowed] : []),
    ...PERMISSION_FLAGS, ...LEAN_FLAGS,
    '--model', model,
    ...(effort ? ['--effort', effort] : []),
    '--json-schema', JSON.stringify(schema),
    ...(resume ? ['--resume', session] : ['--session-id', session]),
  ]
}

/** Pure. The child's environment: the launching session's variables dropped, the host's configuration kept. */
export function cleanEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDECODE' && k !== 'AI_AGENT'))
}

const targetOf = (input) => (input && (input.file_path || input.command || input.pattern || input.path || input.url)) || ''

/** Pure. One call's stream-json output, read whole. */
export function parseStream(text) {
  let result = null
  let sessionId = ''
  let turns = 0
  let lastTool = null
  let malformed = 0
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim() === '') continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      malformed++
      continue
    }
    if (e.session_id) sessionId = e.session_id
    if (e.type === 'assistant') {
      turns++
      for (const c of (e.message && e.message.content) || []) {
        if (c && c.type === 'tool_use') lastTool = { name: c.name, target: targetOf(c.input) }
      }
    }
    if (e.type === 'result') result = e
  }
  return {
    result,
    structured: result && result.structured_output !== undefined ? result.structured_output : null,
    usage: (result && result.usage) || null,
    costTotal: result && typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
    denials: (result && Array.isArray(result.permission_denials)) ? result.permission_denials : [],
    sessionId,
    turns,
    lastTool,
    malformed,
  }
}

/** Pure. What a finished call amounts to (docs/DESIGN.md#host-stops). */
export function classifyCall({ code, stderr = '', parsed }) {
  const r = (parsed && parsed.result) || {}
  const said = String(stderr) + '\n' + String(r.result || '')
  if (code === 0 && r.subtype === 'success' && !r.is_error && parsed.structured !== null) return { status: 'returned' }
  if (/No conversation found with session ID/i.test(said)) return { status: 'failed', cause: 'session_missing', message: said.trim() }
  if (r.subtype === 'error_max_structured_output_retries' || (r.subtype === 'success' && !r.is_error && parsed.structured === null)) {
    return { status: 'failed', cause: 'schema_failed', message: String(r.result || r.subtype) }
  }
  const status = r.api_error_status
  if (status === 429 || /rate.?limit/i.test(said)) return { status: 'stopped', cause: 'rate_limit', until: '' }
  const usage = said.match(/usage limit[^\n]*?reset(?:s)?(?: at)? ([^\n.]+)/i)
  if (usage || /usage limit|limit reached/i.test(said)) return { status: 'stopped', cause: 'usage_limit', until: usage ? usage[1].trim() : '' }
  if (status === 529 || /overloaded/i.test(said)) return { status: 'stopped', cause: 'overloaded', until: '' }
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(said)) return { status: 'stopped', cause: 'network', until: '' }
  return { status: 'failed', cause: 'host_error', message: (said.trim() || 'exit ' + code).slice(-400) }
}
