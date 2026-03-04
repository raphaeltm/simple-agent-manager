/**
 * Regression tests for chat session cross-contamination fix.
 *
 * Bug: When switching between sessions, in-flight polling requests for the
 * old session could resolve after the switch and overwrite the new session's
 * messages with the old session's data.
 *
 * Fix: Added AbortController to the polling useEffect and a session ID guard
 * that skips responses where data.session.id !== current sessionId.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
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

  it('does not apply polling response from a different session', async () => {
    // Initial load returns session-A data
    const sessionAResponse = makeSessionResponse('session-A', [
      makeMessage('msg-a1', 'session-A', 'Hello from A'),
    ]);
    const sessionBResponse = makeSessionResponse('session-B', [
      makeMessage('msg-b1', 'session-B', 'Hello from B'),
    ]);

    // First call is the initial load, subsequent calls are polls
    let callCount = 0;
    mocks.getChatSession.mockImplementation(async (_projectId: string, sessionId: string) => {
      callCount++;
      if (sessionId === 'session-A') return sessionAResponse;
      if (sessionId === 'session-B') return sessionBResponse;
      throw new Error(`Unexpected session: ${sessionId}`);
    });

    const { rerender } = render(
      <ProjectMessageView projectId="proj-1" sessionId="session-A" />
    );

    // Wait for initial load
    await waitFor(() => {
      expect(screen.getByText('Hello from A')).toBeTruthy();
    });

    // Now switch to session B
    rerender(
      <ProjectMessageView projectId="proj-1" sessionId="session-B" />
    );

    // Wait for session B to load
    await waitFor(() => {
      expect(screen.getByText('Hello from B')).toBeTruthy();
    });

    // Session A's messages should NOT be visible
    expect(screen.queryByText('Hello from A')).toBeNull();
  });

  it('aborts in-flight polling requests on session switch', async () => {
    // Track whether AbortSignal is passed to getChatSession
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

    // Wait for initial load
    await waitFor(() => {
      expect(screen.getByText('Data from A')).toBeTruthy();
    });

    // Advance time to trigger a poll
    await act(async () => {
      vi.advanceTimersByTime(3100);
    });

    // The polling call should have received a signal
    const signalBeforeSwitch = lastSignal;

    // Now switch session — should abort the old signal
    const sessionBResponse = makeSessionResponse('session-B', [
      makeMessage('msg-b1', 'session-B', 'Data from B'),
    ]);
    mocks.getChatSession.mockImplementation(async () => sessionBResponse);

    rerender(
      <ProjectMessageView projectId="proj-1" sessionId="session-B" />
    );

    // The old signal should be aborted after the rerender
    await waitFor(() => {
      expect(signalBeforeSwitch?.aborted).toBe(true);
    });
  });
});
