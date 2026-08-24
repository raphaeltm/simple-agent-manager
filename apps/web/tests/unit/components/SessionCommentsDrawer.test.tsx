import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@simple-agent-manager/acp-client', () => ({
  appendDictatedText: (current: string, text: string) => `${current}${text}`,
  VoiceButton: () => <button type="button">Voice</button>,
}));

vi.mock('../../../src/lib/api/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/agents')>()),
  getTranscribeApiUrl: vi.fn(() => 'https://api.test/transcribe'),
}));

import { SessionCommentsDrawer } from '../../../src/components/chat/SessionCommentsDrawer';
import { toInboxItem } from '../../../src/components/project-message-view/comments/comment-inbox';
import type { UiCommentThread } from '../../../src/components/project-message-view/comments/comment-utils';

const VIEWER_ID = 'viewer-1';
const OTHER_ID = 'reviewer-1';

const otherAuthor = {
  id: OTHER_ID,
  kind: 'human' as const,
  name: 'Grace Hopper',
  email: null,
  avatarUrl: null,
};

function thread(overrides: Partial<UiCommentThread> = {}): UiCommentThread {
  return {
    id: 'thread-1',
    clientId: null,
    projectId: 'project-1',
    author: otherAuthor,
    body: 'Please revisit this edge case.',
    status: 'open',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    anchor: { kind: 'message', messageId: 'msg-2', quote: 'selected context' },
    replies: [],
    syncState: 'synced',
    ...overrides,
  } as UiCommentThread;
}

function sessionItem(overrides: Partial<UiCommentThread> = {}) {
  return toInboxItem(thread(overrides), {
    kind: 'session',
    sessionId: 'session-1',
    sessionTopic: 'Ship the drawer',
    messageId: 'msg-2',
    messageRole: 'assistant',
  });
}

function renderDrawer(overrides: Partial<Parameters<typeof SessionCommentsDrawer>[0]> = {}) {
  const props = {
    items: [sessionItem()],
    loading: false,
    viewerId: VIEWER_ID,
    onClose: vi.fn(),
    onJump: vi.fn(),
    onReply: vi.fn(async () => undefined),
    onResolve: vi.fn(async () => undefined),
    onReopen: vi.fn(async () => undefined),
    onSendToAgent: vi.fn(async () => undefined),
    ...overrides,
  };

  render(<SessionCommentsDrawer {...props} />);
  return props;
}

describe('SessionCommentsDrawer', () => {
  it('expands a row and jumps to the anchored message from Show in conversation', () => {
    const props = renderDrawer();

    fireEvent.click(screen.getByText('Please revisit this edge case.').closest('button')!);
    const expanded = screen.getByRole('article', { name: 'Comment by Grace Hopper' });
    fireEvent.click(within(expanded.parentElement!).getByRole('button', { name: /show in conversation/i }));

    expect(props.onJump).toHaveBeenCalledWith({
      messageId: 'msg-2',
      timestamp: 1_700_000_000_000,
    });
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('submits replies through the real expanded CommentThread composer', async () => {
    const props = renderDrawer();

    fireEvent.click(screen.getByText('Please revisit this edge case.').closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    fireEvent.change(screen.getByLabelText('Reply…'), {
      target: { value: 'I checked this and added coverage.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));

    await waitFor(() => {
      expect(props.onReply).toHaveBeenCalledWith(
        'thread-1',
        'I checked this and added coverage.',
        'note'
      );
    });
  });

  it('wires resolve and send-to-agent actions from the expanded thread', () => {
    const onResolve = vi.fn(async () => undefined);
    const onSendToAgent = vi.fn(async () => undefined);
    renderDrawer({ onResolve, onSendToAgent });

    fireEvent.click(screen.getByText('Please revisit this edge case.').closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));

    expect(onSendToAgent).toHaveBeenCalledWith('thread-1');
    expect(onResolve).toHaveBeenCalledWith('thread-1');
  });

  it('wires reopen from a resolved expanded thread', () => {
    const onReopen = vi.fn(async () => undefined);
    renderDrawer({ items: [sessionItem({ status: 'resolved' })], onReopen });

    fireEvent.click(screen.getByText('Please revisit this edge case.').closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: /show resolved thread/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));

    expect(onReopen).toHaveBeenCalledWith('thread-1');
  });
});
