import type { InboxConversation, InboxItem } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  conversationEntries,
  latestResponseId,
  nextConversationCursor,
  replierName,
  replyDisplayText,
  rowReplyHint,
} from '../../../src/components/inbox/inbox-conversation-model';

const page = (overrides: Partial<InboxConversation> = {}): InboxConversation => ({
  replies: [],
  responses: [],
  nextReplyCursor: null,
  nextResponseCursor: null,
  hasMore: false,
  ...overrides,
});
const reply = (id: string, createdAt: number, content = id) => ({
  id,
  content,
  createdAt,
  userId: 'u1',
  attachments: [],
});
const response = (id: string, createdAt: number) => ({
  id,
  itemId: 'q',
  author: { kind: 'agent' as const, id: 'a' },
  body: id,
  status: 'open' as const,
  createdAt,
  updatedAt: createdAt,
  replies: [],
});

describe('conversationEntries', () => {
  it('merges pages in time order and keeps one copy of a turn read twice', () => {
    const entries = conversationEntries([
      page({ replies: [reply('r2', 30)], responses: [response('c1', 20)] }),
      null,
      // A later page walks back through replies and forward through responses.
      page({ replies: [reply('r1', 10), reply('r2', 30)], responses: [response('c2', 40)] }),
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(['r1', 'c1', 'r2', 'c2']);
    expect(latestResponseId(entries)).toBe('c2');
  });

  it('skips malformed turns and has no latest response without one', () => {
    const entries = conversationEntries([
      page({ replies: [reply('ok', 1), { id: 3 } as never], responses: [{} as never] }),
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(['ok']);
    expect(latestResponseId(entries)).toBeNull();
  });
});

describe('nextConversationCursor', () => {
  it('advances only the streams that have a cursor', () => {
    expect(nextConversationCursor(page({ nextResponseCursor: 0 }))).toEqual({ responseCursor: 0 });
    expect(nextConversationCursor(page({ nextReplyCursor: 'abc' }))).toEqual({
      replyCursor: 'abc',
    });
    expect(nextConversationCursor(page({ nextReplyCursor: 'abc', nextResponseCursor: 4 }))).toEqual(
      { replyCursor: 'abc', responseCursor: 4 }
    );
    expect(nextConversationCursor(page())).toBeNull();
    expect(nextConversationCursor(null)).toBeNull();
  });
});

describe('replyDisplayText', () => {
  it('drops the file list only when the reply has attachments', () => {
    const files = [{ uploadId: 'u', filename: 'a.png', size: 1, contentType: 'image/png' }];
    const text = 'Look\n\n## Attached Files\n\n- a.png';
    expect(replyDisplayText({ ...reply('r', 1, text), attachments: files })).toBe('Look');
    expect(replyDisplayText(reply('r', 1, text))).toBe(text);
  });
});

describe('rowReplyHint', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const base = {
    status: 'open',
    canReply: true,
    latestReply: {
      userId: 'me',
      name: 'Me',
      messageId: 'm',
      repliedAt: '2026-11-20T11:55:00Z',
    },
  } as unknown as InboxItem;

  it('says nothing when nobody replied', () => {
    expect(rowReplyHint({ ...base, latestReply: null }, 'me', now)).toBeNull();
  });
  it('is quiet while the reply is with the agent', () => {
    expect(rowReplyHint({ ...base, withAgent: true }, 'me', now)).toEqual({
      fresh: false,
      text: 'You replied 5m ago',
    });
  });
  it('is fresh when the agent responded and the item came back', () => {
    expect(rowReplyHint({ ...base, withAgent: false }, 'me', now)?.fresh).toBe(true);
  });
  it('is not fresh for a closed item the agent resolved', () => {
    expect(rowReplyHint({ ...base, status: 'answered', canReply: false }, 'me', now)?.fresh).toBe(
      false
    );
  });
  it('names a teammate, or a teammate without a name', () => {
    expect(replierName({ userId: 'u2', name: 'Dana' }, 'me')).toBe('Dana');
    expect(replierName({ userId: 'u2', name: null }, 'me')).toBe('A teammate');
  });
});
