/**
 * Regression tests for chat session cross-contamination fix.
 *
 * Bug: When switching between sessions, in-flight polling requests for the
 * old session could resolve after the switch and overwrite the new session's
 * messages with the old session's data.
 *
 * Fix: Added AbortController to the polling useEffect so in-flight requests
 * are cancelled when the session changes.
 */
import { DEFAULT_CHAT_SESSION_MESSAGE_LIMIT, DEFAULT_CHAT_SESSION_MESSAGE_MAX } from '@simple-agent-manager/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom doesn't support scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

// --- Mocks ---

const mocks = vi.hoisted(() => ({
  getChatSession: vi.fn(),
  getTranscribeApiUrl: vi.fn(() => 'https://api.test.com/api/transcribe'),
  resetIdleTimer: vi.fn(),
  sendFollowUpPrompt: vi.fn(),
  cancelAgentPrompt: vi.fn(),
  getWorkspace: vi.fn(),
  getNode: vi.fn(),
  updateProjectTaskStatus: vi.fn(),
  deleteWorkspace: vi.fn(),
  // Timeline data sources (useSessionTimeline)
  listChatMessages: vi.fn(),
  listActivityEvents: vi.fn(),
  listNotifications: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getChatSession: mocks.getChatSession,
  getTranscribeApiUrl: mocks.getTranscribeApiUrl,
  getTtsApiUrl: vi.fn().mockReturnValue('https://api.example.com/api/tts'),
  resetIdleTimer: mocks.resetIdleTimer,
  sendFollowUpPrompt: mocks.sendFollowUpPrompt,
  cancelAgentPrompt: mocks.cancelAgentPrompt,
  getWorkspace: mocks.getWorkspace,
  getNode: mocks.getNode,
  updateProjectTaskStatus: mocks.updateProjectTaskStatus,
  deleteWorkspace: mocks.deleteWorkspace,
}));

// Captured WebSocket onMessage callback — tests can call this to inject messages
let capturedWsOnMessage: ((msg: ReturnType<typeof makeMessage>) => void) | null = null;
// Captured onCatchUp callback — tests can call this to simulate catch-up after reconnect
let capturedWsOnCatchUp: ((msgs: ReturnType<typeof makeMessage>[], session: ReturnType<typeof makeSession>) => void) | null = null;
let mockWsConnectionState: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' = 'connected';

vi.mock('../../../src/hooks/useChatWebSocket', () => ({
  useChatWebSocket: (opts: { onMessage?: (msg: unknown) => void; onCatchUp?: (msgs: unknown[], session: unknown) => void }) => {
    capturedWsOnMessage = (opts.onMessage ?? null) as typeof capturedWsOnMessage;
    capturedWsOnCatchUp = (opts.onCatchUp ?? null) as typeof capturedWsOnCatchUp;
    return {
      connectionState: mockWsConnectionState,
      wsRef: { current: null },
      retry: vi.fn(),
    };
  },
}));

vi.mock('@simple-agent-manager/acp-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simple-agent-manager/acp-client')>();
  return {
    ...actual,
    VoiceButton: () => <button data-testid="voice-button">Voice</button>,
    MessageBubble: ({ text, role }: { text: string; role: string }) => (
      <div data-testid={`acp-message-${role}`}>{text}</div>
    ),
    ToolCallCard: ({ toolCall }: { toolCall: { title: string } }) => (
      <div data-testid="acp-tool-call">{toolCall.title}</div>
    ),
    ThinkingBlock: ({ text }: { text: string }) => (
      <div data-testid="acp-thinking">{text}</div>
    ),
    TypewriterText: ({ text }: { text: string }) => <span>{text}</span>,
  };
});

// Mock react-virtuoso — JSDOM has no layout engine, so Virtuoso can't measure items.
// Uses vi.hoisted to ensure the mock factory runs before imports.
//
// The mock exposes `scrollToIndex` via useImperativeHandle so tests can assert the
// EXACT index the component asks Virtuoso to scroll to. This is critical: real
// Virtuoso's `scrollToIndex` uses the 0-based data-array coordinate, while
// `itemContent`'s `index` arg is the `firstItemIndex`-offset absolute coordinate.
// Passing the absolute value (~VIRTUAL_START) is out of range and silently does
// nothing — a dead click on virtualized sessions. The mock renders every row, so
// a highlight-presence assertion alone would NOT catch that; the scrollToIndex
// argument assertion does.
const virtuosoMock = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
  const React = require('react') as typeof import('react');
  const scrollToIndexCalls: Array<{ index?: number | string } | number> = [];
  return {
    scrollToIndexCalls,
    Virtuoso: React.forwardRef(function MockVirtuoso(
      props: {
        data?: unknown[];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        itemContent?: (index: number, item: any) => React.ReactNode;
        style?: React.CSSProperties;
        components?: { Header?: React.ComponentType };
      },
      ref: React.Ref<unknown>,
    ) {
      const { data, itemContent, style, components } = props;
      React.useImperativeHandle(ref, () => ({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        scrollToIndex: (arg: any) => { scrollToIndexCalls.push(arg); },
      }), []);
      const HeaderComponent = components?.Header;
      return React.createElement('div', { 'data-testid': 'virtuoso-scroller', style },
        HeaderComponent ? React.createElement(HeaderComponent) : null,
        data?.map((item, index) =>
          React.createElement('div', { key: index }, itemContent?.(index, item))
        )
      );
    }),
  };
});
vi.mock('react-virtuoso', () => ({ Virtuoso: virtuosoMock.Virtuoso }));

// Timeline data sources — useSessionTimeline fetches these when the drawer opens.
vi.mock('../../../src/lib/api/sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/sessions')>()),
  listChatMessages: mocks.listChatMessages,
  listActivityEvents: mocks.listActivityEvents,
}));
vi.mock('../../../src/lib/api/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/notifications')>()),
  listNotifications: mocks.listNotifications,
}));

// Safe defaults so any expanded-header / timeline fetch resolves to empty rather
// than `undefined` (SessionHeader chains `.then()` on listChatMessages). These
// implementations survive `vi.clearAllMocks()` (which clears calls, not impls),
// so unrelated tests that expand the header keep working.
mocks.listChatMessages.mockResolvedValue({ messages: [], hasMore: false });
mocks.listActivityEvents.mockResolvedValue({ events: [] });
mocks.listNotifications.mockResolvedValue({ notifications: [], nextCursor: null });

import { chatMessagesToConversationItems, ProjectMessageView } from '../../../src/components/project-message-view';

beforeEach(() => {
  mockWsConnectionState = 'connected';
  capturedWsOnMessage = null;
  capturedWsOnCatchUp = null;
});

// --- Test helpers ---

function makeSession(id: string, status = 'active') {
  return {
    id,
    workspaceId: `ws-${id}`,
    topic: `Session ${id}`,
    status,
    messageCount: 1,
    startedAt: Date.now() - 60000,
    endedAt: null,
    createdAt: Date.now() - 60000,
  };
}

function makeMessage(id: string, sessionId: string, content: string) {
  return {
    id,
    sessionId,
    role: 'assistant' as const,
    content,
    toolMetadata: null,
    createdAt: Date.now(),
    sequence: null,
  };
}

function makeSessionResponse(sessionId: string, messages: ReturnType<typeof makeMessage>[]) {
  return {
    session: makeSession(sessionId),
    messages,
    hasMore: false,
  };
}

type WorkspaceBadgeFixture = {
  id: string;
  name: string;
  status: string;
  vmSize: string;
  workspaceProfile: 'lightweight' | 'full' | null;
};

function renderWorkspaceBadgeFixture(sessionId: string, workspace: WorkspaceBadgeFixture) {
  mocks.getWorkspace.mockResolvedValue({
    ...workspace,
    vmLocation: 'fsn1',
    nodeId: 'node-1',
  });
  mocks.getNode.mockResolvedValue({
    id: 'node-1',
    name: 'node-1',
    status: 'active',
    healthStatus: 'healthy',
  });
  mocks.getChatSession.mockResolvedValue({
    session: makeSession(sessionId, 'active'),
    messages: [makeMessage('m1', sessionId, 'Hello')],
    hasMore: false,
  });

  render(<ProjectMessageView projectId="proj-1" sessionId={sessionId} />);
}

describe('ProjectMessageView — session isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    mockWsConnectionState = 'connected';
    // Default workspace/node mocks — return pending promises to avoid side effects
    mocks.getWorkspace.mockResolvedValue({ id: 'ws-test', name: 'test', status: 'running', vmSize: 'medium', vmLocation: 'fsn1' });
    mocks.getNode.mockResolvedValue({ id: 'node-test', name: 'node-test', status: 'active', healthStatus: 'healthy' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads the full conversation on open and polls with only the small window', async () => {
    // The fallback poll only runs while the WebSocket is not connected.
    mockWsConnectionState = 'reconnecting';
    const limits: Array<number | undefined> = [];
    mocks.getChatSession.mockImplementation(async (_p: string, _s: string, params?: { limit?: number }) => {
      limits.push(params?.limit);
      return makeSessionResponse('session-A', [makeMessage('m1', 'session-A', 'Hi')]);
    });

    render(<ProjectMessageView projectId="proj-1" sessionId="session-A" />);

    // Initial load requests the full-conversation ceiling.
    await waitFor(() => expect(limits.length).toBeGreaterThanOrEqual(1));
    expect(limits[0]).toBe(DEFAULT_CHAT_SESSION_MESSAGE_MAX);
    // The fallback poll must request only the small recent window — never the ceiling.
    // Under full coverage load, React may commit the polling effect after the
    // first timer advance, so advance multiple intervals until it fires.
    for (let attempts = 0; attempts < 3 && limits.length < 2; attempts += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(10_500); });
    }
    await waitFor(() => expect(limits.length).toBeGreaterThanOrEqual(2));
    expect(limits.slice(1)).toContain(DEFAULT_CHAT_SESSION_MESSAGE_LIMIT);
    expect(limits.slice(1)).not.toContain(DEFAULT_CHAT_SESSION_MESSAGE_MAX);
  });

  it('does not apply polling response from a different session', async () => {
    const sessionAResponse = makeSessionResponse('session-A', [
      makeMessage('msg-a1', 'session-A', 'Hello from A'),
    ]);
    const sessionBResponse = makeSessionResponse('session-B', [
      makeMessage('msg-b1', 'session-B', 'Hello from B'),
    ]);

    mocks.getChatSession.mockImplementation(async (_projectId: string, sessionId: string) => {
      if (sessionId === 'session-A') return sessionAResponse;
      if (sessionId === 'session-B') return sessionBResponse;
      throw new Error(`Unexpected session: ${sessionId}`);
    });

    const { rerender } = render(
      <ProjectMessageView projectId="proj-1" sessionId="session-A" />
    );

    await waitFor(() => {
      expect(screen.getByText('Hello from A')).toBeTruthy();
    });

    rerender(
      <ProjectMessageView projectId="proj-1" sessionId="session-B" />
    );

    await waitFor(() => {
      expect(screen.getByText('Hello from B')).toBeTruthy();
    });

    expect(screen.queryByText('Hello from A')).toBeNull();
  });

  it('aborts in-flight polling requests on session switch', async () => {
    mockWsConnectionState = 'reconnecting';
    let pollSignal: AbortSignal | undefined;

    const sessionAResponse = makeSessionResponse('session-A', [
      makeMessage('msg-a1', 'session-A', 'Data from A'),
    ]);

    // Initial load — no signal capture (initial load effect is separate)
    mocks.getChatSession.mockResolvedValue(sessionAResponse);

    const { rerender } = render(
      <ProjectMessageView projectId="proj-1" sessionId="session-A" />
    );

    await waitFor(() => {
      expect(screen.getByText('Data from A')).toBeTruthy();
    });

    // Now capture the signal from the degraded fallback polling interval.
    mocks.getChatSession.mockImplementation(async (
      _projectId: string,
      _sessionId: string,
      params?: { signal?: AbortSignal }
    ) => {
      pollSignal = params?.signal;
      return sessionAResponse;
    });

    // Advance past the fallback poll interval. Use advanceTimersByTimeAsync to
    // properly process microtasks (the fallback effect starts asynchronously
    // after session state is committed to the DOM).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_100);
    });

    // Verify the poll fired and we captured a signal. CI can schedule the
    // polling callback a tick later than advanceTimersByTimeAsync resolves.
    await waitFor(() => {
      expect(pollSignal).toBeDefined();
    });
    expect(pollSignal!.aborted).toBe(false);

    const sessionBResponse = makeSessionResponse('session-B', [
      makeMessage('msg-b1', 'session-B', 'Data from B'),
    ]);
    mocks.getChatSession.mockResolvedValue(sessionBResponse);

    // Switch sessions — cleanup should abort the poll signal
    rerender(
      <ProjectMessageView projectId="proj-1" sessionId="session-B" />
    );

    await waitFor(() => {
      expect(pollSignal!.aborted).toBe(true);
    });
  });

  it('discards stale poll response that resolves after session switch', async () => {
    mockWsConnectionState = 'reconnecting';
    // This is the definitive regression test: a poll for session A is
    // held in-flight while the user switches to session B. When the
    // signal is aborted, the mock rejects with AbortError (matching
    // real fetch behavior), and the catch block silently drops it.
    const sessionAResponse = makeSessionResponse('session-A', [
      makeMessage('msg-a1', 'session-A', 'Hello from A'),
    ]);
    const sessionBResponse = makeSessionResponse('session-B', [
      makeMessage('msg-b1', 'session-B', 'Hello from B'),
    ]);

    // Track call count to distinguish initial load from poll
    let callIndex = 0;

    mocks.getChatSession.mockImplementation((_projectId: string, sessionId: string, params?: { signal?: AbortSignal }) => {
      callIndex++;
      if (sessionId === 'session-A') {
        if (callIndex <= 1) {
          // First call: initial load — resolve immediately
          return Promise.resolve(sessionAResponse);
        }
        // Second call (poll): simulate real fetch behavior — return a
        // promise that rejects with AbortError when the signal fires.
        const signal = params?.signal;
        if (signal?.aborted) {
          return Promise.reject(new DOMException('Aborted', 'AbortError'));
        }
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            reject(new DOMException('Aborted', 'AbortError'));
          };
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
      if (sessionId === 'session-B') return Promise.resolve(sessionBResponse);
      return Promise.reject(new Error(`Unexpected session: ${sessionId}`));
    });

    const { rerender } = render(
      <ProjectMessageView projectId="proj-1" sessionId="session-A" />
    );

    // Wait for initial session A load
    await waitFor(() => {
      expect(screen.getByText('Hello from A')).toBeTruthy();
    });

    // Trigger a fallback poll for session A.
    await act(async () => {
      vi.advanceTimersByTime(10_100);
    });

    // Switch to session B while the poll is in-flight.
    // The effect cleanup aborts the AbortController, which causes
    // the in-flight poll promise to reject with AbortError.
    mocks.getChatSession.mockImplementation(async () => sessionBResponse);

    await act(async () => {
      rerender(
        <ProjectMessageView projectId="proj-1" sessionId="session-B" />
      );
    });

    // Wait for session B to load
    await waitFor(() => {
      expect(screen.getByText('Hello from B')).toBeTruthy();
    });

    // Session B must remain visible — stale A data must NOT contaminate
    expect(screen.queryByText('Hello from A')).toBeNull();
  });
});

describe('ProjectMessageView — message rendering', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    mocks.getWorkspace.mockResolvedValue({ id: 'ws-test', name: 'test', status: 'running', vmSize: 'medium', vmLocation: 'fsn1' });
    mocks.getNode.mockResolvedValue({ id: 'node-test', name: 'node-test', status: 'active', healthStatus: 'healthy' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders system messages as preformatted text (not markdown)', async () => {
    const errorLog = '# Step 1/23 : FROM node:18\n* Installing dependencies...\nhttps://example.com';
    mocks.getChatSession.mockResolvedValue({
      session: makeSession('session-1', 'stopped'),
      messages: [{
        id: 'sys-1',
        sessionId: 'session-1',
        role: 'system',
        content: errorLog,
        toolMetadata: null,
        createdAt: Date.now(),
        sequence: null,
      }],
      hasMore: false,
    });

    render(<ProjectMessageView projectId="proj-1" sessionId="session-1" />);

    // Should render the System label
    await waitFor(() => {
      expect(screen.getByText('System')).toBeTruthy();
    });

    // Should render content in a <pre> element (preformatted, not markdown)
    const preElement = document.querySelector('pre');
    expect(preElement).toBeTruthy();
    expect(preElement!.textContent).toContain('# Step 1/23');
    expect(preElement!.textContent).toContain('* Installing dependencies...');

    // Should NOT render markdown headings (h1) or emphasis — the content is raw
    expect(document.querySelector('h1')).toBeNull();
    expect(document.querySelector('em')).toBeNull();
  });

  it('renders DO messages using ACP components', async () => {
    mocks.getChatSession.mockResolvedValue(
      makeSessionResponse('session-1', [
        makeMessage('msg-1', 'session-1', 'Agent response'),
      ]),
    );

    render(<ProjectMessageView projectId="proj-1" sessionId="session-1" />);

    // The mock AcpMessageBubble renders as <div data-testid="acp-message-agent">
    await waitFor(() => {
      expect(screen.getByTestId('acp-message-agent')).toBeTruthy();
    });
    expect(screen.getByText('Agent response')).toBeTruthy();
  });
});


describe('chatMessagesToConversationItems', () => {

  it('converts user messages', () => {
    const items = chatMessagesToConversationItems([
      { id: 'u1', sessionId: 's1', role: 'user', content: 'Hello', toolMetadata: null, createdAt: 1000 },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('user_message');
    expect(items[0].text).toBe('Hello');
  });

  it('merges consecutive assistant messages', () => {
    const items = chatMessagesToConversationItems([
      { id: 'a1', sessionId: 's1', role: 'assistant', content: 'Part 1', toolMetadata: null, createdAt: 1000 },
      { id: 'a2', sessionId: 's1', role: 'assistant', content: ' Part 2', toolMetadata: null, createdAt: 1001 },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('agent_message');
    expect(items[0].text).toBe('Part 1 Part 2');
  });

  it('converts tool messages with metadata', () => {
    const items = chatMessagesToConversationItems([
      {
        id: 't1', sessionId: 's1', role: 'tool', content: 'file contents',
        toolMetadata: { kind: 'read', locations: [{ path: '/src/index.ts' }] },
        createdAt: 1000,
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('tool_call');
    const tool = items[0] as { toolKind: string; locations: Array<{ path: string }> };
    expect(tool.toolKind).toBe('read');
    expect(tool.locations[0].path).toBe('/src/index.ts');
  });

  it('skips placeholder content in tool messages', () => {
    const items = chatMessagesToConversationItems([
      { id: 't1', sessionId: 's1', role: 'tool', content: '(tool call)', toolMetadata: null, createdAt: 1000 },
    ]);
    expect(items).toHaveLength(1);
    const tool = items[0] as { content: Array<unknown> };
    expect(tool.content).toHaveLength(0);
  });

  it('converts system messages as system_message kind', () => {
    const items = chatMessagesToConversationItems([
      { id: 's1', sessionId: 's1', role: 'system', content: 'Session started', toolMetadata: null, createdAt: 1000 },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('system_message');
    expect(items[0].text).toBe('Session started');
  });

  it('preserves raw content in system messages without markdown prefix', () => {
    const errorLog = '# Step 1/23 : FROM node:18\n* Installing dependencies...';
    const items = chatMessagesToConversationItems([
      { id: 's1', sessionId: 's1', role: 'system', content: errorLog, toolMetadata: null, createdAt: 1000 },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('system_message');
    // Content should be preserved exactly as-is (no markdown wrapping like *System:*)
    expect(items[0].text).toBe(errorLog);
  });

  it('converts empty system message', () => {
    const items = chatMessagesToConversationItems([
      { id: 's1', sessionId: 's1', role: 'system', content: '', toolMetadata: null, createdAt: 1000 },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('system_message');
    expect(items[0].text).toBe('');
  });

  it('does not merge consecutive system messages', () => {
    const items = chatMessagesToConversationItems([
      { id: 's1', sessionId: 's1', role: 'system', content: 'Task started', toolMetadata: null, createdAt: 1000 },
      { id: 's2', sessionId: 's1', role: 'system', content: 'Task failed', toolMetadata: null, createdAt: 2000 },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].kind).toBe('system_message');
    expect(items[0].text).toBe('Task started');
    expect(items[1].kind).toBe('system_message');
    expect(items[1].text).toBe('Task failed');
  });

  it('handles system message in mixed-role sequence', () => {
    const items = chatMessagesToConversationItems([
      { id: 'u1', sessionId: 's1', role: 'user', content: 'Run this task', toolMetadata: null, createdAt: 1000 },
      { id: 'a1', sessionId: 's1', role: 'assistant', content: 'Working on it', toolMetadata: null, createdAt: 2000 },
      { id: 's1', sessionId: 's1', role: 'system', content: 'Build failed: exit code 1', toolMetadata: null, createdAt: 3000 },
      { id: 'a2', sessionId: 's1', role: 'assistant', content: 'The build failed', toolMetadata: null, createdAt: 4000 },
    ]);
    expect(items).toHaveLength(4);
    expect(items[0].kind).toBe('user_message');
    expect(items[1].kind).toBe('agent_message');
    expect(items[2].kind).toBe('system_message');
    expect(items[2].text).toBe('Build failed: exit code 1');
    expect(items[3].kind).toBe('agent_message');
  });

  it('uses title from toolMetadata when available', () => {
    const items = chatMessagesToConversationItems([
      {
        id: 't1', sessionId: 's1', role: 'tool', content: 'file contents',
        toolMetadata: { title: 'Read file /src/index.ts', kind: 'read', locations: [{ path: '/src/index.ts' }] },
        createdAt: 1000,
      },
    ]);
    expect(items).toHaveLength(1);
    const tool = items[0] as { title: string; toolKind: string };
    expect(tool.title).toBe('Read file /src/index.ts');
    expect(tool.toolKind).toBe('read');
  });

  it('falls back to kind when title is not in metadata', () => {
    const items = chatMessagesToConversationItems([
      {
        id: 't1', sessionId: 's1', role: 'tool', content: '(tool call)',
        toolMetadata: { kind: 'bash' },
        createdAt: 1000,
      },
    ]);
    expect(items).toHaveLength(1);
    const tool = items[0] as { title: string; toolKind: string };
    expect(tool.title).toBe('Bash');
    expect(tool.toolKind).toBe('bash');
  });

  it('uses lazy-load metadata for structured tool content', () => {
    const items = chatMessagesToConversationItems([
      {
        id: 't1', sessionId: 's1', role: 'tool', content: 'diff: /src/main.go',
        toolMetadata: {
          title: 'Edit file /src/main.go',
          kind: 'edit',
          content: [
            { type: 'diff', text: '/src/main.go' },
          ],
        },
        createdAt: 1000,
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      content: [],
      contentLoaded: false,
      messageId: 't1',
      contentSize: expect.any(Number),
    });
  });

  it('uses status from metadata when available', () => {
    const items = chatMessagesToConversationItems([
      {
        id: 't1', sessionId: 's1', role: 'tool', content: '(tool update)',
        toolMetadata: { kind: 'bash', status: 'failed' },
        createdAt: 1000,
      },
    ]);
    expect(items).toHaveLength(1);
    const tool = items[0] as { status: string };
    expect(tool.status).toBe('failed');
  });

  it('uses lazy-load metadata for raw tool content when metadata has no structured content', () => {
    const items = chatMessagesToConversationItems([
      {
        id: 't1', sessionId: 's1', role: 'tool', content: 'some output',
        toolMetadata: { kind: 'bash' },
        createdAt: 1000,
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      content: [],
      contentLoaded: false,
      messageId: 't1',
      contentSize: 'some output'.length,
    });
  });

  it('preserves in_progress status from metadata', () => {
    const items = chatMessagesToConversationItems([
      {
        id: 't1', sessionId: 's1', role: 'tool', content: '(tool update)',
        toolMetadata: { kind: 'bash', status: 'in_progress' },
        createdAt: 1000,
      },
    ]);
    expect(items).toHaveLength(1);
    const tool = items[0] as { status: string };
    expect(tool.status).toBe('in_progress');
  });

  it('handles null toolMetadata with real content', () => {
    const items = chatMessagesToConversationItems([
      {
        id: 't1', sessionId: 's1', role: 'tool', content: 'stdout: build succeeded',
        toolMetadata: null,
        createdAt: 1000,
      },
    ]);
    expect(items).toHaveLength(1);
    const tool = items[0] as { title: string; content: Array<unknown>; contentLoaded?: boolean; messageId?: string; contentSize?: number };
    expect(tool.title).toBe('Tool Call');
    expect(tool.content).toHaveLength(0);
    expect(tool.contentLoaded).toBe(false);
    expect(tool.messageId).toBe('t1');
    expect(tool.contentSize).toBe('stdout: build succeeded'.length);
  });

  it('skips placeholder content for tool-update string', () => {
    const items = chatMessagesToConversationItems([
      { id: 't1', sessionId: 's1', role: 'tool', content: '(tool update)', toolMetadata: null, createdAt: 1000 },
    ]);
    expect(items).toHaveLength(1);
    const tool = items[0] as { content: Array<unknown> };
    expect(tool.content).toHaveLength(0);
  });

  it('uses lazy-load metadata for terminal content from metadata', () => {
    const items = chatMessagesToConversationItems([
      {
        id: 't1', sessionId: 's1', role: 'tool', content: '(tool call)',
        toolMetadata: { kind: 'bash', content: [{ type: 'terminal', text: 'term-1' }] },
        createdAt: 1000,
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      content: [],
      contentLoaded: false,
      messageId: 't1',
      contentSize: expect.any(Number),
    });
  });

  it('does not merge assistant followed by user followed by assistant', () => {
    const items = chatMessagesToConversationItems([
      { id: 'a1', sessionId: 's1', role: 'assistant', content: 'Hello', toolMetadata: null, createdAt: 1000 },
      { id: 'u1', sessionId: 's1', role: 'user', content: 'Hi', toolMetadata: null, createdAt: 1001 },
      { id: 'a2', sessionId: 's1', role: 'assistant', content: 'World', toolMetadata: null, createdAt: 1002 },
    ]);
    expect(items).toHaveLength(3);
    expect(items[0].kind).toBe('agent_message');
    expect(items[0].text).toBe('Hello');
    expect(items[1].kind).toBe('user_message');
    expect(items[2].kind).toBe('agent_message');
    expect(items[2].text).toBe('World');
  });
});

// ---------------------------------------------------------------------------
// Collapsible session header
// ---------------------------------------------------------------------------

describe('ProjectMessageView — collapsible session header', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    mocks.getWorkspace.mockResolvedValue({ id: 'ws-test', name: 'test', status: 'running', vmSize: 'medium', vmLocation: 'fsn1' });
    mocks.getNode.mockResolvedValue({ id: 'node-test', name: 'node-test', status: 'active', healthStatus: 'healthy' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows session title and state indicator in compact header', async () => {
    const response = {
      session: makeSession('sess-1', 'active'),
      messages: [makeMessage('m1', 'sess-1', 'Hi')],
      hasMore: false,
    };
    mocks.getChatSession.mockResolvedValue(response);

    render(<ProjectMessageView projectId="proj-1" sessionId="sess-1" />);

    await waitFor(() => {
      expect(screen.getByText('Session sess-1')).toBeTruthy();
    });

    // State indicator should be visible
    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('hides branch/PR details by default and reveals them on toggle', async () => {
    const session = {
      ...makeSession('sess-2', 'active'),
      task: {
        id: 'task-1',
        outputBranch: 'sam/my-feature',
        outputPrUrl: 'https://github.com/test/pr/1',
        status: 'in_progress',
        executionStep: null,
        errorMessage: null,
        outputSummary: null,
        finalizedAt: null,
      },
    };
    const response = {
      session,
      messages: [makeMessage('m1', 'sess-2', 'Hi')],
      hasMore: false,
    };
    mocks.getChatSession.mockResolvedValue(response);

    render(<ProjectMessageView projectId="proj-1" sessionId="sess-2" />);

    await waitFor(() => {
      expect(screen.getByText('Session sess-2')).toBeTruthy();
    });

    // Branch and PR should NOT be visible initially
    expect(screen.queryByText('sam/my-feature')).toBeNull();
    expect(screen.queryByText('View PR')).toBeNull();

    // Click the expand toggle
    const expandButton = screen.getByRole('button', { name: /show session details/i });
    fireEvent.click(expandButton);

    // Now branch and PR should be visible
    await waitFor(() => {
      expect(screen.getByText('sam/my-feature')).toBeTruthy();
      expect(screen.getByText('View PR')).toBeTruthy();
    });
  });

  it('collapses details when toggle is clicked again', async () => {
    const session = {
      ...makeSession('sess-3', 'active'),
      task: {
        id: 'task-1',
        outputBranch: 'sam/collapse-test',
        outputPrUrl: null,
        status: 'in_progress',
        executionStep: null,
        errorMessage: null,
        outputSummary: null,
        finalizedAt: null,
      },
    };
    const response = {
      session,
      messages: [makeMessage('m1', 'sess-3', 'Hi')],
      hasMore: false,
    };
    mocks.getChatSession.mockResolvedValue(response);

    render(<ProjectMessageView projectId="proj-1" sessionId="sess-3" />);

    await waitFor(() => {
      expect(screen.getByText('Session sess-3')).toBeTruthy();
    });

    // Expand
    const expandButton = screen.getByRole('button', { name: /show session details/i });
    fireEvent.click(expandButton);

    await waitFor(() => {
      expect(screen.getByText('sam/collapse-test')).toBeTruthy();
    });

    // Collapse
    const collapseButton = screen.getByRole('button', { name: /hide session details/i });
    fireEvent.click(collapseButton);

    await waitFor(() => {
      expect(screen.queryByText('sam/collapse-test')).toBeNull();
    });
  });

  it('sets aria-expanded attribute correctly on toggle', async () => {
    const session = {
      ...makeSession('sess-aria', 'active'),
      task: {
        id: 'task-1',
        outputBranch: 'sam/aria-test',
        outputPrUrl: null,
        status: 'in_progress',
        executionStep: null,
        errorMessage: null,
        outputSummary: null,
        finalizedAt: null,
      },
    };
    const response = {
      session,
      messages: [makeMessage('m1', 'sess-aria', 'Hi')],
      hasMore: false,
    };
    mocks.getChatSession.mockResolvedValue(response);

    render(<ProjectMessageView projectId="proj-1" sessionId="sess-aria" />);

    await waitFor(() => {
      expect(screen.getByText('Session sess-aria')).toBeTruthy();
    });

    const expandButton = screen.getByRole('button', { name: /show session details/i });
    expect(expandButton.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(expandButton);

    await waitFor(() => {
      const collapseButton = screen.getByRole('button', { name: /hide session details/i });
      expect(collapseButton.getAttribute('aria-expanded')).toBe('true');
    });
  });

  it('shows stopped state indicator', async () => {
    const session = makeSession('sess-stopped', 'stopped');
    const response = {
      session,
      messages: [makeMessage('m1', 'sess-stopped', 'Done')],
      hasMore: false,
    };
    mocks.getChatSession.mockResolvedValue(response);

    render(<ProjectMessageView projectId="proj-1" sessionId="sess-stopped" />);

    await waitFor(() => {
      expect(screen.getByText('Session sess-stopped')).toBeTruthy();
    });

    expect(screen.getByText('Stopped')).toBeTruthy();
  });

  it('always shows expand toggle for reference IDs', async () => {
    // Even sessions without branch, PR, or workspace still have reference IDs
    const session = { ...makeSession('sess-4', 'stopped'), workspaceId: null };
    const response = {
      session,
      messages: [makeMessage('m1', 'sess-4', 'Done')],
      hasMore: false,
    };
    mocks.getChatSession.mockResolvedValue(response);

    render(<ProjectMessageView projectId="proj-1" sessionId="sess-4" />);

    await waitFor(() => {
      expect(screen.getByText('Session sess-4')).toBeTruthy();
    });

    // Toggle should always exist — every session has at least a Session ID to display
    expect(screen.queryByRole('button', { name: /show session details/i })).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Session context dropdown — workspace & node info
// ---------------------------------------------------------------------------

describe('ProjectMessageView — session context dropdown', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows workspace and node details in expanded header', async () => {
    mocks.getWorkspace.mockResolvedValue({
      id: 'ws-ctx-1',
      name: 'my-workspace',
      displayName: 'My Workspace',
      status: 'running',
      vmSize: 'medium',
      vmLocation: 'fsn1',
      nodeId: 'node-ctx-1',
      url: 'https://ws-ctx-1.example.com',
    });
    mocks.getNode.mockResolvedValue({
      id: 'node-ctx-1',
      name: 'htz-fsn1-abc',
      status: 'active',
      healthStatus: 'healthy',
      cloudProvider: 'hetzner',
    });

    const session = makeSession('sess-ctx', 'active');
    mocks.getChatSession.mockResolvedValue({
      session,
      messages: [makeMessage('m1', 'sess-ctx', 'Hello')],
      hasMore: false,
    });

    render(<ProjectMessageView projectId="proj-1" sessionId="sess-ctx" />);

    await waitFor(() => {
      expect(screen.getByText('Session sess-ctx')).toBeTruthy();
    });

    // Expand the header
    const expandButton = screen.getByRole('button', { name: /show session details/i });
    fireEvent.click(expandButton);

    // Wait for workspace/node data to load and render
    await waitFor(() => {
      expect(screen.getByText('My Workspace')).toBeTruthy();
    });

    // Should show workspace info
    expect(screen.getByText('Workspace:')).toBeTruthy();
    // Workspace status "(running)" may appear alongside timing "(running)" — check at least one exists
    expect(screen.getAllByText('(running)').length).toBeGreaterThanOrEqual(1);

    // Should show VM size
    expect(screen.getByText('VM Size:')).toBeTruthy();
    expect(screen.getByText('Medium')).toBeTruthy();

    // Should show node info
    expect(screen.getByText('Node:')).toBeTruthy();
    expect(screen.getByText('htz-fsn1-abc')).toBeTruthy();
    expect(screen.getByText('(healthy)')).toBeTruthy();

    // Should show cloud provider with location combined
    expect(screen.getByText('Provider:')).toBeTruthy();
    // Provider and location are in the same row: "Hetzner" + "— fsn1"
    expect(screen.getByText(/Hetzner/)).toBeTruthy();
    expect(screen.getByText(/— fsn1/)).toBeTruthy();

    // Direct URL should NOT be shown (removed)
    expect(screen.queryByText('Direct URL:')).toBeNull();
  });

  it('shows lightweight badge for lightweight workspace profile', async () => {
    renderWorkspaceBadgeFixture('sess-light', {
      id: 'ws-light',
      name: 'light-ws',
      status: 'running',
      vmSize: 'small',
      workspaceProfile: 'lightweight',
    });

    // Wait for workspace data to load — the badge appears in the compact row
    await waitFor(() => {
      expect(screen.getByText('Lightweight')).toBeTruthy();
    });
  });

  it('shows full badge for full workspace profile', async () => {
    renderWorkspaceBadgeFixture('sess-full', {
      id: 'ws-full',
      name: 'full-ws',
      status: 'running',
      vmSize: 'large',
      workspaceProfile: 'full',
    });

    await waitFor(() => {
      expect(screen.getByText('Full')).toBeTruthy();
    });
  });

  it('shows full badge when workspaceProfile is null (default)', async () => {
    renderWorkspaceBadgeFixture('sess-null', {
      id: 'ws-null',
      name: 'null-ws',
      status: 'running',
      vmSize: 'medium',
      workspaceProfile: null,
    });

    await waitFor(() => {
      expect(screen.getByText('Full')).toBeTruthy();
    });
  });

  it('shows a recovery container badge with explanatory hover and tap text', async () => {
    renderWorkspaceBadgeFixture('sess-recovery', {
      id: 'ws-recovery',
      name: 'recovery-ws',
      status: 'recovery',
      vmSize: 'medium',
      workspaceProfile: 'full',
    });

    const badge = await screen.findByRole('button', {
      name: /recovery container: devcontainer build failed/i,
    });
    expect(screen.getByText('Recovery container')).toBeTruthy();
    expect(screen.queryByText('Full')).toBeNull();

    fireEvent.mouseEnter(badge);
    expect(screen.getByRole('tooltip').textContent).toContain('Boot Logs');
    expect(screen.getByRole('tooltip').textContent).toContain('fallback recovery container');

    fireEvent.mouseLeave(badge);
    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).toBeNull();
    });

    fireEvent.click(badge);
    expect(screen.getByRole('tooltip').textContent).toContain('devcontainer error output');
  });

  it('does not show context section when workspace fetch fails', async () => {
    mocks.getWorkspace.mockRejectedValue(new Error('Not found'));

    const session = makeSession('sess-err', 'active');
    mocks.getChatSession.mockResolvedValue({
      session,
      messages: [makeMessage('m1', 'sess-err', 'Hello')],
      hasMore: false,
    });

    render(<ProjectMessageView projectId="proj-1" sessionId="sess-err" />);

    await waitFor(() => {
      expect(screen.getByText('Session sess-err')).toBeTruthy();
    });

    // Expand the header
    const expandButton = screen.getByRole('button', { name: /show session details/i });
    fireEvent.click(expandButton);

    // Should show loading fallback, then settle to no workspace/node labels
    await waitFor(() => {
      expect(screen.queryByText('Workspace:')).toBeNull();
      expect(screen.queryByText('Node:')).toBeNull();
    });
  });

  it('falls back to workspace name when displayName is absent', async () => {
    mocks.getWorkspace.mockResolvedValue({
      id: 'ws-nodn',
      name: 'raw-workspace-name',
      // no displayName
      status: 'running',
      vmSize: 'medium',
      vmLocation: 'fsn1',
      nodeId: 'node-1',
    });
    mocks.getNode.mockResolvedValue({
      id: 'node-1',
      name: 'node-1',
      status: 'active',
      healthStatus: 'healthy',
    });

    const session = makeSession('sess-dn', 'active');
    mocks.getChatSession.mockResolvedValue({
      session,
      messages: [makeMessage('m1', 'sess-dn', 'Hello')],
      hasMore: false,
    });

    render(<ProjectMessageView projectId="proj-1" sessionId="sess-dn" />);

    await waitFor(() => {
      expect(screen.getByText('Session sess-dn')).toBeTruthy();
    });

    const expandButton = screen.getByRole('button', { name: /show session details/i });
    fireEvent.click(expandButton);

    // Should fall back to name when displayName is absent
    await waitFor(() => {
      expect(screen.getByText('raw-workspace-name')).toBeTruthy();
    });
  });

  it('shows workspace details without node when workspace has no nodeId', async () => {
    mocks.getWorkspace.mockResolvedValue({
      id: 'ws-nonode',
      name: 'standalone-ws',
      status: 'running',
      vmSize: 'small',
      vmLocation: 'hel1',
      // no nodeId
    });

    const session = makeSession('sess-nonode', 'active');
    mocks.getChatSession.mockResolvedValue({
      session,
      messages: [makeMessage('m1', 'sess-nonode', 'Hello')],
      hasMore: false,
    });

    render(<ProjectMessageView projectId="proj-1" sessionId="sess-nonode" />);

    await waitFor(() => {
      expect(screen.getByText('Session sess-nonode')).toBeTruthy();
    });

    const expandButton = screen.getByRole('button', { name: /show session details/i });
    fireEvent.click(expandButton);

    // Workspace details should appear
    await waitFor(() => {
      expect(screen.getByText('standalone-ws')).toBeTruthy();
    });
    expect(screen.getByText('Location:')).toBeTruthy();
    expect(screen.getByText('hel1')).toBeTruthy();

    // Node details should NOT appear — getNode was never called
    expect(screen.queryByText('Node:')).toBeNull();
    expect(mocks.getNode).not.toHaveBeenCalled();
  });

  it('shows workspace details but not node when getNode fails', async () => {
    mocks.getWorkspace.mockResolvedValue({
      id: 'ws-partial',
      name: 'partial-ws',
      status: 'running',
      vmSize: 'medium',
      vmLocation: 'fsn1',
      nodeId: 'node-fail',
    });
    mocks.getNode.mockRejectedValue(new Error('Node not found'));

    const session = makeSession('sess-partial', 'active');
    mocks.getChatSession.mockResolvedValue({
      session,
      messages: [makeMessage('m1', 'sess-partial', 'Hello')],
      hasMore: false,
    });

    render(<ProjectMessageView projectId="proj-1" sessionId="sess-partial" />);

    await waitFor(() => {
      expect(screen.getByText('Session sess-partial')).toBeTruthy();
    });

    const expandButton = screen.getByRole('button', { name: /show session details/i });
    fireEvent.click(expandButton);

    // Workspace details should still appear despite node failure
    await waitFor(() => {
      expect(screen.getByText('partial-ws')).toBeTruthy();
    });
    expect(screen.getByText('Workspace:')).toBeTruthy();
    expect(screen.getByText('VM Size:')).toBeTruthy();

    // Node details should NOT appear
    await waitFor(() => {
      expect(screen.queryByText('Node:')).toBeNull();
    });
  });
});

describe('ProjectMessageView — virtual scroll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorkspace.mockResolvedValue({ id: 'ws-test', name: 'test', status: 'running', vmSize: 'medium', vmLocation: 'fsn1' });
    mocks.getNode.mockResolvedValue({ id: 'node-test', name: 'node-test', status: 'active', healthStatus: 'healthy' });
  });

  it('renders messages via Virtuoso mock', async () => {
    mocks.getChatSession.mockResolvedValue(
      makeSessionResponse('session-1', [
        makeMessage('msg-1', 'session-1', 'First message'),
        makeMessage('msg-2', 'session-1', 'Second message'),
      ]),
    );

    render(<ProjectMessageView projectId="proj-1" sessionId="session-1" />);

    await waitFor(() => {
      // Both messages may be merged by chatMessagesToConversationItems since
      // they share the same role — check for presence within the rendered text
      expect(screen.getByTestId('virtuoso-scroller').textContent).toContain('First message');
      expect(screen.getByTestId('virtuoso-scroller').textContent).toContain('Second message');
    });

    // Verify Virtuoso mock is in the tree
    expect(screen.getByTestId('virtuoso-scroller')).toBeTruthy();
  });

  it('renders new WebSocket messages inside Virtuoso', async () => {
    mocks.getChatSession.mockResolvedValue(
      makeSessionResponse('session-1', [
        makeMessage('msg-1', 'session-1', 'First message'),
      ]),
    );

    render(<ProjectMessageView projectId="proj-1" sessionId="session-1" />);

    await waitFor(() => {
      expect(screen.getByText('First message')).toBeTruthy();
    });

    // Inject a new message via WebSocket
    expect(capturedWsOnMessage).toBeTruthy();
    await act(async () => {
      capturedWsOnMessage!(makeMessage('msg-2', 'session-1', 'WS message'));
    });

    // Messages may be merged by chatMessagesToConversationItems
    expect(screen.getByTestId('virtuoso-scroller').textContent).toContain('WS message');
  });

  it('renders "Load earlier messages" button when hasMore is true', async () => {
    mocks.getChatSession.mockResolvedValue({
      session: makeSession('session-1'),
      messages: [makeMessage('msg-1', 'session-1', 'Recent message')],
      hasMore: true,
    });

    render(<ProjectMessageView projectId="proj-1" sessionId="session-1" />);

    await waitFor(() => {
      expect(screen.getByText('Recent message')).toBeTruthy();
    });

    // The Virtuoso mock renders components.Header which contains the load-more button
    expect(screen.getByText('Load earlier messages')).toBeTruthy();
  });

  it('does not render "Load earlier messages" button when hasMore is false', async () => {
    mocks.getChatSession.mockResolvedValue(
      makeSessionResponse('session-1', [
        makeMessage('msg-1', 'session-1', 'Only message'),
      ]),
    );

    render(<ProjectMessageView projectId="proj-1" sessionId="session-1" />);

    await waitFor(() => {
      expect(screen.getByText('Only message')).toBeTruthy();
    });

    expect(screen.queryByText('Load earlier messages')).toBeNull();
  });

  it('clicking "Load earlier messages" prepends older messages', async () => {
    mocks.getChatSession
      .mockResolvedValueOnce({
        session: makeSession('session-1'),
        messages: [makeMessage('msg-2', 'session-1', 'Recent message')],
        hasMore: true,
      })
      .mockResolvedValueOnce({
        session: makeSession('session-1'),
        messages: [makeMessage('msg-1', 'session-1', 'Older message')],
        hasMore: false,
      });

    render(<ProjectMessageView projectId="proj-1" sessionId="session-1" />);

    await waitFor(() => {
      expect(screen.getByText('Recent message')).toBeTruthy();
    });

    // Click the load-more button
    const loadMoreBtn = screen.getByText('Load earlier messages');
    await act(async () => {
      fireEvent.click(loadMoreBtn);
    });

    // Second call should use 'before' pagination
    await waitFor(() => {
      expect(mocks.getChatSession).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('virtuoso-scroller').textContent).toContain('Older message');
      expect(screen.getByTestId('virtuoso-scroller').textContent).toContain('Recent message');
    });
  });

  it('renders messages from new session after session switch', async () => {
    mocks.getChatSession.mockResolvedValue(
      makeSessionResponse('session-A', [
        makeMessage('msg-a1', 'session-A', 'Session A message'),
      ]),
    );

    const { rerender } = render(<ProjectMessageView projectId="proj-1" sessionId="session-A" />);

    await waitFor(() => {
      expect(screen.getByText('Session A message')).toBeTruthy();
    });

    // Switch to a new session
    mocks.getChatSession.mockResolvedValue(
      makeSessionResponse('session-B', [
        makeMessage('msg-b1', 'session-B', 'Session B message'),
      ]),
    );
    rerender(<ProjectMessageView projectId="proj-1" sessionId="session-B" />);

    await waitFor(() => {
      expect(screen.getByText('Session B message')).toBeTruthy();
    });
  });
});

// ===========================================================================
// Regression test: messages must survive onCatchUp with 'replace' strategy.
// This is the test that would have caught the bug introduced in c64ee4c7.
// See docs/notes/2026-03-23-disappearing-messages-postmortem.md
// ===========================================================================

describe('ProjectMessageView — catch-up race regression', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    mocks.getWorkspace.mockResolvedValue({ id: 'ws-test', name: 'test', status: 'running', vmSize: 'medium', vmLocation: 'fsn1' });
    mocks.getNode.mockResolvedValue({ id: 'node-test', name: 'node-test', status: 'active', healthStatus: 'healthy' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('messages from loadSession persist even if onCatchUp fires with replace strategy', async () => {
    // This test simulates what happens if the wasReconnect guard is removed:
    // loadSession loads messages, then onCatchUp fires with a different/empty
    // set and replaces them. The user sees messages disappear.
    // Use alternating roles so chatMessagesToConversationItems does not merge them
    const fullMessages = [
      { ...makeMessage('msg-1', 'session-1', 'First message from user'), role: 'user' },
      makeMessage('msg-2', 'session-1', 'Agent response with details'),
      { ...makeMessage('msg-3', 'session-1', 'Follow-up question'), role: 'user' },
    ];

    mocks.getChatSession.mockResolvedValue({
      session: makeSession('session-1'),
      messages: fullMessages,
      hasMore: false,
    });

    render(<ProjectMessageView projectId="proj-1" sessionId="session-1" />);

    // Wait for loadSession to complete and messages to display
    await waitFor(() => {
      expect(screen.getByText('First message from user')).toBeTruthy();
      expect(screen.getByText('Agent response with details')).toBeTruthy();
      expect(screen.getByText('Follow-up question')).toBeTruthy();
    });

    // Simulate what onCatchUp does with the same data (normal case)
    // This verifies that even if catch-up fires, messages with the same
    // data survive the 'replace' merge strategy
    expect(capturedWsOnCatchUp).not.toBeNull();
    act(() => {
      capturedWsOnCatchUp!(
        fullMessages,
        makeSession('session-1'),
      );
    });

    // Messages must still be visible after catch-up with same data
    expect(screen.getByText('First message from user')).toBeTruthy();
    expect(screen.getByText('Agent response with details')).toBeTruthy();
    expect(screen.getByText('Follow-up question')).toBeTruthy();
  });

  it('onCatchUp with empty messages preserves existing display (replace strategy keeps earlier messages)', async () => {
    // After the fix for the load-more regression, the replace strategy
    // preserves messages older than the incoming window. When incoming
    // is empty (oldest = Infinity), all existing messages are preserved.
    const fullMessages = [
      makeMessage('msg-1', 'session-1', 'Important conversation'),
    ];

    mocks.getChatSession.mockResolvedValue({
      session: makeSession('session-1'),
      messages: fullMessages,
      hasMore: false,
    });

    render(<ProjectMessageView projectId="proj-1" sessionId="session-1" />);

    await waitFor(() => {
      expect(screen.getByText('Important conversation')).toBeTruthy();
    });

    // Simulate onCatchUp with EMPTY messages
    expect(capturedWsOnCatchUp).not.toBeNull();
    act(() => {
      capturedWsOnCatchUp!(
        [],
        makeSession('session-1'),
      );
    });

    // Messages are preserved — empty incoming does not wipe earlier messages
    expect(screen.getByText('Important conversation')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Cancel button — agent working indicator
// ---------------------------------------------------------------------------

describe('ProjectMessageView — cancel button', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    mocks.getWorkspace.mockResolvedValue({ id: 'ws-test', name: 'test', status: 'running', vmSize: 'medium', vmLocation: 'fsn1' });
    mocks.getNode.mockResolvedValue({ id: 'node-test', name: 'node-test', status: 'active', healthStatus: 'healthy' });
    mocks.cancelAgentPrompt.mockResolvedValue({ status: 'cancelled', message: 'Prompt cancel signal sent' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows cancel button when agent is working and calls cancelAgentPrompt on click', async () => {
    mocks.getChatSession.mockResolvedValue(
      makeSessionResponse('session-1', [
        makeMessage('msg-1', 'session-1', 'Working on it'),
      ]),
    );

    render(<ProjectMessageView projectId="proj-1" sessionId="session-1" />);

    await waitFor(() => {
      expect(screen.getByText('Working on it')).toBeTruthy();
    });

    // Initially no working morph — the dock's Interrupt control is absent
    expect(screen.queryByRole('button', { name: 'Interrupt agent' })).toBeNull();

    // Inject an assistant message via WebSocket to trigger 'responding' state
    expect(capturedWsOnMessage).toBeTruthy();
    await act(async () => {
      capturedWsOnMessage!(makeMessage('msg-2', 'session-1', 'Still working'));
    });

    // Now the dock morphs to the working state — a red Interrupt control appears
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Interrupt agent' })).toBeTruthy();
    });
    const cancelButton = screen.getByRole('button', { name: 'Interrupt agent' });
    expect(cancelButton).toBeTruthy();

    // Click interrupt
    await act(async () => {
      fireEvent.click(cancelButton);
    });

    // Verify cancelAgentPrompt was called with the right args
    expect(mocks.cancelAgentPrompt).toHaveBeenCalledWith('proj-1', 'session-1');

    // After successful cancel, the working morph disappears (agent goes idle)
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Interrupt agent' })).toBeNull();
    });
  });
});

describe('ProjectMessageView — inline idle indicator', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    mocks.getWorkspace.mockResolvedValue({ id: 'ws-test', name: 'test', status: 'running', vmSize: 'medium', vmLocation: 'fsn1' });
    mocks.getNode.mockResolvedValue({ id: 'node-test', name: 'node-test', status: 'active', healthStatus: 'healthy' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows Archive control for idle conversation-mode session with onCloseConversation', async () => {
    const session = {
      ...makeSession('sess-idle', 'active'),
      isIdle: true,
      task: {
        id: 'task-conv',
        status: 'in_progress',
        taskMode: 'conversation' as const,
        executionStep: null,
        errorMessage: null,
        outputBranch: null,
        outputPrUrl: null,
        outputSummary: null,
        finalizedAt: null,
      },
    };
    mocks.getChatSession.mockResolvedValue({
      session,
      messages: [makeMessage('m1', 'sess-idle', 'Hello')],
      hasMore: false,
    });

    const onClose = vi.fn();
    render(
      <ProjectMessageView
        projectId="proj-1"
        sessionId="sess-idle"
        onCloseConversation={onClose}
      />,
    );

    // Idle conversation-mode dock morphs to the grey Archive control
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Archive conversation' })).toBeTruthy();
    });
    // Working morph is absent while idle
    expect(screen.queryByRole('button', { name: 'Interrupt agent' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Archive conversation' }));
    expect(screen.getByRole('dialog', { name: 'Archive conversation?' })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Archive Conversation' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });


  it('keeps complete-and-delete behind confirmation and surfaces completion errors', async () => {
    const session = {
      ...makeSession('sess-complete-error', 'active'),
      task: {
        id: 'task-complete-error',
        status: 'in_progress',
        taskMode: 'task' as const,
        executionStep: null,
        errorMessage: null,
        outputBranch: null,
        outputPrUrl: null,
        outputSummary: null,
        finalizedAt: null,
      },
    };
    mocks.getChatSession.mockResolvedValue({
      session,
      messages: [makeMessage('m1', 'sess-complete-error', 'Working summary')],
      hasMore: false,
    });
    mocks.updateProjectTaskStatus.mockRejectedValueOnce(new Error('Task transition denied'));
    const onSessionMutated = vi.fn();

    render(
      <ProjectMessageView
        projectId="proj-1"
        sessionId="sess-complete-error"
        onSessionMutated={onSessionMutated}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Show session details' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Show session details' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Complete' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Complete' }));
    expect(screen.getByRole('dialog', { name: 'Mark task as complete?' })).toBeTruthy();
    expect(mocks.updateProjectTaskStatus).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Complete & Delete' }));

    await waitFor(() => {
      expect(screen.getByText('Task transition denied')).toBeTruthy();
    });
    expect(mocks.updateProjectTaskStatus).toHaveBeenCalledWith('proj-1', 'task-complete-error', { toStatus: 'completed' });
    expect(mocks.deleteWorkspace).not.toHaveBeenCalled();
    expect(onSessionMutated).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Mark task as complete?' })).toBeNull();
  });

  it('does NOT show Archive control for idle task-mode session', async () => {
    const session = {
      ...makeSession('sess-task', 'active'),
      isIdle: true,
      task: {
        id: 'task-auto',
        status: 'in_progress',
        taskMode: 'task' as const,
        executionStep: null,
        errorMessage: null,
        outputBranch: null,
        outputPrUrl: null,
        outputSummary: null,
        finalizedAt: null,
      },
    };
    mocks.getChatSession.mockResolvedValue({
      session,
      messages: [makeMessage('m1', 'sess-task', 'Hello')],
      hasMore: false,
    });

    render(
      <ProjectMessageView
        projectId="proj-1"
        sessionId="sess-task"
        onCloseConversation={vi.fn()}
      />,
    );

    // Wait for session to load
    await waitFor(() => {
      expect(screen.getByText('Session sess-task')).toBeTruthy();
    });

    // The dock's Archive control must never appear for task-mode idle sessions
    expect(screen.queryByRole('button', { name: 'Archive conversation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Interrupt agent' })).toBeNull();
  });

  it('shows Archive control for active conversation-mode session (always-mounted morph)', async () => {
    const session = {
      ...makeSession('sess-active', 'active'),
      isIdle: false,
      task: {
        id: 'task-conv-2',
        status: 'in_progress',
        taskMode: 'conversation' as const,
        executionStep: null,
        errorMessage: null,
        outputBranch: null,
        outputPrUrl: null,
        outputSummary: null,
        finalizedAt: null,
      },
    };
    mocks.getChatSession.mockResolvedValue({
      session,
      messages: [makeMessage('m1', 'sess-active', 'Hello')],
      hasMore: false,
    });

    render(
      <ProjectMessageView
        projectId="proj-1"
        sessionId="sess-active"
        onCloseConversation={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Session sess-active')).toBeTruthy();
    });

    // The dock stays mounted for conversation-mode while active; with the agent
    // idle it shows the grey Archive morph (not the working Interrupt).
    expect(screen.getByRole('button', { name: 'Archive conversation' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Interrupt agent' })).toBeNull();
  });

  it('renders error banner with glass-chrome styling when task has errorMessage', async () => {
    const session = {
      ...makeSession('sess-err'),
      task: {
        id: 'task-err',
        title: 'Broken task',
        status: 'failed',
        executionStep: null,
        outputBranch: null,
        outputPrUrl: null,
        outputSummary: null,
        errorMessage: 'Node provisioning failed',
        finalizedAt: Date.now(),
      },
    };
    const response = {
      session,
      messages: [makeMessage('m1', 'sess-err', 'Starting work...')],
      hasMore: false,
    };
    mocks.getChatSession.mockResolvedValue(response);

    const { container } = render(
      <ProjectMessageView projectId="proj-1" sessionId="sess-err" />,
    );

    await waitFor(() => {
      expect(screen.getByText('Task failed:')).toBeTruthy();
    });

    // Error banner should have glass-chrome styling
    const errorBanner = screen.getByText('Node provisioning failed').closest('div');
    expect(errorBanner).toBeTruthy();
    expect(errorBanner!.className).toContain('glass-chrome');
    // glass-composited removed — its transform: translateZ(0) broke backdrop-filter blur

    // SessionHeader should have hasContentBelow (no rounded-b-2xl)
    const headerEl = container.querySelector('.glass-chrome.border-t-0');
    expect(headerEl).toBeTruthy();
    expect(headerEl!.className).not.toContain('rounded-b-2xl');
  });
});

describe('ProjectMessageView — timeline jump-to-message', () => {
  function makeUserMessage(id: string, sessionId: string, content: string, createdAt: number) {
    return { id, sessionId, role: 'user' as const, content, toolMetadata: null, createdAt, sequence: null };
  }
  function makeAgentMessage(id: string, sessionId: string, content: string, createdAt: number) {
    return { id, sessionId, role: 'assistant' as const, content, toolMetadata: null, createdAt, sequence: null };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    virtuosoMock.scrollToIndexCalls.length = 0;
    mocks.getWorkspace.mockResolvedValue({ id: 'ws-test', name: 'test', status: 'running', vmSize: 'medium', vmLocation: 'fsn1' });
    mocks.getNode.mockResolvedValue({ id: 'node-test', name: 'node-test', status: 'active', healthStatus: 'healthy' });
    mocks.listActivityEvents.mockResolvedValue({ events: [] });
    mocks.listNotifications.mockResolvedValue({ notifications: [], nextCursor: null });
  });

  // Regression: clicking a timeline entry must scroll the chat to that message.
  // itemIndexById previously stored `firstItemIndex + i` (absolute ≈ VIRTUAL_START
  // + i ≈ 100000) and passed it to Virtuoso's scrollToIndex, which expects the
  // 0-BASED data index. The out-of-range value never scrolled, so on a real
  // virtualized session the target row stayed unmounted and the highlight never
  // rendered — a dead click. jsdom renders every row, so a highlight-presence
  // assertion would pass despite the bug; asserting the scrollToIndex ARGUMENT is
  // what catches it.
  it('scrolls Virtuoso to the target message using its 0-based index (not the firstItemIndex offset)', async () => {
    const sid = 'session-jump';
    // Order matters: user message sits at 0-based conversation index 1 (between two
    // agent messages), so the correct index (1) is unambiguously different from the
    // buggy absolute value (VIRTUAL_START + 1 = 100001).
    const messages = [
      makeAgentMessage('a0', sid, 'agent intro', 1000),
      makeUserMessage('user-jump-1', sid, 'JUMPME', 2000),
      makeAgentMessage('a2', sid, 'agent reply', 3000),
    ];
    mocks.getChatSession.mockResolvedValue({ session: makeSession(sid, 'active'), messages, hasMore: false });
    // Timeline fetches user messages independently (roles=['user']).
    mocks.listChatMessages.mockResolvedValue({
      messages: [makeUserMessage('user-jump-1', sid, 'JUMPME', 2000)],
      hasMore: false,
    });

    render(<ProjectMessageView projectId="proj-1" sessionId={sid} />);

    // Wait for the conversation to load.
    await waitFor(() => {
      expect(screen.getByTestId('virtuoso-scroller').textContent).toContain('JUMPME');
    });

    // Expand the session header, then open the Timeline drawer.
    fireEvent.click(screen.getByRole('button', { name: 'Show session details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Timeline' }));

    const drawer = await screen.findByRole('dialog', { name: 'Session timeline' });

    // The user-message timeline entry.
    const entry = await waitFor(() => {
      const btn = within(drawer).getAllByRole('button').find((b) => /JUMPME/.test(b.textContent ?? ''));
      expect(btn).toBeTruthy();
      return btn!;
    });

    fireEvent.click(entry);

    // The component must ask Virtuoso to scroll to the 0-based data index (1),
    // NOT the firstItemIndex-offset absolute value.
    await waitFor(() => {
      expect(virtuosoMock.scrollToIndexCalls.length).toBeGreaterThan(0);
    });
    const indices = virtuosoMock.scrollToIndexCalls.map((c) =>
      typeof c === 'number' ? c : c.index,
    );
    expect(indices).toContain(1);
    // Guard against the regression: no call may use the absolute VIRTUAL_START coordinate.
    for (const idx of indices) {
      expect(typeof idx === 'number' ? idx : Number(idx)).toBeLessThan(1000);
    }
  });
});
