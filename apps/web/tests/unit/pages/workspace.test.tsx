import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  getWorkspace: vi.fn(),
  getTerminalToken: vi.fn(),
  stopWorkspace: vi.fn(),
  restartWorkspace: vi.fn(),
  listWorkspaceEvents: vi.fn(),
  listAgentSessions: vi.fn(),
  createAgentSession: vi.fn(),
  stopAgentSession: vi.fn(),
  resumeAgentSession: vi.fn(),
  renameAgentSession: vi.fn(),
  updateWorkspace: vi.fn(),
  rebuildWorkspace: vi.fn(),
  listAgents: vi.fn(),
  getGitStatus: vi.fn(),
  getFileIndex: vi.fn(),
  getWorktrees: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  getAgentSettings: vi.fn(),
  saveAgentSettings: vi.fn(),
  listAgentSessionsLive: vi.fn(),
  useAcpSession: vi.fn(),
  featureFlags: {
    multiTerminal: false,
    conversationView: false,
    mobileOptimized: true,
    debugMode: false,
  },
}));

vi.mock('../../../src/lib/api', () => ({
  ApiClientError: class ApiClientError extends Error {
    code: string;
    status: number;

    constructor(code: string, message: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
      this.name = 'ApiClientError';
    }
  },
  getWorkspace: mocks.getWorkspace,
  getTerminalToken: mocks.getTerminalToken,
  stopWorkspace: mocks.stopWorkspace,
  restartWorkspace: mocks.restartWorkspace,
  listWorkspaceEvents: mocks.listWorkspaceEvents,
  listAgentSessions: mocks.listAgentSessions,
  createAgentSession: mocks.createAgentSession,
  stopAgentSession: mocks.stopAgentSession,
  resumeAgentSession: mocks.resumeAgentSession,
  renameAgentSession: mocks.renameAgentSession,
  updateWorkspace: mocks.updateWorkspace,
  rebuildWorkspace: mocks.rebuildWorkspace,
  listAgents: mocks.listAgents,
  getGitStatus: mocks.getGitStatus,
  getFileIndex: mocks.getFileIndex,
  getWorktrees: mocks.getWorktrees,
  createWorktree: mocks.createWorktree,
  removeWorktree: mocks.removeWorktree,
  getAgentSettings: mocks.getAgentSettings,
  saveAgentSettings: mocks.saveAgentSettings,
  listAgentSessionsLive: mocks.listAgentSessionsLive,
  getTranscribeApiUrl: () => 'https://api.example.com/api/transcribe',
  getClientErrorsApiUrl: () => 'https://api.example.com/api/client-errors',
}));

vi.mock('@simple-agent-manager/terminal', async () => {
  const React = await import('react');
  const MultiTerminal = React.forwardRef(({ onSessionsChange }: any, ref: any) => {
    const [sessions, setSessions] = React.useState([
      { id: 'term-1', name: 'Terminal 1', status: 'connected' },
    ]);
    const [activeSessionId, setActiveSessionId] = React.useState<string | null>('term-1');
    const counterRef = React.useRef(1);

    React.useEffect(() => {
      onSessionsChange?.(sessions, activeSessionId);
    }, [sessions, activeSessionId, onSessionsChange]);

    React.useImperativeHandle(
      ref,
      () => ({
        createSession: () => {
          counterRef.current += 1;
          const next = counterRef.current;
          const sessionId = `term-${next}`;
          setSessions((prev: any[]) => [
            ...prev,
            { id: sessionId, name: `Terminal ${next}`, status: 'connected' },
          ]);
          setActiveSessionId(sessionId);
          return sessionId;
        },
        closeSession: (sessionId: string) => {
          setSessions((prev: any[]) => {
            const next = prev.filter((session) => session.id !== sessionId);
            setActiveSessionId(next[0]?.id ?? null);
            return next;
          });
        },
        activateSession: (sessionId: string) => {
          setActiveSessionId(sessionId);
        },
        renameSession: (sessionId: string, name: string) => {
          setSessions((prev: any[]) =>
            prev.map((session) => (session.id === sessionId ? { ...session, name } : session))
          );
        },
        focus: vi.fn(),
      }),
      []
    );

    return <div data-testid="multi-terminal">multi-terminal</div>;
  });
  MultiTerminal.displayName = 'MockMultiTerminal';

  return {
    Terminal: () => <div data-testid="terminal">terminal</div>,
    MultiTerminal,
  };
});

vi.mock('@simple-agent-manager/acp-client', () => ({
  useAcpMessages: () => ({
    processMessage: vi.fn(),
    items: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    availableCommands: [],
    addUserMessage: vi.fn(),
    clear: vi.fn(),
  }),
  useAcpSession: mocks.useAcpSession,
  AgentPanel: () => <div data-testid="agent-panel">agent-panel</div>,
}));

vi.mock('../../../src/components/UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));

vi.mock('../../../src/config/features', () => ({
  useFeatureFlags: () => mocks.featureFlags,
}));

import { Workspace } from '../../../src/pages/Workspace';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{`${location.pathname}${location.search}`}</div>;
}

function renderWorkspace(initialEntry = '/workspaces/ws-123', includeProbe = false) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="/workspaces/:id"
          element={
            includeProbe ? (
              <>
                <Workspace />
                <LocationProbe />
              </>
            ) : (
              <Workspace />
            )
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

function setMobileViewport() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

async function findCloseTerminalButton() {
  const closeButtons = await screen.findAllByRole(
    'button',
    { name: /Close Terminal/ },
    { timeout: 5_000 }
  );
  return closeButtons[0];
}

describe('Workspace page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.featureFlags.multiTerminal = false;
    mocks.featureFlags.conversationView = false;
    mocks.featureFlags.mobileOptimized = true;
    mocks.featureFlags.debugMode = false;

    mocks.useAcpSession.mockReturnValue({
      state: 'no_session',
      agentType: null,
      switchAgent: vi.fn(),
      connected: true,
      error: null,
      sendMessage: vi.fn(),
    });

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    mocks.getWorkspace.mockResolvedValue({
      id: 'ws-123',
      nodeId: 'node-1',
      name: 'Workspace A',
      displayName: 'Workspace A',
      repository: 'octo/repo',
      branch: 'main',
      status: 'running',
      vmSize: 'small',
      vmLocation: 'nbg1',
      vmIp: null,
      lastActivityAt: null,
      errorMessage: null,
      shutdownDeadline: null,
      idleTimeoutSeconds: 0,
      createdAt: '2026-02-08T00:00:00.000Z',
      updatedAt: '2026-02-08T00:00:00.000Z',
      url: 'https://ws-ws-123.example.com',
    });
    mocks.getTerminalToken.mockResolvedValue({
      token: 'tok_123',
      expiresAt: '2026-02-08T01:00:00.000Z',
      workspaceUrl: 'https://ws-ws-123.example.com',
    });
    mocks.listWorkspaceEvents.mockResolvedValue({ events: [], nextCursor: null });
    mocks.listAgentSessions.mockResolvedValue([]);
    mocks.listAgentSessionsLive.mockRejectedValue(new Error('not mocked'));
    mocks.updateWorkspace.mockResolvedValue({
      id: 'ws-123',
      nodeId: 'node-1',
      name: 'Workspace A',
      displayName: 'Workspace A',
      repository: 'octo/repo',
      branch: 'main',
      status: 'running',
      vmSize: 'small',
      vmLocation: 'nbg1',
      vmIp: null,
      lastActivityAt: null,
      errorMessage: null,
      shutdownDeadline: null,
      idleTimeoutSeconds: 0,
      createdAt: '2026-02-08T00:00:00.000Z',
      updatedAt: '2026-02-08T00:00:00.000Z',
      url: 'https://ws-ws-123.example.com',
    });
    mocks.getGitStatus.mockResolvedValue({ staged: [], unstaged: [], untracked: [] });
    mocks.getFileIndex.mockResolvedValue([]);
    mocks.getWorktrees.mockResolvedValue({
      worktrees: [
        {
          path: '/workspaces/repo',
          branch: 'main',
          headCommit: 'abc1234',
          isPrimary: true,
          isDirty: false,
          dirtyFileCount: 0,
        },
        {
          path: '/workspaces/repo-wt-feature-auth',
          branch: 'feature/auth',
          headCommit: 'def5678',
          isPrimary: false,
          isDirty: false,
          dirtyFileCount: 0,
        },
      ],
    });
    mocks.createWorktree.mockResolvedValue(undefined);
    mocks.removeWorktree.mockResolvedValue({ removed: '/workspaces/repo-wt-old' });
    mocks.resumeAgentSession.mockResolvedValue(undefined);
    mocks.renameAgentSession.mockResolvedValue(undefined);
    mocks.rebuildWorkspace.mockResolvedValue({
      workspaceId: 'ws-123',
      status: 'pending',
      message: 'Workspace rebuild started',
    });
    mocks.getAgentSettings.mockResolvedValue({ model: null, permissionMode: 'default' });
    mocks.listAgents.mockResolvedValue({
      agents: [
        {
          id: 'claude-code',
          name: 'Claude Code',
          description: 'Anthropic agent',
          supportsAcp: true,
          configured: true,
          credentialHelpUrl: 'https://example.com',
        },
      ],
    });
  });

  describe('multi-terminal tab lifecycle', () => {
    it('closing active terminal tab focuses a running chat tab', async () => {
      mocks.featureFlags.multiTerminal = true;
      mocks.listAgentSessions.mockResolvedValue([
        {
          id: 'sess-1',
          workspaceId: 'ws-123',
          status: 'running',
          label: 'Claude Chat',
          createdAt: '2026-02-08T00:10:00.000Z',
          updatedAt: '2026-02-08T00:10:00.000Z',
        },
      ]);

      renderWorkspace('/workspaces/ws-123', true);

      expect(await findCloseTerminalButton()).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Chat tab: Claude Chat' })).toBeInTheDocument();

      fireEvent.click(await findCloseTerminalButton());

      await waitFor(() => {
        const probe = screen.getByTestId('location-probe').textContent ?? '';
        expect(probe).toContain('view=conversation');
        expect(probe).toContain('sessionId=sess-1');
      });
      expect(screen.queryByRole('tab', { name: 'Terminal tab: Terminal 1' })).not.toBeInTheDocument();
    });

    it('allows creating a new terminal from + menu after closing the last terminal tab', async () => {
      mocks.featureFlags.multiTerminal = true;
      mocks.listAgentSessions.mockResolvedValue([]);

      renderWorkspace('/workspaces/ws-123', true);

      expect(await findCloseTerminalButton()).toBeInTheDocument();
      fireEvent.click(await findCloseTerminalButton());

      await waitFor(() => {
        expect(screen.queryByRole('tab', { name: /Terminal tab:/ })).not.toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Create terminal or chat session' }));
      fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));

      await waitFor(() => {
        expect(screen.getByRole('tab', { name: /Terminal tab: Terminal/ })).toBeInTheDocument();
      });
    });
  });

  it('renders workspace detail with terminal and session sidebar', async () => {
    renderWorkspace('/workspaces/ws-123');

    await waitFor(() => {
      expect(mocks.getWorkspace).toHaveBeenCalledWith('ws-123');
    });

    expect(await screen.findByText('Workspace A')).toBeInTheDocument();
    expect(screen.getByText('octo/repo@main')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('terminal')).toBeInTheDocument();
    });
    expect(screen.getByText(/Events/)).toBeInTheDocument();
  });

  it('treats recovery workspace status as active for terminal access', async () => {
    mocks.getWorkspace.mockResolvedValue({
      id: 'ws-123',
      nodeId: 'node-1',
      name: 'Workspace A',
      displayName: 'Workspace A',
      repository: 'octo/repo',
      branch: 'main',
      status: 'recovery',
      vmSize: 'small',
      vmLocation: 'nbg1',
      vmIp: null,
      lastActivityAt: null,
      errorMessage: null,
      shutdownDeadline: null,
      idleTimeoutSeconds: 0,
      createdAt: '2026-02-08T00:00:00.000Z',
      updatedAt: '2026-02-08T00:00:00.000Z',
      url: 'https://ws-ws-123.example.com',
    });

    renderWorkspace('/workspaces/ws-123');

    expect(await screen.findByText('Recovery')).toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.getTerminalToken).toHaveBeenCalledWith('ws-123');
    });
  });

  it('supports chat tab attach flow and updates workspace query string', async () => {
    mocks.listAgentSessions.mockResolvedValue([
      {
        id: 'sess-1',
        workspaceId: 'ws-123',
        status: 'running',
        label: 'Claude Chat',
        createdAt: '2026-02-08T00:10:00.000Z',
        updatedAt: '2026-02-08T00:10:00.000Z',
      },
    ]);

    renderWorkspace('/workspaces/ws-123', true);

    await waitFor(() => {
      expect(mocks.listAgentSessions).toHaveBeenCalledWith('ws-123');
    });

    fireEvent.click(await screen.findByRole('tab', { name: 'Chat tab: Claude Chat' }));

    await waitFor(() => {
      const probe = screen.getByTestId('location-probe');
      expect(probe.textContent).toContain('/workspaces/ws-123?');
      expect(probe.textContent).toContain('view=conversation');
      expect(probe.textContent).toContain('sessionId=sess-1');
    });
  });

  it('stops active chat session when closing the chat tab', async () => {
    mocks.stopAgentSession.mockResolvedValue(undefined);
    const sessionData = {
      id: 'sess-tab',
      workspaceId: 'ws-123',
      status: 'running',
      label: 'Claude Code Chat',
      createdAt: '2026-02-08T00:10:00.000Z',
      updatedAt: '2026-02-08T00:10:00.000Z',
    };
    // Multiple mocks needed: loadWorkspaceState re-runs when workspace.status
    // changes and when terminalToken becomes available (live session fallback).
    mocks.listAgentSessions.mockResolvedValueOnce([sessionData]);
    mocks.listAgentSessions.mockResolvedValueOnce([sessionData]);
    mocks.listAgentSessions.mockResolvedValueOnce([sessionData]);
    mocks.listAgentSessions.mockResolvedValueOnce([]);

    renderWorkspace('/workspaces/ws-123?view=conversation&sessionId=sess-tab', true);

    const stopBtn = await screen.findByRole('button', { name: 'Stop Claude Code Chat' });
    fireEvent.click(stopBtn);

    await waitFor(() => {
      expect(mocks.stopAgentSession).toHaveBeenCalledWith('ws-123', 'sess-tab');
    });

    await waitFor(() => {
      const probe = screen.getByTestId('location-probe');
      expect(probe.textContent).toContain('/workspaces/ws-123?');
      expect(probe.textContent).toContain('view=terminal');
      expect(probe.textContent).not.toContain('sessionId=');
    });
  });

  it('provides session-aware ACP URL resolver when a sessionId is selected', async () => {
    mocks.listAgentSessions.mockResolvedValue([
      {
        id: 'sess-1',
        workspaceId: 'ws-123',
        status: 'running',
        label: 'Claude Chat',
        createdAt: '2026-02-08T00:10:00.000Z',
        updatedAt: '2026-02-08T00:10:00.000Z',
      },
    ]);

    renderWorkspace('/workspaces/ws-123?view=conversation&sessionId=sess-1');

    await waitFor(() => {
      expect(mocks.useAcpSession).toHaveBeenCalled();
    });

    await waitFor(() => {
      const resolvers = mocks.useAcpSession.mock.calls
        .map(([options]) => options?.resolveWsUrl)
        .filter((value): value is (() => Promise<string | null>) => typeof value === 'function');
      expect(resolvers.length).toBeGreaterThan(0);
    });

    const resolver = mocks.useAcpSession.mock.calls
      .map(([options]) => options?.resolveWsUrl)
      .find((value): value is () => Promise<string | null> => typeof value === 'function');

    expect(resolver).toBeDefined();
    const resolvedUrl = await resolver!();
    expect(resolvedUrl).toBeTruthy();
    expect(resolvedUrl!).toContain('sessionId=sess-1');
    expect(resolvedUrl!).not.toContain('takeover=');
    expect(mocks.getTerminalToken).toHaveBeenCalledWith('ws-123');
    await waitFor(() => {
      // ChatSession uses resolver mode, so wsUrl is intentionally null.
      const wsUrlValues = mocks.useAcpSession.mock.calls.map(([options]) => options?.wsUrl);
      expect(wsUrlValues.some((value) => value === null)).toBe(true);
    });
  });

  it('shows retry action with terminal connection error messaging', async () => {
    mocks.getTerminalToken.mockRejectedValueOnce(new Error('Workspace not found or has no VM IP'));
    mocks.getTerminalToken.mockResolvedValueOnce({
      token: 'tok_retry',
      expiresAt: '2026-02-08T01:00:00.000Z',
      workspaceUrl: 'https://ws-ws-123.example.com',
    });

    renderWorkspace('/workspaces/ws-123');

    expect(await screen.findByText('Connection Failed')).toBeInTheDocument();
    // With R3 useTokenRefresh, the raw error message is shown directly
    expect(screen.getByText('Workspace not found or has no VM IP')).toBeInTheDocument();

    const callsBeforeRetry = mocks.getTerminalToken.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry Connection' }));

    await waitFor(() => {
      expect(mocks.getTerminalToken.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
    });
    await waitFor(() => {
      expect(screen.getByTestId('terminal')).toBeInTheDocument();
    });
  });

  it('renames workspace from the sidebar using trimmed display name', async () => {
    mocks.updateWorkspace.mockResolvedValue({
      id: 'ws-123',
      nodeId: 'node-1',
      name: 'Workspace A',
      displayName: 'Renamed Workspace',
      repository: 'octo/repo',
      branch: 'main',
      status: 'running',
      vmSize: 'small',
      vmLocation: 'nbg1',
      vmIp: null,
      lastActivityAt: null,
      errorMessage: null,
      shutdownDeadline: null,
      idleTimeoutSeconds: 0,
      createdAt: '2026-02-08T00:00:00.000Z',
      updatedAt: '2026-02-08T00:00:00.000Z',
      url: 'https://ws-ws-123.example.com',
    });

    renderWorkspace('/workspaces/ws-123');

    await waitFor(() => {
      expect(mocks.getWorkspace).toHaveBeenCalledWith('ws-123');
    });

    const input = await screen.findByDisplayValue('Workspace A');
    fireEvent.change(input, { target: { value: '  Renamed Workspace  ' } });
    fireEvent.click(screen.getByRole('button', { name: /rename/i }));

    await waitFor(() => {
      expect(mocks.updateWorkspace).toHaveBeenCalledWith('ws-123', {
        displayName: 'Renamed Workspace',
      });
    });
    expect(await screen.findByDisplayValue('Renamed Workspace')).toBeInTheDocument();
  });

  it('retries initial git status fetch and updates the header badge when retry succeeds', async () => {
    mocks.getGitStatus
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({
        staged: [{ path: 'src/app.ts', status: 'M' }],
        unstaged: [],
        untracked: [],
      });

    renderWorkspace('/workspaces/ws-123');
    await screen.findByText('Workspace A');

    await waitFor(() => {
      expect(mocks.getGitStatus).toHaveBeenCalledTimes(2);
    });

    const gitButton = screen.getByRole('button', { name: 'View git changes' });
    expect(gitButton).toHaveTextContent('1');
  });

  it('marks git status as stale in the header when refresh fails', async () => {
    mocks.getGitStatus.mockRejectedValue(new Error('still failing'));

    renderWorkspace('/workspaces/ws-123');
    await screen.findByText('Workspace A');

    await waitFor(
      () => {
        expect(
          screen.getByRole('button', { name: 'View git changes (status may be stale)' })
        ).toBeInTheDocument();
      },
      { timeout: 5000 }
    );
  });

  it('uses the only configured agent when creating a chat session from the + menu', async () => {
    mocks.createAgentSession.mockResolvedValue({
      id: 'sess-new',
      workspaceId: 'ws-123',
      status: 'running',
      label: 'Claude Code 1',
      createdAt: '2026-02-08T00:12:00.000Z',
      updatedAt: '2026-02-08T00:12:00.000Z',
      stoppedAt: null,
      errorMessage: null,
    });

    renderWorkspace('/workspaces/ws-123');
    await screen.findByText('Workspace A');

    fireEvent.click(screen.getByRole('button', { name: 'Create terminal or chat session' }));
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }));

    await waitFor(() => {
      expect(mocks.createAgentSession).toHaveBeenCalledWith('ws-123', { label: 'Claude Code 1' });
    });
  });

  it('shows agent-specific chat options when multiple configured agents are available', async () => {
    mocks.listAgents.mockResolvedValue({
      agents: [
        {
          id: 'claude-code',
          name: 'Claude Code',
          description: 'Anthropic agent',
          supportsAcp: true,
          configured: true,
          credentialHelpUrl: 'https://example.com',
        },
        {
          id: 'openai-codex',
          name: 'Codex',
          description: 'OpenAI agent',
          supportsAcp: true,
          configured: true,
          credentialHelpUrl: 'https://example.com',
        },
      ],
    });
    mocks.createAgentSession.mockResolvedValue({
      id: 'sess-codex',
      workspaceId: 'ws-123',
      status: 'running',
      label: 'Codex 1',
      createdAt: '2026-02-08T00:12:00.000Z',
      updatedAt: '2026-02-08T00:12:00.000Z',
      stoppedAt: null,
      errorMessage: null,
    });

    renderWorkspace('/workspaces/ws-123');
    await screen.findByText('Workspace A');

    fireEvent.click(screen.getByRole('button', { name: 'Create terminal or chat session' }));

    expect(screen.getByRole('button', { name: 'Terminal' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claude Code' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));

    await waitFor(() => {
      expect(mocks.createAgentSession).toHaveBeenCalledWith('ws-123', { label: 'Codex 1' });
    });
  });

  it('restores active worktree from URL search params', async () => {
    renderWorkspace('/workspaces/ws-123?worktree=%2Fworkspaces%2Frepo-wt-feature-auth', true);

    await waitFor(() => {
      expect(mocks.getWorktrees).toHaveBeenCalledWith(
        'https://ws-ws-123.example.com',
        'ws-123',
        'tok_123'
      );
    });

    expect(screen.getByRole('button', { name: /Switch worktree \(feature\/auth\)/i })).toBeInTheDocument();
    expect(screen.getByTestId('location-probe').textContent).toContain(
      'worktree=%2Fworkspaces%2Frepo-wt-feature-auth'
    );
  });

  it('clears stale files and git params when switching worktrees', async () => {
    renderWorkspace(
      '/workspaces/ws-123?worktree=%2Fworkspaces%2Frepo-wt-feature-auth&files=src%2Findex.ts&git=README.md',
      true
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Switch worktree \(feature\/auth\)/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Switch worktree \(feature\/auth\)/i }));
    fireEvent.click(screen.getByRole('button', { name: /^main \(primary\)/i }));

    await waitFor(() => {
      const probe = screen.getByTestId('location-probe').textContent ?? '';
      expect(probe).not.toContain('files=');
      expect(probe).not.toContain('git=');
      expect(probe).not.toContain('worktree=');
    });
  });

  describe('orphaned session recovery', () => {
    it('shows orphaned sessions as tabs when hostStatus is alive but status is not running', async () => {
      // Live endpoint returns a session with status='stopped' but hostStatus='ready'
      mocks.listAgentSessionsLive.mockResolvedValue([
        {
          id: 'sess-orphan',
          workspaceId: 'ws-123',
          status: 'stopped',
          hostStatus: 'ready',
          label: 'Orphaned Chat',
          createdAt: '2026-02-08T00:10:00.000Z',
          updatedAt: '2026-02-08T00:10:00.000Z',
          stoppedAt: '2026-02-08T00:11:00.000Z',
        },
      ]);

      renderWorkspace('/workspaces/ws-123');

      // The orphaned session should appear as a tab
      await waitFor(() => {
        expect(screen.getByRole('tab', { name: 'Chat tab: Orphaned Chat' })).toBeInTheDocument();
      });

      // Should show the recovery banner
      expect(screen.getByText(/Recovered 1 hidden session still running on VM/)).toBeInTheDocument();

      // Should auto-resume in DB
      await waitFor(() => {
        expect(mocks.resumeAgentSession).toHaveBeenCalledWith('ws-123', 'sess-orphan');
      });
    });

    it('dismisses orphaned sessions banner when dismiss is clicked', async () => {
      mocks.listAgentSessionsLive.mockResolvedValue([
        {
          id: 'sess-orphan',
          workspaceId: 'ws-123',
          status: 'stopped',
          hostStatus: 'ready',
          label: 'Orphaned Chat',
          createdAt: '2026-02-08T00:10:00.000Z',
          updatedAt: '2026-02-08T00:10:00.000Z',
        },
      ]);

      renderWorkspace('/workspaces/ws-123');

      await waitFor(() => {
        expect(screen.getByText(/Recovered.*hidden session/)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Dismiss orphaned sessions banner' }));
      expect(screen.queryByText(/Recovered.*hidden session/)).not.toBeInTheDocument();
    });
  });

  describe('mobile sidebar menu', () => {
    it('does NOT show mobile menu button on desktop viewport', async () => {
      renderWorkspace('/workspaces/ws-123');
      await screen.findByText('Workspace A');

      expect(screen.queryByRole('button', { name: 'Open workspace menu' })).not.toBeInTheDocument();
    });

    it('shows mobile menu button on mobile viewport', async () => {
      setMobileViewport();
      renderWorkspace('/workspaces/ws-123');
      await screen.findByText('Workspace A');

      expect(screen.getByRole('button', { name: 'Open workspace menu' })).toBeInTheDocument();
    });

    it('shows command palette button on mobile viewport', async () => {
      setMobileViewport();
      renderWorkspace('/workspaces/ws-123');
      await screen.findByText('Workspace A');

      expect(screen.getByRole('button', { name: 'Open command palette' })).toBeInTheDocument();
    });

    it('opens command palette when mobile button is tapped', async () => {
      setMobileViewport();
      renderWorkspace('/workspaces/ws-123');
      await screen.findByText('Workspace A');

      fireEvent.click(screen.getByRole('button', { name: 'Open command palette' }));
      expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    });

    it('opens overlay with rename and events sections when menu button is clicked', async () => {
      mocks.listWorkspaceEvents.mockResolvedValue({
        events: [
          {
            id: 'evt-1',
            type: 'workspace.created',
            message: 'Workspace created',
            createdAt: '2026-02-08T00:00:00.000Z',
          },
        ],
        nextCursor: null,
      });
      setMobileViewport();
      renderWorkspace('/workspaces/ws-123');
      await screen.findByText('Workspace A');

      // Wait for events to load (fetched from VM Agent after terminal token is available)
      await waitFor(() => {
        expect(mocks.listWorkspaceEvents).toHaveBeenCalled();
      });

      // No overlay initially
      expect(screen.queryByRole('dialog', { name: 'Workspace menu' })).not.toBeInTheDocument();

      // Click the menu button
      fireEvent.click(screen.getByRole('button', { name: 'Open workspace menu' }));

      // Overlay should now be visible
      expect(screen.getByRole('dialog', { name: 'Workspace menu' })).toBeInTheDocument();

      // Should contain rename section
      expect(screen.getByDisplayValue('Workspace A')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /rename/i })).toBeInTheDocument();

      // Should contain events section (collapsed by default — header visible, content hidden)
      expect(screen.getByText(/Events/)).toBeInTheDocument();
    });

    it('closes overlay when close button is clicked', async () => {
      setMobileViewport();
      renderWorkspace('/workspaces/ws-123');
      await screen.findByText('Workspace A');

      fireEvent.click(screen.getByRole('button', { name: 'Open workspace menu' }));
      expect(screen.getByRole('dialog', { name: 'Workspace menu' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Close workspace menu' }));
      expect(screen.queryByRole('dialog', { name: 'Workspace menu' })).not.toBeInTheDocument();
    });

    it('closes overlay when backdrop is clicked', async () => {
      setMobileViewport();
      renderWorkspace('/workspaces/ws-123');
      await screen.findByText('Workspace A');

      fireEvent.click(screen.getByRole('button', { name: 'Open workspace menu' }));
      expect(screen.getByRole('dialog', { name: 'Workspace menu' })).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('mobile-menu-backdrop'));
      expect(screen.queryByRole('dialog', { name: 'Workspace menu' })).not.toBeInTheDocument();
    });

    it('closes overlay on Escape key press', async () => {
      setMobileViewport();
      renderWorkspace('/workspaces/ws-123');
      await screen.findByText('Workspace A');

      fireEvent.click(screen.getByRole('button', { name: 'Open workspace menu' }));
      expect(screen.getByRole('dialog', { name: 'Workspace menu' })).toBeInTheDocument();

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('dialog', { name: 'Workspace menu' })).not.toBeInTheDocument();
    });
  });
});
