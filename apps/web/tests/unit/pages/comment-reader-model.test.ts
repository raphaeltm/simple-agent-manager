/**
 * Pure parts of the comment reader: which rendered row a comment is on, the order
 * previous/next walk, and the link into the chat.
 */
import { describe, expect, it } from 'vitest';

import { toInboxItem } from '../../../src/components/project-message-view/comments/comment-inbox';
import { normalizeThread } from '../../../src/components/project-message-view/comments/comment-utils';
import { groupToolCallItems } from '../../../src/components/project-message-view/tool-call-groups';
import { chatMessagesToConversationItems } from '../../../src/components/project-message-view/types';
import type { ChatMessageResponse, MessageCommentThread } from '../../../src/lib/api';
import {
  buildRowLocator,
  commentNavigation,
  commentReaderPath,
  openInChatPath,
} from '../../../src/pages/comment-reader/reader-model';

let sequence = 0;
function row(
  id: string,
  role: string,
  toolMetadata: Record<string, unknown> | null = null
): ChatMessageResponse {
  sequence += 1;
  return {
    id,
    sessionId: 's1',
    role,
    content: `${id} `,
    toolMetadata,
    createdAt: 1_000 + sequence,
    sequence,
  };
}

function locatorFor(rows: ChatMessageResponse[]) {
  return buildRowLocator(rows, groupToolCallItems(chatMessagesToConversationItems(rows)));
}

describe('buildRowLocator', () => {
  it('resolves a reply chunk, a folded thought and a tool call to the row that shows them', () => {
    const locate = locatorFor([
      row('u1', 'user'),
      row('a1', 'assistant'),
      row('a2', 'assistant'),
      row('th1', 'thinking'),
      row('th2', 'thinking'),
      row('t1', 'tool', { toolCallId: 'call-1', title: 'Run', kind: 'execute' }),
      row('a3', 'assistant'),
    ]);

    expect(locate('u1')).toBe('u1');
    expect(locate('a2')).toBe('a1');
    // The thought and the call are folded into one tool-call group row, keyed by its first item.
    expect(locate('th2')).toBe('th1');
    expect(locate('t1')).toBe('th1');
    expect(locate('missing')).toBeNull();
  });
});

const VIEWER = 'viewer-1';
function thread(
  id: string,
  overrides: Partial<MessageCommentThread> & { lastBy?: string } = {}
): MessageCommentThread {
  const authorId = overrides.lastBy ?? 'someone-else';
  return {
    id,
    projectId: 'p1',
    sessionId: overrides.sessionId ?? 's1',
    anchor: { kind: 'message', messageId: `m-${id}`, quote: null },
    author: { id: authorId, name: authorId, kind: 'human' },
    body: id,
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.createdAt ?? 1,
    status: overrides.status ?? 'open',
    replies: [],
  };
}

function inbox(threads: MessageCommentThread[]) {
  return threads.map((item) =>
    toInboxItem(normalizeThread(item), {
      kind: 'session',
      sessionId: item.sessionId,
      sessionTopic: 'topic',
      messageId: item.anchor.messageId,
    })
  );
}

describe('commentNavigation', () => {
  it('walks the Comments page order: needs you, with agent, open, resolved; newest first', () => {
    const items = inbox([
      thread('resolved', { status: 'resolved', createdAt: 50 }),
      thread('mine-open', { lastBy: VIEWER, createdAt: 40 }),
      thread('needs-old', { createdAt: 10 }),
      thread('sent', { status: 'sent', createdAt: 30 }),
      thread('needs-new', { createdAt: 20 }),
    ]);

    const order: string[] = [];
    let id: string | null = 'needs-new';
    while (id) {
      order.push(id);
      id = commentNavigation(items, VIEWER, id).next?.thread.id ?? null;
    }

    expect(order).toEqual(['needs-new', 'needs-old', 'sent', 'mine-open', 'resolved']);
    expect(commentNavigation(items, VIEWER, 'sent')).toMatchObject({ position: 3, total: 5 });
    expect(commentNavigation(items, VIEWER, 'needs-new').previous).toBeNull();
  });

  it('skips library comments, which open in the library, and reports an unlisted comment', () => {
    const items = [
      ...inbox([thread('chat-1', { createdAt: 2 })]),
      toInboxItem(normalizeThread(thread('file-1', { createdAt: 3 })), {
        kind: 'library_file',
        fileId: 'f1',
        fileName: 'notes.md',
      }),
    ];

    expect(commentNavigation(items, VIEWER, 'chat-1')).toMatchObject({
      position: 1,
      total: 1,
      previous: null,
      next: null,
    });
    expect(commentNavigation(items, VIEWER, 'not-listed').position).toBeNull();
  });
});

describe('links', () => {
  it('opens the chat on the thread at the commented message and its own time', () => {
    expect(
      openInChatPath('p1', 's1', 't1', { messageId: 'a2', createdAt: 1_725_000_000_123 })
    ).toBe('/projects/p1/chat/s1?commentThread=t1&commentMessage=a2&commentAt=1725000000123');
    expect(openInChatPath('p1', 's1', 't1', { messageId: 'a2', createdAt: null })).toBe(
      '/projects/p1/chat/s1?commentThread=t1&commentMessage=a2'
    );
  });

  it('addresses a comment in the reader by its chat and thread', () => {
    expect(commentReaderPath('p1', 's1', 't1')).toBe('/projects/p1/comments/s1/t1');
  });
});
