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
  listAgents: vi.fn(),
  useAcpSession: vi.fn(),
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
  listAgents: mocks.listAgents,
}));

vi.mock('@simple-agent-manager/terminal', () => ({
  Terminal: () => <div data-testid="terminal">terminal</div>,
  MultiTerminal: () => <div data-testid="multi-terminal">multi-terminal</div>,
}));

vi.mock('@simple-agent-manager/acp-client', () => ({
  useAcpMessages: () => ({ processMessage: vi.fn(), items: [] }),
  useAcpSession: mocks.useAcpSession,
  AgentPanel: () => <div data-testid="agent-panel">agent-panel</div>,
}));

vi.mock('../../../src/components/UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu" />,
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

describe('Workspace page', () => {
  beforeEach(() => {
    vi.clearAllMocks();

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
    expect(screen.getByText('Workspace Events')).toBeInTheDocument();
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
    mocks.listAgentSessions.mockResolvedValueOnce([
      {
        id: 'sess-tab',
        workspaceId: 'ws-123',
        status: 'running',
        label: 'Claude Code Chat',
        createdAt: '2026-02-08T00:10:00.000Z',
        updatedAt: '2026-02-08T00:10:00.000Z',
      },
    ]);
    mocks.listAgentSessions.mockResolvedValueOnce([
      {
        id: 'sess-tab',
        workspaceId: 'ws-123',
        status: 'running',
        label: 'Claude Code Chat',
        createdAt: '2026-02-08T00:10:00.000Z',
        updatedAt: '2026-02-08T00:10:00.000Z',
      },
    ]);
    mocks.listAgentSessions.mockResolvedValueOnce([]);

    renderWorkspace('/workspaces/ws-123?view=conversation&sessionId=sess-tab', true);

    expect(await screen.findByRole('tablist', { name: 'Workspace sessions' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Stop Claude Code Chat' }));

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

  it('adds takeover flag to ACP websocket URL when a sessionId is selected', async () => {
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
      const wsUrls = mocks.useAcpSession.mock.calls
        .map(([options]) => options?.wsUrl)
        .filter((value): value is string => typeof value === 'string');
      expect(
        wsUrls.some((url) => url.includes('sessionId=sess-1') && url.includes('takeover=1'))
      ).toBe(true);
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
    expect(
      screen.getByText('Unable to establish terminal connection right now. Please retry.')
    ).toBeInTheDocument();
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
      expect(mocks.updateWorkspace).toHaveBeenCalledWith('ws-123', {
        displayName: 'Renamed Workspace',
      });
    });
    expect(await screen.findByDisplayValue('Renamed Workspace')).toBeInTheDocument();
  });

  it('uses the only configured agent when creating a chat session from the + menu', async () => {
    mocks.createAgentSession.mockResolvedValue({
      id: 'sess-new',
      workspaceId: 'ws-123',
      status: 'running',
      label: 'Claude Code Chat',
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
      expect(mocks.createAgentSession).toHaveBeenCalledWith(
        'ws-123',
        { label: 'Claude Code Chat' },
        expect.any(String)
      );
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
      label: 'Codex Chat',
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
      expect(mocks.createAgentSession).toHaveBeenCalledWith(
        'ws-123',
        { label: 'Codex Chat' },
        expect.any(String)
      );
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
      expect(screen.getByText('Workspace name')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Workspace A')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /rename/i })).toBeInTheDocument();

      // Should contain events section
      expect(screen.getByText('Workspace Events')).toBeInTheDocument();
      expect(screen.getByText('workspace.created')).toBeInTheDocument();
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
