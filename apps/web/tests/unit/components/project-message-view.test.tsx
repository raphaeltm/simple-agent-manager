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

vi.mock('@simple-agent-manager/acp-client', () => ({
  VoiceButton: () => <button data-testid="voice-button">Voice</button>,
}));

import { ProjectMessageView } from '../../../src/components/chat/ProjectMessageView';

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
    let lastSignal: AbortSignal | undefined;

    const sessionAResponse = makeSessionResponse('session-A', [
      makeMessage('msg-a1', 'session-A', 'Data from A'),
    ]);

    mocks.getChatSession.mockImplementation(async (
      _projectId: string,
      _sessionId: string,
      params?: { signal?: AbortSignal }
    ) => {
      lastSignal = params?.signal;
      return sessionAResponse;
    });

    const { rerender } = render(
      <ProjectMessageView projectId="proj-1" sessionId="session-A" />
    );

    await waitFor(() => {
      expect(screen.getByText('Data from A')).toBeTruthy();
    });

    // Advance time to trigger a poll
    await act(async () => {
      vi.advanceTimersByTime(3100);
    });

    const signalBeforeSwitch = lastSignal;

    const sessionBResponse = makeSessionResponse('session-B', [
      makeMessage('msg-b1', 'session-B', 'Data from B'),
    ]);
    mocks.getChatSession.mockImplementation(async () => sessionBResponse);

    rerender(
      <ProjectMessageView projectId="proj-1" sessionId="session-B" />
    );

    await waitFor(() => {
      expect(signalBeforeSwitch?.aborted).toBe(true);
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
