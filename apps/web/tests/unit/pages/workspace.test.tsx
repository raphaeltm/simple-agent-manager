import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  getWorkspace: vi.fn(),
  getTerminalToken: vi.fn(),
  stopWorkspace: vi.fn(),
  restartWorkspace: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  getWorkspace: mocks.getWorkspace,
  getTerminalToken: mocks.getTerminalToken,
  stopWorkspace: mocks.stopWorkspace,
  restartWorkspace: mocks.restartWorkspace,
}));

vi.mock('@simple-agent-manager/terminal', () => ({
  Terminal: () => <div data-testid="terminal">terminal</div>,
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

vi.mock('../../../src/components/UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu">user-menu</div>,
}));

vi.mock('../../../src/components/AgentSelector', () => ({
  AgentSelector: () => <div data-testid="agent-selector">agent-selector</div>,
}));

import { Workspace } from '../../../src/pages/Workspace';

function renderWorkspace(initialEntry = '/workspaces/ws-123') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/workspaces/:id" element={<Workspace />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('Workspace page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorkspace.mockResolvedValue({
      id: 'ws-123',
      name: 'Test Workspace',
      repository: 'octo/repo',
      branch: 'main',
      status: 'running',
      vmSize: 'small',
      vmLocation: 'nbg1',
      vmIp: '203.0.113.10',
      lastActivityAt: null,
      errorMessage: null,
      shutdownDeadline: null,
      createdAt: '2026-02-08T00:00:00.000Z',
      updatedAt: '2026-02-08T00:00:00.000Z',
      url: 'https://ws-ws-123.example.com',
    });
    mocks.getTerminalToken.mockResolvedValue({
      token: 'tok_123',
      expiresAt: '2026-02-08T01:00:00.000Z',
      workspaceUrl: 'https://ws-ws-123.example.com',
    });
  });

  it('opens a new terminal tab with view=terminal', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({} as unknown as Window);

    renderWorkspace('/workspaces/ws-123');

    await waitFor(() => {
      expect(mocks.getWorkspace).toHaveBeenCalledWith('ws-123');
    });

    fireEvent.click(await screen.findByRole('button', { name: 'New Terminal Tab' }));

    expect(openSpy).toHaveBeenCalledWith('/workspaces/ws-123?view=terminal', '_blank');
  });
});

