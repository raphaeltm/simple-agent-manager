import {
  type CommentMention,
  type MessageCommentThread,
  NOTIFICATION_TYPE_URGENCY,
} from '@simple-agent-manager/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

/**
 * Mocks sit at the notification-sending boundary (`src/services/notification.ts`) and the
 * settings boundary (`collaboration-settings.ts`), per the mocking pattern used elsewhere for
 * this feature (idea 01M59MYE4GY91BWTE8TZF1ZB5D). `buildActionUrl` is kept as a faithful
 * reimplementation (not a stub returning a constant) since the session-access notification
 * link depends on its exact output shape.
 */
const mocks = vi.hoisted(() => ({
  getProjectName: vi.fn(),
  sendNotification: vi.fn(),
  sendNotificationOnce: vi.fn(),
  getCommentNotificationWindowMs: vi.fn(),
}));

vi.mock('../../../src/services/notification', () => ({
  buildActionUrl: (projectId: string, sessionId?: string | null) =>
    sessionId ? `/projects/${projectId}/chat/${sessionId}` : `/projects/${projectId}`,
  getProjectName: mocks.getProjectName,
  sendNotification: mocks.sendNotification,
  sendNotificationOnce: mocks.sendNotificationOnce,
}));

vi.mock('../../../src/services/collaboration-settings', () => ({
  getCommentNotificationWindowMs: mocks.getCommentNotificationWindowMs,
}));

import {
  type CommentActivityInput,
  notifyCommentActivity,
  notifySessionAccessChange,
  planCommentRecipients,
} from '../../../src/services/collaboration-notifications';

const FIXED_NOW = 1_700_000_000_000;
const WINDOW_MS = 123_456;

const env = { DATABASE: {} } as unknown as Env;

function makeThread(overrides: Partial<MessageCommentThread> = {}): MessageCommentThread {
  return {
    id: 'thread-1',
    sessionId: 'session-1',
    taskId: 'task-1',
    status: 'open',
    anchor: { kind: 'message', messageId: 'message-1', quote: 'Quoted text' },
    body: 'Root comment body',
    author: { kind: 'human', id: 'root-author', displayName: 'Root Author' },
    createdAt: 1000,
    updatedAt: 1000,
    resolvedAt: null,
    replyCount: 0,
    lastReplyAt: null,
    sourceMessage: { id: 'message-1', role: 'assistant', quote: 'Source', createdAt: 900 },
    directive: null,
    replies: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<CommentActivityInput> = {}): CommentActivityInput {
  return {
    projectId: 'project-1',
    sessionId: 'session-1',
    sessionTopic: 'Debugging the thing',
    sessionOwnerUserId: 'owner-1',
    thread: makeThread(),
    comment: { id: 'comment-1', body: 'Please look at this', mentions: [] },
    kind: 'thread',
    actor: { userId: 'actor-1', name: 'Actor Name' },
    ...overrides,
  };
}

function mention(userId: string, displayName: string | null = 'Mentioned'): CommentMention {
  return { userId, displayName };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  mocks.getProjectName.mockResolvedValue('Demo Project');
  mocks.getCommentNotificationWindowMs.mockResolvedValue(WINDOW_MS);
  mocks.sendNotification.mockResolvedValue(undefined);
  mocks.sendNotificationOnce.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('planCommentRecipients', () => {
  const cases: Array<{
    name: string;
    overrides: Partial<CommentActivityInput>;
    expected: Array<[string, string]>;
  }> = [
    {
      name: 'mentions a teammate who is neither the owner nor a participant',
      overrides: {
        sessionOwnerUserId: null,
        comment: { id: 'c1', body: 'b', mentions: [mention('mentioned-1')] },
      },
      expected: [['mentioned-1', 'mention']],
    },
    {
      name: 'notifies the session owner for a top-level comment',
      overrides: {
        kind: 'thread',
        sessionOwnerUserId: 'owner-1',
        comment: { id: 'c1', body: 'b', mentions: [] },
      },
      expected: [['owner-1', 'your_session']],
    },
    {
      name: 'notifies the thread author and an earlier replier as participants on a reply',
      overrides: {
        kind: 'reply',
        sessionOwnerUserId: null,
        thread: makeThread({
          author: { kind: 'human', id: 'thread-author', displayName: 'Author' },
          replies: [
            {
              id: 'reply-1',
              body: 'earlier reply',
              author: { kind: 'human', id: 'replier-1', displayName: 'R1' },
              createdAt: 1100,
            },
            {
              id: 'reply-2',
              body: 'the reply just posted',
              author: { kind: 'human', id: 'replier-2', displayName: 'R2' },
              createdAt: 1200,
            },
          ],
        }),
        // reply-2 is the comment just written: it must not notify its own author.
        comment: { id: 'reply-2', body: 'the reply just posted', mentions: [] },
      },
      expected: [
        ['thread-author', 'participant'],
        ['replier-1', 'participant'],
      ],
    },
    {
      name: 'does not add thread participants for a top-level (non-reply) comment',
      overrides: {
        kind: 'thread',
        sessionOwnerUserId: null,
        thread: makeThread({
          author: { kind: 'human', id: 'thread-author', displayName: 'Author' },
        }),
        comment: { id: 'c1', body: 'b', mentions: [] },
      },
      expected: [],
    },
    {
      name: 'skips an agent-authored thread when computing participants',
      overrides: {
        kind: 'reply',
        sessionOwnerUserId: null,
        thread: makeThread({
          author: { kind: 'agent', id: 'agent-1', displayName: 'Agent' },
          replies: [],
        }),
        comment: { id: 'reply-3', body: 'x', mentions: [] },
      },
      expected: [],
    },
    {
      name: 'a mention wins over session-owner for the same person',
      overrides: {
        sessionOwnerUserId: 'dual-1',
        comment: { id: 'c1', body: 'b', mentions: [mention('dual-1')] },
      },
      expected: [['dual-1', 'mention']],
    },
    {
      name: 'session-owner wins over participant for the same person',
      overrides: {
        kind: 'reply',
        sessionOwnerUserId: 'dual-2',
        thread: makeThread({ author: { kind: 'human', id: 'dual-2', displayName: 'Dual' } }),
        comment: { id: 'reply-4', body: 'x', mentions: [] },
      },
      expected: [['dual-2', 'your_session']],
    },
    {
      name: 'a mention wins over participant for the same person',
      overrides: {
        kind: 'reply',
        sessionOwnerUserId: null,
        thread: makeThread({ author: { kind: 'human', id: 'dual-3', displayName: 'Dual' } }),
        comment: { id: 'reply-5', body: 'x', mentions: [mention('dual-3')] },
      },
      expected: [['dual-3', 'mention']],
    },
    {
      name: 'never includes the actor, even when mentioned and the session owner',
      overrides: {
        sessionOwnerUserId: 'actor-1',
        comment: { id: 'c1', body: 'b', mentions: [mention('actor-1')] },
      },
      expected: [],
    },
    {
      name: 'dedupes an id that appears twice in the mentions list',
      overrides: {
        sessionOwnerUserId: null,
        comment: { id: 'c1', body: 'b', mentions: [mention('dup-1'), mention('dup-1')] },
      },
      expected: [['dup-1', 'mention']],
    },
  ];

  it.each(cases)('$name', ({ overrides, expected }) => {
    const result = planCommentRecipients(makeInput(overrides));

    expect([...result.entries()]).toEqual(expected);
  });
});

describe('notifyCommentActivity', () => {
  it('keys each mention notification to its own comment, never grouped across comments', async () => {
    await notifyCommentActivity(
      env,
      makeInput({
        sessionOwnerUserId: null,
        comment: { id: 'comment-1', body: 'first', mentions: [mention('mentioned-1')] },
      })
    );
    await notifyCommentActivity(
      env,
      makeInput({
        sessionOwnerUserId: null,
        comment: { id: 'comment-2', body: 'second', mentions: [mention('mentioned-1')] },
      })
    );

    expect(mocks.sendNotificationOnce).toHaveBeenCalledTimes(2);
    const dedupKeys = mocks.sendNotificationOnce.mock.calls.map((call) => call[2]);
    expect(dedupKeys).toEqual(['mention:comment-1', 'mention:comment-2']);
    for (const call of mocks.sendNotificationOnce.mock.calls) {
      expect(call[0]).toBe(env);
      expect(call[1]).toBe('mentioned-1');
      expect(call[3]).toBe(FIXED_NOW + WINDOW_MS);
      expect(call[4]).toMatchObject({ type: 'mention' });
      expect(call[5]).toBe(FIXED_NOW);
    }
  });

  it('keys ordinary (non-mention) comment notifications to the session, using the configured window', async () => {
    await notifyCommentActivity(
      env,
      makeInput({
        sessionOwnerUserId: 'owner-1',
        comment: { id: 'comment-1', body: 'body', mentions: [] },
      })
    );

    expect(mocks.sendNotificationOnce).toHaveBeenCalledWith(
      env,
      'owner-1',
      'comment-activity:session-1',
      FIXED_NOW + WINDOW_MS,
      expect.objectContaining({ type: 'comment' }),
      FIXED_NOW
    );
  });

  it('links the notification to the thread in the Comments page reader', async () => {
    await notifyCommentActivity(
      env,
      makeInput({
        sessionOwnerUserId: 'owner-1',
        thread: makeThread({
          id: 'thread-42',
          anchor: { kind: 'message', messageId: 'message-99', quote: null },
        }),
        comment: { id: 'comment-1', body: 'body', mentions: [] },
      })
    );

    const notification = mocks.sendNotificationOnce.mock.calls[0]?.[4];
    expect(notification.actionUrl).toBe('/projects/project-1/comments/session-1/thread-42');
  });

  it('does nothing and makes no external calls when there are no recipients', async () => {
    await notifyCommentActivity(
      env,
      makeInput({
        actor: { userId: 'actor-1', name: 'Actor' },
        sessionOwnerUserId: 'actor-1',
        comment: { id: 'comment-1', body: 'body', mentions: [mention('actor-1')] },
      })
    );

    expect(mocks.sendNotificationOnce).not.toHaveBeenCalled();
    expect(mocks.getProjectName).not.toHaveBeenCalled();
    expect(mocks.getCommentNotificationWindowMs).not.toHaveBeenCalled();
  });

  it('does not throw when sendNotificationOnce rejects for a recipient (best-effort)', async () => {
    mocks.sendNotificationOnce.mockRejectedValueOnce(new Error('notification DO unavailable'));

    await expect(
      notifyCommentActivity(
        env,
        makeInput({
          sessionOwnerUserId: 'owner-1',
          comment: { id: 'comment-1', body: 'body', mentions: [] },
        })
      )
    ).resolves.toBeUndefined();
  });
});

describe('notifySessionAccessChange', () => {
  it('notifies only the grantee when the owner shares (no duplicate self-notification)', async () => {
    await notifySessionAccessChange(env, {
      projectId: 'project-1',
      sessionId: 'session-1',
      sessionTopic: 'Debugging the thing',
      sessionOwnerUserId: 'owner-1',
      actor: { userId: 'owner-1', name: 'Owner Name' },
      change: 'granted',
      affectedUserIds: ['grantee-1'],
      granteeName: 'Grantee Name',
    });

    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification).toHaveBeenCalledWith(
      env,
      'grantee-1',
      expect.objectContaining({
        projectId: 'project-1',
        sessionId: 'session-1',
        type: 'session_access',
        urgency: NOTIFICATION_TYPE_URGENCY.session_access,
        title: expect.stringContaining('Owner Name'),
        body: 'You can chat in this session. It runs on the owner’s accounts.',
        actionUrl: '/projects/project-1/chat/session-1',
        metadata: { projectName: 'Demo Project', change: 'granted', actorUserId: 'owner-1' },
      })
    );
  });

  it('says how long shared or extended access lasts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      await notifySessionAccessChange(env, {
        projectId: 'project-1',
        sessionId: 'session-1',
        sessionTopic: 'Debugging the thing',
        sessionOwnerUserId: 'owner-1',
        actor: { userId: 'owner-1', name: 'Owner Name' },
        change: 'granted',
        affectedUserIds: ['grantee-1'],
        granteeName: 'Grantee Name',
        expiresAt: 1_000_000 + 30 * 60_000,
      });
      await notifySessionAccessChange(env, {
        projectId: 'project-1',
        sessionId: 'session-1',
        sessionTopic: 'Debugging the thing',
        sessionOwnerUserId: 'owner-1',
        actor: { userId: 'owner-1', name: 'Owner Name' },
        change: 'renewed',
        affectedUserIds: ['grantee-1'],
        granteeName: 'Grantee Name',
        expiresAt: 1_000_000 + 5 * 60_000,
      });
    } finally {
      vi.useRealTimers();
    }

    expect(mocks.sendNotification).toHaveBeenNthCalledWith(
      1,
      env,
      'grantee-1',
      expect.objectContaining({
        body: 'You can chat in this session for the next 30 minutes. It runs on the owner’s accounts.',
      })
    );
    expect(mocks.sendNotification).toHaveBeenNthCalledWith(
      2,
      env,
      'grantee-1',
      expect.objectContaining({
        title: expect.stringContaining('Owner Name extended your access to'),
        body: 'You can chat in this session for the next 5 minutes.',
        metadata: { projectName: 'Demo Project', change: 'renewed', actorUserId: 'owner-1' },
      })
    );
    // One notification per change, both to the grantee.
    expect(mocks.sendNotification).toHaveBeenCalledTimes(2);
  });

  it('notifies both the new grantee and the owner when a grantee re-shares the session', async () => {
    await notifySessionAccessChange(env, {
      projectId: 'project-1',
      sessionId: 'session-1',
      sessionTopic: 'Debugging the thing',
      sessionOwnerUserId: 'owner-1',
      actor: { userId: 'grantee-1', name: 'Grantee Name' },
      change: 'granted',
      affectedUserIds: ['grantee-2'],
      granteeName: 'Grantee Two',
    });

    expect(mocks.sendNotification).toHaveBeenCalledTimes(2);
    const recipients = mocks.sendNotification.mock.calls.map((call) => call[1]).sort();
    expect(recipients).toEqual(['grantee-2', 'owner-1']);
    const ownerCall = mocks.sendNotification.mock.calls.find((call) => call[1] === 'owner-1');
    expect(ownerCall?.[2].title).toContain('Grantee Name');
    expect(ownerCall?.[2].title).toContain('Grantee Two');
  });

  it('notifies every affected grantee on revoke, deduped, and never the actor', async () => {
    await notifySessionAccessChange(env, {
      projectId: 'project-1',
      sessionId: 'session-1',
      sessionTopic: 'Debugging the thing',
      sessionOwnerUserId: 'owner-1',
      actor: { userId: 'owner-1', name: 'Owner Name' },
      change: 'revoked',
      // owner-1 (the actor) and a duplicate id are both included to prove exclusion + dedup.
      affectedUserIds: ['grantee-1', 'grantee-1', 'grantee-2', 'owner-1'],
      granteeName: null,
    });

    expect(mocks.sendNotification).toHaveBeenCalledTimes(2);
    const recipients = mocks.sendNotification.mock.calls.map((call) => call[1]).sort();
    expect(recipients).toEqual(['grantee-1', 'grantee-2']);
    for (const call of mocks.sendNotification.mock.calls) {
      expect(call[2]).toMatchObject({ type: 'session_access', body: null });
      expect(call[2].title).toContain('was removed');
    }
  });
});
