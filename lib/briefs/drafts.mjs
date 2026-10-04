// lib/briefs/drafts.mjs — the prompt of one approach draft: the question with its evidence and the
// decisions so far, and the stance the draft argues.
//
// Design: docs/DESIGN.md#design.

const CHARGES = {
  'minimal-change': 'the smallest change that satisfies the decisions so far',
  'long-horizon': 'the approach that absorbs the growth axes the decisions name, at the cost of a larger change now',
  'adopt-dont-build': 'adopting what already exists, from the candidates the question names, and building only what none of them covers',
}

/** Pure. One stance's brief: what to return, the stance and what it argues for, then the question whole. */
export function draftBrief({ question, stance, guidance }) {
  const charge = Object.hasOwn(CHARGES, stance) ? CHARGES[stance] : 'the approach its name calls for'
  return 'Draft one approach to the question below from the stance `' + stance + '`: ' + charge + '. Return it as the ' +
    '`approach` structured output. approach: the approach in a paragraph; shape: its parts and how they interact; ' +
    'contracts: each interface or data shape it rests on or creates; cites: the ids of the evidence items below it ' +
    'rests on; risks: each way it could fail.\n\n' +
    'Argue this stance as well as it can be argued. Other stances are drafted apart from you, and the choice among ' +
    'them is the user\'s. A draft that cites no evidence is an opinion.\n\n' +
    'THE QUESTION, WITH ITS EVIDENCE AND THE DECISIONS SO FAR:\n' + question + (guidance ? '\n\n' + guidance : '')
}
