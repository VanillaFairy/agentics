// lib/briefs/survey.mjs — every prompt the survey program builds: the re-judge, the plan, the topic
// scouts, the common ground, the history and docs channels, and the judges.
//
// Design: docs/DESIGN.md#survey.

const join = (...parts) => parts.filter(Boolean).join('\n\n')
const block = (title, body) => (body ? title + '\n' + body : '')
const where = (subtree) => subtree || 'the whole repository'

const EXHAUST = 'Report every location you find, and search to exhaustion: you stop when the surface is covered ' +
  'or you are genuinely stuck, never because the list is getting long. If one pass cannot cover it, report what ' +
  'you have, set stop_reason "unfinished" and name exactly what remains in not_reached: you are resumed until the ' +
  'search is done.'

/** Pure. Recorded items as claims, each with the lines it was anchored to. */
const claimsOf = (items) => items.map((it) => '- ' + it.claim +
  (Array.isArray(it.spans) && it.spans.length ? ' (' + it.spans.map((s) => s.path + ':' + s.start + '-' + s.end).join(', ') + ')' : '')).join('\n')

/** Pure. What a topic charges its searcher and its judge with: its plan entry, or, searched again, what it used to claim. */
const chargeOf = (topic) => (topic.forced
  ? 'Re-establish from the current code what this topic used to claim about ' + where(topic.subtree) + '. None of it ' +
    'holds as recorded any more; find what is true now. It claimed:\n' + claimsOf(topic.used)
  : topic.find)

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
 * the pool establishes and which topics are searched again whatever it plans.
 */
export function planBrief({ question, roots, notes = '', prior = '', maxTopics, known = '', forced = [], guidance = '' }) {
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
      'Plan no topic they answer; plan only what they leave open, and no topics at all when they answer the question:', known),
    forced.length ? 'SEARCHED AGAIN REGARDLESS — what was recorded for these topics no longer holds, so they are ' +
      'searched whatever you plan. Do not plan them: ' + forced.join(', ') : '',
    'TOPICS — aim for at most ' + maxTopics + '. That number sizes the plan; it is not a cap, and every topic you ' +
      'plan is searched. Each topic must be answerable by searching the current code on its own. Give each a short ' +
      'kebab-case key; a find, a precise instruction for one read-only search agent saying what to find and where to ' +
      'look; and a subtree, the one directory or file it is about, repo-relative, or an empty string when it is ' +
      'repository-wide. Size each so one agent can exhaust it in one pass: prefer more, smaller topics to one ' +
      'catch-all.',
    'common_ground — when several topics would each read the same files, name that surface once, as an ' +
      'instruction for one search agent: it is searched once and every judge receives it. Confine each topic to ' +
      'what is unique to it. Empty when the topics share no ground.',
    'history_question — what only git history can answer: when a behaviour changed, which commit introduced or ' +
      'removed something, why code is the way it is, a regression. Empty when the current tree answers the question.',
    'docs_question — what only vendor or standards documentation outside these repositories can answer. Empty ' +
      'when none is needed.',
    guidance,
  )
}

/** Pure. One topic scout's brief: its topic's charge and subtree, and the common ground to leave alone. */
export function scoutBrief({ question, topic, common = '', roots, guidance = '' }) {
  return join(
    'Mode: a survey topic. Return the scout_hits schema.',
    block('OVERALL QUESTION:', question),
    block('YOUR TOPIC (' + topic.key + '):', chargeOf(topic)),
    'WHERE TO LOOK: ' + where(topic.subtree),
    block('SHARED GROUND — another scout searches this for every topic. Leave it alone:', common),
    'REPOSITORIES: ' + roots.join(', '),
    EXHAUST,
    guidance,
  )
}

/** Pure. The common-ground scout's brief. */
export function commonBrief({ question, common, roots, guidance = '' }) {
  return join(
    'Mode: a survey\'s shared ground. Return the scout_hits schema.',
    block('OVERALL QUESTION:', question),
    block('YOUR CHARGE — the ground several topics share, searched once for all of them:', common),
    'REPOSITORIES: ' + roots.join(', '),
    EXHAUST,
    guidance,
  )
}

const CHANNELS = {
  history: { mode: 'Mode: git history for a survey. Return the historian schema.', ask: 'YOUR QUESTION — answer it from the history:' },
  docs: {
    mode: 'Mode: documentation research for a survey. Return the doc_research schema.',
    ask: 'YOUR QUESTION — research it in primary sources and give each fact with the URL that owns it:',
  },
}

/** Pure. A history or docs channel's brief: the plan's question for it, and the survey's question as context. */
export function channelBrief({ channel, question, ask, roots, guidance = '' }) {
  return join(
    CHANNELS[channel].mode,
    block(CHANNELS[channel].ask, ask),
    block('CONTEXT — the question the survey serves:', question),
    'REPOSITORIES: ' + roots.join(', '),
    guidance,
  )
}

/** Pure. How a search ended, as the judge reads it. */
function searchLine(s, who) {
  if (s.outcome === 'done') return who + ' exhausted the search.'
  if (s.outcome === 'stop') {
    return who + ' ended short (' + s.why + '); its report below names what it never reached. Your items inherit ' +
      'that limit: say what they rest on.'
  }
  return who + ' failed (' + s.cause + ')' + (s.rounds ? ' after ' + s.rounds + ' round(s)' : ' before reporting anything') +
    '. Say in risks what this lacks.'
}

const ANCHORS = 'KINDS AND ANCHORS — an item makes one claim, and its kind decides the anchor it must carry:\n' +
  '  behaviour: spans (path, first line, last line);\n' +
  '  absence: a query (an extended regex as git grep -E takes it, and its scope) the recorder re-runs; it refuses the item if the query finds anything;\n' +
  '  enumeration: a query whose result the recorder keeps;\n' +
  '  relation: spans and a query;\n' +
  '  external: sources (url, version);\n' +
  '  derived: rests_on, the exact claims of other items you return, or the ids of ESTABLISHED items.\n' +
  'A claim that needs anchors in two unrelated places is two items. An item without its anchor is refused and ' +
  'comes back to you. Every topic gets at least one item, or a risk saying why nothing in its evidence can be anchored.'

/**
 * Pure. A judge's brief: its topics with how each search ended, the anchor each kind needs, the
 * units it rules, what the pool establishes, and the scouts' excerpts inline.
 */
export function judgeBrief({ question, topics, common = null, known = '', excerpts, guidance = '' }) {
  return join(
    'Mode: judging evidence into items. Return the items schema.',
    'Judge ' + (topics.length > 1 ? 'these ' + topics.length + ' topics' : 'this topic') + ' of a larger question from ' +
      'the evidence below. You have no search tools: judge what it shows, and where it is not enough to decide a ' +
      'topic, say what is missing in risks rather than guessing.',
    block('OVERALL QUESTION:', question),
    'TOPICS — set every item\'s and risk\'s topic to its topic\'s key:\n' +
      topics.map((t) => '- ' + t.key + ' (' + where(t.subtree) + '): ' + chargeOf(t) + '\n  Its search: ' + searchLine(t.search, 'its scout')).join('\n'),
    common ? 'SHARED GROUND — scouted once for every topic, part of your evidence: ' + searchLine(common, 'its scout') : '',
    ANCHORS,
    'UNITS — rule each of these in units: anchored when its items rest on the evidence below, unanchored when ' +
      'they cannot: ' + topics.map((t) => t.key).join(', '),
    block('ESTABLISHED — anchored items the pool already holds. Do not restate them:', known),
    block('EVIDENCE — every scout report for these topics and the shared ground, then the lines they point at, ' +
      'read once for you. Do not open the source files again to find these lines:', excerpts),
    guidance,
  )
}
