import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { WorkspaceCard } from '../../../src/components/WorkspaceCard';
import { useIsMobile } from '../../../src/hooks/useIsMobile';
import type { WorkspaceResponse } from '@simple-agent-manager/shared';

vi.mock('../../../src/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(),
}));

const workspace: WorkspaceResponse = {
  id: '01KTESTWORKSPACEID0000000000000',
  name: 'Test Workspace',
  repository: 'acme/repo',
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
  url: 'https://ws-01ktestworkspaceid0000000000000.simple-agent-manager.org',
};

const mockUseIsMobile = vi.mocked(useIsMobile);

describe('WorkspaceCard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUseIsMobile.mockReturnValue(false);
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
    expect(openSpy).not.toHaveBeenCalledWith(workspace.url, '_blank');
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

  it('uses 56px touch targets for mobile actions', () => {
    mockUseIsMobile.mockReturnValue(true);

    render(
      <MemoryRouter>
        <WorkspaceCard workspace={workspace} onStop={() => undefined} />
      </MemoryRouter>
    );

    expect(screen.getByRole('button', { name: 'Open' })).toHaveStyle({
      minHeight: '56px',
      minWidth: '120px',
    });
    expect(screen.getByRole('button', { name: 'Stop' })).toHaveStyle({
      minHeight: '56px',
      minWidth: '120px',
    });
  });
});
