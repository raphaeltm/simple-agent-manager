/**
 * The plain-words layer and the payload normaliser behind linked work.
 *
 * These are pure, so they are tested directly — the surfaces that render them are covered
 * behaviourally in `tests/unit/components/chat/session-linked-work.test.tsx`,
 * `tests/unit/components/library/file-linked-work.test.tsx` and the Playwright audit.
 */
import type { LinkedSession, LinkRelation } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import { normalizeFileContext, normalizeSessionContext } from '../../../src/lib/api/links';
import {
  describeRelations,
  fileProvenance,
  formatCappedTotal,
  isKnownLinkRelation,
  LINK_RELATION_LABELS,
  linkedSessionLabel,
  orderFileSessions,
  sortLinkRelations,
} from '../../../src/lib/linked-work';

/**
 * The shared union, restated here on purpose.
 *
 * `LINK_RELATION_LABELS` is typed `Record<LinkRelation, string>`, so a MISSING phrase is a
 * typecheck failure. This list catches the other direction a type cannot: a relation removed
 * from the union leaving a dead phrase, and a phrase that is empty or still a raw enum value.
 */
const EVERY_RELATION: LinkRelation[] = [
  'created',
  'edited',
  'read',
  'works_on',
  'discusses',
  'linked',
  'uploaded',
  'replaced',
  'viewed',
  'opened',
  'related',
];

function session(overrides: Partial<LinkedSession> = {}): LinkedSession {
  return {
    sessionId: 's-1',
    topic: 'A chat',
    status: 'active',
    relations: ['viewed'],
    lastActivityAt: 1,
    taskId: null,
    ...overrides,
  };
}

describe('link relation labels', () => {
  it('gives every relation a human phrase and nothing else', () => {
    expect(Object.keys(LINK_RELATION_LABELS).sort()).toEqual([...EVERY_RELATION].sort());
    for (const relation of EVERY_RELATION) {
      const label = LINK_RELATION_LABELS[relation];
      expect(label.length).toBeGreaterThan(0);
      // A phrase, not the stored verb: `works_on` must not reach a user as "works_on".
      expect(label).not.toContain('_');
      expect(label[0]).toBe(label[0]?.toUpperCase());
    }
  });

  it('accepts only relations it has a phrase for', () => {
    for (const relation of EVERY_RELATION) expect(isKnownLinkRelation(relation)).toBe(true);
    for (const other of ['', 'mentions', 'WORKS_ON', 42, null, undefined, {}]) {
      expect(isKnownLinkRelation(other)).toBe(false);
    }
  });

  it('puts what the chat did before what it only saw', () => {
    expect(sortLinkRelations(['read', 'works_on'])).toEqual(['works_on', 'read']);
    expect(sortLinkRelations(['viewed', 'uploaded'])).toEqual(['uploaded', 'viewed']);
    expect(describeRelations(['read', 'works_on'])).toBe('Working on · Read');
    expect(describeRelations(['uploaded'])).toBe('Uploaded');
  });

  it('describes nothing as an empty string, so no stray separator is rendered', () => {
    expect(describeRelations([])).toBe('');
  });
});

describe('formatCappedTotal', () => {
  it('renders an exact count plainly and a bounded one with a plus', () => {
    expect(formatCappedTotal({ total: 4, totalIsLowerBound: false })).toBe('4');
    expect(formatCappedTotal({ total: 4, totalIsLowerBound: true })).toBe('4+');
    // Zero is still zero, not "0+" — a lower bound of nothing would be meaningless.
    expect(formatCappedTotal({ total: 0, totalIsLowerBound: false })).toBe('0');
  });
});

describe('file provenance', () => {
  it('leads with the chat that produced the file, then the most recent reader', () => {
    const ordered = orderFileSessions([
      session({ sessionId: 'old-reader', relations: ['viewed'], lastActivityAt: 10 }),
      session({ sessionId: 'new-reader', relations: ['viewed'], lastActivityAt: 99 }),
      session({ sessionId: 'author', relations: ['uploaded'], lastActivityAt: 1 }),
    ]);
    expect(ordered.map((s) => s.sessionId)).toEqual(['author', 'new-reader', 'old-reader']);
  });

  it('sorts a chat with no recorded activity last rather than first', () => {
    const ordered = orderFileSessions([
      session({ sessionId: 'undated', relations: ['viewed'], lastActivityAt: null }),
      session({ sessionId: 'dated', relations: ['viewed'], lastActivityAt: 5 }),
    ]);
    expect(ordered.map((s) => s.sessionId)).toEqual(['dated', 'undated']);
  });

  it('names the verb from the strongest relation the producing chat has', () => {
    expect(fileProvenance([session({ relations: ['uploaded'] })])?.verb).toBe('Uploaded by');
    expect(fileProvenance([session({ relations: ['replaced'] })])?.verb).toBe('Replaced by');
    expect(fileProvenance([session({ relations: ['viewed'] })])?.verb).toBe('Viewed by');
    // An idea-linked file with no session relation still gets an honest phrase.
    expect(fileProvenance([session({ relations: [] })])?.verb).toBe('Linked to');
    expect(fileProvenance([])).toBeNull();
  });

  it('labels an untitled chat rather than rendering an empty name', () => {
    expect(linkedSessionLabel({ topic: null })).toBe('Untitled chat');
    expect(linkedSessionLabel({ topic: '   ' })).toBe('Untitled chat');
    expect(linkedSessionLabel({ topic: 'Fix the login bug' })).toBe('Fix the login bug');
  });
});

describe('normalizeSessionContext', () => {
  it('reads a well-formed payload through unchanged', () => {
    const context = normalizeSessionContext({
      ideas: {
        items: [{ ideaId: 'i-1', title: 'Idea', status: 'draft', relations: ['works_on'] }],
        total: 7,
        truncated: true,
        totalIsLowerBound: true,
      },
      files: { items: [], total: 0, truncated: false, totalIsLowerBound: false },
      pullRequests: {
        items: [
          {
            url: 'https://github.com/o/r/pull/3',
            number: 3,
            source: 'task_output',
            bySessionId: 's-1',
            state: {
              state: 'merged',
              isDraft: false,
              title: 'A pull request',
              checksState: 'success',
              mergedAt: '2026-10-24T00:00:00Z',
              updatedAt: '2026-10-24T00:00:00Z',
              stale: false,
            },
          },
        ],
        total: 1,
        truncated: false,
        totalIsLowerBound: false,
      },
    });

    expect(context.ideas.items).toEqual([
      { ideaId: 'i-1', title: 'Idea', status: 'draft', relations: ['works_on'] },
    ]);
    expect(context.ideas.total).toBe(7);
    expect(context.ideas.totalIsLowerBound).toBe(true);
    expect(context.pullRequests.items[0]?.state?.state).toBe('merged');
    expect(context.pullRequests.items[0]?.state?.checksState).toBe('success');
  });

  it('degrades a body it cannot read to nothing linked instead of throwing', () => {
    // This is the shape a test harness catch-all, an older API, or a proxy error page returns.
    // The chat header renders this on every project chat, so a throw here is a blank page.
    for (const payload of [{}, null, undefined, 'nope', 42, [], { ideas: 'nope' }]) {
      const context = normalizeSessionContext(payload);
      expect(context.ideas.items).toEqual([]);
      expect(context.files.items).toEqual([]);
      expect(context.pullRequests.items).toEqual([]);
      expect(context.ideas.total).toBe(0);
      expect(context.ideas.totalIsLowerBound).toBe(false);
    }
  });

  it('drops rows with no identifier rather than linking nowhere', () => {
    const context = normalizeSessionContext({
      ideas: { items: [{ title: 'No id' }, { ideaId: 'i-2', title: 'Kept' }] },
      files: { items: [{ filename: 'orphan.md' }, { fileId: 'f-2' }] },
      pullRequests: {
        items: [
          { url: 'https://github.com/o/r/pull/1' },
          { number: 2 },
          { url: 'https://github.com/o/r/pull/3', number: 0 },
          { url: 'https://github.com/o/r/pull/4', number: 4 },
        ],
      },
    });
    expect(context.ideas.items.map((i) => i.ideaId)).toEqual(['i-2']);
    expect(context.files.items.map((f) => f.fileId)).toEqual(['f-2']);
    expect(context.pullRequests.items.map((p) => p.number)).toEqual([4]);
  });

  it('keeps a total above the rows it was sent — that is what truncation means', () => {
    expect(
      normalizeSessionContext({ ideas: { items: [{ ideaId: 'a' }], total: 9, truncated: true } })
        .ideas
    ).toMatchObject({ total: 9, truncated: true });
  });

  it('never reports a total below the number of rows it kept', () => {
    // An incoherent total (fewer than the rows actually sent, or not a number at all) falls
    // back to the one count that is certainly true.
    expect(
      normalizeSessionContext({ ideas: { items: [{ ideaId: 'a' }, { ideaId: 'b' }], total: 1 } })
        .ideas.total
    ).toBe(2);
    expect(
      normalizeSessionContext({ ideas: { items: [{ ideaId: 'a' }], total: 'lots' } }).ideas.total
    ).toBe(1);
    expect(
      normalizeSessionContext({ ideas: { items: [{ ideaId: 'a' }], total: Number.NaN } }).ideas
        .total
    ).toBe(1);
  });

  it('fills missing display fields and drops relations it has no phrase for', () => {
    const context = normalizeSessionContext({
      ideas: { items: [{ ideaId: 'i-1', relations: ['works_on', 'invented', 'works_on'] }] },
      files: { items: [{ fileId: 'f-1', relations: 'not-an-array' }] },
    });
    expect(context.ideas.items[0]).toEqual({
      ideaId: 'i-1',
      title: 'Untitled idea',
      status: 'draft',
      // Deduplicated, and the unknown relation is gone rather than printed raw.
      relations: ['works_on'],
    });
    expect(context.files.items[0]?.filename).toBe('Untitled file');
    expect(context.files.items[0]?.directory).toBe('/');
    expect(context.files.items[0]?.relations).toEqual([]);
  });

  it('treats an unrecognised pull-request state as no state at all', () => {
    const context = normalizeSessionContext({
      pullRequests: {
        items: [
          {
            url: 'https://github.com/o/r/pull/5',
            number: 5,
            state: { state: 'rebased', isDraft: false, checksState: 'cancelled' },
          },
        ],
      },
    });
    // No pill is better than a pill asserting a state SAM does not understand.
    expect(context.pullRequests.items[0]?.state).toBeNull();
  });

  it('keeps a known state while discarding only an unknown checks value', () => {
    const context = normalizeSessionContext({
      pullRequests: {
        items: [
          {
            url: 'https://github.com/o/r/pull/6',
            number: 6,
            state: { state: 'open', isDraft: true, checksState: 'cancelled' },
          },
        ],
      },
    });
    expect(context.pullRequests.items[0]?.state?.state).toBe('open');
    expect(context.pullRequests.items[0]?.state?.isDraft).toBe(true);
    expect(context.pullRequests.items[0]?.state?.checksState).toBeNull();
  });
});

describe('normalizeFileContext', () => {
  it('reads sessions and ideas, and degrades an unreadable body to nothing', () => {
    const context = normalizeFileContext({
      sessions: {
        items: [
          {
            sessionId: 's-1',
            topic: 'Wrote it',
            status: 'completed',
            relations: ['uploaded'],
            lastActivityAt: 12,
            taskId: 't-1',
          },
        ],
        total: 1,
      },
      ideas: { items: [{ ideaId: 'i-1', title: 'Idea' }] },
    });
    expect(context.sessions.items[0]?.topic).toBe('Wrote it');
    expect(context.sessions.items[0]?.lastActivityAt).toBe(12);
    expect(context.ideas.items[0]?.ideaId).toBe('i-1');

    const empty = normalizeFileContext({});
    expect(empty.sessions.items).toEqual([]);
    expect(empty.ideas.items).toEqual([]);
  });

  it('keeps a null topic null, so the UI decides how to label an untitled chat', () => {
    const context = normalizeFileContext({
      sessions: { items: [{ sessionId: 's-1', topic: '', lastActivityAt: 'soon' }] },
    });
    expect(context.sessions.items[0]?.topic).toBeNull();
    expect(context.sessions.items[0]?.lastActivityAt).toBeNull();
    expect(context.sessions.items[0]?.status).toBe('unknown');
  });
});
