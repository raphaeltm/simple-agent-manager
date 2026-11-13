/**
 * Commented words in the project chat: open threads' quotes are painted by default, the thread
 * someone was sent to is painted strongly, and clicking painted words opens their thread.
 *
 * Rendered through the production wiring — `useMessageComments` + `useProjectMessageCommentUi`
 * over real `CommentableConversationItem` rows — so the threads come from the comments API,
 * the deep link enters through `focusCommentThreadId`, and a click enters through the chat
 * log's own listener. Only the message bubble is replaced, by its plain text.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageCommentThread } from '../../../src/lib/api/comments';
import { type HighlightStubs, POINTER, stubCssHighlights } from '../../test-utils/css-highlights';

const mocks = vi.hoisted(() => ({
  listMessageComments: vi.fn(),
  getProjectMembers: vi.fn(),
}));

vi.mock('../../../src/lib/api/comments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/comments')>()),
  listMessageComments: mocks.listMessageComments,
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getProjectMembers: mocks.getProjectMembers,
}));

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-owner', name: 'Olive Owner', email: 'o@example.com' } }),
}));

vi.mock('@simple-agent-manager/acp-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@simple-agent-manager/acp-client')>()),
  VoiceButton: () => null,
}));

vi.mock('../../../src/components/project-message-view/AcpConversationItemView', () => ({
  AcpConversationItemView: ({ item }: { item: { text?: string } }) => <p>{item.text}</p>,
}));

import { CommentableConversationItem } from '../../../src/components/project-message-view/comments/CommentableConversationItem';
import { useMessageComments } from '../../../src/components/project-message-view/comments/useMessageComments';
import { useProjectMessageCommentUi } from '../../../src/components/project-message-view/comments/useProjectMessageCommentUi';
import type { DisplayItem } from '../../../src/components/project-message-view/tool-call-groups';
import { renderWithQuery } from '../../test-utils/query-test-utils';

const FIRST_TEXT = 'The retry loop gives up after three attempts. Then it logs the failure and exits.';
const SECOND_TEXT = 'Deploys run on every merge to main.';

function makeThread(overrides: Partial<MessageCommentThread>): MessageCommentThread {
  return {
    id: 'thread',
    clientId: null,
    projectId: 'proj-1',
    sessionId: 'sess-1',
    anchor: { kind: 'message', messageId: 'msg-1', quote: null },
    author: { id: 'user-grace', name: 'Grace Hopper', kind: 'human' },
    body: 'A comment',
    createdAt: 1_000,
    updatedAt: 1_000,
    status: 'open',
    replies: [],
    ...overrides,
  };
}

const OPEN_OLDER = makeThread({
  id: 'open-older',
  anchor: { kind: 'message', messageId: 'msg-1', quote: 'gives up after three attempts' },
  body: 'Why three?',
  createdAt: 1_000,
});
const OPEN_NEWER = makeThread({
  id: 'open-newer',
  anchor: { kind: 'message', messageId: 'msg-1', quote: 'after three attempts' },
  body: 'Should be configurable.',
  createdAt: 2_000,
});
const RESOLVED = makeThread({
  id: 'resolved',
  anchor: { kind: 'message', messageId: 'msg-1', quote: 'logs the failure' },
  body: 'Done already.',
  createdAt: 3_000,
  status: 'resolved',
});
const WHOLE_MESSAGE = makeThread({ id: 'no-quote', anchor: { kind: 'message', messageId: 'msg-2', quote: null } });

function items(firstText = FIRST_TEXT): DisplayItem[] {
  return [
    { kind: 'agent_message', id: 'msg-1', text: firstText, streaming: false, timestamp: 1 },
    { kind: 'agent_message', id: 'msg-2', text: SECOND_TEXT, streaming: false, timestamp: 2 },
  ] as DisplayItem[];
}

/** The chat log as `SessionMessageView` wires it: rows in the log, the rail beside it. */
function ChatHarness({
  rows = items(),
  focusCommentThreadId,
}: {
  rows?: DisplayItem[];
  focusCommentThreadId?: string | null;
}) {
  const messageComments = useMessageComments('proj-1', 'sess-1', true);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const [railOpen, setRailOpen] = useState(false);
  const ui = useProjectMessageCommentUi({
    messageComments,
    canComment: true,
    canSendToAgent: true,
    hasMessages: true,
    chatLogRef,
    sessionId: 'sess-1',
    projectId: 'proj-1',
    onRequestCommentSurface: () => setRailOpen(true),
    focusCommentThreadId,
    commentSurfaceOpen: railOpen,
  });
  return (
    <>
      <div ref={chatLogRef} data-testid="chat-log">
        {rows.map((item, index) => (
          <CommentableConversationItem
            key={item.id}
            index={index}
            firstItemIndex={0}
            item={item}
            projectId="proj-1"
            highlighted={false}
            onLoadToolContent={async () => []}
            animateAgentText={false}
            animateUserMessage={false}
            canComment
            canSendToAgent
            agentActivity="idle"
            animationTargetIdx={-1}
            commentState={ui.rowState}
          />
        ))}
      </div>
      <output data-testid="focus-state">
        {`${ui.rowState.activeMessageId ?? '-'}|${ui.rowState.focusedCommentId ?? '-'}|${railOpen ? 'rail' : 'no-rail'}`}
      </output>
      <button type="button" onClick={() => setRailOpen(false)}>
        Close rail
      </button>
    </>
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

function focusState() {
  return screen.getByTestId('focus-state').textContent;
}

let highlights: HighlightStubs;

beforeEach(() => {
  vi.clearAllMocks();
  setRailViewport(true);
  highlights = stubCssHighlights();
  mocks.getProjectMembers.mockResolvedValue({ members: [], inviteLinks: [], accessRequests: [] });
  mocks.listMessageComments.mockResolvedValue({
    comments: [OPEN_OLDER, OPEN_NEWER, RESOLVED, WHOLE_MESSAGE],
  });
});

afterEach(() => {
  highlights.restore();
  setRailViewport(false);
});

describe('chat comment quotes', () => {
  it('paints open comments’ quotes by default, not resolved ones', async () => {
    renderWithQuery(<ChatHarness />);

    await waitFor(() =>
      expect(highlights.otherQuotes()).toEqual([
        'gives up after three attempts',
        'after three attempts',
      ])
    );
    expect(highlights.activeQuotes()).toEqual([]);
    // Liveness: the messages rendered, and nothing is focused.
    expect(screen.getByText(SECOND_TEXT)).toBeTruthy();
    expect(focusState()).toBe('-|-|no-rail');
  });

  it('paints a deep-linked comment strongly, even a resolved one, with the rail open', async () => {
    renderWithQuery(<ChatHarness focusCommentThreadId="resolved" />);

    await waitFor(() => expect(highlights.activeQuotes()).toEqual(['logs the failure']));
    expect(focusState()).toBe('msg-1|resolved|rail');
    // The open ones stay painted faintly beside it.
    expect(highlights.otherQuotes()).toEqual(['gives up after three attempts', 'after three attempts']);
  });

  it('stops painting the focused comment strongly once the rail is closed', async () => {
    renderWithQuery(<ChatHarness focusCommentThreadId="open-older" />);
    await waitFor(() => expect(highlights.activeQuotes()).toEqual(['gives up after three attempts']));

    fireEvent.click(screen.getByRole('button', { name: 'Close rail' }));

    await waitFor(() => expect(highlights.activeQuotes()).toEqual([]));
    // Still an open comment, so it goes back to the faint default.
    expect(highlights.otherQuotes()).toContain('gives up after three attempts');
  });

  it('opens the newest open thread under a click on overlapping painted words', async () => {
    renderWithQuery(<ChatHarness />);
    await waitFor(() => expect(highlights.otherQuotes()).toHaveLength(2));

    highlights.pointerOver('gives up after three attempts', 'after three attempts');
    fireEvent.click(screen.getByText(FIRST_TEXT), POINTER);

    await waitFor(() => expect(focusState()).toBe('msg-1|open-newer|rail'));
    await waitFor(() => expect(highlights.activeQuotes()).toEqual(['after three attempts']));
    expect(highlights.otherQuotes()).toEqual(['gives up after three attempts']);
  });

  it('on smaller screens opens the thread inline under its message', async () => {
    setRailViewport(false);
    renderWithQuery(<ChatHarness />);
    await waitFor(() => expect(highlights.otherQuotes()).toHaveLength(2));

    highlights.pointerOver('gives up after three attempts');
    fireEvent.click(screen.getByText(FIRST_TEXT), POINTER);

    await waitFor(() => expect(focusState()).toBe('msg-1|open-older|no-rail'));
    // The message's threads open inline, the clicked one focused.
    await waitFor(() =>
      expect(document.querySelector('[data-comment-focused="true"]')?.textContent).toContain(
        'Why three?'
      )
    );
    await waitFor(() => expect(highlights.activeQuotes()).toEqual(['gives up after three attempts']));
  });

  it('ignores a click on unpainted words, and a click that ends a text selection', async () => {
    renderWithQuery(<ChatHarness />);
    await waitFor(() => expect(highlights.otherQuotes()).toHaveLength(2));

    highlights.pointerOver();
    fireEvent.click(screen.getByText(FIRST_TEXT), POINTER);
    expect(focusState()).toBe('-|-|no-rail');

    highlights.pointerOver('after three attempts');
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(screen.getByText(SECOND_TEXT));
    selection?.addRange(range);
    fireEvent.click(screen.getByText(FIRST_TEXT), POINTER);
    expect(focusState()).toBe('-|-|no-rail');

    // Control: the same click, without the selection, opens the thread.
    selection?.removeAllRanges();
    fireEvent.click(screen.getByText(FIRST_TEXT), POINTER);
    await waitFor(() => expect(focusState()).toBe('msg-1|open-newer|rail'));
  });

  it('finds the words again when the message is redrawn', async () => {
    const { rerender } = renderWithQuery(<ChatHarness rows={items('Still streaming…')} />);
    await waitFor(() => expect(mocks.listMessageComments).toHaveBeenCalled());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(highlights.otherQuotes()).toEqual([]);

    rerender(<ChatHarness rows={items()} />);

    await waitFor(() => expect(highlights.otherQuotes()).toHaveLength(2));
  });

  it('paints nothing and opens nothing where the browser has no highlight API', async () => {
    highlights.restore();
    renderWithQuery(<ChatHarness />);
    await waitFor(() => expect(mocks.listMessageComments).toHaveBeenCalled());
    expect(screen.getByText(FIRST_TEXT)).toBeTruthy();

    fireEvent.click(screen.getByText(FIRST_TEXT), POINTER);
    expect(focusState()).toBe('-|-|no-rail');
    highlights = stubCssHighlights();
  });
});
