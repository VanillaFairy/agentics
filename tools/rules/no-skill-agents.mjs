// tools/rules/no-skill-agents.mjs — no skill starts an agent.
//
// Design: docs/DESIGN.md#self-checks. Every agent is dispatched by a program, through the runner,
// so its role, tools, brief, records and resume are code's (P2). A skill's session that starts an
// agent itself — the host's `Agent` or `Task` tool, a `subagent_type`, an `agentics:<type>`
// agent name — dispatches one nothing records. The Task tools that keep a task list
// (`TaskCreate`, `TaskUpdate`, `TaskList`) start no agent. An `agentics:<name>` is a skill when
// `skills/<name>/` exists; `agentics:verbatim` marks a pinned block. `OWN_FIX` is the one skill whose
// agent works on this plugin's own repository, outside every effort, so no program dispatches it.

import { readdirSync } from 'node:fs'

export const id = 'no-skill-agents'

export const applies = /^skills\/.+\.md$/

/** The skill that starts the plugin's own fix agent with the host's agent tool (docs/DESIGN.md#skills). */
const OWN_FIX = 'skills/self-improve/SKILL.md'

let skills = null
/** The skill names: the folders under `skills/`, read once. */
const skillNames = () => {
  if (skills) return skills
  try {
    skills = new Set(readdirSync(new URL('../../skills/', import.meta.url), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name))
  } catch {
    skills = new Set()
  }
  return skills
}

/** What names an agent to start, each with what it says. */
const PATTERNS = [
  [/\bsubagent_type\b/g, () => '`subagent_type` names an agent type to start'],
  [/\b(Agent|Task)\s*\(/g, (m) => '`' + m[1] + '(` calls the host tool that starts an agent'],
  [/`(Agent|Task)`/g, (m) => '`' + m[1] + '` is the host tool that starts an agent'],
  [/\b(Agent|Task) tool\b/g, (m) => 'the ' + m[1] + ' tool starts an agent'],
]
const NAMED = /\bagentics:([a-z][a-z0-9-]*)/g

/**
 * Pure but for the skill folders it reads once.
 * @param {string} source full file text
 * @param {string} [filePath] the repository path it was read from
 * @returns {Array<{line: number, message: string}>}
 */
export function check(source, filePath = '') {
  const violations = []
  const tail = ': no skill starts an agent; a program dispatches every agent (run it with lib/run.mjs)'
  source.split('\n').forEach((text, index) => {
    for (const [re, say] of filePath === OWN_FIX ? [] : PATTERNS) {
      for (const m of text.matchAll(re)) violations.push({ line: index + 1, message: say(m) + tail })
    }
    for (const m of text.matchAll(NAMED)) {
      if (m[1] === 'verbatim' || skillNames().has(m[1])) continue
      violations.push({ line: index + 1, message: '`agentics:' + m[1] + '` names an agent, not a skill' + tail })
    }
  })
  return violations
}
