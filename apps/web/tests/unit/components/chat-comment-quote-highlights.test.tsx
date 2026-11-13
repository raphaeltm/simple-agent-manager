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

// A message is its text; one starting "LINK:" is a link, to check links keep their own click.
vi.mock('../../../src/components/project-message-view/AcpConversationItemView', () => ({
  AcpConversationItemView: ({ item }: { item: { text?: string } }) =>
    item.text?.startsWith('LINK:') ? (
      <p>
        <a href="#docs">{item.text.slice('LINK:'.length)}</a>
      </p>
    ) : (
      <p>{item.text}</p>
    ),
}));

import { CommentableConversationItem } from '../../../src/components/project-message-view/comments/CommentableConversationItem';
import { useMessageComments } from '../../../src/components/project-message-view/comments/useMessageComments';
import { useProjectMessageCommentUi } from '../../../src/components/project-message-view/comments/useProjectMessageCommentUi';
import type { DisplayItem } from '../../../src/components/project-message-view/tool-call-groups';
import { renderWithQuery } from '../../test-utils/query-test-utils';

const FIRST_TEXT =
  'The retry loop gives up after three attempts. Then it logs the failure and exits.';
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
const WHOLE_MESSAGE = makeThread({
  id: 'no-quote',
  anchor: { kind: 'message', messageId: 'msg-2', quote: null },
});

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
  ready = true,
}: {
  rows?: DisplayItem[];
  focusCommentThreadId?: string | null;
  /** False renders a loading pane where the log goes, as the chat does before its session. */
  ready?: boolean;
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
      {!ready && <p>Loading chat…</p>}
      {ready && (
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
      )}
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

function box(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 100,
    width: 100,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

/** Let a delayed mouse-click open (or not), and pending frames run. */
async function settle(ms = 400) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function focusState() {
  return screen.getByTestId('focus-state').textContent;
}

let highlights: HighlightStubs;

// jsdom ranges have no layout; the chat's own selection reader measures one (a zero box reads
// as "nothing to offer a Comment button for").
const rangeBoundingRect = Range.prototype.getBoundingClientRect;

beforeEach(() => {
  vi.clearAllMocks();
  setRailViewport(true);
  highlights = stubCssHighlights();
  Range.prototype.getBoundingClientRect = () => ({ ...box(0, 0), right: 0, width: 0 });
  mocks.getProjectMembers.mockResolvedValue({ members: [], inviteLinks: [], accessRequests: [] });
  mocks.listMessageComments.mockResolvedValue({
    comments: [OPEN_OLDER, OPEN_NEWER, RESOLVED, WHOLE_MESSAGE],
  });
});

afterEach(() => {
  highlights.restore();
  setRailViewport(false);
  Range.prototype.getBoundingClientRect = rangeBoundingRect;
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
    expect(highlights.otherQuotes()).toEqual([
      'gives up after three attempts',
      'after three attempts',
    ]);
  });

  it('stops painting the focused comment strongly once the rail is closed', async () => {
    renderWithQuery(<ChatHarness focusCommentThreadId="open-older" />);
    await waitFor(() =>
      expect(highlights.activeQuotes()).toEqual(['gives up after three attempts'])
    );

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
    await waitFor(() =>
      expect(highlights.activeQuotes()).toEqual(['gives up after three attempts'])
    );
  });

  it('ignores a click on unpainted words, and a click that ends a text selection', async () => {
    renderWithQuery(<ChatHarness />);
    await waitFor(() => expect(highlights.otherQuotes()).toHaveLength(2));

    highlights.pointerOver();
    fireEvent.click(screen.getByText(FIRST_TEXT), POINTER);
    await settle();
    expect(focusState()).toBe('-|-|no-rail');

    highlights.pointerOver('after three attempts');
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(screen.getByText(SECOND_TEXT));
    selection?.addRange(range);
    fireEvent.click(screen.getByText(FIRST_TEXT), POINTER);
    await settle();
    expect(focusState()).toBe('-|-|no-rail');

    // Control: the same click, without the selection, opens the thread.
    selection?.removeAllRanges();
    fireEvent.click(screen.getByText(FIRST_TEXT), POINTER);
    await waitFor(() => expect(focusState()).toBe('msg-1|open-newer|rail'));
  });

  it('ignores a tap that only dismisses a selection, though the press collapses it', async () => {
    renderWithQuery(<ChatHarness />);
    await waitFor(() => expect(highlights.otherQuotes()).toHaveLength(2));
    highlights.pointerOver('after three attempts');
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(screen.getByText(SECOND_TEXT));
    selection?.addRange(range);

    const words = screen.getByText(FIRST_TEXT);
    fireEvent.pointerDown(words, POINTER);
    selection?.removeAllRanges(); // what the press does in a browser
    fireEvent.click(words, POINTER);
    await settle();
    expect(focusState()).toBe('-|-|no-rail');

    // Control: a press with nothing selected, then the click, opens it.
    fireEvent.pointerDown(words, POINTER);
    fireEvent.click(words, POINTER);
    await waitFor(() => expect(focusState()).toBe('msg-1|open-newer|rail'));
  });

  it('lets a double click select a word without opening the thread', async () => {
    renderWithQuery(<ChatHarness />);
    await waitFor(() => expect(highlights.otherQuotes()).toHaveLength(2));
    highlights.pointerOver('after three attempts');

    const words = screen.getByText(FIRST_TEXT);
    fireEvent.click(words, { ...POINTER, detail: 1 });
    fireEvent.click(words, { ...POINTER, detail: 2 });
    await settle();
    expect(focusState()).toBe('-|-|no-rail');

    // Control: one click alone opens it.
    fireEvent.click(words, { ...POINTER, detail: 1 });
    await waitFor(() => expect(focusState()).toBe('msg-1|open-newer|rail'));
  });

  it('leaves a click on a link inside painted words to the link', async () => {
    const linkThread = makeThread({
      id: 'on-link',
      anchor: { kind: 'message', messageId: 'msg-3', quote: 'read the runbook' },
    });
    mocks.listMessageComments.mockResolvedValue({ comments: [OPEN_OLDER, linkThread] });
    const rows = [
      ...items(),
      {
        kind: 'agent_message',
        id: 'msg-3',
        text: 'LINK:read the runbook',
        streaming: false,
        timestamp: 3,
      },
    ] as DisplayItem[];
    renderWithQuery(<ChatHarness rows={rows} />);
    await waitFor(() => expect(highlights.otherQuotes()).toContain('read the runbook'));

    highlights.pointerOver('read the runbook');
    fireEvent.click(screen.getByRole('link', { name: 'read the runbook' }), POINTER);
    await settle();
    expect(focusState()).toBe('-|-|no-rail');

    // Control: painted words outside a link still open their thread.
    highlights.pointerOver('gives up after three attempts');
    fireEvent.click(screen.getByText(FIRST_TEXT), POINTER);
    await waitFor(() => expect(focusState()).toBe('msg-1|open-older|rail'));
  });

  it('finds the words again when the message is redrawn', async () => {
    const { rerender } = renderWithQuery(<ChatHarness rows={items('Still streaming…')} />);
    await waitFor(() => expect(mocks.listMessageComments).toHaveBeenCalled());
    await settle(20);
    expect(highlights.otherQuotes()).toEqual([]);

    rerender(<ChatHarness rows={items()} />);

    await waitFor(() => expect(highlights.otherQuotes()).toHaveLength(2));
  });

  it('paints once the chat log mounts after a loading pane', async () => {
    const { rerender } = renderWithQuery(<ChatHarness ready={false} />);
    await waitFor(() => expect(mocks.listMessageComments).toHaveBeenCalled());
    await settle(20);
    expect(highlights.otherQuotes()).toEqual([]);

    rerender(<ChatHarness ready />);

    await waitFor(() => expect(highlights.otherQuotes()).toHaveLength(2));
  });

  it('watches the conversation only while there are quoted comments to paint', async () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    mocks.listMessageComments.mockResolvedValue({ comments: [RESOLVED, WHOLE_MESSAGE] });
    renderWithQuery(<ChatHarness />);
    await waitFor(() => expect(mocks.listMessageComments).toHaveBeenCalled());
    await settle(20);

    const watchingLog = () =>
      observe.mock.calls.some(([target]) => target === screen.getByTestId('chat-log'));
    expect(watchingLog()).toBe(false);
    expect(highlights.registry.size).toBe(0);
    observe.mockRestore();
  });

  it('paints nothing and opens nothing where the browser has no highlight API', async () => {
    vi.stubGlobal('Highlight', undefined);
    renderWithQuery(<ChatHarness />);
    await waitFor(() => expect(mocks.listMessageComments).toHaveBeenCalled());
    await settle(20);
    expect(screen.getByText(FIRST_TEXT)).toBeTruthy();
    expect(highlights.registry.size).toBe(0);

    highlights.pointerOver('after three attempts');
    fireEvent.click(screen.getByText(FIRST_TEXT), POINTER);
    await settle();
    expect(focusState()).toBe('-|-|no-rail');
  });
});

/*
 * Bringing the words on screen. jsdom has no layout, so the chat log is given one: it scrolls
 * (500px tall, 3000px of content) and the quoted words sit 1500px down it.
 */
describe('bringing a comment’s words on screen', () => {
  const QUOTE_TOP = 1500;
  let restoreLayout: () => void = () => undefined;

  function layOut(log: HTMLElement) {
    log.style.overflowY = 'auto';
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 3000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 500 });
    log.getBoundingClientRect = () => box(0, 500);
    const original = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
      const top = QUOTE_TOP - log.scrollTop;
      return box(top, top + 20);
    };
    restoreLayout = () => {
      Range.prototype.getBoundingClientRect = original;
    };
  }

  afterEach(() => restoreLayout());

  async function openLog(focusCommentThreadId?: string) {
    const view = renderWithQuery(<ChatHarness focusCommentThreadId={focusCommentThreadId} />);
    const log = screen.getByTestId('chat-log');
    layOut(log);
    return { ...view, log };
  }

  /** Redraw a row, as streaming or a virtualized mount does. */
  function redraw(rerender: (ui: React.ReactElement) => void, text: string) {
    const rows = items();
    rows[1] = { ...rows[1], text } as DisplayItem;
    rerender(<ChatHarness rows={rows} focusCommentThreadId="open-older" />);
  }

  it('scrolls a deep-linked comment’s words into view', async () => {
    const { log } = await openLog('open-older');

    await waitFor(() =>
      expect(highlights.activeQuotes()).toEqual(['gives up after three attempts'])
    );
    await waitFor(() => expect(log.scrollTop).toBe(QUOTE_TOP - 500 * 0.3));
  });

  it('keeps them there while the conversation settles, until the reader scrolls', async () => {
    const { log, rerender } = await openLog('open-older');
    await waitFor(() => expect(log.scrollTop).toBe(QUOTE_TOP - 150));

    // Something else moves the list (a row mounting above): the words are brought back.
    log.scrollTop = 0;
    redraw(rerender, 'Deploys run on every merge to main, and on tags.');
    await waitFor(() => expect(log.scrollTop).toBe(QUOTE_TOP - 150));

    // The reader scrolls away: the next redraw leaves them where they are.
    fireEvent.wheel(log);
    log.scrollTop = 0;
    redraw(rerender, 'Deploys run on every merge to main, on tags, and nightly.');
    await settle(50);
    expect(log.scrollTop).toBe(0);
    expect(
      screen.getByText('Deploys run on every merge to main, on tags, and nightly.')
    ).toBeTruthy();
  });

  it('stops bringing them back once the settling window has passed', async () => {
    let now = 1_000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const { log, rerender } = await openLog('open-older');
      await waitFor(() => expect(log.scrollTop).toBe(QUOTE_TOP - 150));

      now += 5_000;
      log.scrollTop = 0;
      redraw(rerender, 'Deploys run on every merge to main, and on tags.');
      await settle(50);
      expect(log.scrollTop).toBe(0);
      expect(screen.getByText('Deploys run on every merge to main, and on tags.')).toBeTruthy();
    } finally {
      clock.mockRestore();
    }
  });

  it('does not scroll when the reader clicks the words themselves', async () => {
    const { log } = await openLog();
    await waitFor(() => expect(highlights.otherQuotes()).toHaveLength(2));

    highlights.pointerOver('gives up after three attempts');
    fireEvent.click(screen.getByText(FIRST_TEXT), POINTER);

    await waitFor(() => expect(focusState()).toBe('msg-1|open-older|rail'));
    await waitFor(() =>
      expect(highlights.activeQuotes()).toEqual(['gives up after three attempts'])
    );
    await settle(50);
    expect(log.scrollTop).toBe(0);
  });
});
