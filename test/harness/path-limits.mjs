// test/harness/path-limits.mjs — the room a name the plugin mints must fit in on any machine,
// Windows included: 255 characters for one path component and MAX_PATH's 260 (259 and the
// terminator) for the whole path, each with the Write tool's `.tmp.<pid>.<hex>` suffix on top.

export const COMPONENT_MAX = 255
export const PATH_MAX = 259
/** At least as long as the suffix the Write tool puts on the file it writes and renames. */
export const TEMP_SUFFIX = '.tmp.4194304.' + 'f'.repeat(19)

/** A long but ordinary Windows checkout. */
export const ROOT = 'C:/Users/firstname.lastname/source/repos/project-name'
/**
 * The length of a path inside the project, from its root, that a checkout in any framework
 * worktree under ROOT must take, written in place as git checks it out.
 */
export const PROJECT_PATH_BUDGET = 150
/** A dated effort name as long as a user is likely to confirm. */
export const EFFORT = '2026-09-26-reshape-pets-onto-entities-and-action-queues-x'.padEnd(60, 'y')

/**
 * What `path` runs over while it is written under `suffix`: [] when it fits. An agent's Write goes
 * through TEMP_SUFFIX, lib writes a file in place (''), git writes a ref through '.lock'.
 */
export function overruns(path, suffix = TEMP_SUFFIX) {
  const written = String(path).split('\\').join('/') + suffix
  const out = written.split('/').filter((c) => c.length > COMPONENT_MAX)
    .map((c) => 'a component of ' + c.length + ' characters: ' + c)
  if (written.length > PATH_MAX) out.push('a path of ' + written.length + ' characters: ' + written)
  return out
}
