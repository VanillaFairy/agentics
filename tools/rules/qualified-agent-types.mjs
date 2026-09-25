// tools/rules/qualified-agent-types.mjs — agent references must be namespaced.
//
// Agent types resolve from one flat, global registry shared by every installed plugin.
// A bare `agentType: 'scout'` resolves only by luck and breaks the moment another plugin
// defines a `scout` — failing at agent-resolution time, mid-run, with nothing pointing
// back at the workflow that caused it.
//
// Form only. Whether the named plugin and agent actually exist needs the registry, which
// a pure function cannot see.

export const id = 'qualified-agent-types'

export const applies = /\.workflow\.js$/

/** `agentType:` followed by a quoted string. Backticks included — all three appear in the wild. */
const AGENT_TYPE = /agentType\s*:\s*(['"`])([^'"`]*)\1/g

const SEGMENT = '[a-z0-9]+(?:-[a-z0-9]+)*'
const QUALIFIED = new RegExp(`^${SEGMENT}:${SEGMENT}$`)

export function check(source) {
  const violations = []

  source.split('\n').forEach((text, index) => {
    for (const match of text.matchAll(AGENT_TYPE)) {
      const value = match[2]
      if (QUALIFIED.test(value)) continue

      violations.push({
        line: index + 1,
        message:
          `agentType "${value}" is not namespaced. Agent types resolve from one flat ` +
          `global registry, so a bare name collides with other installed plugins and ` +
          `fails mid-run. Use "<plugin>:<agent>", e.g. "agentics:scout".`,
      })
    }
  })

  return violations
}
