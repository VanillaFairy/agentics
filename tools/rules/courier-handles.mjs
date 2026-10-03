// tools/rules/courier-handles.mjs — GP6: couriers carry handles, never data.
//
// docs/DESIGN.md#p2--code-does-what-is-deterministic-models-only-judge
//
// A command a workflow, an agent or a skill hands to a model holds only paths, ids, shas,
// digests, enums and counts. Each pattern below is a way to put data into a command instead:
// an encoded token, a token file the model writes, a heredoc or stdin body, a pipe. The scan runs
// over raw source, strings included, because commands live in prompt strings.

export const id = 'courier-handles'

export const applies = /(\.workflow\.js|^agents\/[^/]+\.md|^skills\/.+\.md)$/

const SHAPES = [
  [/--(b64|b64-file|json-file|stdin)\b/, 'an argument token or stdin body'],
  [/\bprintf\b/, 'a printf that writes data'],
  [/<<-?\s*['"]?[A-Za-z_]+/, 'a heredoc body'],
  [/\|\s*node\b/, 'a pipe into a lib CLI'],
]

const MESSAGE = (what) =>
  'GP6: a command carries handles only, and this puts ' + what + ' into one. Have the data\'s ' +
  'author write it to a file with its Write tool and pass the path.'

export function check(source) {
  const violations = []
  source.split('\n').forEach((text, index) => {
    const hit = SHAPES.find(([re]) => re.test(text))
    if (hit) violations.push({ line: index + 1, message: MESSAGE(hit[1]) })
  })
  return violations
}
