/**
 * One definition of the idea shapes the tests build.
 *
 * `IdeaDerivedStatus` and `IdeaDetail` were being rebuilt field-by-field in every file that
 * needed one — the idea page's tests, the Ideas list's, the Start work sheet's and its
 * Playwright audit. Four copies of a shape means four places to edit when a field is added,
 * and three of them will be missed; it is also what SonarCloud measured as duplication on new
 * code. Both are symptoms of the same thing, so the fix is a shared factory rather than a
 * smaller diff.
 *
 * Deliberately permissive about overrides: a test should be able to say exactly the one field
 * it cares about and let the rest be the boring default.
 */
import type { IdeaDerivedStatus } from '@simple-agent-manager/shared';

import type { IdeaDetail } from '../../src/lib/api';

/** A derived status that nothing has happened to yet. */
export function makeDerived(overrides: Partial<IdeaDerivedStatus> = {}): IdeaDerivedStatus {
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

/** An idea with a plan and nothing linked to it. */
export function makeIdeaDetail(overrides: Partial<IdeaDetail> = {}): IdeaDetail {
  return {
    ideaId: 'idea-1',
    title: 'Retry failed webhook deliveries',
    content: '# What we want\n\n- Retry with exponential backoff for up to 3 days.',
    summary: 'Retry with exponential backoff for up to 3 days.',
    status: 'draft',
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    derived: makeDerived(),
    counts: { updates: 0, chats: 0, files: 0, pullRequests: 0 },
    filedByAgent: false,
    filedBy: null,
    completedAt: null,
    sessions: [],
    pullRequests: [],
    // The detail response carries the newest Updates slice now, so the page makes one request
    // per poll instead of two. An idea with no notes still has the envelope.
    updates: { items: [], total: 0, nextCursor: null },
    ...overrides,
  };
}

/** The four capped lists an idea's `/links` read returns, all empty. */
export function emptyIdeaLinks() {
  const empty = { items: [], total: 0, truncated: false, totalIsLowerBound: false };
  return { sessions: empty, files: empty, pullRequests: empty, relatedIdeas: empty };
}
