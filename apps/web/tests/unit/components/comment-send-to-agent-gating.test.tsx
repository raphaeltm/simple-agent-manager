/**
 * "Send to agent" queues a prompt on the session owner's agent, so only the owner and people
 * the session was shared with may use it (the server returns 403 to everyone else). Every
 * other project member can still comment and reply.
 *
 * Each surface is rendered through the real wiring — `useMessageComments` +
 * `useProjectMessageCommentUi` building the viewer's actions, `ProjectMessageViewDrawers`
 * applying its own gate — so the gate under test is the production one, never a prop the
 * test hands in to the leaf.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { type ReactNode, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageCommentThread } from '../../../src/lib/api/comments';

const mocks = vi.hoisted(() => ({
  listMessageComments: vi.fn(),
  createMessageCommentThread: vi.fn(),
  createMessageCommentReply: vi.fn(),
  sendMessageCommentThreadToAgent: vi.fn(),
  getProjectMembers: vi.fn(),
}));

vi.mock('../../../src/lib/api/comments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/comments')>()),
  listMessageComments: mocks.listMessageComments,
  createMessageCommentThread: mocks.createMessageCommentThread,
  createMessageCommentReply: mocks.createMessageCommentReply,
  sendMessageCommentThreadToAgent: mocks.sendMessageCommentThreadToAgent,
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getProjectMembers: mocks.getProjectMembers,
}));

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-reader', name: 'Rae Reader', email: 'rae@example.com' } }),
}));

vi.mock('@simple-agent-manager/acp-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@simple-agent-manager/acp-client')>()),
  VoiceButton: () => (
    <button type="button" aria-label="Start voice input">
      mic
    </button>
  ),
}));

// The message bubble itself is irrelevant to comment gating.
vi.mock('../../../src/components/project-message-view/AcpConversationItemView', () => ({
  AcpConversationItemView: ({ item }: { item: { text?: string } }) => <div>{item.text}</div>,
}));

import { toInboxItem } from '../../../src/components/project-message-view/comments/comment-inbox';
import { CommentableConversationItem } from '../../../src/components/project-message-view/comments/CommentableConversationItem';
import { READER_COMMENT_HINT } from '../../../src/components/project-message-view/comments/CommentComposer';
import { buildCommentedMessageDescriber } from '../../../src/components/project-message-view/comments/commented-message-label';
import { DesktopCommentRail } from '../../../src/components/project-message-view/comments/MessageCommentPanels';
import { useMessageComments } from '../../../src/components/project-message-view/comments/useMessageComments';
import { useProjectMessageCommentUi } from '../../../src/components/project-message-view/comments/useProjectMessageCommentUi';
import { ProjectMessageViewDrawers } from '../../../src/components/project-message-view/ProjectMessageViewDrawers';
import { renderWithQuery } from '../../test-utils/query-test-utils';

const THREAD: MessageCommentThread = {
  id: 'thread-1',
  clientId: null,
  projectId: 'proj-1',
  sessionId: 'sess-1',
  anchor: { kind: 'message', messageId: 'msg-1', quote: 'Quoted line' },
  author: { id: 'user-grace', name: 'Grace Hopper', kind: 'human' },
  body: 'Should this retry?',
  createdAt: 1_000,
  updatedAt: 1_000,
  status: 'open',
  replies: [],
};

type Surface = 'rail' | 'inline' | 'drawer' | 'mobile-composer';

const DESCRIBE_MESSAGE = buildCommentedMessageDescriber(
  [{ kind: 'agent_message', id: 'msg-1', text: 'Agent answer', streaming: false, timestamp: 1 }],
  { ownerName: 'Grace Hopper', viewerIsOwner: true }
);

function CommentUiHarness({
  surface,
  canSendToAgent,
  canComment = true,
  focusCommentThreadId,
  onRequestCommentSurface,
}: {
  surface: Surface;
  canSendToAgent: boolean;
  canComment?: boolean;
  focusCommentThreadId?: string | null;
  onRequestCommentSurface?: () => void;
}) {
  const messageComments = useMessageComments('proj-1', 'sess-1', true);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const ui = useProjectMessageCommentUi({
    messageComments,
    canComment,
    canSendToAgent,
    hasMessages: true,
    chatLogRef,
    sessionId: 'sess-1',
    projectId: 'proj-1',
    onRequestCommentSurface,
    focusCommentThreadId,
  });

  let content: ReactNode = null;
  if (surface === 'rail') {
    content = (
      <DesktopCommentRail
        comments={messageComments.comments}
        draft={ui.rowState.draft}
        loading={messageComments.loading}
        refreshing={messageComments.refreshing}
        error={messageComments.error}
        activeMessageId={ui.rowState.activeMessageId}
        focusedCommentId={ui.rowState.focusedCommentId}
        actions={ui.rowState.actions}
        onRetry={() => undefined}
        onClearDraft={ui.rowState.onClearDraft}
        onSelectMessage={ui.rowState.onSelectMessageComments}
        onClose={() => undefined}
        describeMessage={DESCRIBE_MESSAGE}
      />
    );
  } else if (surface === 'inline') {
    content = (
      <CommentableConversationItem
        index={0}
        firstItemIndex={0}
        item={{
          kind: 'agent_message',
          id: 'msg-1',
          text: 'Agent answer',
          streaming: false,
          timestamp: 1,
        }}
        projectId="proj-1"
        highlighted={false}
        onLoadToolContent={async () => []}
        animateAgentText={false}
        animateUserMessage={false}
        canComment={canComment}
        canSendToAgent={canSendToAgent}
        agentActivity="idle"
        animationTargetIdx={-1}
        commentState={ui.rowState}
      />
    );
  } else if (surface === 'drawer') {
    content = (
      <ProjectMessageViewDrawers
        showTimeline={false}
        projectId="proj-1"
        sessionId="sess-1"
        timelineEntries={[]}
        timelineLoading={false}
        showTimelineContext={false}
        onToggleTimelineContext={() => undefined}
        onCloseTimeline={() => undefined}
        showResources={false}
        onCloseResources={() => undefined}
        showComments
        commentItems={messageComments.comments.map((thread) =>
          toInboxItem(thread, {
            kind: 'session',
            sessionId: 'sess-1',
            sessionTopic: 'Retry policy',
            messageId: thread.anchor.messageId,
          })
        )}
        commentsLoading={messageComments.loading}
        viewerId="user-reader"
        canSendToAgent={canSendToAgent}
        onCloseComments={() => undefined}
        onJump={() => undefined}
        onReply={(threadId, body, action, mentions) =>
          messageComments.reply({ commentId: threadId, body, action, mentions })
        }
        onResolve={messageComments.resolve}
        onReopen={messageComments.reopen}
        onSendToAgent={(threadId) => messageComments.sendToAgent({ commentId: threadId })}
      />
    );
  }

  return (
    <div ref={chatLogRef}>
      <div data-comment-anchor="msg-1">Select this phrase in the agent answer.</div>
      <button
        type="button"
        onClick={() => ui.rowState.onStartComment({ anchorId: 'msg-1', quote: 'Quoted words' })}
      >
        Start quoted comment
      </button>
      {ui.selectionControls}
      {surface === 'mobile-composer' ? ui.selectedTextComposer : content}
      <output data-testid="focus-state">
        {`${ui.rowState.activeMessageId ?? '-'}|${ui.rowState.focusedCommentId ?? '-'}`}
      </output>
    </div>
  );
}

function setRailViewport(matches: boolean) {
  vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
    matches: query === '(min-width: 1024px)' ? matches : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

/** The visible thread, opened the way each surface opens it. */
async function openThread(surface: Surface) {
  if (surface === 'inline') {
    fireEvent.click(await screen.findByRole('button', { name: /1 comment on this message/ }));
  } else if (surface === 'drawer') {
    fireEvent.click(await screen.findByRole('button', { name: /Should this retry\?/ }));
  }
  return screen.findByRole('article', { name: 'Comment by Grace Hopper' });
}

beforeEach(() => {
  vi.clearAllMocks();
  setRailViewport(false);
  mocks.listMessageComments.mockResolvedValue({ comments: [THREAD] });
  mocks.getProjectMembers.mockResolvedValue({ members: [], inviteLinks: [], accessRequests: [] });
  mocks.sendMessageCommentThreadToAgent.mockResolvedValue({
    comment: { ...THREAD, status: 'sent' },
  });
  mocks.createMessageCommentReply.mockImplementation(async (_p, _s, commentId: string) => ({
    comment: { ...THREAD, id: commentId },
  }));
  mocks.createMessageCommentThread.mockImplementation(async () => ({ comment: THREAD }));
});

afterEach(() => {
  setRailViewport(false);
});

describe.each<Surface>(['rail', 'inline', 'drawer'])('thread on the %s surface', (surface) => {
  it('offers a reader no way to message the agent, but still lets them reply', async () => {
    renderWithQuery(<CommentUiHarness surface={surface} canSendToAgent={false} />);
    const thread = await openThread(surface);

    expect(within(thread).queryByRole('button', { name: 'Send to agent' })).toBeNull();
    fireEvent.click(within(thread).getByRole('button', { name: 'Reply' }));
    const reply = within(thread).getByLabelText('Reply…');
    const form = reply.closest('form')!;
    expect(within(form).queryByRole('radio', { name: 'Send to agent' })).toBeNull();
    expect(within(form).getByText(READER_COMMENT_HINT)).toBeInTheDocument();

    // Liveness: the reply itself still goes through.
    fireEvent.change(reply, { target: { value: 'I think it should.' } });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(mocks.createMessageCommentReply).toHaveBeenCalledWith(
        'proj-1',
        'sess-1',
        'thread-1',
        expect.objectContaining({ body: 'I think it should.', action: 'note' })
      )
    );
    expect(mocks.sendMessageCommentThreadToAgent).not.toHaveBeenCalled();
  });

  it('offers the owner or a grantee Send to agent on the thread and in the reply', async () => {
    renderWithQuery(<CommentUiHarness surface={surface} canSendToAgent />);
    const thread = await openThread(surface);

    fireEvent.click(within(thread).getByRole('button', { name: 'Reply' }));
    const form = within(thread).getByLabelText('Reply…').closest('form')!;
    expect(within(form).getByRole('radio', { name: 'Send to agent' })).toBeInTheDocument();
    expect(within(form).queryByText(READER_COMMENT_HINT)).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));

    fireEvent.click(within(thread).getByRole('button', { name: 'Send to agent' }));
    await waitFor(() =>
      expect(mocks.sendMessageCommentThreadToAgent).toHaveBeenCalledWith(
        'proj-1',
        'sess-1',
        'thread-1',
        expect.anything()
      )
    );
  });
});

describe.each<Surface>(['rail', 'mobile-composer'])('new comment on the %s surface', (surface) => {
  it('shows a reader the hint instead of the Send to agent choice', async () => {
    if (surface === 'rail') setRailViewport(true);
    renderWithQuery(<CommentUiHarness surface={surface} canSendToAgent={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start quoted comment' }));

    const textarea = await screen.findByLabelText('Add a comment…');
    const form = textarea.closest('form')!;
    expect(within(form).queryByRole('radio', { name: 'Send to agent' })).toBeNull();
    expect(within(form).getByText(READER_COMMENT_HINT)).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: 'Worth a second look.' } });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(mocks.createMessageCommentThread).toHaveBeenCalledWith(
        'proj-1',
        'sess-1',
        expect.objectContaining({ body: 'Worth a second look.', action: 'note', mentions: [] })
      )
    );
  });

  it('offers a session writer the Send to agent choice', async () => {
    if (surface === 'rail') setRailViewport(true);
    renderWithQuery(<CommentUiHarness surface={surface} canSendToAgent />);
    fireEvent.click(screen.getByRole('button', { name: 'Start quoted comment' }));

    const form = (await screen.findByLabelText('Add a comment…')).closest('form')!;
    fireEvent.click(within(form).getByRole('radio', { name: 'Send to agent' }));
    expect(within(form).getByRole('button', { name: 'Comment & send' })).toBeInTheDocument();
    expect(within(form).queryByText(READER_COMMENT_HINT)).toBeNull();
  });
});

describe('commenting from selected text', () => {
  async function selectPhrase() {
    const anchor = screen.getByText('Select this phrase in the agent answer.');
    const textNode = anchor.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 'Select this phrase'.length);
    range.getBoundingClientRect = () =>
      ({
        left: 96,
        right: 260,
        top: 120,
        bottom: 140,
        width: 164,
        height: 20,
        x: 96,
        y: 120,
        toJSON: () => ({}),
      }) as DOMRect;
    await act(async () => {
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      document.dispatchEvent(new Event('mouseup'));
    });
  }

  it('is available to every member who can comment, readers included', async () => {
    renderWithQuery(<CommentUiHarness surface="rail" canSendToAgent={false} />);
    await selectPhrase();
    expect(await screen.findByRole('dialog', { name: 'Comment on selection' })).toBeInTheDocument();
  });

  it('is not offered when the viewer cannot comment', async () => {
    renderWithQuery(<CommentUiHarness surface="rail" canSendToAgent={false} canComment={false} />);
    await selectPhrase();
    // Liveness: the thread list still rendered for this viewer.
    expect(
      await screen.findByRole('article', { name: 'Comment by Grace Hopper' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Comment on selection' })).toBeNull();
  });
});

describe('opening a thread from a deep link', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it('opens the docked rail focused on the thread once it loads, even after the URL was cleared', async () => {
    setRailViewport(true);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const second: MessageCommentThread = {
      ...THREAD,
      id: 'thread-2',
      anchor: { kind: 'message', messageId: 'msg-9', quote: null },
      body: 'Second thread',
    };
    const list = deferred<{ comments: MessageCommentThread[] }>();
    mocks.listMessageComments.mockReturnValue(list.promise);
    const onRequestCommentSurface = vi.fn();

    const { rerender } = renderWithQuery(
      <CommentUiHarness
        surface="rail"
        canSendToAgent={false}
        focusCommentThreadId="thread-2"
        onRequestCommentSurface={onRequestCommentSurface}
      />
    );
    // The route drops `commentThread` as soon as the conversation jump starts — before the
    // threads have arrived.
    rerender(
      <CommentUiHarness
        surface="rail"
        canSendToAgent={false}
        focusCommentThreadId={null}
        onRequestCommentSurface={onRequestCommentSurface}
      />
    );
    expect(screen.getByTestId('focus-state')).toHaveTextContent('-|-');
    expect(onRequestCommentSurface).not.toHaveBeenCalled();

    await act(async () => list.resolve({ comments: [THREAD, second] }));

    await waitFor(() =>
      expect(screen.getByTestId('focus-state')).toHaveTextContent('msg-9|thread-2')
    );
    expect(onRequestCommentSurface).toHaveBeenCalledTimes(1);
    const focused = screen
      .getAllByRole('article')
      .find((article) => article.getAttribute('data-comment-focused') === 'true');
    expect(focused).toHaveAttribute('data-comment-id', 'thread-2');
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('expands the thread under its message on smaller screens without opening the rail', async () => {
    const onRequestCommentSurface = vi.fn();
    renderWithQuery(
      <CommentUiHarness
        surface="inline"
        canSendToAgent={false}
        focusCommentThreadId="thread-1"
        onRequestCommentSurface={onRequestCommentSurface}
      />
    );
    await waitFor(() =>
      expect(screen.getByTestId('focus-state')).toHaveTextContent('msg-1|thread-1')
    );
    const thread = await screen.findByRole('article', { name: 'Comment by Grace Hopper' });
    expect(thread).toHaveAttribute('data-comment-focused', 'true');
    expect(onRequestCommentSurface).not.toHaveBeenCalled();
  });

  it('gives up quietly when the linked thread is not in this session', async () => {
    const onRequestCommentSurface = vi.fn();
    setRailViewport(true);
    renderWithQuery(
      <CommentUiHarness
        surface="rail"
        canSendToAgent={false}
        focusCommentThreadId="thread-missing"
        onRequestCommentSurface={onRequestCommentSurface}
      />
    );
    // Liveness: the list loaded.
    expect(
      await screen.findByRole('article', { name: 'Comment by Grace Hopper' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('focus-state')).toHaveTextContent('-|-');
    expect(onRequestCommentSurface).not.toHaveBeenCalled();
  });
});
