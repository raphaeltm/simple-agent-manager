import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceCard } from '../../src/components/WorkspaceCard';
import type { WorkspaceResponse } from '@simple-agent-manager/shared';

// Mock useIsStandalone
vi.mock('../../src/hooks/useIsStandalone', () => ({
  useIsStandalone: () => false,
}));

function makeWorkspace(overrides: Partial<WorkspaceResponse> = {}): WorkspaceResponse {
  return {
    id: 'ws-1',
    name: 'test-workspace',
    displayName: 'Test Workspace',
    status: 'running',
    repository: 'owner/repo',
    branch: 'main',
    nodeId: 'node-1',
    userId: 'user-1',
    projectId: null,
    vmSize: 'cx22',
    vmLocation: 'fsn1',
    lastActivityAt: '2026-01-15T12:00:00Z',
    errorMessage: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-15T12:00:00Z',
    ...overrides,
  };
}

function renderCard(
  workspace: WorkspaceResponse,
  handlers: {
    onStop?: (id: string) => void;
    onRestart?: (id: string) => void;
    onDelete?: (id: string) => void;
  } = {},
) {
  return render(
    <MemoryRouter>
      <WorkspaceCard
        workspace={workspace}
        onStop={handlers.onStop}
        onRestart={handlers.onRestart}
        onDelete={handlers.onDelete}
      />
    </MemoryRouter>,
  );
}

describe('WorkspaceCard', () => {
  let onStop: ReturnType<typeof vi.fn>;
  let onRestart: ReturnType<typeof vi.fn>;
  let onDelete: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onStop = vi.fn();
    onRestart = vi.fn();
    onDelete = vi.fn();
  });

  it('renders workspace display name and branch', () => {
    renderCard(makeWorkspace());
    expect(screen.getByText('Test Workspace')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
  });

  it('renders repository name', () => {
    renderCard(makeWorkspace());
    expect(screen.getByText(/owner\/repo/)).toBeInTheDocument();
  });

  it('shows "Open" primary action for running workspace', () => {
    renderCard(makeWorkspace({ status: 'running' }), { onStop, onDelete });
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });

  it('shows "Start" primary action for stopped workspace', () => {
    renderCard(makeWorkspace({ status: 'stopped' }), { onRestart, onDelete });
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
  });

  it('shows "Please wait..." for transitional states', () => {
    renderCard(makeWorkspace({ status: 'creating' }), { onDelete });
    expect(screen.getByText('Please wait...')).toBeInTheDocument();
  });

  it('renders overflow menu with Stop and Delete for running workspace', async () => {
    const user = userEvent.setup();
    renderCard(makeWorkspace({ status: 'running' }), { onStop, onDelete });

    // Find and click the overflow trigger
    const trigger = screen.getByRole('button', { name: /actions for/i });
    await user.click(trigger);

    expect(screen.getByRole('menuitem', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('renders overflow menu with Restart and Delete for stopped workspace', async () => {
    const user = userEvent.setup();
    renderCard(makeWorkspace({ status: 'stopped' }), { onRestart, onDelete });

    const trigger = screen.getByRole('button', { name: /actions for/i });
    await user.click(trigger);

    expect(screen.getByRole('menuitem', { name: 'Restart' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('calls onStop when Stop is clicked in overflow menu', async () => {
    const user = userEvent.setup();
    renderCard(makeWorkspace({ status: 'running' }), { onStop, onDelete });

    const trigger = screen.getByRole('button', { name: /actions for/i });
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Stop' }));

    expect(onStop).toHaveBeenCalledWith('ws-1');
  });

  it('disables Delete action for transitional workspace states', async () => {
    const user = userEvent.setup();
    renderCard(makeWorkspace({ status: 'creating' }), { onDelete });

    const trigger = screen.getByRole('button', { name: /actions for/i });
    await user.click(trigger);

    const deleteItem = screen.getByRole('menuitem', { name: 'Delete' });
    expect(deleteItem).toHaveAttribute('aria-disabled', 'true');
  });

  it('renders error message when present', () => {
    renderCard(makeWorkspace({ errorMessage: 'VM failed to start' }));
    expect(screen.getByText('VM failed to start')).toBeInTheDocument();
  });

  it('falls back to workspace name when displayName is null', () => {
    renderCard(makeWorkspace({ displayName: null, name: 'ws-fallback' }));
    expect(screen.getByText('ws-fallback')).toBeInTheDocument();
  });
});
