import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { WorkspaceCard } from '../../../src/components/WorkspaceCard';
import { useIsStandalone } from '../../../src/hooks/useIsStandalone';
import type { WorkspaceResponse } from '@simple-agent-manager/shared';

vi.mock('../../../src/hooks/useIsStandalone', () => ({
  useIsStandalone: vi.fn(),
}));

const workspace: WorkspaceResponse = {
  id: '01KTESTWORKSPACEID0000000000000',
  name: 'Test Workspace',
  displayName: 'Test Workspace',
  repository: 'acme/repo',
  branch: 'main',
  status: 'running',
  vmSize: 'small',
  vmLocation: 'nbg1',
  nodeId: 'node-1',
  userId: 'user-1',
  projectId: null,
  lastActivityAt: null,
  errorMessage: null,
  createdAt: '2026-02-08T00:00:00.000Z',
  updatedAt: '2026-02-08T00:00:00.000Z',
};

const mockUseIsStandalone = vi.mocked(useIsStandalone);

describe('WorkspaceCard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUseIsStandalone.mockReturnValue(false);
  });

  it('opens the control plane workspace page (not the ws-* URL)', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({} as unknown as Window);

    render(
      <MemoryRouter>
        <WorkspaceCard workspace={workspace} />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(openSpy).toHaveBeenCalledWith(
      `/workspaces/${workspace.id}`,
      '_blank'
    );
  });

  it('navigates when pop-ups are blocked', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<WorkspaceCard workspace={workspace} />} />
          <Route path="/workspaces/:id" element={<div>Workspace page</div>} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(screen.getByText('Workspace page')).toBeInTheDocument();
  });

  it('shows Stop action in overflow menu for running workspace', async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(
      <MemoryRouter>
        <WorkspaceCard workspace={workspace} onStop={onStop} />
      </MemoryRouter>
    );

    const trigger = screen.getByRole('button', { name: /actions for/i });
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Stop' }));

    expect(onStop).toHaveBeenCalledWith(workspace.id);
  });

  it('treats recovery workspaces as active and shows Open button', () => {
    const recoveryWorkspace: WorkspaceResponse = { ...workspace, status: 'recovery' };

    render(
      <MemoryRouter>
        <WorkspaceCard workspace={recoveryWorkspace} onStop={() => undefined} />
      </MemoryRouter>
    );

    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });

  it('navigates in-place in PWA standalone mode instead of opening new tab', () => {
    mockUseIsStandalone.mockReturnValue(true);
    const openSpy = vi.spyOn(window, 'open');

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<WorkspaceCard workspace={workspace} />} />
          <Route path="/workspaces/:id" element={<div>Workspace page</div>} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.getByText('Workspace page')).toBeInTheDocument();
  });

  it('opens new tab in normal browser mode', () => {
    mockUseIsStandalone.mockReturnValue(false);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({} as unknown as Window);

    render(
      <MemoryRouter>
        <WorkspaceCard workspace={workspace} />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(openSpy).toHaveBeenCalledWith(`/workspaces/${workspace.id}`, '_blank');
  });
});
