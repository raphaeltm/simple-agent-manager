/**
 * The idea-links payload normaliser.
 *
 * `IdeaContext` feeds the Start work sheet, which renders inside a dialog on the idea page.
 * An older API, a proxy with a different body shape, or a route mock that answers `{}` must
 * leave the sheet saying "nothing linked yet" rather than throwing inside its render path, so
 * every list, row and field is parsed defensively instead of cast.
 */
import { describe, expect, it } from 'vitest';

import { normalizeIdeaContext } from '../../../src/lib/api/links';

describe('normalizeIdeaContext', () => {
  it('degrades a body that is not an object to four empty lists', () => {
    for (const value of [undefined, null, 'nope', 7, []]) {
      const context = normalizeIdeaContext(value);
      expect(context.sessions.items).toEqual([]);
      expect(context.files.items).toEqual([]);
      expect(context.pullRequests.items).toEqual([]);
      expect(context.relatedIdeas.items).toEqual([]);
      expect(context.sessions.total).toBe(0);
      expect(context.sessions.truncated).toBe(false);
    }
  });

  it('reads all four lists of a well-formed context', () => {
    const context = normalizeIdeaContext({
      sessions: {
        items: [
          {
            sessionId: 'sess-1',
            topic: 'Rate limiting',
            status: 'active',
            relations: ['works_on'],
            lastActivityAt: 1792800000000,
            taskId: 'task-1',
          },
        ],
        total: 1,
        truncated: false,
        totalIsLowerBound: false,
      },
      files: {
        items: [
          {
            fileId: 'file-1',
            filename: 'plan.md',
            directory: '/engineering',
            relations: ['created'],
            bySessionId: 'sess-1',
          },
        ],
        total: 1,
      },
      pullRequests: {
        items: [
          {
            url: 'https://github.com/owner/repo/pull/12',
            number: 12,
            source: 'task_output',
            state: null,
            bySessionId: 'sess-1',
          },
        ],
        total: 1,
      },
      relatedIdeas: {
        items: [{ ideaId: 'idea-2', title: 'Split the payouts worker', status: 'draft' }],
        total: 1,
      },
    });

    expect(context.sessions.items[0]).toEqual({
      sessionId: 'sess-1',
      topic: 'Rate limiting',
      status: 'active',
      relations: ['works_on'],
      lastActivityAt: 1792800000000,
      taskId: 'task-1',
    });
    expect(context.files.items[0]?.filename).toBe('plan.md');
    expect(context.pullRequests.items[0]?.number).toBe(12);
    expect(context.relatedIdeas.items[0]?.ideaId).toBe('idea-2');
    // No `relations` key at all is an empty list, not a crash.
    expect(context.relatedIdeas.items[0]?.relations).toEqual([]);
  });

  it('drops a row with no identifier rather than rendering a row that links nowhere', () => {
    const context = normalizeIdeaContext({
      sessions: { items: [{ topic: 'No id' }, { sessionId: 'sess-2' }] },
      relatedIdeas: { items: [{ title: 'No id' }] },
      files: { items: [{ filename: 'no-id.md' }] },
      pullRequests: {
        items: [
          { url: 'https://github.com/owner/repo/pull/3' },
          { number: 3 },
          { url: 'https://github.com/owner/repo/pull/0', number: 0 },
        ],
      },
    });
    expect(context.sessions.items.map((s) => s.sessionId)).toEqual(['sess-2']);
    expect(context.relatedIdeas.items).toEqual([]);
    expect(context.files.items).toEqual([]);
    expect(context.pullRequests.items).toEqual([]);
  });

  it('drops a relation string the client does not know', () => {
    const context = normalizeIdeaContext({
      sessions: {
        items: [{ sessionId: 'sess-1', relations: ['works_on', 'WORKS_ON', 'nonsense', 4] }],
      },
    });
    expect(context.sessions.items[0]?.relations).toEqual(['works_on']);
  });

  it('deduplicates relations so a phrase is rendered once', () => {
    const context = normalizeIdeaContext({
      sessions: { items: [{ sessionId: 'sess-1', relations: ['discusses', 'discusses'] }] },
    });
    expect(context.sessions.items[0]?.relations).toEqual(['discusses']);
  });

  it('keeps a total above the rows sent, because that is what truncated means', () => {
    const context = normalizeIdeaContext({
      sessions: {
        items: [{ sessionId: 'sess-1' }],
        total: 40,
        truncated: true,
        totalIsLowerBound: true,
      },
    });
    expect(context.sessions.total).toBe(40);
    expect(context.sessions.truncated).toBe(true);
    expect(context.sessions.totalIsLowerBound).toBe(true);
  });

  it('falls back to the surviving row count when the reported total is incoherent', () => {
    for (const total of [undefined, null, 'many', Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      const context = normalizeIdeaContext({
        sessions: { items: [{ sessionId: 'sess-1' }, { sessionId: 'sess-2' }], total },
      });
      expect(context.sessions.total).toBe(2);
    }
  });

  it('parses pull request state only when the state word is one the UI can render', () => {
    const context = normalizeIdeaContext({
      pullRequests: {
        items: [
          {
            url: 'https://github.com/owner/repo/pull/1',
            number: 1,
            state: { state: 'merged', isDraft: false, checksState: 'success', stale: false },
          },
          {
            url: 'https://github.com/owner/repo/pull/2',
            number: 2,
            state: { state: 'reopened', checksState: 'success' },
          },
          {
            url: 'https://github.com/owner/repo/pull/3',
            number: 3,
            state: { state: 'open', checksState: 'exploded' },
          },
        ],
      },
    });
    expect(context.pullRequests.items[0]?.state?.state).toBe('merged');
    expect(context.pullRequests.items[0]?.state?.checksState).toBe('success');
    // An unrenderable state word means "no pill", not a pill reading "reopened".
    expect(context.pullRequests.items[1]?.state).toBeNull();
    // A known state with an unknown checks word keeps the state and drops the checks word.
    expect(context.pullRequests.items[2]?.state?.state).toBe('open');
    expect(context.pullRequests.items[2]?.state?.checksState).toBeNull();
  });

  it('defaults an unrecognised pull request source to an explicit link', () => {
    const context = normalizeIdeaContext({
      pullRequests: {
        items: [{ url: 'https://github.com/owner/repo/pull/1', number: 1, source: 'telepathy' }],
      },
    });
    expect(context.pullRequests.items[0]?.source).toBe('explicit_link');
  });
});
