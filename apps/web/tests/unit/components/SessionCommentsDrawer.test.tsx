import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionCommentsDrawer } from '../../../src/components/chat/SessionCommentsDrawer';
import {
  type CommentInboxItem,
  toInboxItem,
} from '../../../src/components/project-message-view/comments/comment-inbox';
import type { UiCommentThread } from '../../../src/components/project-message-view/comments/comment-utils';
import type { MessageCommentAuthor } from '../../../src/lib/api/comments';

const VIEWER = 'user-viewer';
const OTHER = 'user-other';

const viewerAuthor: MessageCommentAuthor = {
  id: VIEWER,
  name: 'Ada',
  email: 'ada@example.test',
  avatarUrl: null,
  kind: 'human',
};

const otherAuthor: MessageCommentAuthor = {
  id: OTHER,
  name: 'Grace',
  email: 'grace@example.test',
  avatarUrl: null,
  kind: 'human',
};

function makeThread(overrides: Partial<UiCommentThread> = {}): UiCommentThread {
  return {
    id: 'thread-1',
    clientId: null,
    projectId: 'project-1',
    anchor: { quote: 'Highlighted text' },
    author: viewerAuthor,
    body: 'Please review this line.',
    createdAt: 1_000,
    updatedAt: 1_000,
    status: 'open',
    replies: [],
    syncState: 'synced',
    ...overrides,
  };
}

function makeInboxItem(thread: UiCommentThread): CommentInboxItem {
  return toInboxItem(thread, {
    kind: 'session',
    sessionId: 'session-1',
    sessionTopic: 'Ship comment navigation',
    messageId: 'message-1',
    messageRole: 'assistant',
  });
}

const defaultProps = {
  items: [] as CommentInboxItem[],
  loading: false,
  viewerId: VIEWER,
  onClose: vi.fn(),
  onJump: vi.fn(),
  onReply: vi.fn().mockResolvedValue(undefined),
  onResolve: vi.fn().mockResolvedValue(undefined),
  onReopen: vi.fn().mockResolvedValue(undefined),
  onSendToAgent: vi.fn().mockResolvedValue(undefined),
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SessionCommentsDrawer', () => {
  it('renders empty and loading states without exposing stale rows', () => {
    const { rerender } = render(<SessionCommentsDrawer {...defaultProps} loading={true} />);

    expect(screen.getByRole('dialog', { name: 'Session comments' })).toBeTruthy();
    expect(screen.queryByText('No comments in this session')).toBeNull();

    rerender(<SessionCommentsDrawer {...defaultProps} />);

    expect(screen.getByText('No comments in this session')).toBeTruthy();
  });

  it('expands a session thread and jumps to its annotated message', () => {
    const onJump = vi.fn();
    const onClose = vi.fn();
    const item = makeInboxItem(
      makeThread({
        replies: [
          {
            id: 'reply-1',
            author: otherAuthor,
            body: 'I left feedback here.',
            createdAt: 2_000,
            syncState: 'synced',
          },
        ],
      })
    );

    render(
      <SessionCommentsDrawer {...defaultProps} items={[item]} onJump={onJump} onClose={onClose} />
    );

    fireEvent.click(screen.getByRole('button', { name: /Please review this line/i }));
    expect(screen.getByRole('article', { name: 'Comment by Ada' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show in conversation' }));

    expect(onJump).toHaveBeenCalledWith({ messageId: 'message-1', timestamp: 1_000 });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps keyboard focus inside the comments drawer', () => {
    render(<SessionCommentsDrawer {...defaultProps} />);
    const closeBtn = screen.getByLabelText('Close comments');
    const lastFilter = screen.getByRole('button', { name: 'Resolved, 0 comments' });

    closeBtn.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });

    expect(document.activeElement).toBe(lastFilter);
  });

  it('wires reply, send-to-agent, and resolve actions through the expanded thread', async () => {
    const onReply = vi.fn().mockResolvedValue(undefined);
    const onResolve = vi.fn().mockResolvedValue(undefined);
    const onSendToAgent = vi.fn().mockResolvedValue(undefined);

    render(
      <SessionCommentsDrawer
        {...defaultProps}
        items={[makeInboxItem(makeThread())]}
        onReply={onReply}
        onResolve={onResolve}
        onSendToAgent={onSendToAgent}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Please review this line/i }));

    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));
    expect(onSendToAgent).toHaveBeenCalledWith('thread-1');

    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    const replyForm = screen.getByLabelText('Reply…').closest('form')!;
    fireEvent.change(within(replyForm).getByLabelText('Reply…'), {
      target: { value: '  Re-check after the patch.  ' },
    });
    fireEvent.submit(replyForm);

    await waitFor(() => {
      expect(onReply).toHaveBeenCalledWith('thread-1', 'Re-check after the patch.', 'note');
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Resolve' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));

    expect(onResolve).toHaveBeenCalledWith('thread-1');
  });

  it('uses pressed filter buttons instead of tab semantics', () => {
    const needsYou = makeInboxItem(
      makeThread({
        id: 'needs-you',
        body: 'Other person replied last.',
        replies: [
          {
            id: 'reply-1',
            author: otherAuthor,
            body: 'Needs review.',
            createdAt: 2_000,
            syncState: 'synced',
          },
        ],
      })
    );
    const open = makeInboxItem(
      makeThread({
        id: 'open',
        body: 'Viewer spoke last.',
      })
    );

    render(<SessionCommentsDrawer {...defaultProps} items={[needsYou, open]} />);

    expect(screen.queryByRole('tablist')).toBeNull();
    const needsYouFilter = screen.getByRole('button', { name: 'Needs you, 1 comment' });
    expect(needsYouFilter.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'All, 2 comments' }));

    expect(
      screen.getByRole('button', { name: 'All, 2 comments' }).getAttribute('aria-pressed')
    ).toBe('true');
    expect(screen.getByText('Other person replied last.')).toBeTruthy();
    expect(screen.getByText('Viewer spoke last.')).toBeTruthy();
  });
});
