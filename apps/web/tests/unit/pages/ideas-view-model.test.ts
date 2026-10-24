/**
 * The words and buttons the Ideas pages put on a derived state.
 *
 * The API returns no copy, so this is where "stuck, in the chat that failed" becomes
 * "Work stopped" with a "Try again…" button. These assertions are the contract for every
 * Needs-you action and for the idea page's one primary action.
 */
import type { IdeaCounts, IdeaDerivedStatus, IdeaListItem } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  groupIdeas,
  IDEA_NEEDS_YOU_VISIBLE,
  ideaAttention,
  ideaCountsLine,
  ideaMatchesSearch,
  ideaPrimaryAction,
  ideaRowLine,
  ideaSecondaryAction,
  ideaSourceLabel,
  relativeTime,
} from '../../../src/pages/ideas/view-model';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');

function derived(overrides: Partial<IdeaDerivedStatus> = {}): IdeaDerivedStatus {
  return {
    state: 'not-started',
    needsYou: null,
    source: { origin: 'none', observedAt: null, stale: false },
    session: null,
    pullRequest: null,
    note: null,
    ...overrides,
  };
}

function session(overrides: Partial<NonNullable<IdeaDerivedStatus['session']>> = {}) {
  return {
    sessionId: 'sess-1',
    topic: 'Building retries',
    sessionStatus: 'active',
    taskId: 'task-1',
    taskStatus: 'in_progress',
    agentLabel: 'Opus 5.5',
    lastActivityAt: '2026-10-23T11:55:00.000Z',
    ...overrides,
  };
}

function pullRequest(
  overrides: Partial<NonNullable<IdeaDerivedStatus['pullRequest']>> = {}
): NonNullable<IdeaDerivedStatus['pullRequest']> {
  return {
    url: 'https://github.com/acme/payments/pull/482',
    number: 482,
    state: 'open',
    isDraft: false,
    title: 'Retry failed webhook deliveries',
    checksState: 'success',
    mergedAt: null,
    updatedAt: '2026-10-23T11:58:00.000Z',
    stale: false,
    ...overrides,
  };
}

function item(overrides: Partial<IdeaListItem> = {}): IdeaListItem {
  return {
    ideaId: 'idea-1',
    title: 'Retry failed webhook deliveries',
    summary: 'Retry with exponential backoff for up to 3 days.',
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    derived: derived(),
    counts: { updates: 0, chats: 0, files: 0, pullRequests: 0, atLeast: [] },
    filedByAgent: false,
    filedBy: null,
    viaConnector: null,
    ...overrides,
  };
}

/*
 * `IdeasListPage` slices the Needs-you cards with this value, and `slice(0, NaN)` returns an
 * EMPTY array — so a misconfigured override folded every urgent card behind "N more need you",
 * which is the one thing that list exists to prevent. A negative value dropped cards instead.
 */
describe('IDEA_NEEDS_YOU_VISIBLE', () => {
  it('is a positive integer whatever the environment says', () => {
    expect(Number.isInteger(IDEA_NEEDS_YOU_VISIBLE)).toBe(true);
    expect(IDEA_NEEDS_YOU_VISIBLE).toBeGreaterThan(0);
  });

  it('slices rather than empties the list', () => {
    const cards = Array.from({ length: 10 }, (_, index) => index);
    // The real consumer's expression. With NaN this returned [] and hid everything.
    expect(cards.slice(0, IDEA_NEEDS_YOU_VISIBLE).length).toBeGreaterThan(0);
  });
});

describe('ideaRowLine', () => {
  it('says who is working on it', () => {
    expect(ideaRowLine(item({ derived: derived({ state: 'working', session: session() }) }))).toBe(
      'Opus 5.5 is working in Building retries'
    );
  });

  it('falls back to "An agent" and "the chat" when neither is known', () => {
    expect(
      ideaRowLine(
        item({
          derived: derived({
            state: 'working',
            session: session({ agentLabel: null, topic: null }),
          }),
        })
      )
    ).toBe('An agent is working in the chat');
  });

  it('names the pull request and what its checks did', () => {
    expect(
      ideaRowLine(item({ derived: derived({ state: 'review', pullRequest: pullRequest() }) }))
    ).toBe('PR #482 is open, checks passed');
    expect(
      ideaRowLine(
        item({
          derived: derived({
            state: 'review',
            pullRequest: pullRequest({ checksState: 'failure' }),
          }),
        })
      )
    ).toBe('PR #482 is open, checks failed');
  });

  it('says nothing about checks it does not know about', () => {
    expect(
      ideaRowLine(
        item({
          derived: derived({ state: 'review', pullRequest: pullRequest({ checksState: null }) }),
        })
      )
    ).toBe('PR #482 is open');
  });

  it('asks the merged question on the row itself', () => {
    expect(
      ideaRowLine(
        item({
          derived: derived({
            state: 'merged',
            pullRequest: pullRequest({ state: 'merged', mergedAt: '2026-10-23T08:00:00.000Z' }),
          }),
        })
      )
    ).toBe('PR #482 merged — is this idea done?');
  });

  it('shows what stopped the work, when the work said', () => {
    expect(
      ideaRowLine(
        item({
          derived: derived({
            state: 'stuck',
            session: session(),
            note: 'the suite went red',
          }),
        })
      )
    ).toBe('the suite went red');
  });

  it('says where a done idea shipped', () => {
    expect(
      ideaRowLine(
        item({
          derived: derived({
            state: 'done',
            pullRequest: pullRequest({ state: 'merged', mergedAt: '2026-10-23T08:00:00.000Z' }),
          }),
        })
      )
    ).toBe('Shipped in PR #482');
  });

  it('falls back to the idea’s own summary when nothing has happened', () => {
    expect(ideaRowLine(item())).toBe('Retry with exponential backoff for up to 3 days.');
    expect(ideaRowLine(item({ summary: null }))).toBe('Nothing has started yet');
  });
});

describe('ideaCountsLine', () => {
  const counts = (overrides: Partial<IdeaCounts> = {}): IdeaCounts => ({
    updates: 0,
    chats: 0,
    files: 0,
    pullRequests: 0,
    atLeast: [],
    ...overrides,
  });

  it('omits whatever is zero and gets the plurals right', () => {
    expect(ideaCountsLine(counts({ updates: 4, chats: 2, files: 1 }))).toBe(
      '4 updates · 2 chats · 1 file'
    );
    expect(ideaCountsLine(counts({ updates: 1 }))).toBe('1 update');
    expect(ideaCountsLine(counts({ pullRequests: 1 }))).toBe('1 PR');
    expect(ideaCountsLine(counts({ pullRequests: 2 }))).toBe('2 PRs');
  });

  it('says nothing at all when an idea has collected nothing', () => {
    expect(ideaCountsLine(counts())).toBeNull();
  });

  // The server can only establish a minimum when a bounded link read hits its per-idea cap.
  // Writing that as "50 files" would be a number nobody counted (rule 65).
  it('writes a capped count as a minimum, and leaves the exact ones alone', () => {
    expect(
      ideaCountsLine(
        counts({
          updates: 137,
          chats: 50,
          files: 50,
          pullRequests: 50,
          atLeast: ['chats', 'files', 'pullRequests'],
        })
      )
    ).toBe('137 updates · 50+ chats · 50+ files · 50+ PRs');
  });

  // A minimum of one is still "1+", never "1": the plural rule must not hide the disclosure.
  it('keeps the plural when the count is a minimum of one', () => {
    expect(ideaCountsLine(counts({ files: 1, atLeast: ['files'] }))).toBe('1+ files');
  });
});

describe('ideaSourceLabel', () => {
  it('names where the state came from and when', () => {
    expect(
      ideaSourceLabel(
        { origin: 'github', observedAt: '2026-10-23T11:59:00.000Z', stale: false },
        NOW
      )
    ).toBe('From GitHub, a minute ago');
  });

  it('warns when the state is stored and may be out of date', () => {
    expect(
      ideaSourceLabel(
        { origin: 'github', observedAt: '2026-10-23T11:59:00.000Z', stale: true },
        NOW
      )
    ).toBe('From GitHub, a minute ago, may be out of date');
  });

  it('says nothing when nothing decided the state', () => {
    expect(ideaSourceLabel({ origin: 'none', observedAt: null, stale: false }, NOW)).toBeNull();
  });
});

describe('relativeTime', () => {
  it.each([
    ['2026-10-23T11:59:50.000Z', 'just now'],
    ['2026-10-23T11:59:00.000Z', 'a minute ago'],
    ['2026-10-23T11:45:00.000Z', '15 minutes ago'],
    ['2026-10-23T11:00:00.000Z', 'an hour ago'],
    ['2026-10-23T06:00:00.000Z', '6 hours ago'],
    ['2026-10-22T11:00:00.000Z', 'yesterday'],
    ['2026-10-18T11:00:00.000Z', '5 days ago'],
  ])('%s reads as %s', (iso, expected) => {
    expect(relativeTime(iso, NOW)).toBe(expected);
  });

  it('does not invent a time it cannot read', () => {
    expect(relativeTime('not a date', NOW)).toBe('at an unknown time');
  });
});

describe('ideaAttention', () => {
  it('is nothing for an idea that does not need a person', () => {
    expect(ideaAttention(item())).toBeNull();
    expect(ideaAttention(item({ derived: derived({ state: 'working' }) }))).toBeNull();
    expect(ideaAttention(item({ derived: derived({ state: 'review' }) }))).toBeNull();
  });

  it('offers Answer, pointed at the chat that asked', () => {
    const attention = ideaAttention(
      item({
        derived: derived({
          state: 'question',
          needsYou: 'question',
          session: session({ sessionId: 'sess-asking' }),
          note: 'Cap retries at 3 days?',
        }),
      })
    );
    expect(attention).toMatchObject({
      tone: 'warning',
      title: 'Opus 5.5 asked you something',
      body: 'Cap retries at 3 days?',
      primary: { label: 'Answer', target: { to: 'chat', sessionId: 'sess-asking' } },
    });
    expect(attention?.secondary).toBeUndefined();
  });

  it('falls back to the idea when the question has no chat to open', () => {
    const attention = ideaAttention(
      item({ derived: derived({ state: 'question', needsYou: 'question' }) })
    );
    expect(attention?.primary.target).toEqual({ to: 'idea', ideaId: 'idea-1' });
  });

  it('offers Try again… and See what happened for work that stopped', () => {
    const attention = ideaAttention(
      item({
        derived: derived({
          state: 'stuck',
          needsYou: 'stuck',
          session: session({ sessionId: 'sess-failed' }),
          note: 'pnpm test failed. The suite went red in retry-schedule.test.ts.',
        }),
      })
    );
    // Looking leads, because retrying a failure you have not read repeats it. The note's
    // first sentence leads the card, so a column of stuck cards is scannable.
    expect(attention).toMatchObject({
      tone: 'danger',
      title: 'Work stopped: pnpm test failed',
      // The body picks up where the headline left off, rather than repeating it.
      body: 'The suite went red in retry-schedule.test.ts.',
      primary: { label: 'See what happened', target: { to: 'chat', sessionId: 'sess-failed' } },
      secondary: { label: 'Try again…', target: { to: 'start-work', ideaId: 'idea-1' } },
    });
  });

  // A headline is only worth having if it summarises. A note that rambles on without a
  // sentence break, or whose first sentence is itself a paragraph, would only repeat the
  // opening of the body printed directly underneath it.
  it('says where it stopped when the headline used up the whole note', () => {
    const attention = ideaAttention(
      item({
        derived: derived({
          state: 'stuck',
          needsYou: 'stuck',
          session: session({ sessionId: 'sess-failed', topic: 'Wiring the retry schedule' }),
          note: 'pnpm test failed.',
        }),
      })
    );
    expect(attention?.title).toBe('Work stopped: pnpm test failed');
    // Not the same sentence twice.
    expect(attention?.body).toBe('Wiring the retry schedule stopped before it finished.');
  });

  it.each([
    ['no sentence break at all', 'x'.repeat(200)],
    ['a first sentence too long to be a headline', `${'x '.repeat(60)}. And then more.`],
  ])('keeps the generic headline for %s', (_case, note) => {
    const attention = ideaAttention(
      item({
        derived: derived({
          state: 'stuck',
          needsYou: 'stuck',
          session: session({ sessionId: 'sess-failed' }),
          note,
        }),
      })
    );
    expect(attention?.title).toBe('Work stopped');
    expect(attention?.body).toBe(note);
  });

  it('offers only a retry for stopped work with no chat to open', () => {
    const attention = ideaAttention(
      item({ derived: derived({ state: 'stuck', needsYou: 'stuck', session: null }) })
    );
    expect(attention?.primary).toEqual({
      label: 'Try again…',
      target: { to: 'start-work', ideaId: 'idea-1' },
    });
    expect(attention?.secondary).toBeUndefined();
  });

  it('asks whether a merged pull request finished the idea, with both answers', () => {
    const attention = ideaAttention(
      item({
        derived: derived({
          state: 'merged',
          needsYou: 'merged',
          pullRequest: pullRequest({ state: 'merged', mergedAt: '2026-10-23T08:00:00.000Z' }),
        }),
      })
    );
    expect(attention?.tone).toBe('info');
    expect(attention?.title).toContain('PR #482 was merged');
    expect(attention?.primary).toEqual({
      label: 'Mark done',
      target: { to: 'mark-done', ideaId: 'idea-1' },
    });
    expect(attention?.secondary).toEqual({
      label: 'Keep open',
      target: { to: 'keep-open', ideaId: 'idea-1' },
    });
  });
});

describe('ideaPrimaryAction', () => {
  it.each([
    ['not-started', 'Start work'],
    ['merged', 'Mark done'],
    ['done', 'Start follow-up work'],
    ['parked', 'Reopen'],
  ] as const)('%s offers %s', (state, label) => {
    expect(ideaPrimaryAction({ ideaId: 'idea-1', derived: derived({ state }) }).label).toBe(label);
  });

  it('opens the chat while work is running', () => {
    expect(
      ideaPrimaryAction({
        ideaId: 'idea-1',
        derived: derived({ state: 'working', session: session({ sessionId: 'sess-live' }) }),
      })
    ).toEqual({ label: 'Open the chat', target: { to: 'chat', sessionId: 'sess-live' } });
  });

  it('answers the question while one is open', () => {
    expect(
      ideaPrimaryAction({
        ideaId: 'idea-1',
        derived: derived({ state: 'question', session: session({ sessionId: 'sess-ask' }) }),
      })
    ).toEqual({ label: 'Answer', target: { to: 'chat', sessionId: 'sess-ask' } });
  });

  it('reviews the pull request while one is open', () => {
    expect(
      ideaPrimaryAction({
        ideaId: 'idea-1',
        derived: derived({ state: 'review', pullRequest: pullRequest() }),
      })
    ).toEqual({
      label: 'Review PR #482',
      target: { to: 'pull-request', url: 'https://github.com/acme/payments/pull/482' },
    });
  });

  it('falls back to starting work when the state’s own target is missing', () => {
    expect(
      ideaPrimaryAction({ ideaId: 'idea-1', derived: derived({ state: 'working' }) }).label
    ).toBe('Start work');
    expect(
      ideaPrimaryAction({ ideaId: 'idea-1', derived: derived({ state: 'review' }) }).label
    ).toBe('Start work');
  });
});

describe('ideaSecondaryAction', () => {
  it('pairs Mark done with Keep open', () => {
    expect(
      ideaSecondaryAction({ ideaId: 'idea-1', derived: derived({ state: 'merged' }) })
    ).toEqual({ label: 'Keep open', target: { to: 'keep-open', ideaId: 'idea-1' } });
  });

  // Every one of these asserts the label AND the target together. A "Park" button shipped
  // wired to "mark done" because only the label was ever checked, and the three status
  // actions are one `keep-open` typo apart from each other.
  it('reopens a done idea rather than acknowledging a merge', () => {
    expect(ideaSecondaryAction({ ideaId: 'idea-1', derived: derived({ state: 'done' }) })).toEqual({
      label: 'Reopen',
      target: { to: 'reopen', ideaId: 'idea-1' },
    });
  });

  it('parks an idea nobody has started, which is not the same as finishing it', () => {
    expect(
      ideaSecondaryAction({ ideaId: 'idea-1', derived: derived({ state: 'not-started' }) })
    ).toEqual({ label: 'Park', target: { to: 'park', ideaId: 'idea-1' } });
  });

  it('reopens a parked idea rather than acknowledging a merge', () => {
    expect(ideaPrimaryAction({ ideaId: 'idea-1', derived: derived({ state: 'parked' }) })).toEqual({
      label: 'Reopen',
      target: { to: 'reopen', ideaId: 'idea-1' },
    });
  });

  it('offers the chat beside an open pull request', () => {
    expect(
      ideaSecondaryAction({
        ideaId: 'idea-1',
        derived: derived({ state: 'review', session: session({ sessionId: 'sess-7' }) }),
      })
    ).toEqual({ label: 'Open the chat', target: { to: 'chat', sessionId: 'sess-7' } });
  });

  it('offers the retry as the quieter half of a stopped run', () => {
    expect(
      ideaSecondaryAction({
        ideaId: 'idea-1',
        derived: derived({ state: 'stuck', session: session({ sessionId: 'sess-7' }) }),
      })
    ).toEqual({ label: 'Try again…', target: { to: 'start-work', ideaId: 'idea-1' } });
  });

  it('has nothing to add while work is running', () => {
    expect(
      ideaSecondaryAction({ ideaId: 'idea-1', derived: derived({ state: 'working' }) })
    ).toBeNull();
  });
});

describe('Needs you is ranked by urgency, not recency', () => {
  // The cap is three cards and then a fold, so the slice order decides what a person sees.
  // The server orders by `updated_at`, which says nothing about urgency: without a ranking
  // the newest card wins, and a chat blocked on an answer disappears behind the fold
  // because someone merged a pull request five minutes ago (rule 65).
  const needsYouItem = (id: string, state: 'question' | 'stuck' | 'merged') =>
    item({ ideaId: id, derived: derived({ state, needsYou: state }) });

  it('puts an unanswered question first, then stopped work, then a merged pull request', () => {
    // Deliberately given in the reverse of the wanted order, so a function that returns the
    // input untouched cannot pass.
    const groups = groupIdeas([
      needsYouItem('merged-1', 'merged'),
      needsYouItem('stuck-1', 'stuck'),
      needsYouItem('question-1', 'question'),
    ]);
    expect(groups.needsYou.map((entry) => entry.ideaId)).toEqual([
      'question-1',
      'stuck-1',
      'merged-1',
    ]);
  });

  it('folds the merged card, not the question, when more than three need you', () => {
    // The case the page actually hits: four cards, three slots. The one that folds must be
    // the decision that can wait, never the agent that is blocked.
    const groups = groupIdeas([
      needsYouItem('merged-1', 'merged'),
      needsYouItem('merged-2', 'merged'),
      needsYouItem('stuck-1', 'stuck'),
      needsYouItem('question-1', 'question'),
    ]);
    expect(groups.needsYou.slice(0, 3).map((entry) => entry.ideaId)).toEqual([
      'question-1',
      'stuck-1',
      'merged-1',
    ]);
  });

  it('keeps the server’s recency order within one urgency', () => {
    const groups = groupIdeas([
      needsYouItem('stuck-newest', 'stuck'),
      needsYouItem('stuck-older', 'stuck'),
    ]);
    expect(groups.needsYou.map((entry) => entry.ideaId)).toEqual(['stuck-newest', 'stuck-older']);
  });
});

describe('groupIdeas', () => {
  const needsYou = item({
    ideaId: 'needs-you',
    derived: derived({ state: 'stuck', needsYou: 'stuck' }),
  });
  const working = item({ ideaId: 'working', derived: derived({ state: 'working' }) });
  const inReview = item({ ideaId: 'review', derived: derived({ state: 'review' }) });
  const fresh = item({ ideaId: 'fresh' });
  const done = item({ ideaId: 'done', derived: derived({ state: 'done' }) });
  const parked = item({ ideaId: 'parked', derived: derived({ state: 'parked' }) });
  const agentFiled = item({ ideaId: 'agent', filedByAgent: true, filedBy: 'incident' });

  it('puts each idea in exactly one visible section', () => {
    const groups = groupIdeas([needsYou, working, inReview, fresh, done, parked]);
    expect(groups.needsYou.map((entry) => entry.ideaId)).toEqual(['needs-you']);
    expect(groups.inProgress.map((entry) => entry.ideaId)).toEqual(['working', 'review']);
    expect(groups.notStarted.map((entry) => entry.ideaId)).toEqual(['fresh']);
    expect(groups.doneRecently.map((entry) => entry.ideaId)).toEqual(['done', 'parked']);
    expect(groups.filedByAgents).toEqual([]);
  });

  it('keeps an idea that needs you out of the other sections', () => {
    const groups = groupIdeas([needsYou]);
    expect(groups.inProgress).toEqual([]);
    expect(groups.notStarted).toEqual([]);
    expect(groups.doneRecently).toEqual([]);
  });

  it('folds an agent-filed idea away instead of letting it crowd the list', () => {
    const groups = groupIdeas([fresh, agentFiled]);
    expect(groups.notStarted.map((entry) => entry.ideaId)).toEqual(['fresh']);
    expect(groups.filedByAgents.map((entry) => entry.ideaId)).toEqual(['agent']);
  });

  it('still surfaces an agent-filed idea that needs a person', () => {
    const agentNeedsYou = item({
      ideaId: 'agent-stuck',
      filedByAgent: true,
      derived: derived({ state: 'stuck', needsYou: 'stuck' }),
    });
    const groups = groupIdeas([agentNeedsYou]);
    expect(groups.needsYou.map((entry) => entry.ideaId)).toEqual(['agent-stuck']);
    expect(groups.filedByAgents.map((entry) => entry.ideaId)).toEqual(['agent-stuck']);
  });
});

describe('ideaMatchesSearch', () => {
  it('matches the title and the summary, case-insensitively', () => {
    expect(ideaMatchesSearch(item(), 'WEBHOOK')).toBe(true);
    expect(ideaMatchesSearch(item(), 'exponential')).toBe(true);
    expect(ideaMatchesSearch(item(), 'kubernetes')).toBe(false);
  });

  it('matches everything when nothing was typed', () => {
    expect(ideaMatchesSearch(item(), '   ')).toBe(true);
  });

  it('does not blow up on an idea with no summary', () => {
    expect(ideaMatchesSearch(item({ summary: null }), 'webhook')).toBe(true);
  });
});
