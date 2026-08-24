/**
 * The comment inbox triage model.
 *
 * `bucketFor` is the load-bearing function of the whole comment-navigation
 * feature: it is the answer to "has anything happened that I have not seen?",
 * which is the question that previously had no surface at all. A regression here
 * — an inverted actor comparison, a missed status — shows every thread as
 * needing you or none of them, while the UI still renders perfectly.
 */
import { describe, expect, it } from 'vitest';

import {
  bucketFor,
  bucketForThread,
  byRecency,
  COMMENT_BUCKET_ORDER,
  type CommentInboxItem,
  countBuckets,
  filterInbox,
  groupInbox,
  lastActivitySummary,
  sourceLabel,
  toInboxItem,
} from '../../../src/components/project-message-view/comments/comment-inbox';
import type { UiCommentThread } from '../../../src/components/project-message-view/comments/comment-utils';

const VIEWER = 'user-viewer';
const OTHER = 'user-other';

function author(id: string, name: string, kind: 'human' | 'agent' = 'human') {
  return { id, kind, name, email: null, avatarUrl: null };
}

function thread(overrides: Partial<UiCommentThread> = {}): UiCommentThread {
  return {
    id: 'thread-1',
    clientId: null,
    projectId: 'project-1',
    anchor: { kind: 'message', messageId: 'message-1', quote: 'quoted' },
    author: author(VIEWER, 'You'),
    body: 'root comment',
    createdAt: 1_000,
    updatedAt: 1_000,
    status: 'open',
    replies: [],
    syncState: 'synced',
    ...overrides,
  } as UiCommentThread;
}

function reply(id: string, actorId: string, createdAt: number) {
  return {
    id,
    clientId: null,
    author: author(actorId, actorId === VIEWER ? 'You' : 'Grace'),
    body: `reply ${id}`,
    createdAt,
    updatedAt: null,
    sentToAgent: false,
    syncState: 'synced' as const,
  };
}

const SESSION_SOURCE = {
  kind: 'session' as const,
  sessionId: 'session-1',
  sessionTopic: 'Ship the inbox',
  messageId: 'message-1',
};

function item(t: UiCommentThread): CommentInboxItem {
  return toInboxItem(t, SESSION_SOURCE);
}

describe('toInboxItem', () => {
  it('takes last activity from the newest reply, not the thread body', () => {
    const result = item(
      thread({ replies: [reply('r1', OTHER, 5_000), reply('r2', OTHER, 3_000)] })
    );

    expect(result.lastActivityAt).toBe(5_000);
    expect(result.lastActor.id).toBe(OTHER);
    expect(result.messageCount).toBe(3);
  });

  it('falls back to the thread itself when there are no replies', () => {
    const result = item(thread());

    expect(result.lastActivityAt).toBe(1_000);
    expect(result.lastActor.id).toBe(VIEWER);
    expect(result.messageCount).toBe(1);
  });

  /**
   * Replies are appended, but a thread can be optimistically reordered
   * mid-flight, so the reducer takes the max rather than the tail.
   */
  it('takes the max reply time even when replies arrive out of order', () => {
    const result = item(
      thread({ replies: [reply('r1', OTHER, 9_000), reply('r2', VIEWER, 2_000)] })
    );

    expect(result.lastActivityAt).toBe(9_000);
    expect(result.lastActor.id).toBe(OTHER);
  });
});

describe('bucketFor', () => {
  it('is needs_you when somebody else spoke last on an open thread', () => {
    expect(bucketFor(item(thread({ replies: [reply('r1', OTHER, 5_000)] })), VIEWER)).toBe(
      'needs_you'
    );
  });

  it('is open when the viewer spoke last', () => {
    expect(bucketFor(item(thread({ replies: [reply('r1', VIEWER, 5_000)] })), VIEWER)).toBe('open');
  });

  it('is open for a thread the viewer opened and nobody answered', () => {
    expect(bucketFor(item(thread()), VIEWER)).toBe('open');
  });

  /** `sent` and `resolved` are viewer-independent and outrank the actor check. */
  it('is with_agent for a sent thread even when somebody else spoke last', () => {
    const sent = thread({ status: 'sent', replies: [reply('r1', OTHER, 5_000)] });
    expect(bucketFor(item(sent), VIEWER)).toBe('with_agent');
  });

  it('is resolved for a resolved thread even when somebody else spoke last', () => {
    const done = thread({ status: 'resolved', replies: [reply('r1', OTHER, 5_000)] });
    expect(bucketFor(item(done), VIEWER)).toBe('resolved');
  });

  /**
   * Signed out there is no "you", so nothing can be waiting on you. Without the
   * `viewerId &&` guard every thread would land in needs_you.
   */
  it('never reports needs_you when there is no viewer', () => {
    const byOther = thread({ replies: [reply('r1', OTHER, 5_000)] });
    expect(bucketFor(item(byOther), null)).toBe('open');
  });
});

describe('bucketForThread', () => {
  /**
   * The chat timeline keys its dot to this. It used to key to raw `status`,
   * which made the timeline paint a thread amber ("waiting on you") while the
   * drawer painted the very same thread grey. This pins the two together.
   */
  it('agrees with bucketFor for the same thread', () => {
    const cases: Array<[UiCommentThread, string | null]> = [
      [thread({ replies: [reply('r1', OTHER, 5_000)] }), VIEWER],
      [thread({ replies: [reply('r1', VIEWER, 5_000)] }), VIEWER],
      [thread({ status: 'sent' }), VIEWER],
      [thread({ status: 'resolved' }), VIEWER],
      [thread(), null],
    ];

    for (const [t, viewer] of cases) {
      const asItem = item(t);
      expect(bucketForThread(t.status, asItem.lastActor.id, viewer)).toBe(
        bucketFor(asItem, viewer)
      );
    }
  });

  it('does not report needs_you for a thread the viewer answered last', () => {
    expect(bucketForThread('open', VIEWER, VIEWER)).toBe('open');
  });
});

describe('countBuckets', () => {
  it('counts each bucket and the total', () => {
    const items = [
      item(thread({ id: 'a', replies: [reply('r', OTHER, 5_000)] })),
      item(thread({ id: 'b', replies: [reply('r', OTHER, 5_000)] })),
      item(thread({ id: 'c', status: 'sent' })),
      item(thread({ id: 'd' })),
      item(thread({ id: 'e', status: 'resolved' })),
    ];

    expect(countBuckets(items, VIEWER)).toEqual({
      all: 5,
      needs_you: 2,
      with_agent: 1,
      open: 1,
      resolved: 1,
    });
  });

  it('reports zeroes rather than omitting buckets when there is nothing', () => {
    expect(countBuckets([], VIEWER)).toEqual({
      all: 0,
      needs_you: 0,
      with_agent: 0,
      open: 0,
      resolved: 0,
    });
  });
});

describe('filterInbox', () => {
  const items = [
    item(thread({ id: 'needs', createdAt: 1_000, replies: [reply('r', OTHER, 5_000)] })),
    item(thread({ id: 'mine', createdAt: 2_000 })),
    item(thread({ id: 'done', createdAt: 3_000, status: 'resolved' })),
  ];

  it('narrows to one bucket', () => {
    expect(filterInbox(items, 'needs_you', VIEWER).map((i) => i.thread.id)).toEqual(['needs']);
    expect(filterInbox(items, 'resolved', VIEWER).map((i) => i.thread.id)).toEqual(['done']);
  });

  it('returns everything for "all", newest activity first', () => {
    expect(filterInbox(items, 'all', VIEWER).map((i) => i.thread.id)).toEqual([
      'needs',
      'done',
      'mine',
    ]);
  });

  it('does not mutate the input array', () => {
    const original = [...items];
    filterInbox(items, 'all', VIEWER);
    expect(items).toEqual(original);
  });
});

describe('groupInbox', () => {
  it('returns groups in triage order and omits empty buckets', () => {
    const items = [
      item(thread({ id: 'done', status: 'resolved' })),
      item(thread({ id: 'needs', replies: [reply('r', OTHER, 5_000)] })),
    ];

    const groups = groupInbox(items, VIEWER);

    expect(groups.map((g) => g.bucket)).toEqual(['needs_you', 'resolved']);
    expect(groups.map((g) => g.bucket)).not.toContain('with_agent');
  });

  it('orders every non-empty bucket by the canonical triage order', () => {
    const items = [
      item(thread({ id: 'done', status: 'resolved' })),
      item(thread({ id: 'mine' })),
      item(thread({ id: 'agent', status: 'sent' })),
      item(thread({ id: 'needs', replies: [reply('r', OTHER, 5_000)] })),
    ];

    expect(groupInbox(items, VIEWER).map((g) => g.bucket)).toEqual(COMMENT_BUCKET_ORDER);
  });

  it('sorts items inside a group by recency', () => {
    const items = [
      item(thread({ id: 'older', createdAt: 1_000, replies: [reply('r', OTHER, 2_000)] })),
      item(thread({ id: 'newer', createdAt: 1_000, replies: [reply('r', OTHER, 8_000)] })),
    ];

    expect(groupInbox(items, VIEWER)[0]?.items.map((i) => i.thread.id)).toEqual(['newer', 'older']);
  });

  it('returns no groups at all for an empty inbox', () => {
    expect(groupInbox([], VIEWER)).toEqual([]);
  });
});

describe('byRecency', () => {
  it('sorts newest activity first', () => {
    const older = item(thread({ id: 'older', createdAt: 1_000 }));
    const newer = item(thread({ id: 'newer', createdAt: 2_000 }));
    expect([older, newer].sort(byRecency).map((i) => i.thread.id)).toEqual(['newer', 'older']);
  });
});

describe('lastActivitySummary', () => {
  it('says "You" for the viewer and the name for anybody else', () => {
    expect(lastActivitySummary(item(thread()), VIEWER)).toBe('You commented');
    expect(lastActivitySummary(item(thread()), OTHER)).toBe('You commented'.replace('You', 'You'));
  });

  it('distinguishes a reply from the original comment', () => {
    const replied = item(thread({ replies: [reply('r', OTHER, 5_000)] }));
    expect(lastActivitySummary(replied, VIEWER)).toBe('Grace replied');
  });

  it('names the other person when they opened the thread', () => {
    const byOther = item(thread({ author: author(OTHER, 'Grace') }));
    expect(lastActivitySummary(byOther, VIEWER)).toBe('Grace commented');
  });
});

describe('sourceLabel', () => {
  it('uses the session topic for a chat thread', () => {
    expect(sourceLabel(SESSION_SOURCE)).toBe('Ship the inbox');
  });

  it('uses the filename for a library thread', () => {
    expect(sourceLabel({ kind: 'library_file', fileId: 'f1', fileName: 'design.md' })).toBe(
      'design.md'
    );
  });
});
