/**
 * Behavioral tests for auto-resume of suspended ACP sessions in ProjectMessageView.
 *
 * These tests verify:
 * 1. Follow-up sends trigger auto-resume when agent is idle/suspended
 * 2. The waking/restoring UI state is shown during resume
 * 3. Queued messages are flushed when agent becomes active
 * 4. Resume failures show clear error messages
 * 5. Idle countdown pauses during resume
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectMessageView } from '../../../../src/components/project-message-view';
// Real ApiClientError (NOT overridden by the api mock below — the factory spreads
// importOriginal, so this is the exact class `getRuntimeRecoveryMessage`'s
// `instanceof` check compares against). Constructing production-shaped instances
// (code + message + status) exercises the code-matching path at the component level.
import { ApiClientError } from '../../../../src/lib/api';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockResumeAgentSession = vi.fn();
const mockResetIdleTimer = vi.fn();
const mockGetChatSession = vi.fn();
const mockGetWorkspace = vi.fn();
const mockGetNode = vi.fn();
const mockGetTerminalToken = vi.fn();
const mockSendFollowUpPrompt = vi.fn();
const mockCancelAgentPrompt = vi.fn();
const mockGetTranscribeApiUrl = vi.fn().mockReturnValue('https://api.example.com/transcribe');
const mockGetTtsApiUrl = vi.fn().mockReturnValue('https://api.example.com/tts');

vi.mock('../../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/lib/api')>()),
  resumeAgentSession: (...args: unknown[]) => mockResumeAgentSession(...args),
  resetIdleTimer: (...args: unknown[]) => mockResetIdleTimer(...args),
  getChatSession: (...args: unknown[]) => mockGetChatSession(...args),
  getWorkspace: (...args: unknown[]) => mockGetWorkspace(...args),
  getNode: (...args: unknown[]) => mockGetNode(...args),
  getTerminalToken: (...args: unknown[]) => mockGetTerminalToken(...args),
  sendFollowUpPrompt: (...args: unknown[]) => mockSendFollowUpPrompt(...args),
  cancelAgentPrompt: (...args: unknown[]) => mockCancelAgentPrompt(...args),
  getTranscribeApiUrl: () => mockGetTranscribeApiUrl(),
  getTtsApiUrl: () => mockGetTtsApiUrl(),
  updateProjectTaskStatus: vi.fn(),
  deleteWorkspace: vi.fn(),
  saveCachedCommands: vi.fn().mockResolvedValue({ cached: 0 }),
}));

// Mock useChatWebSocket
const mockWsRef = { current: null };
vi.mock('../../../../src/hooks/useChatWebSocket', () => ({
  useChatWebSocket: () => ({
    connectionState: 'connected',
    wsRef: mockWsRef,
    retry: vi.fn(),
  }),
}));

// Mock useWorkspacePorts
vi.mock('../../../../src/hooks/useWorkspacePorts', () => ({
  useWorkspacePorts: () => ({ ports: [], loading: false }),
}));

// Mock error-reporter
vi.mock('../../../../src/lib/error-reporter', () => ({
  reportError: vi.fn(),
}));

// Mock acp-client components
vi.mock('@simple-agent-manager/acp-client', () => ({
  useAcpSession: vi.fn(),
  useAcpMessages: vi.fn(),
  VoiceButton: () => null,
  MessageBubble: () => null,
  ToolCallCard: () => null,
  ThinkingBlock: () => null,
  PlanView: () => null,
  RawFallbackView: () => null,
  mapToolCallContent: vi.fn(),
  TypewriterText: ({ text }: { text: string }) => text,
  UserMessageFade: ({ text }: { text: string }) => text,
}));

// Mock react-virtuoso
vi.mock('react-virtuoso', () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: unknown[];
    itemContent: (index: number, item: unknown) => React.ReactNode;
  }) => (
    <div data-testid="virtuoso">
      {data?.map((item, i) => (
        <div key={i}>{itemContent(i, item)}</div>
      ))}
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-123';
const SESSION_ID = 'sess-456';
const WORKSPACE_ID = 'ws-789';
const AGENT_SESSION_ID = 'agent-sess-001';

function makeSessionResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    status: 'active',
    topic: 'Test session',
    workspaceId: WORKSPACE_ID,
    agentSessionId: AGENT_SESSION_ID,
    taskId: null,
    isIdle: false,
    agentCompletedAt: null,
    cleanupAt: null,
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 60_000,
    endedAt: null,
    stoppedAt: null,
    messageCount: 1,
    task: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProjectMessageView — auto-resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: session is idle with workspace and agent session
    mockGetChatSession.mockResolvedValue({
      session: makeSessionResponse({ isIdle: true, agentCompletedAt: Date.now() - 5_000 }),
      messages: [
        {
          id: 'msg-1',
          sessionId: SESSION_ID,
          role: 'user',
          content: 'Hello',
          toolMetadata: null,
          createdAt: Date.now() - 10_000,
        },
      ],
      hasMore: false,
    });
    mockGetWorkspace.mockResolvedValue({ id: WORKSPACE_ID, nodeId: 'node-1' });
    mockGetNode.mockResolvedValue({ id: 'node-1', name: 'test-node' });
    mockGetTerminalToken.mockResolvedValue({ token: 'test-token' });
    mockResetIdleTimer.mockResolvedValue({ cleanupAt: Date.now() + 1800_000 });
    mockResumeAgentSession.mockResolvedValue({ id: AGENT_SESSION_ID, status: 'running' });
    mockSendFollowUpPrompt.mockResolvedValue({ status: 'accepted', sessionId: AGENT_SESSION_ID });
    mockCancelAgentPrompt.mockResolvedValue({ status: 'cancelled', message: 'ok' });
  });

  it('keeps the archive dock visible for idle taskless instant sessions', async () => {
    const onCloseConversation = vi.fn();

    render(
      <ProjectMessageView
        projectId={PROJECT_ID}
        sessionId={SESSION_ID}
        onCloseConversation={onCloseConversation}
      />
    );

    const archiveButton = await screen.findByRole('button', { name: /^archive conversation$/i });
    expect(archiveButton).toBeInTheDocument();

    fireEvent.click(archiveButton);
    const archiveActions = await screen.findAllByRole('button', {
      name: /^archive conversation$/i,
    });
    fireEvent.click(archiveActions[archiveActions.length - 1]);

    expect(onCloseConversation).toHaveBeenCalledOnce();
  });

  it('calls resumeAgentSession when sending follow-up to idle session', async () => {
    render(<ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} />);

    // Wait for initial load
    await waitFor(() => {
      expect(mockGetChatSession).toHaveBeenCalled();
    });

    // Find and fill the input, then click Send
    const input = await screen.findByPlaceholderText(/send a message/i);
    fireEvent.change(input, { target: { value: 'Continue working on this' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(mockResumeAgentSession).toHaveBeenCalledWith(WORKSPACE_ID, AGENT_SESSION_ID);
    });
  });

  it('shows the waking/restoring banner during resume', async () => {
    // Make resume hang (never resolve)
    mockResumeAgentSession.mockReturnValue(new Promise(() => {}));

    render(<ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} />);

    await waitFor(() => {
      expect(mockGetChatSession).toHaveBeenCalled();
    });

    const input = await screen.findByPlaceholderText(/send a message/i);
    fireEvent.change(input, { target: { value: 'Resume please' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByText('Waking and restoring Instant session...')).toBeInTheDocument();
    });
  });

  it('shows error when resume fails with 404', async () => {
    mockResumeAgentSession.mockRejectedValue(new Error('404 Not Found'));

    render(<ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} />);

    await waitFor(() => {
      expect(mockGetChatSession).toHaveBeenCalled();
    });

    const input = await screen.findByPlaceholderText(/send a message/i);
    fireEvent.change(input, { target: { value: 'Hello again' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/could not resume agent.*workspace may have been cleaned up/i)
      ).toBeInTheDocument();
    });
  });

  it('shows generic error when resume fails with non-404 error', async () => {
    mockResumeAgentSession.mockRejectedValue(new Error('Network timeout'));

    render(<ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} />);

    await waitFor(() => {
      expect(mockGetChatSession).toHaveBeenCalled();
    });

    const input = await screen.findByPlaceholderText(/send a message/i);
    fireEvent.change(input, { target: { value: 'Hello again' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByText(/could not resume agent.*please try again/i)).toBeInTheDocument();
    });
  });

  it('shows resuming banner instead of agent offline during resume', async () => {
    // When resuming, the waking/restoring banner should be visible
    // and the generic "Agent offline" banner should NOT appear.
    // For idle sessions, the AgentErrorBanner wouldn't show anyway (guard: sessionState === 'active'),
    // but the resuming banner IS the intended UX replacement for the disconnect state.
    mockResumeAgentSession.mockReturnValue(new Promise(() => {}));

    render(<ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} />);

    await waitFor(() => {
      expect(mockGetChatSession).toHaveBeenCalled();
    });

    const input = await screen.findByPlaceholderText(/send a message/i);
    fireEvent.change(input, { target: { value: 'Test' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByText('Waking and restoring Instant session...')).toBeInTheDocument();
    });

    // Resuming banner is the active indicator — no error/offline banners
    expect(screen.queryByText(/agent offline/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/agent is not connected/i)).not.toBeInTheDocument();
  });
});

describe('ProjectMessageView — auto-resume on page visit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Default: session is idle with workspace and agent session
    mockGetChatSession.mockResolvedValue({
      session: makeSessionResponse({ isIdle: true, agentCompletedAt: Date.now() - 5_000 }),
      messages: [
        {
          id: 'msg-1',
          sessionId: SESSION_ID,
          role: 'user',
          content: 'Hello',
          toolMetadata: null,
          createdAt: Date.now() - 10_000,
        },
      ],
      hasMore: false,
    });
    mockGetWorkspace.mockResolvedValue({ id: WORKSPACE_ID, nodeId: 'node-1' });
    mockGetNode.mockResolvedValue({ id: 'node-1', name: 'test-node' });
    mockGetTerminalToken.mockResolvedValue({ token: 'test-token' });
    mockResetIdleTimer.mockResolvedValue({ cleanupAt: Date.now() + 1800_000 });
    mockResumeAgentSession.mockResolvedValue({ id: AGENT_SESSION_ID, status: 'running' });
    mockSendFollowUpPrompt.mockResolvedValue({ status: 'accepted', sessionId: AGENT_SESSION_ID });
    mockCancelAgentPrompt.mockResolvedValue({ status: 'cancelled', message: 'ok' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-resumes idle session after 2s delay without user interaction', async () => {
    render(<ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} />);

    // Wait for initial load
    await waitFor(() => {
      expect(mockGetChatSession).toHaveBeenCalled();
    });

    // Resume should NOT be called immediately
    expect(mockResumeAgentSession).not.toHaveBeenCalled();

    // Advance past the 2s delay
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    await waitFor(() => {
      expect(mockResumeAgentSession).toHaveBeenCalledWith(WORKSPACE_ID, AGENT_SESSION_ID);
    });
  });

  it('shows the waking/restoring banner during auto-resume', async () => {
    // Make resume hang
    mockResumeAgentSession.mockReturnValue(new Promise(() => {}));

    render(<ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} />);

    await waitFor(() => {
      expect(mockGetChatSession).toHaveBeenCalled();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    await waitFor(() => {
      expect(screen.getByText('Waking and restoring Instant session...')).toBeInTheDocument();
    });
  });

  it('shows error when auto-resume fails with 404', async () => {
    mockResumeAgentSession.mockRejectedValue(new Error('404 Not Found'));

    render(<ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} />);

    await waitFor(() => {
      expect(mockGetChatSession).toHaveBeenCalled();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/could not resume agent.*workspace may have been cleaned up/i)
      ).toBeInTheDocument();
    });
  });

  it('does not auto-resume during provisioning', async () => {
    render(
      <ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} isProvisioning={true} />
    );

    await waitFor(() => {
      expect(mockGetChatSession).toHaveBeenCalled();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    expect(mockResumeAgentSession).not.toHaveBeenCalled();
  });

  it('does not auto-resume non-idle sessions', async () => {
    // Session is active, not idle
    mockGetChatSession.mockResolvedValue({
      session: makeSessionResponse({ isIdle: false, agentCompletedAt: null }),
      messages: [],
      hasMore: false,
    });

    render(<ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} />);

    await waitFor(() => {
      expect(mockGetChatSession).toHaveBeenCalled();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    expect(mockResumeAgentSession).not.toHaveBeenCalled();
  });

  it('shows generic error when auto-resume fails with non-404 error', async () => {
    mockResumeAgentSession.mockRejectedValue(new Error('Network timeout'));

    render(<ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} />);

    await waitFor(() => {
      expect(mockGetChatSession).toHaveBeenCalled();
    });

    // Advance timer to trigger the auto-resume, then flush pending promises
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    await waitFor(
      () => {
        expect(screen.getByText(/could not resume agent.*please try again/i)).toBeInTheDocument();
      },
      { timeout: 3000 }
    );
  });

  it('resets auto-resume state when session ID changes', async () => {
    // Make first auto-resume hang
    mockResumeAgentSession.mockReturnValue(new Promise(() => {}));

    const { rerender } = render(
      <ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} />
    );

    await waitFor(() => {
      expect(mockGetChatSession).toHaveBeenCalled();
    });

    // Trigger auto-resume for first session
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    await waitFor(() => {
      expect(screen.getByText('Waking and restoring Instant session...')).toBeInTheDocument();
    });

    // Switch to a different session — should reset resume state
    const NEW_SESSION_ID = 'sess-new';
    mockGetChatSession.mockResolvedValue({
      session: makeSessionResponse({
        id: NEW_SESSION_ID,
        isIdle: true,
        agentCompletedAt: Date.now() - 5_000,
      }),
      messages: [],
      hasMore: false,
    });
    mockResumeAgentSession.mockClear();
    mockResumeAgentSession.mockResolvedValue({ id: AGENT_SESSION_ID, status: 'running' });

    rerender(<ProjectMessageView projectId={PROJECT_ID} sessionId={NEW_SESSION_ID} />);

    await waitFor(() => {
      expect(mockGetChatSession).toHaveBeenCalledTimes(2);
    });

    // Auto-resume should fire for the new session after the delay
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    await waitFor(() => {
      expect(mockResumeAgentSession).toHaveBeenCalled();
    });
  });

  it('does not double-resume when follow-up sent before auto-resume timer fires', async () => {
    mockResumeAgentSession.mockResolvedValue({ id: AGENT_SESSION_ID, status: 'running' });

    render(<ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} />);

    await waitFor(() => {
      expect(mockGetChatSession).toHaveBeenCalled();
    });

    // Send a follow-up BEFORE the 2s auto-resume timer fires
    // This triggers the handleSendFollowUp resume path which sets hasAttemptedAutoResumeRef
    const input = await screen.findByPlaceholderText(/send a message/i);
    fireEvent.change(input, { target: { value: 'Early message' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(mockResumeAgentSession).toHaveBeenCalledTimes(1);
    });

    // Now advance past the auto-resume timer — it should NOT fire a second resume
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    // Still only 1 call (from the follow-up, not from auto-resume)
    expect(mockResumeAgentSession).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// T5 — runtime-recovery messages exercised with REAL ApiClientError instances.
//
// Every scenario above rejects with a plain `Error`, so
// `getRuntimeRecoveryMessage`'s `instanceof ApiClientError` + `.code` matching
// was never exercised at the component level. These tests reject the ACTIVE
// session's `sendFollowUpPrompt` (the previously-uncovered active branch) with
// production-shaped ApiClientError instances and assert the rendered banner.
// ---------------------------------------------------------------------------

const ACTIVE_MESSAGES = [
  {
    id: 'msg-active-1',
    sessionId: SESSION_ID,
    role: 'assistant' as const,
    content: 'Ready for the next instruction.',
    toolMetadata: null,
    createdAt: Date.now() - 20_000,
  },
];

function mockActiveSession(overrides: Record<string, unknown> = {}) {
  mockGetChatSession.mockResolvedValue({
    session: makeSessionResponse({ isIdle: false, agentCompletedAt: null, ...overrides }),
    messages: ACTIVE_MESSAGES,
    hasMore: false,
  });
}

async function sendMessage(text: string) {
  const input = await screen.findByPlaceholderText(/send a message/i);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
  return input;
}

describe('ProjectMessageView — runtime recovery messages (real ApiClientError)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveSession();
    mockGetWorkspace.mockResolvedValue({ id: WORKSPACE_ID, nodeId: 'node-1' });
    mockGetNode.mockResolvedValue({ id: 'node-1', name: 'test-node' });
    mockGetTerminalToken.mockResolvedValue({ token: 'test-token' });
    mockResetIdleTimer.mockResolvedValue({ cleanupAt: Date.now() + 1800_000 });
    mockResumeAgentSession.mockResolvedValue({ id: AGENT_SESSION_ID, status: 'running' });
    mockSendFollowUpPrompt.mockResolvedValue({ status: 'accepted', sessionId: AGENT_SESSION_ID });
    mockCancelAgentPrompt.mockResolvedValue({ status: 'cancelled', message: 'ok' });
  });

  it('renders the specific waking copy for a RUNTIME_RECOVERING ApiClientError', async () => {
    mockSendFollowUpPrompt.mockRejectedValue(
      new ApiClientError('RUNTIME_RECOVERING', 'raw server text that must be replaced', 503)
    );

    render(<ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} />);
    await waitFor(() => expect(mockGetChatSession).toHaveBeenCalled());
    await sendMessage('please continue the work');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      /Waking and restoring the Instant session\. Wait for restore to finish, then send your message\./i
    );
    // The specific mapped copy replaces the raw server text.
    expect(alert).not.toHaveTextContent('raw server text that must be replaced');
  });

  it('renders the manual-retry disposition message for a RUNTIME_REQUEST_INTERRUPTED ApiClientError', async () => {
    const interruptedCopy =
      'The request was interrupted before the agent confirmed it. Resend when you are ready.';
    mockSendFollowUpPrompt.mockRejectedValue(
      new ApiClientError('RUNTIME_REQUEST_INTERRUPTED', interruptedCopy, 409)
    );

    render(<ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} />);
    await waitFor(() => expect(mockGetChatSession).toHaveBeenCalled());
    await sendMessage('resend this please');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(interruptedCopy);
  });

  it('renders the degraded message and does NOT claim a successful resume for RUNTIME_RECOVERY_DEGRADED', async () => {
    const degradedCopy =
      'The Instant runtime woke without a usable checkpoint. Verify local files before continuing.';
    mockSendFollowUpPrompt.mockRejectedValue(
      new ApiClientError('RUNTIME_RECOVERY_DEGRADED', degradedCopy, 503)
    );

    render(<ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} />);
    await waitFor(() => expect(mockGetChatSession).toHaveBeenCalled());
    await sendMessage('continue after the replacement');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(degradedCopy);
    // A degraded recovery must not be presented as a clean/successful resume.
    expect(alert).not.toHaveTextContent(/resumed successfully|successfully resumed/i);
  });

  it('DISCRIMINATION: a plain Error is not code-matched — falls back to the generic delivery copy', async () => {
    // Same string as the RUNTIME_RECOVERING case, but a plain Error (not
    // ApiClientError). If code-matching were skipped, the specific waking copy
    // would appear; instead the generic default must be shown.
    mockSendFollowUpPrompt.mockRejectedValue(new Error('RUNTIME_RECOVERING'));

    render(<ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} />);
    await waitFor(() => expect(mockGetChatSession).toHaveBeenCalled());
    await sendMessage('this should not be code-matched');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      /Your message is saved, but delivery could not be confirmed\./i
    );
    expect(alert).not.toHaveTextContent(/Wait for restore to finish/i);
  });
});

// ---------------------------------------------------------------------------
// Delivery / resume failure UX (UX1, UX2, UX3, UX7) + Dismiss interaction (T8).
// ---------------------------------------------------------------------------

describe('ProjectMessageView — delivery/resume failure UX', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveSession();
    mockGetWorkspace.mockResolvedValue({ id: WORKSPACE_ID, nodeId: 'node-1' });
    mockGetNode.mockResolvedValue({ id: 'node-1', name: 'test-node' });
    mockGetTerminalToken.mockResolvedValue({ token: 'test-token' });
    mockResetIdleTimer.mockResolvedValue({ cleanupAt: Date.now() + 1800_000 });
    mockResumeAgentSession.mockResolvedValue({ id: AGENT_SESSION_ID, status: 'running' });
    mockSendFollowUpPrompt.mockResolvedValue({ status: 'accepted', sessionId: AGENT_SESSION_ID });
    mockCancelAgentPrompt.mockResolvedValue({ status: 'cancelled', message: 'ok' });
  });

  it('UX1: a failed idle resume resets the working state (no stuck "Agent is working…", no Interrupt) and shows the error', async () => {
    // Idle session so the send goes through the resume path.
    mockGetChatSession.mockResolvedValue({
      session: makeSessionResponse({ isIdle: true, agentCompletedAt: Date.now() - 5_000 }),
      messages: ACTIVE_MESSAGES,
      hasMore: false,
    });
    mockResumeAgentSession.mockRejectedValue(new Error('Network timeout'));

    render(<ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} />);
    await waitFor(() => expect(mockGetChatSession).toHaveBeenCalled());
    await sendMessage('resume please');

    // Error banner is visible…
    await screen.findByText(/could not resume agent.*please try again/i);

    // …and the working state was cleared: placeholder is no longer "Agent is working…"
    // and the working-only Interrupt control is gone.
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Agent is working...')).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /interrupt agent/i })).not.toBeInTheDocument();
  });

  it('UX2: a later successful send clears a stale delivery-error banner', async () => {
    mockSendFollowUpPrompt
      .mockRejectedValueOnce(
        new ApiClientError('RUNTIME_REQUEST_INTERRUPTED', 'Delivery interrupted — try again.', 409)
      )
      .mockResolvedValue({ status: 'accepted', sessionId: AGENT_SESSION_ID });

    render(<ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} />);
    await waitFor(() => expect(mockGetChatSession).toHaveBeenCalled());

    // First send fails → banner.
    const input = await sendMessage('first attempt');
    expect(await screen.findByText('Delivery interrupted — try again.')).toBeInTheDocument();

    // Second send succeeds → banner must clear (previously it lingered forever).
    fireEvent.change(input, { target: { value: 'second attempt' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.queryByText('Delivery interrupted — try again.')).not.toBeInTheDocument();
    });
  });

  it('UX3: a terminal RUNTIME_STOPPED failure terminates the session and disables the composer', async () => {
    mockSendFollowUpPrompt.mockRejectedValue(
      new ApiClientError('RUNTIME_STOPPED', 'The Instant runtime has stopped.', 410)
    );

    render(<ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} />);
    await waitFor(() => expect(mockGetChatSession).toHaveBeenCalled());
    await sendMessage('are you still there?');

    // The existing terminated presentation takes over…
    await screen.findByText('This session has ended.');
    // …the composer is gone (disabled)…
    expect(screen.queryByPlaceholderText(/send a message/i)).not.toBeInTheDocument();
    // …and there is no dismissible retry banner inviting futile retries.
    expect(screen.queryByRole('button', { name: /^dismiss$/i })).not.toBeInTheDocument();
  });

  it('UX7: the composer keeps its text on delivery failure and clears only on success', async () => {
    mockSendFollowUpPrompt
      .mockRejectedValueOnce(
        new ApiClientError('RUNTIME_REQUEST_INTERRUPTED', 'Interrupted, retry.', 409)
      )
      .mockResolvedValue({ status: 'accepted', sessionId: AGENT_SESSION_ID });

    render(<ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} />);
    await waitFor(() => expect(mockGetChatSession).toHaveBeenCalled());

    const input = await sendMessage('keep me on failure');
    // On failure the typed text remains as the manual-retry affordance.
    await screen.findByText('Interrupted, retry.');
    expect(input).toHaveValue('keep me on failure');

    // Retry (now succeeds) → the composer clears.
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('T8: clicking Dismiss removes the resume-error banner', async () => {
    mockSendFollowUpPrompt.mockRejectedValue(
      new ApiClientError('RUNTIME_REQUEST_INTERRUPTED', 'Interrupted — retry when ready.', 409)
    );

    render(<ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} />);
    await waitFor(() => expect(mockGetChatSession).toHaveBeenCalled());
    await sendMessage('trigger the banner');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Interrupted — retry when ready.');

    fireEvent.click(within(alert).getByRole('button', { name: /^dismiss$/i }));

    await waitFor(() => {
      expect(screen.queryByText('Interrupted — retry when ready.')).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// UX4 — re-entrancy / ordering: auto-resume fires FIRST, then the user sends
// while it is still pending. The existing suite only covers the opposite
// ordering ("follow-up sent before auto-resume timer fires").
// ---------------------------------------------------------------------------

describe('ProjectMessageView — resume re-entrancy (UX4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockGetChatSession.mockResolvedValue({
      session: makeSessionResponse({ isIdle: true, agentCompletedAt: Date.now() - 5_000 }),
      messages: ACTIVE_MESSAGES,
      hasMore: false,
    });
    mockGetWorkspace.mockResolvedValue({ id: WORKSPACE_ID, nodeId: 'node-1' });
    mockGetNode.mockResolvedValue({ id: 'node-1', name: 'test-node' });
    mockGetTerminalToken.mockResolvedValue({ token: 'test-token' });
    mockResetIdleTimer.mockResolvedValue({ cleanupAt: Date.now() + 1800_000 });
    mockResumeAgentSession.mockResolvedValue({ id: AGENT_SESSION_ID, status: 'running' });
    mockSendFollowUpPrompt.mockResolvedValue({ status: 'accepted', sessionId: AGENT_SESSION_ID });
    mockCancelAgentPrompt.mockResolvedValue({ status: 'cancelled', message: 'ok' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('piggybacks a user send onto the in-flight auto-resume (single resume) and delivers without a spurious banner', async () => {
    // Hold the auto-resume pending so the user can send while it is in flight.
    let resolveResume: (value: unknown) => void = () => {};
    mockResumeAgentSession.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveResume = resolve;
      })
    );

    render(<ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} />);
    await waitFor(() => expect(mockGetChatSession).toHaveBeenCalled());

    // Auto-resume fires FIRST → exactly one resume call, banner visible.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    await waitFor(() => expect(mockResumeAgentSession).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Waking and restoring Instant session...')).toBeInTheDocument();

    // User sends WHILE the auto-resume is still pending.
    const input = await screen.findByPlaceholderText(/send a message/i);
    fireEvent.change(input, { target: { value: 'continue from the checkpoint' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    // Re-entrancy guard: NO overlapping second resume call.
    expect(mockResumeAgentSession).toHaveBeenCalledTimes(1);

    // Settle the single resume → the piggybacked follow-up is delivered.
    await act(async () => {
      resolveResume({ id: AGENT_SESSION_ID, status: 'running' });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockSendFollowUpPrompt).toHaveBeenCalledWith(
        PROJECT_ID,
        SESSION_ID,
        'continue from the checkpoint'
      );
    });

    // Still exactly one resume, and the stale settlement produced no error banner.
    expect(mockResumeAgentSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
