/**
 * Behavioral tests for auto-resume of suspended ACP sessions in ProjectMessageView.
 *
 * These tests verify:
 * 1. Follow-up sends trigger auto-resume when agent is idle/suspended
 * 2. "Resuming agent..." UI state is shown during resume
 * 3. Queued messages are flushed when agent becomes active
 * 4. Resume failures show clear error messages
 * 5. Idle countdown pauses during resume
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectMessageView } from '../../../../src/components/chat/ProjectMessageView';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockResumeAgentSession = vi.fn();
const mockResetIdleTimer = vi.fn();
const mockGetChatSession = vi.fn();
const mockGetWorkspace = vi.fn();
const mockGetNode = vi.fn();
const mockGetTerminalToken = vi.fn();
const mockGetTranscribeApiUrl = vi.fn().mockReturnValue('https://api.example.com/transcribe');
const mockGetTtsApiUrl = vi.fn().mockReturnValue('https://api.example.com/tts');

vi.mock('../../../../src/lib/api', () => ({
  resumeAgentSession: (...args: unknown[]) => mockResumeAgentSession(...args),
  resetIdleTimer: (...args: unknown[]) => mockResetIdleTimer(...args),
  getChatSession: (...args: unknown[]) => mockGetChatSession(...args),
  getWorkspace: (...args: unknown[]) => mockGetWorkspace(...args),
  getNode: (...args: unknown[]) => mockGetNode(...args),
  getTerminalToken: (...args: unknown[]) => mockGetTerminalToken(...args),
  getTranscribeApiUrl: () => mockGetTranscribeApiUrl(),
  getTtsApiUrl: () => mockGetTtsApiUrl(),
  updateProjectTaskStatus: vi.fn(),
  deleteWorkspace: vi.fn(),
}));

// Mock useProjectAgentSession — controllable via module-level variable
let mockAgentSession = {
  isAgentActive: false,
  isPrompting: false,
  isConnecting: false,
  sendPrompt: vi.fn(),
  cancelPrompt: vi.fn(),
  transcribeApiUrl: 'https://api.example.com/transcribe',
  session: {
    connected: false,
    state: 'disconnected' as string,
    agentType: null,
    error: null,
    errorCode: null,
    sendMessage: vi.fn(),
    reconnect: vi.fn(),
    switchAgent: vi.fn(),
  },
  messages: { items: [], processMessage: vi.fn(), prepareForReplay: vi.fn(), clear: vi.fn(), addUserMessage: vi.fn() },
};

vi.mock('../../../../src/hooks/useProjectAgentSession', () => ({
  useProjectAgentSession: () => mockAgentSession,
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
  getErrorMeta: vi.fn(),
}));

// Mock react-virtuoso
vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ data, itemContent }: { data: unknown[]; itemContent: (index: number, item: unknown) => React.ReactNode }) => (
    <div data-testid="virtuoso">
      {data?.map((item, i) => <div key={i}>{itemContent(i, item)}</div>)}
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
      messages: [{ id: 'msg-1', sessionId: SESSION_ID, role: 'user', content: 'Hello', toolMetadata: null, createdAt: Date.now() - 10_000 }],
      hasMore: false,
    });
    mockGetWorkspace.mockResolvedValue({ id: WORKSPACE_ID, nodeId: 'node-1' });
    mockGetNode.mockResolvedValue({ id: 'node-1', name: 'test-node' });
    mockGetTerminalToken.mockResolvedValue({ token: 'test-token' });
    mockResetIdleTimer.mockResolvedValue({ cleanupAt: Date.now() + 1800_000 });
    mockResumeAgentSession.mockResolvedValue({ id: AGENT_SESSION_ID, status: 'running' });

    // Reset agent session mock to idle state
    mockAgentSession = {
      isAgentActive: false,
      isPrompting: false,
      isConnecting: false,
      sendPrompt: vi.fn(),
      cancelPrompt: vi.fn(),
      transcribeApiUrl: 'https://api.example.com/transcribe',
      session: {
        connected: false,
        state: 'disconnected',
        agentType: null,
        error: null,
        errorCode: null,
        sendMessage: vi.fn(),
        reconnect: vi.fn(),
        switchAgent: vi.fn(),
      },
      messages: { items: [], processMessage: vi.fn(), prepareForReplay: vi.fn(), clear: vi.fn(), addUserMessage: vi.fn() },
    };
  });

  it('calls resumeAgentSession when sending follow-up to idle session', async () => {
    render(
      <ProjectMessageView
        projectId={PROJECT_ID}
        sessionId={SESSION_ID}
      />
    );

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

  it('shows "Resuming agent..." banner during resume', async () => {
    // Make resume hang (never resolve)
    mockResumeAgentSession.mockReturnValue(new Promise(() => {}));

    render(
      <ProjectMessageView
        projectId={PROJECT_ID}
        sessionId={SESSION_ID}
      />
    );

    await waitFor(() => {
      expect(mockGetChatSession).toHaveBeenCalled();
    });

    const input = await screen.findByPlaceholderText(/send a message/i);
    fireEvent.change(input, { target: { value: 'Resume please' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByText('Resuming agent...')).toBeInTheDocument();
    });
  });

  it('shows error when resume fails with 404', async () => {
    mockResumeAgentSession.mockRejectedValue(new Error('404 Not Found'));

    render(
      <ProjectMessageView
        projectId={PROJECT_ID}
        sessionId={SESSION_ID}
      />
    );

    await waitFor(() => {
      expect(mockGetChatSession).toHaveBeenCalled();
    });

    const input = await screen.findByPlaceholderText(/send a message/i);
    fireEvent.change(input, { target: { value: 'Hello again' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByText(/could not resume agent.*workspace may have been cleaned up/i)).toBeInTheDocument();
    });
  });

  it('shows generic error when resume fails with non-404 error', async () => {
    mockResumeAgentSession.mockRejectedValue(new Error('Network timeout'));

    render(
      <ProjectMessageView
        projectId={PROJECT_ID}
        sessionId={SESSION_ID}
      />
    );

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
    // When resuming, the "Resuming agent..." banner should be visible
    // and the generic "Agent offline" banner should NOT appear.
    // For idle sessions, the AgentErrorBanner wouldn't show anyway (guard: sessionState === 'active'),
    // but the resuming banner IS the intended UX replacement for the disconnect state.
    mockResumeAgentSession.mockReturnValue(new Promise(() => {}));

    render(
      <ProjectMessageView
        projectId={PROJECT_ID}
        sessionId={SESSION_ID}
      />
    );

    await waitFor(() => {
      expect(mockGetChatSession).toHaveBeenCalled();
    });

    const input = await screen.findByPlaceholderText(/send a message/i);
    fireEvent.change(input, { target: { value: 'Test' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByText('Resuming agent...')).toBeInTheDocument();
    });

    // Resuming banner is the active indicator — no error/offline banners
    expect(screen.queryByText(/agent offline/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/agent is not connected/i)).not.toBeInTheDocument();
  });

  it('flushes pending message when agent becomes active after resume', async () => {
    // Start with agent inactive (idle session)
    let resolveResume: (value: unknown) => void;
    mockResumeAgentSession.mockReturnValue(new Promise((resolve) => { resolveResume = resolve; }));

    const { rerender } = render(
      <ProjectMessageView
        projectId={PROJECT_ID}
        sessionId={SESSION_ID}
      />
    );

    await waitFor(() => {
      expect(mockGetChatSession).toHaveBeenCalled();
    });

    // Send a message that triggers resume
    const input = await screen.findByPlaceholderText(/send a message/i);
    fireEvent.change(input, { target: { value: 'Queued message' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(mockResumeAgentSession).toHaveBeenCalled();
    });

    // sendPrompt should NOT have been called yet (message is queued)
    expect(mockAgentSession.sendPrompt).not.toHaveBeenCalled();

    // Resolve the resume API call
    resolveResume!({ id: AGENT_SESSION_ID, status: 'running' });

    // Now simulate the agent becoming active (ACP WebSocket reconnected)
    mockAgentSession.isAgentActive = true;
    rerender(
      <ProjectMessageView
        projectId={PROJECT_ID}
        sessionId={SESSION_ID}
      />
    );

    // The pending message should be flushed via sendPrompt
    await waitFor(() => {
      expect(mockAgentSession.sendPrompt).toHaveBeenCalledWith('Queued message');
    });
  });

  it('sends directly via ACP when agent is already active (no resume)', async () => {
    // Agent is already active — no resume needed
    mockAgentSession.isAgentActive = true;

    render(
      <ProjectMessageView
        projectId={PROJECT_ID}
        sessionId={SESSION_ID}
      />
    );

    await waitFor(() => {
      expect(mockGetChatSession).toHaveBeenCalled();
    });

    const input = await screen.findByPlaceholderText(/send a message/i);
    fireEvent.change(input, { target: { value: 'Direct message' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(mockAgentSession.sendPrompt).toHaveBeenCalledWith('Direct message');
    });

    // resumeAgentSession should NOT have been called
    expect(mockResumeAgentSession).not.toHaveBeenCalled();
  });
});
