// lib/briefs/fit.mjs — the one fit of a brief to what its reader can read: once the whole is past the
// room, every part but the charge is handed as a file to open, until it fits.
//
// Design: docs/DESIGN.md#the-agent-runner.

/**
 * A part of a brief: `{key, text, ref?, rank?, file?}`. `ref(path)` is what the brief says instead of
 * `text` once the part is the file at `path`, which holds `file` when given (the lines as a reader
 * opens them), else `text`; a part with no `ref` is the charge and always stays inline.
 * Parts are given up by `rank`, lowest first, and within a rank the largest first.
 */

const SEPARATOR = '\n\n'
const bytes = (text) => Buffer.byteLength(text, 'utf8')

/** Pure. A brief's parts, joined as the reader reads them. */
export const joined = (parts) => parts.map((p) => p.text).join(SEPARATOR)

/** Pure. What a section handed by reference says: its heading, and where its lines are. */
const leftOut = (path) => 'This part was left out to fit what you can read in one brief: it is the file ' + path +
  '. Read it before you rely on anything it holds.'

/**
 * Pure. A plain brief's parts: what comes before its first `## ` or `### ` heading is the charge, kept
 * inline; each section from such a heading on may go by reference, the blank lines ending a part being
 * the separator `joined` puts back. A heading inside a `~~~~` or
 * ```` ``` ```` fence is the fenced text's, not the brief's.
 */
export function sectionsOf(text) {
  const parts = []
  let current = { key: 'charge', lines: [] }
  let fence = ''
  for (const line of String(text).split('\n')) {
    const mark = line.match(/^(~~~~|```)/)
    if (mark) fence = fence ? (line.startsWith(fence) ? '' : fence) : mark[1]
    if (!fence && !mark && /^#{2,3} /.test(line) && current.lines.length) {
      parts.push(current)
      current = { key: line.replace(/^#+ /, ''), lines: [] }
    }
    current.lines.push(line)
  }
  parts.push(current)
  return parts.map((p, i) => {
    const lines = [...p.lines]
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    const body = lines.join('\n')
    if (i === 0) return { key: p.key, text: body }
    const heading = p.lines[0]
    return { key: p.key, text: body, ref: (path) => heading + SEPARATOR + leftOut(path) }
  })
}

/**
 * Pure. `parts` fitted to `room` bytes: whole when they fit, else each part with a `ref`, by rank and
 * size, written through `write(key, text) → path` and replaced by what its `ref` says, until the brief
 * fits or only the charge is left. `handed` lists what went by reference, `{key, path}`.
 */
export function fitParts(parts, room, write) {
  const shown = parts.map((p) => p.text)
  const total = () => bytes(shown.join(SEPARATOR))
  const handed = []
  const order = parts.map((p, i) => ({ p, i })).filter(({ p }) => typeof p.ref === 'function')
    .sort((a, b) => (a.p.rank ?? 0) - (b.p.rank ?? 0) || bytes(b.p.text) - bytes(a.p.text))
  for (const { p, i } of order) {
    if (total() <= room) break
    const path = write(p.key, p.file ?? p.text)
    shown[i] = p.ref(path)
    handed.push({ key: p.key, path })
  }
  return { text: shown.join(SEPARATOR), handed }
}
