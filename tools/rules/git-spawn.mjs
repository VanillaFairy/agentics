// tools/rules/git-spawn.mjs — only lib/store.mjs starts git.
//
// Design: docs/DESIGN.md#the-process-model. Every git the plugin runs is held to one environment
// (`gitCommand`: no prompt, no editor, no lazy fetch, no optional lock, no automatic gc), counted,
// and killed at one ceiling; a git started anywhere else escapes all three.

export const id = 'git-spawn'

export const applies = /^lib\/.+\.mjs$/

const HOME = 'lib/store.mjs'
/** A child-process call whose program is git, however it is spelled or laid out. */
const STARTS = /\b(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(\s*['"`]git(\.exe)?\b/g

/**
 * Pure.
 * @param {string} source full file text
 * @param {string} [filePath] the repository path it was read from
 * @returns {Array<{line: number, message: string}>}
 */
export function check(source, filePath = '') {
  if (filePath === HOME) return []
  const lineOf = (index) => source.slice(0, index).split('\n').length
  return [...source.matchAll(STARTS)].map((m) => ({
    line: lineOf(m.index),
    message: 'git is started only by lib/store.mjs (gitSync, gitAsync, readBlobs): its env, its count and its ceiling hold every git',
  }))
}
