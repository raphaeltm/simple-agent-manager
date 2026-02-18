import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  getWorkspace: vi.fn(),
  getTerminalToken: vi.fn(),
  listAgentSessions: vi.fn(),
  listWorkspaceEvents: vi.fn(),
  listAgents: vi.fn(),
  getGitStatus: vi.fn(),
  stopWorkspace: vi.fn(),
  restartWorkspace: vi.fn(),
  rebuildWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  createAgentSession: vi.fn(),
  stopAgentSession: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  getWorkspace: mocks.getWorkspace,
  getTerminalToken: mocks.getTerminalToken,
  listAgentSessions: mocks.listAgentSessions,
  listWorkspaceEvents: mocks.listWorkspaceEvents,
  listAgents: mocks.listAgents,
  getGitStatus: mocks.getGitStatus,
  stopWorkspace: mocks.stopWorkspace,
  restartWorkspace: mocks.restartWorkspace,
  rebuildWorkspace: mocks.rebuildWorkspace,
  updateWorkspace: mocks.updateWorkspace,
  createAgentSession: mocks.createAgentSession,
  stopAgentSession: mocks.stopAgentSession,
  ApiClientError: class ApiClientError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('../../../src/components/UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));

vi.mock('../../../src/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('../../../src/config/features', () => ({
  useFeatureFlags: () => ({}),
}));

vi.mock('@simple-agent-manager/terminal', () => ({
  Terminal: () => <div data-testid="terminal" />,
  MultiTerminal: () => <div data-testid="multi-terminal" />,
}));

import { Workspace } from '../../../src/pages/Workspace';

describe('Workspace toolbar declutter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorkspace.mockResolvedValue({
      id: 'ws-1',
      nodeId: 'node-1',
      name: 'test-workspace',
      displayName: 'Test Workspace',
      repository: 'acme/repo',
      branch: 'main',
      status: 'running',
      vmSize: 'medium',
      vmLocation: 'nbg1',
      vmIp: null,
      lastActivityAt: null,
      errorMessage: null,
      shutdownDeadline: null,
      idleTimeoutSeconds: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      url: 'https://ws-ws-1.example.com',
    });
    mocks.getTerminalToken.mockResolvedValue({ token: 'test-token' });
    mocks.listAgentSessions.mockResolvedValue([]);
    mocks.listWorkspaceEvents.mockResolvedValue({ events: [], nextCursor: null });
    mocks.listAgents.mockResolvedValue([]);
    mocks.getGitStatus.mockResolvedValue({ staged: [], unstaged: [], untracked: [] });
  });

  async function renderWorkspace() {
    const result = render(
      <MemoryRouter initialEntries={['/workspaces/ws-1']}>
        <Routes>
          <Route path="/workspaces/:id" element={<Workspace />} />
        </Routes>
      </MemoryRouter>
    );

    // Wait for workspace to load
    await screen.findByText('Test Workspace');
    return result;
  }

  it('does not render Stop/Rebuild buttons in the toolbar header', async () => {
    await renderWorkspace();

    // The header/toolbar is a <header> element
    const header = document.querySelector('header');
    expect(header).not.toBeNull();

    const headerScope = within(header!);

    // Stop and Rebuild should NOT be in the toolbar
    const headerButtons = headerScope.queryAllByRole('button');
    const headerButtonTexts = headerButtons.map(b => b.textContent?.trim());
    expect(headerButtonTexts).not.toContain('Stop');
    expect(headerButtonTexts).not.toContain('Rebuild');
  });

  it('renders Stop and Rebuild buttons in the sidebar for a running workspace', async () => {
    await renderWorkspace();

    // The sidebar contains workspace rename and lifecycle actions
    // Look for Stop and Rebuild buttons anywhere in the page (they should be in sidebar)
    const allButtons = screen.getAllByRole('button');
    const buttonTexts = allButtons.map(b => b.textContent?.trim());

    expect(buttonTexts).toContain('Stop');
    expect(buttonTexts).toContain('Rebuild');
  });

  it('renders Stop and Rebuild buttons in the sidebar for a recovery workspace', async () => {
    mocks.getWorkspace.mockResolvedValue({
      id: 'ws-1',
      nodeId: 'node-1',
      name: 'test-workspace',
      displayName: 'Test Workspace',
      repository: 'acme/repo',
      branch: 'main',
      status: 'recovery',
      vmSize: 'medium',
      vmLocation: 'nbg1',
      vmIp: null,
      lastActivityAt: null,
      errorMessage: null,
      shutdownDeadline: null,
      idleTimeoutSeconds: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      url: 'https://ws-ws-1.example.com',
    });

    await renderWorkspace();

    const allButtons = screen.getAllByRole('button');
    const buttonTexts = allButtons.map((b) => b.textContent?.trim());

    expect(buttonTexts).toContain('Stop');
    expect(buttonTexts).toContain('Rebuild');
  });

  it('renders Restart button in the sidebar for a stopped workspace', async () => {
    mocks.getWorkspace.mockResolvedValue({
      id: 'ws-1',
      nodeId: 'node-1',
      name: 'test-workspace',
      displayName: 'Test Workspace',
      repository: 'acme/repo',
      branch: 'main',
      status: 'stopped',
      vmSize: 'medium',
      vmLocation: 'nbg1',
      vmIp: null,
      lastActivityAt: null,
      errorMessage: null,
      shutdownDeadline: null,
      idleTimeoutSeconds: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      url: 'https://ws-ws-1.example.com',
    });

    await renderWorkspace();

    // Restart should be present (in sidebar) but not in toolbar
    const header = document.querySelector('header');
    expect(header).not.toBeNull();

    const headerScope = within(header!);
    const headerButtons = headerScope.queryAllByRole('button');
    const headerButtonTexts = headerButtons.map(b => b.textContent?.trim());
    expect(headerButtonTexts).not.toContain('Restart');

    // But Restart should be somewhere on the page (sidebar or centered status)
    const allButtons = screen.getAllByRole('button');
    const allButtonTexts = allButtons.map(b => b.textContent?.trim());
    expect(allButtonTexts.some(t => t?.includes('Restart'))).toBe(true);
  });
});
