// tools/rules/send-back-guard.mjs — only the loop guard sends a producer back for more work.
//
// Design: docs/DESIGN.md#l2--states-end-work-counts-dont. A message that hands a producer more work
// (`SEND_BACKS` in lib/boundaries/loop-guard.mjs) is built by `sendBack` alone, so every such loop
// ends on the state its send-backs left, by one rule: a send-back built anywhere else is a loop
// nothing ends.

export const id = 'send-back-guard'

export const applies = /^lib\/.+\.mjs$/

const GUARD = 'lib/boundaries/loop-guard.mjs'
const SEND_BACKS = ['failures', 'rebase', 'surviving_mutations', 'needs_tests']
const NAMED = '[\'"](' + SEND_BACKS.join('|') + ')[\'"]'
/** A `message(` call naming one, however its arguments are laid out, and a record built by hand with `msg:` set to one. */
const BUILT = [new RegExp('\\bmessage\\([^;()]*?' + NAMED, 'g'), new RegExp("kind:\\s*'message'[^}]*?msg:\\s*" + NAMED, 'g')]

/**
 * Pure.
 * @param {string} source full file text
 * @param {string} [filePath] the repository path it was read from
 * @returns {Array<{line: number, message: string}>}
 */
export function check(source, filePath = '') {
  if (filePath === GUARD) return []
  const lineOf = (index) => source.slice(0, index).split('\n').length
  return BUILT.flatMap((re) => [...source.matchAll(re)].map((m) => ({
    line: lineOf(m.index),
    message: 'a `' + m[1] + '` message hands a producer more work: build it with sendBack (lib/boundaries/loop-guard.mjs), which ends the loop',
  })))
}
