// lib/briefs/survey.mjs — every prompt the survey program builds: the re-judge, the plan, the topics' and channels' asks, and the judges.
//
// Design: docs/DESIGN.md#survey.

import { PART_BYTES } from '../roles.mjs'
import { bounded } from './size.mjs'

/**
 * What a brief may hold of each body the evidence pool feeds, which grows with every survey
 * (`knownText` in lib/evidence.mjs, `bounded`): a planner reads the standing items to plan around
 * them, a judge only so as not to restate them. With the stale candidates they leave a quarter of
 * a part to the question and what its caller wrote.
 */
export const PLAN_KNOWN_BYTES = Math.floor(PART_BYTES / 2)
export const JUDGE_KNOWN_BYTES = Math.floor(PART_BYTES / 4)
const STALE_BYTES = Math.floor(PART_BYTES / 4)
const STALE_KEYS_BYTES = Math.floor(STALE_BYTES / 4)
const CLAIMS_BYTES = Math.floor(PART_BYTES / 16)

const join = (...parts) => parts.filter(Boolean).join('\n\n')
const block = (title, body) => (body ? title + '\n' + body : '')
const where = (subtree) => subtree || 'the whole repository'

/** Pure. Recorded items as claims, each with the lines it was anchored to: as many as `CLAIMS_BYTES` hold, the rest counted. */
const claimsOf = (items) => bounded(items.map((it) => '- ' + it.claim +
  (Array.isArray(it.spans) && it.spans.length ? ' (' + it.spans.map((s) => s.path + ':' + s.start + '-' + s.end).join(', ') + ')' : '')),
CLAIMS_BYTES, (left) => '- (' + left.length + ' more claim' + (left.length === 1 ? '' : 's') + ' of it, not shown)')

/** Pure. A topic's ask: its plan entry, and, searched again, what it used to claim. */
export const topicFind = (topic) => (topic.again
  ? topic.find + '\n\nAn earlier survey recorded this topic about ' + where(topic.subtree) + ', and none of it holds as ' +
    'recorded any more; find what is true now. It claimed:\n' + claimsOf(topic.used)
  : topic.find)

/**
 * Pure. The stale candidates as the planner reads them: each key, where it was, and what it claimed,
 * as many as `STALE_BYTES` hold; then the keys of the rest, which it may still adopt, and a count of
 * any the bound could not name.
 */
function candidatesText(stale) {
  const blocks = stale.map((c) => '- ' + c.key + ' (' + where(c.subtree) + '):\n' +
    claimsOf(c.used).split('\n').map((l) => '  ' + l).join('\n'))
  return bounded(blocks, STALE_BYTES - STALE_KEYS_BYTES, (left) => '- left out to fit this brief, what ' + left.length +
    ' more candidate' + (left.length === 1 ? '' : 's') + ' claimed; their keys: ' +
    bounded(stale.slice(stale.length - left.length).map((c) => c.key), STALE_KEYS_BYTES, (more) => 'and ' + more.length + ' more, not named', ', '))
}

/** Pure. A re-judge's brief: the suspect items, each changed anchor's old and new text, and every id to rule. */
export function rejudgeBrief({ ids, pool, guidance = '' }) {
  return join(
    'Mode: re-judging suspect items. Return the rejudge schema.',
    'These evidence items rest on text that has changed since they were recorded. Whether it changed is decided; ' +
      'you rule only whether the change matters to each claim: holds, fails or unsure. unsure is never a pass: it ' +
      'sends the claim to be searched again, so use it only when you truly cannot tell.',
    'UNITS — rule every one of these ids, each once: ' + ids.join(', '),
    block('THE ITEMS:', pool),
    guidance,
  )
}

/**
 * Pure. The planner's brief: the question and what the user said, `prior` kept apart as notes, what
 * the asking session has already read, what the pool establishes, and the stale topics it may adopt.
 */
export function planBrief({ question, roots, notes = '', prior = '', read = '', maxTopics, known = '', stale = [], guidance = '' }) {
  return join(
    'Mode: survey planning. Return the survey_plan schema.',
    'Break this question into independent search topics for read-only search agents. Plan only: search ' +
      'nothing, and do not begin answering the question.',
    block('QUESTION:', question),
    'REPOSITORIES: ' + roots.join(', '),
    block('BACKGROUND THE USER SUPPLIED:', notes),
    block('NOTES FROM AN EARLIER PASS OF THIS EFFORT — somebody\'s notes, not evidence: nothing in them was ' +
      'checked against the current tree, and the code may have moved since. Use them to aim the topics, never to ' +
      'decide that a topic needs no search:', prior),
    block('ESTABLISHED — items the project\'s evidence pool already holds for this ground, anchored and standing. ' +
      'Plan no topic they answer; plan only what they leave open, and no topics at all when they answer the question. ' +
      'Where a NOT SHOWN list ends them, a part of the question the items shown do not answer is open, whatever topic that list names:', known),
    block('ALREADY READ — what the session that asked has read itself and holds. Plan no topic these answer; plan ' +
      'only the gaps they leave:', read),
    block('STALE CANDIDATES — topics an earlier survey recorded on this ground; what they claimed no longer holds. ' +
      'Each is a candidate, never a duty: plan one again, under its exact key, only when it bears on this question, and ' +
      'leave out the rest:', candidatesText(stale)),
    'TOPICS — aim for at most ' + maxTopics + '. That number sizes the plan; it is not a cap, and every topic you ' +
      'plan is searched. List them in the order the question raises them. Each topic must be answerable by searching ' +
      'the current code on its own. Give each a short ' +
      'kebab-case key; a find, a precise instruction for one read-only search agent saying what to find and where to ' +
      'look; and a subtree, the one directory or file it is about, repo-relative, or an empty string when it is ' +
      'repository-wide. Size each so one agent can exhaust it in one pass: prefer more, smaller topics to one ' +
      'catch-all.',
    'common_ground — when several topics would each read the same files, name those lines once, each entry a ' +
      'repo-relative path with its first and last line, or the path alone for a whole file: code reads them once and ' +
      'hands them to every topic\'s search and every judge, so name lines rather than a file when only part is shared. ' +
      'Confine each topic to what is unique to it. Empty when the topics share no ground.',
    'history_question — what only git history can answer: when a behaviour changed, which commit introduced or ' +
      'removed something, why code is the way it is, a regression. Empty when the current tree answers the question.',
    'docs_question — what only vendor or standards documentation outside these repositories can answer. Empty ' +
      'when none is needed.',
    guidance,
  )
}

/** Pure. A history or docs channel's ask: the plan's question for it, and the survey's question it serves. */
export function channelFind({ channel, question, ask }) {
  const how = channel === 'history' ? 'Answer this from the git history: '
    : 'Research this in primary sources, each fact with the URL that owns it: '
  return how + ask + '\n\nThe question it serves: ' + question
}

/** Pure. How a topic's search ended, as the judge reads it. */
function searchLine(s, who) {
  if (s.status === 'failed' || s.status === 'budget') return who + ' ended ' + s.status + ' (' + s.why + '). Say in risks what this lacks.'
  if (s.status === 'stalled') return who + ' stalled (' + s.why + '): it stopped finding anything new. Your items inherit that limit: say what they rest on.'
  return who + ' ended done.'
}

const ANCHORS = 'KINDS AND ANCHORS — an item makes one claim, and its kind decides the anchor it must carry:\n' +
  '  behaviour: spans (path, first line, last line);\n' +
  '  absence: a query (an extended regex and its scope) the recorder re-runs; it refuses the item if the query finds anything. ' +
    '\\d \\D \\s \\S \\w \\W work as in JavaScript, and \\d \\s \\w inside [ ]; \\D \\S \\W inside [ ], \\b and other backslash-letter ' +
    'escapes, (? groups and lazy quantifiers such as *? are refused, and the item comes back to you;\n' +
  '  enumeration: a query whose result the recorder keeps;\n' +
  '  relation: spans and a query;\n' +
  '  external: sources (url, version);\n' +
  '  derived: rests_on, the exact claims of other items you return, or the ids of ESTABLISHED items.\n' +
  'A claim that needs anchors in two unrelated places is two items. An item without its anchor is refused and ' +
  'comes back to you. Every topic gets at least one item, or a risk saying why nothing in its evidence can be anchored.'

/** Pure. What a judge holding only some of a topic's hits is told of the rest. */
const partLine = (t) => (t.held < t.of
  ? '\n  You hold ' + t.held + ' of its ' + t.of + ' hits; other judges hold the rest and rule the same unit. Judge what yours show.'
  : '')

/**
 * Pure. A judge's brief: its topics with how each search ended, the common ground's lines, the
 * anchor each kind needs, the units it rules, what the pool establishes,
 * and the topics' search excerpts inline. Each topic carries its `search`, its `excerpts`, and how
 * many of its search's hits those hold (`held` of `of`).
 */
export function judgeBrief({ question, topics, common = '', known = '', guidance = '' }) {
  return join(
    'Mode: judging evidence into items. Return the items schema.',
    'Judge ' + (topics.length > 1 ? 'these ' + topics.length + ' topics' : 'this topic') + ' of a larger question from ' +
      'the evidence below. You have no search tools: judge what it shows, and where it is not enough to decide a ' +
      'topic, say what is missing in risks rather than guessing.',
    block('OVERALL QUESTION:', question),
    'TOPICS — set every item\'s and risk\'s topic to its topic\'s key:\n' +
      topics.map((t) => '- ' + t.key + ' (' + where(t.subtree) + '): ' + topicFind(t) + '\n  Its search: ' + searchLine(t.search, 'its search') + partLine(t)).join('\n'),
    block('SHARED GROUND — the lines the topics share, read once for you. Do not open them again:', common),
    ANCHORS,
    'UNITS — rule each of these in units: anchored when its items rest on the evidence below, unanchored when ' +
      'they cannot: ' + topics.map((t) => t.key).join(', '),
    block('ESTABLISHED — anchored items the pool already holds. Do not restate them:', known),
    block('EVIDENCE — every search for these topics, how it ended, what it found and dismissed, then the lines its ' +
      'hits point at, read once for you. Do not open the source files again to find these lines:', topics.map((t) => t.excerpts).join('\n\n')),
    guidance,
  )
}
