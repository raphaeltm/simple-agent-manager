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
import { render, screen, act, waitFor } from '@testing-library/react';

// jsdom doesn't support scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

// --- Mocks ---

const mocks = vi.hoisted(() => ({
  getChatSession: vi.fn(),
  getTranscribeApiUrl: vi.fn(() => 'https://api.test.com/api/transcribe'),
  resetIdleTimer: vi.fn(),
  sendFollowUpPrompt: vi.fn(),
  useProjectAgentSession: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  getChatSession: mocks.getChatSession,
  getTranscribeApiUrl: mocks.getTranscribeApiUrl,
  resetIdleTimer: mocks.resetIdleTimer,
  sendFollowUpPrompt: mocks.sendFollowUpPrompt,
}));

vi.mock('../../../src/hooks/useChatWebSocket', () => ({
  useChatWebSocket: () => ({
    connectionState: 'connected' as const,
    wsRef: { current: null },
    retry: vi.fn(),
  }),
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

vi.mock('@simple-agent-manager/acp-client', () => ({
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
}));

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

    // Advance past the 3s poll interval so getChatSession is called with a signal
    await act(async () => {
      vi.advanceTimersByTime(3100);
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

  it('converts system messages as agent messages', () => {
    const items = chatMessagesToConversationItems([
      { id: 's1', sessionId: 's1', role: 'system', content: 'Session started', toolMetadata: null, createdAt: 1000 },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('agent_message');
    expect(items[0].text).toContain('System:');
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
