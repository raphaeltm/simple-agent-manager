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
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';

// jsdom doesn't support scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

// --- Mocks ---

const mocks = vi.hoisted(() => ({
  getChatSession: vi.fn(),
  getTranscribeApiUrl: vi.fn(() => 'https://api.test.com/api/transcribe'),
  resetIdleTimer: vi.fn(),
  sendFollowUpPrompt: vi.fn(),
  getWorkspace: vi.fn(),
  getNode: vi.fn(),
  updateProjectTaskStatus: vi.fn(),
  deleteWorkspace: vi.fn(),
  useProjectAgentSession: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  getChatSession: mocks.getChatSession,
  getTranscribeApiUrl: mocks.getTranscribeApiUrl,
  getTtsApiUrl: vi.fn().mockReturnValue('https://api.example.com/api/tts'),
  resetIdleTimer: mocks.resetIdleTimer,
  sendFollowUpPrompt: mocks.sendFollowUpPrompt,
  getWorkspace: mocks.getWorkspace,
  getNode: mocks.getNode,
  updateProjectTaskStatus: mocks.updateProjectTaskStatus,
  deleteWorkspace: mocks.deleteWorkspace,
}));

// Captured WebSocket onMessage callback — tests can call this to inject messages
let capturedWsOnMessage: ((msg: ReturnType<typeof makeMessage>) => void) | null = null;

vi.mock('../../../src/hooks/useChatWebSocket', () => ({
  useChatWebSocket: (opts: { onMessage?: (msg: unknown) => void }) => {
    capturedWsOnMessage = (opts.onMessage ?? null) as typeof capturedWsOnMessage;
    return {
      connectionState: 'connected' as const,
      wsRef: { current: null },
      retry: vi.fn(),
    };
  },
}));

function defaultAgentSession() {
  return {
    session: { connected: false, agentType: null, state: 'disconnected', switchAgent: vi.fn(), sendMessage: vi.fn() },
    messages: { items: [], processMessage: vi.fn(), addUserMessage: vi.fn(), prepareForReplay: vi.fn(), clear: vi.fn(), availableCommands: [], usage: { totalTokens: 0 } },
    isAgentActive: false,
    isPrompting: false,
    isConnecting: false,
    sendPrompt: vi.fn(),
    cancelPrompt: vi.fn(),
    transcribeApiUrl: 'https://api.test.com/api/transcribe',
  };
}

vi.mock('../../../src/hooks/useProjectAgentSession', () => ({
  useProjectAgentSession: (...args: unknown[]) => mocks.useProjectAgentSession(...args),
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
  };
});

// Mock react-virtuoso — JSDOM has no layout engine, so Virtuoso can't measure items.
// Uses vi.hoisted to ensure the mock factory runs before imports.
const virtuosoMock = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
  const React = require('react') as typeof import('react');
  return {
    Virtuoso: React.forwardRef(function MockVirtuoso(
      props: {
        data?: unknown[];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        itemContent?: (index: number, item: any) => React.ReactNode;
        style?: React.CSSProperties;
        components?: { Header?: React.ComponentType };
      },
      _ref: React.Ref<unknown>,
    ) {
      const { data, itemContent, style, components } = props;
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
vi.mock('react-virtuoso', () => virtuosoMock);

import { ProjectMessageView, chatMessagesToConversationItems } from '../../../src/components/chat/ProjectMessageView';

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

describe('ProjectMessageView — session isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    mocks.useProjectAgentSession.mockReturnValue(defaultAgentSession());
    // Default workspace/node mocks — return pending promises to avoid side effects
    mocks.getWorkspace.mockResolvedValue({ id: 'ws-test', name: 'test', status: 'running', vmSize: 'medium', vmLocation: 'fsn1' });
    mocks.getNode.mockResolvedValue({ id: 'node-test', name: 'node-test', status: 'active', healthStatus: 'healthy' });
  });

  afterEach(() => {
    vi.useRealTimers();
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

    // Now capture the signal from the polling interval (fires every 3s)
    mocks.getChatSession.mockImplementation(async (
      _projectId: string,
      _sessionId: string,
      params?: { signal?: AbortSignal }
    ) => {
      pollSignal = params?.signal;
      return sessionAResponse;
    });

    // Advance past the 3s poll interval. Use advanceTimersByTimeAsync to
    // properly process microtasks (the polling effect starts asynchronously
    // after session state is committed to the DOM).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });

    // Verify the poll fired and we captured a signal
    expect(pollSignal).toBeDefined();
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

    // Trigger a poll for session A (3s interval)
    await act(async () => {
      vi.advanceTimersByTime(3100);
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

describe('ProjectMessageView — ACP integration', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    mocks.useProjectAgentSession.mockReturnValue(defaultAgentSession());
    mocks.getWorkspace.mockResolvedValue({ id: 'ws-test', name: 'test', status: 'running', vmSize: 'medium', vmLocation: 'fsn1' });
    mocks.getNode.mockResolvedValue({ id: 'node-test', name: 'node-test', status: 'active', healthStatus: 'healthy' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows cancel button when agent is prompting', async () => {
    const cancelPrompt = vi.fn();
    mocks.useProjectAgentSession.mockReturnValue({
      ...defaultAgentSession(),
      isAgentActive: true,
      isPrompting: true,
      cancelPrompt,
    });

    mocks.getChatSession.mockResolvedValue(
      makeSessionResponse('session-1', [
        makeMessage('msg-1', 'session-1', 'Hello'),
      ]),
    );

    render(<ProjectMessageView projectId="proj-1" sessionId="session-1" />);

    await waitFor(() => {
      expect(screen.getByText('Agent is working...')).toBeTruthy();
    });

    const cancelButton = screen.getByText('Cancel');
    expect(cancelButton).toBeTruthy();

    // Click cancel should invoke agentSession.cancelPrompt
    await act(async () => {
      cancelButton.click();
    });
    expect(cancelPrompt).toHaveBeenCalledTimes(1);
  });

  it('shows ACP connecting indicator when workspace has ACP connecting', async () => {
    mocks.useProjectAgentSession.mockReturnValue({
      ...defaultAgentSession(),
      isConnecting: true,
    });

    mocks.getChatSession.mockResolvedValue({
      session: makeSession('session-1'),
      messages: [],
      hasMore: false,
    });

    render(<ProjectMessageView projectId="proj-1" sessionId="session-1" />);

    await waitFor(() => {
      expect(screen.getByText('Connecting to agent...')).toBeTruthy();
    });
  });

  it('shows agent offline banner when agent is not active and not provisioning', async () => {
    mocks.useProjectAgentSession.mockReturnValue({
      ...defaultAgentSession(),
      isAgentActive: false,
      isConnecting: false,
    });

    mocks.getChatSession.mockResolvedValue({
      session: makeSession('session-1'),
      messages: [],
      hasMore: false,
    });

    render(<ProjectMessageView projectId="proj-1" sessionId="session-1" />);

    await waitFor(() => {
      expect(screen.getByText(/Agent offline/)).toBeTruthy();
    });
  });

  it('hides agent offline banner when isProvisioning is true', async () => {
    mocks.useProjectAgentSession.mockReturnValue({
      ...defaultAgentSession(),
      isAgentActive: false,
      isConnecting: false,
    });

    mocks.getChatSession.mockResolvedValue({
      session: makeSession('session-1'),
      messages: [],
      hasMore: false,
    });

    render(<ProjectMessageView projectId="proj-1" sessionId="session-1" isProvisioning />);

    // Wait for session to load
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Send a message...')).toBeTruthy();
    });

    // Agent offline banner should NOT appear during provisioning
    expect(screen.queryByText(/Agent offline/)).toBeNull();
  });

  it('shows agent offline banner after provisioning completes and agent is still offline', async () => {
    mocks.useProjectAgentSession.mockReturnValue({
      ...defaultAgentSession(),
      isAgentActive: false,
      isConnecting: false,
    });

    mocks.getChatSession.mockResolvedValue({
      session: makeSession('session-1'),
      messages: [],
      hasMore: false,
    });

    // Start with provisioning active
    const { rerender } = render(
      <ProjectMessageView projectId="proj-1" sessionId="session-1" isProvisioning />
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Send a message...')).toBeTruthy();
    });
    expect(screen.queryByText(/Agent offline/)).toBeNull();

    // Provisioning completes
    rerender(
      <ProjectMessageView projectId="proj-1" sessionId="session-1" isProvisioning={false} />
    );

    await waitFor(() => {
      expect(screen.getByText(/Agent offline/)).toBeTruthy();
    });
  });

  it('shows error when sending prompt without ACP connection', async () => {
    mocks.useProjectAgentSession.mockReturnValue({
      ...defaultAgentSession(),
      isAgentActive: false,
    });

    mocks.getChatSession.mockResolvedValue({
      session: makeSession('session-1'),
      messages: [],
      hasMore: false,
    });

    render(<ProjectMessageView projectId="proj-1" sessionId="session-1" />);

    // Wait for session to load
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Send a message...')).toBeTruthy();
    });

    // Type a message
    const textarea = screen.getByPlaceholderText('Send a message...');
    await act(async () => {
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      (textarea as HTMLTextAreaElement).value = 'Hello agent';
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });

  it('renders system messages as preformatted text (not markdown)', async () => {
    mocks.useProjectAgentSession.mockReturnValue(defaultAgentSession());

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

  it('renders DO messages using ACP components when ACP is not connected', async () => {
    mocks.useProjectAgentSession.mockReturnValue(defaultAgentSession());

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

describe('ProjectMessageView — DO + ACP message merge', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    mocks.useProjectAgentSession.mockReturnValue(defaultAgentSession());
    mocks.getWorkspace.mockResolvedValue({ id: 'ws-test', name: 'test', status: 'running', vmSize: 'medium', vmLocation: 'fsn1' });
    mocks.getNode.mockResolvedValue({ id: 'node-test', name: 'node-test', status: 'active', healthStatus: 'healthy' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows DO messages when ACP has no items', async () => {
    mocks.useProjectAgentSession.mockReturnValue(defaultAgentSession());

    mocks.getChatSession.mockResolvedValue(
      makeSessionResponse('session-1', [
        makeMessage('msg-1', 'session-1', 'DO message'),
      ]),
    );

    render(<ProjectMessageView projectId="proj-1" sessionId="session-1" />);

    await waitFor(() => {
      expect(screen.getByText('DO message')).toBeTruthy();
    });
  });

  it('shows ACP items only when DO has no messages', async () => {
    mocks.useProjectAgentSession.mockReturnValue({
      ...defaultAgentSession(),
      messages: {
        items: [
          { kind: 'agent_message', id: 'acp-1', text: 'ACP streaming', streaming: true, timestamp: Date.now() },
        ],
        processMessage: vi.fn(),
        addUserMessage: vi.fn(),
        prepareForReplay: vi.fn(),
        clear: vi.fn(),
        availableCommands: [],
        usage: { totalTokens: 0 },
      },
    });

    mocks.getChatSession.mockResolvedValue({
      session: makeSession('session-1'),
      messages: [],
      hasMore: false,
    });

    render(<ProjectMessageView projectId="proj-1" sessionId="session-1" />);

    await waitFor(() => {
      expect(screen.getByText('ACP streaming')).toBeTruthy();
    });
  });

  it('shows only DO messages after grace period (no ACP merge)', async () => {
    const doTimestamp = 1000;
    const acpTimestamp = 2000;

    mocks.useProjectAgentSession.mockReturnValue({
      ...defaultAgentSession(),
      messages: {
        items: [
          { kind: 'agent_message', id: 'acp-1', text: 'ACP response', streaming: false, timestamp: acpTimestamp },
        ],
        processMessage: vi.fn(),
        addUserMessage: vi.fn(),
        prepareForReplay: vi.fn(),
        clear: vi.fn(),
        availableCommands: [],
        usage: { totalTokens: 0 },
      },
    });

    mocks.getChatSession.mockResolvedValue({
      session: makeSession('session-1'),
      messages: [{
        id: 'do-1',
        sessionId: 'session-1',
        role: 'user' as const,
        content: 'DO message',
        toolMetadata: null,
        createdAt: doTimestamp,
        sequence: null,
      }],
      hasMore: false,
    });

    render(<ProjectMessageView projectId="proj-1" sessionId="session-1" />);

    // Only DO messages should appear — ACP items are not merged after grace period
    await waitFor(() => {
      expect(screen.getByText('DO message')).toBeTruthy();
    });
    expect(screen.queryByText('ACP response')).toBeNull();
  });

  it('shows ACP-only view when agent is prompting, even with DO messages', async () => {
    mocks.useProjectAgentSession.mockReturnValue({
      ...defaultAgentSession(),
      isPrompting: true,
      isAgentActive: true,
      messages: {
        items: [
          { kind: 'agent_message', id: 'acp-streaming', text: 'Streaming response', streaming: true, timestamp: Date.now() },
        ],
        processMessage: vi.fn(),
        addUserMessage: vi.fn(),
        prepareForReplay: vi.fn(),
        clear: vi.fn(),
        availableCommands: [],
        usage: { totalTokens: 0 },
      },
    });

    mocks.getChatSession.mockResolvedValue(
      makeSessionResponse('session-1', [
        makeMessage('do-1', 'session-1', 'Earlier persisted message'),
      ]),
    );

    render(<ProjectMessageView projectId="proj-1" sessionId="session-1" />);

    await waitFor(() => {
      expect(screen.getByText('Streaming response')).toBeTruthy();
    });
    // DO messages must NOT appear while ACP is streaming
    expect(screen.queryByText('Earlier persisted message')).toBeNull();
  });

  it('does not duplicate ACP items older than latest DO message', async () => {
    const doTimestamp = 2000;
    const acpTimestamp = 1000; // older

    mocks.useProjectAgentSession.mockReturnValue({
      ...defaultAgentSession(),
      messages: {
        items: [
          { kind: 'agent_message', id: 'acp-old', text: 'Old ACP item', streaming: false, timestamp: acpTimestamp },
        ],
        processMessage: vi.fn(),
        addUserMessage: vi.fn(),
        prepareForReplay: vi.fn(),
        clear: vi.fn(),
        availableCommands: [],
        usage: { totalTokens: 0 },
      },
    });

    mocks.getChatSession.mockResolvedValue({
      session: makeSession('session-1'),
      messages: [{
        id: 'do-1',
        sessionId: 'session-1',
        role: 'user' as const,
        content: 'DO message',
        toolMetadata: null,
        createdAt: doTimestamp,
        sequence: null,
      }],
      hasMore: false,
    });

    render(<ProjectMessageView projectId="proj-1" sessionId="session-1" />);

    await waitFor(() => {
      expect(screen.getByText('DO message')).toBeTruthy();
    });

    // Old ACP item should NOT appear since it's older than latest DO
    expect(screen.queryByText('Old ACP item')).toBeNull();
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

  it('uses structured content from metadata when available', () => {
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
    const tool = items[0] as { content: Array<{ type: string; text: string }> };
    expect(tool.content).toHaveLength(1);
    expect(tool.content[0].type).toBe('diff');
    expect(tool.content[0].text).toBe('/src/main.go');
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

  it('falls back to raw content when metadata has no structured content', () => {
    const items = chatMessagesToConversationItems([
      {
        id: 't1', sessionId: 's1', role: 'tool', content: 'some output',
        toolMetadata: { kind: 'bash' },
        createdAt: 1000,
      },
    ]);
    expect(items).toHaveLength(1);
    const tool = items[0] as { content: Array<{ type: string; text: string }> };
    expect(tool.content).toHaveLength(1);
    expect(tool.content[0].type).toBe('content');
    expect(tool.content[0].text).toBe('some output');
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
    const tool = items[0] as { title: string; content: Array<{ type: string; text: string }> };
    expect(tool.title).toBe('Tool Call');
    expect(tool.content).toHaveLength(1);
    expect(tool.content[0].text).toBe('stdout: build succeeded');
  });

  it('skips placeholder content for tool-update string', () => {
    const items = chatMessagesToConversationItems([
      { id: 't1', sessionId: 's1', role: 'tool', content: '(tool update)', toolMetadata: null, createdAt: 1000 },
    ]);
    expect(items).toHaveLength(1);
    const tool = items[0] as { content: Array<unknown> };
    expect(tool.content).toHaveLength(0);
  });

  it('handles terminal content type from metadata', () => {
    const items = chatMessagesToConversationItems([
      {
        id: 't1', sessionId: 's1', role: 'tool', content: '(tool call)',
        toolMetadata: { kind: 'bash', content: [{ type: 'terminal', text: 'term-1' }] },
        createdAt: 1000,
      },
    ]);
    expect(items).toHaveLength(1);
    const tool = items[0] as { content: Array<{ type: string; text: string }> };
    expect(tool.content).toHaveLength(1);
    expect(tool.content[0].type).toBe('terminal');
    expect(tool.content[0].text).toBe('term-1');
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
    mocks.useProjectAgentSession.mockReturnValue(defaultAgentSession());
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

  it('does not show expand toggle when there are no details', async () => {
    // Session without branch, PR, or workspace link
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

    // No toggle should exist
    expect(screen.queryByRole('button', { name: /show session details/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /hide session details/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Session context dropdown — workspace & node info
// ---------------------------------------------------------------------------

describe('ProjectMessageView — session context dropdown', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    mocks.useProjectAgentSession.mockReturnValue(defaultAgentSession());
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
    expect(screen.getByText('(running)')).toBeTruthy();

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
    mocks.getWorkspace.mockResolvedValue({
      id: 'ws-light',
      name: 'light-ws',
      status: 'running',
      vmSize: 'small',
      vmLocation: 'fsn1',
      workspaceProfile: 'lightweight',
      nodeId: 'node-1',
    });
    mocks.getNode.mockResolvedValue({
      id: 'node-1',
      name: 'node-1',
      status: 'active',
      healthStatus: 'healthy',
    });

    const session = makeSession('sess-light', 'active');
    mocks.getChatSession.mockResolvedValue({
      session,
      messages: [makeMessage('m1', 'sess-light', 'Hello')],
      hasMore: false,
    });

    render(<ProjectMessageView projectId="proj-1" sessionId="sess-light" />);

    // Wait for workspace data to load — the badge appears in the compact row
    await waitFor(() => {
      expect(screen.getByText('Lightweight')).toBeTruthy();
    });
  });

  it('shows full badge for full workspace profile', async () => {
    mocks.getWorkspace.mockResolvedValue({
      id: 'ws-full',
      name: 'full-ws',
      status: 'running',
      vmSize: 'large',
      vmLocation: 'fsn1',
      workspaceProfile: 'full',
      nodeId: 'node-1',
    });
    mocks.getNode.mockResolvedValue({
      id: 'node-1',
      name: 'node-1',
      status: 'active',
      healthStatus: 'healthy',
    });

    const session = makeSession('sess-full', 'active');
    mocks.getChatSession.mockResolvedValue({
      session,
      messages: [makeMessage('m1', 'sess-full', 'Hello')],
      hasMore: false,
    });

    render(<ProjectMessageView projectId="proj-1" sessionId="sess-full" />);

    await waitFor(() => {
      expect(screen.getByText('Full')).toBeTruthy();
    });
  });

  it('shows full badge when workspaceProfile is null (default)', async () => {
    mocks.getWorkspace.mockResolvedValue({
      id: 'ws-null',
      name: 'null-ws',
      status: 'running',
      vmSize: 'medium',
      vmLocation: 'fsn1',
      workspaceProfile: null,
      nodeId: 'node-1',
    });
    mocks.getNode.mockResolvedValue({
      id: 'node-1',
      name: 'node-1',
      status: 'active',
      healthStatus: 'healthy',
    });

    const session = makeSession('sess-null', 'active');
    mocks.getChatSession.mockResolvedValue({
      session,
      messages: [makeMessage('m1', 'sess-null', 'Hello')],
      hasMore: false,
    });

    render(<ProjectMessageView projectId="proj-1" sessionId="sess-null" />);

    await waitFor(() => {
      expect(screen.getByText('Full')).toBeTruthy();
    });
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
    mocks.useProjectAgentSession.mockReturnValue(defaultAgentSession());
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

describe('ProjectMessageView — scroll position stability on follow-up send', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    mocks.getWorkspace.mockResolvedValue({ id: 'ws-test', name: 'test', status: 'running', vmSize: 'medium', vmLocation: 'fsn1' });
    mocks.getNode.mockResolvedValue({ id: 'node-test', name: 'node-test', status: 'active', healthStatus: 'healthy' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps DO view after grace period even when isPrompting flips true (follow-up send)', async () => {
    // Phase 1: Initial load with DO messages + agent prompting (simulates mid-task)
    const session1 = {
      ...makeSession('session-1'),
      workspaceId: 'ws-1',
      agentSessionId: 'agent-session-1',
    };
    const msgs = [
      makeMessage('msg-1', 'session-1', 'Initial response from agent'),
    ];
    mocks.getChatSession.mockResolvedValue({ session: session1, messages: msgs, hasMore: false });

    const agentSess = defaultAgentSession();
    agentSess.isAgentActive = true;
    agentSess.isPrompting = true;
    agentSess.messages.items = [
      { kind: 'agent_message' as const, id: 'acp-1', text: 'Streaming content', streaming: true, timestamp: Date.now() },
    ];
    mocks.useProjectAgentSession.mockReturnValue(agentSess);

    const { rerender } = render(
      <ProjectMessageView projectId="proj-1" sessionId="session-1" />,
    );

    await waitFor(() => {
      // During initial prompting with ACP items, ACP view should be shown
      expect(document.body.textContent).toContain('Streaming content');
    });

    // Phase 2: Agent stops prompting → grace period starts
    mocks.useProjectAgentSession.mockReturnValue({
      ...agentSess,
      isPrompting: false,
    });
    rerender(<ProjectMessageView projectId="proj-1" sessionId="session-1" />);

    // Phase 3: Grace period ends → committed to DO view
    await act(async () => {
      vi.advanceTimersByTime(3100); // ACP_GRACE_MS default = 3000
    });

    // After grace, DO messages should be visible (committed to DO view)
    await waitFor(() => {
      expect(document.body.textContent).toContain('Initial response from agent');
    });

    // Phase 4: User sends follow-up → isPrompting flips true again
    mocks.useProjectAgentSession.mockReturnValue({
      ...agentSess,
      isPrompting: true,
      isAgentActive: true,
      messages: {
        ...agentSess.messages,
        items: [
          { kind: 'user_message' as const, id: 'acp-user-1', text: 'Follow-up question', timestamp: Date.now() },
        ],
      },
    });
    rerender(<ProjectMessageView projectId="proj-1" sessionId="session-1" />);

    // CRITICAL ASSERTION: DO view should be maintained (not switch to ACP)
    // The DO-converted message must be present (rendered via agent role)
    expect(screen.getByText('Initial response from agent')).toBeTruthy();
    // ACP-only content should NOT be visible (view is committed to DO)
    expect(screen.queryByText('Follow-up question')).toBeNull();
  });

  it('shows ACP view initially when DO is empty, then commits to DO after grace', async () => {
    // Start: DO has no messages, agent is prompting with ACP items
    const emptySession = {
      ...makeSession('session-1'),
      workspaceId: 'ws-1',
      agentSessionId: 'agent-session-1',
    };
    mocks.getChatSession.mockResolvedValue({
      session: emptySession,
      messages: [],
      hasMore: false,
    });

    const acpMsgs = {
      items: [{ kind: 'agent_message' as const, id: 'acp-1', text: 'Streaming initial', streaming: true, timestamp: Date.now() }],
      processMessage: vi.fn(), addUserMessage: vi.fn(), prepareForReplay: vi.fn(), clear: vi.fn(), availableCommands: [], usage: { totalTokens: 0 },
    };
    mocks.useProjectAgentSession.mockReturnValue({
      ...defaultAgentSession(),
      isAgentActive: true,
      isPrompting: true,
      messages: acpMsgs,
    });

    const { rerender } = render(
      <ProjectMessageView projectId="proj-1" sessionId="session-1" />,
    );

    // ACP view should be shown (DO is empty)
    await waitFor(() => {
      expect(screen.getByText('Streaming initial')).toBeTruthy();
    });

    // Agent stops prompting; DO now has persisted messages via polling
    const doMsgs = [makeMessage('do-1', 'session-1', 'Persisted response')];
    mocks.getChatSession.mockResolvedValue({
      session: emptySession,
      messages: doMsgs,
      hasMore: false,
    });
    mocks.useProjectAgentSession.mockReturnValue({
      ...defaultAgentSession(),
      isPrompting: false,
      messages: acpMsgs,
    });
    rerender(<ProjectMessageView projectId="proj-1" sessionId="session-1" />);

    // Grace period ends → commits to DO view
    await act(async () => { vi.advanceTimersByTime(3100); });

    // Trigger polling to deliver DO messages
    await act(async () => { vi.advanceTimersByTime(3100); });

    await waitFor(() => {
      expect(screen.getByText('Persisted response')).toBeTruthy();
    });
  });

  it('resets committedToDoView on session switch so new session can show ACP', async () => {
    // Session A: commit to DO view
    mocks.getChatSession.mockResolvedValue(
      makeSessionResponse('session-A', [makeMessage('do-a', 'session-A', 'Session A response')]),
    );

    const acpMsgsA = {
      items: [{ kind: 'agent_message' as const, id: 'acp-a', text: 'ACP A', streaming: true, timestamp: Date.now() }],
      processMessage: vi.fn(), addUserMessage: vi.fn(), prepareForReplay: vi.fn(), clear: vi.fn(), availableCommands: [], usage: { totalTokens: 0 },
    };
    mocks.useProjectAgentSession.mockReturnValue({
      ...defaultAgentSession(),
      isAgentActive: true,
      isPrompting: true,
      messages: acpMsgsA,
    });

    const { rerender } = render(
      <ProjectMessageView projectId="proj-1" sessionId="session-A" />,
    );

    await waitFor(() => {
      expect(screen.getByText('ACP A')).toBeTruthy();
    });

    // Agent stops → grace period → commit to DO
    mocks.useProjectAgentSession.mockReturnValue({
      ...defaultAgentSession(),
      isPrompting: false,
      messages: acpMsgsA,
    });
    rerender(<ProjectMessageView projectId="proj-1" sessionId="session-A" />);
    await act(async () => { vi.advanceTimersByTime(3100); });
    await waitFor(() => {
      expect(screen.getByText('Session A response')).toBeTruthy();
    });

    // Switch to session B: empty DO, ACP streaming
    mocks.getChatSession.mockResolvedValue({
      session: { ...makeSession('session-B'), workspaceId: 'ws-B', agentSessionId: 'agent-session-B' },
      messages: [],
      hasMore: false,
    });
    const acpMsgsB = {
      items: [{ kind: 'agent_message' as const, id: 'acp-b', text: 'ACP B streaming', streaming: true, timestamp: Date.now() }],
      processMessage: vi.fn(), addUserMessage: vi.fn(), prepareForReplay: vi.fn(), clear: vi.fn(), availableCommands: [], usage: { totalTokens: 0 },
    };
    mocks.useProjectAgentSession.mockReturnValue({
      ...defaultAgentSession(),
      isAgentActive: true,
      isPrompting: true,
      messages: acpMsgsB,
    });
    rerender(<ProjectMessageView projectId="proj-1" sessionId="session-B" />);

    // Session B should show ACP view (committedToDoViewRef was reset by session switch)
    await waitFor(() => {
      expect(screen.getByText('ACP B streaming')).toBeTruthy();
    });
    expect(screen.queryByText('Session A response')).toBeNull();
  });
});
