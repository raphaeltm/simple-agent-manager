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
  updateWorkspace: vi.fn(),
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
  updateWorkspace: mocks.updateWorkspace,
}));

vi.mock('@simple-agent-manager/terminal', () => ({
  Terminal: () => <div data-testid="terminal">terminal</div>,
  MultiTerminal: () => <div data-testid="multi-terminal">multi-terminal</div>,
}));

vi.mock('@simple-agent-manager/acp-client', () => ({
  useAcpMessages: () => ({ processMessage: vi.fn() }),
  useAcpSession: () => ({
    state: 'no_session',
    agentType: null,
    switchAgent: vi.fn(),
  }),
  AgentPanel: () => <div data-testid="agent-panel">agent-panel</div>,
}));

vi.mock('../../../src/components/UserMenu', () => ({ UserMenu: () => <div data-testid="user-menu" /> }));
vi.mock('../../../src/components/AgentSelector', () => ({ AgentSelector: () => <div data-testid="agent-selector" /> }));
vi.mock('../../../src/components/AgentSessionList', () => ({
  AgentSessionList: ({
    sessions,
    loading,
    onCreate,
    onAttach,
    onStop,
  }: {
    sessions: Array<{ id: string; label?: string | null }>;
    loading?: boolean;
    onCreate: () => void;
    onAttach: (sessionId: string) => void;
    onStop: (sessionId: string) => void;
  }) => (
    <div data-testid="agent-session-list">
      <button onClick={onCreate} disabled={loading}>new-session</button>
      {sessions.map((session) => (
        <div key={session.id}>
          <span>{session.label || session.id}</span>
          <button onClick={() => onAttach(session.id)}>attach-{session.id}</button>
          <button onClick={() => onStop(session.id)}>stop-{session.id}</button>
        </div>
      ))}
    </div>
  ),
}));
vi.mock('../../../src/components/MobileBottomBar', () => ({ MobileBottomBar: () => null }));
vi.mock('../../../src/components/MobileOverflowMenu', () => ({ MobileOverflowMenu: () => null }));

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
          element={includeProbe ? (
            <>
              <Workspace />
              <LocationProbe />
            </>
          ) : (
            <Workspace />
          )}
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('Workspace page', () => {
  beforeEach(() => {
    vi.clearAllMocks();

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
    expect(screen.getByTestId('agent-session-list')).toBeInTheDocument();
  });

  it('supports session list + attach flow and updates workspace query string', async () => {
    mocks.listAgentSessions.mockResolvedValue([
      {
        id: 'sess-1',
        workspaceId: 'ws-123',
        status: 'running',
        createdAt: '2026-02-08T00:10:00.000Z',
        updatedAt: '2026-02-08T00:10:00.000Z',
      },
    ]);

    renderWorkspace('/workspaces/ws-123', true);

    await waitFor(() => {
      expect(mocks.listAgentSessions).toHaveBeenCalledWith('ws-123');
    });

    fireEvent.click(await screen.findByRole('button', { name: 'attach-sess-1' }));

    await waitFor(() => {
      const probe = screen.getByTestId('location-probe');
      expect(probe.textContent).toContain('/workspaces/ws-123?');
      expect(probe.textContent).toContain('view=conversation');
      expect(probe.textContent).toContain('sessionId=sess-1');
    });
  });

  it('shows retry action with friendly terminal connection error messaging', async () => {
    mocks.getTerminalToken.mockRejectedValueOnce(new Error('Workspace not found or has no VM IP'));
    mocks.getTerminalToken.mockResolvedValueOnce({
      token: 'tok_retry',
      expiresAt: '2026-02-08T01:00:00.000Z',
      workspaceUrl: 'https://ws-ws-123.example.com',
    });

    renderWorkspace('/workspaces/ws-123');

    expect(await screen.findByText('Connection Failed')).toBeInTheDocument();
    expect(screen.getByText('Unable to establish terminal connection right now. Please retry.')).toBeInTheDocument();
    expect(screen.queryByText('Workspace not found or has no VM IP')).not.toBeInTheDocument();

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
      expect(mocks.updateWorkspace).toHaveBeenCalledWith('ws-123', { displayName: 'Renamed Workspace' });
    });
    expect(await screen.findByDisplayValue('Renamed Workspace')).toBeInTheDocument();
  });
});
