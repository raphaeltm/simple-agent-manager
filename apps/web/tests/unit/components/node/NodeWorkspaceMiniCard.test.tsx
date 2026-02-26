import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { NodeWorkspaceMiniCard } from '../../../../src/components/node/NodeWorkspaceMiniCard';
import { useIsStandalone } from '../../../../src/hooks/useIsStandalone';
import type { WorkspaceResponse } from '@simple-agent-manager/shared';

vi.mock('../../../../src/hooks/useIsStandalone', () => ({
  useIsStandalone: vi.fn(),
}));

const mockUseIsStandalone = vi.mocked(useIsStandalone);

const createWorkspace = (overrides?: Partial<WorkspaceResponse>): WorkspaceResponse => ({
  id: 'ws-123',
  name: 'test-workspace',
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
  createdAt: '2026-02-26T00:00:00.000Z',
  updatedAt: '2026-02-26T00:00:00.000Z',
  ...overrides,
});

describe('NodeWorkspaceMiniCard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUseIsStandalone.mockReturnValue(false);
  });

  describe('Status display', () => {
    it('renders workspace status badge', () => {
      const workspace = createWorkspace({ status: 'running' });
      render(
        <MemoryRouter>
          <NodeWorkspaceMiniCard workspace={workspace} />
        </MemoryRouter>
      );

      // StatusBadge component renders the status
      expect(screen.getByText(/running/i)).toBeInTheDocument();
    });

    it('shows status for stopped workspace', () => {
      const workspace = createWorkspace({ status: 'stopped' });
      render(
        <MemoryRouter>
          <NodeWorkspaceMiniCard workspace={workspace} />
        </MemoryRouter>
      );

      expect(screen.getByText(/stopped/i)).toBeInTheDocument();
    });

    it('shows status for creating workspace', () => {
      const workspace = createWorkspace({ status: 'creating' });
      render(
        <MemoryRouter>
          <NodeWorkspaceMiniCard workspace={workspace} />
        </MemoryRouter>
      );

      expect(screen.getByText(/creating/i)).toBeInTheDocument();
    });
  });

  describe('Name and branch display', () => {
    it('displays displayName when available', () => {
      const workspace = createWorkspace({
        name: 'technical-name',
        displayName: 'Human Readable Name',
        branch: 'feature/cool-stuff',
      });

      render(
        <MemoryRouter>
          <NodeWorkspaceMiniCard workspace={workspace} />
        </MemoryRouter>
      );

      expect(screen.getByText('Human Readable Name')).toBeInTheDocument();
      expect(screen.queryByText('technical-name')).not.toBeInTheDocument();
    });

    it('falls back to name when displayName is null', () => {
      const workspace = createWorkspace({
        name: 'technical-name',
        displayName: null,
        branch: 'main',
      });

      render(
        <MemoryRouter>
          <NodeWorkspaceMiniCard workspace={workspace} />
        </MemoryRouter>
      );

      expect(screen.getByText('technical-name')).toBeInTheDocument();
    });

    it('displays branch name when present', () => {
      const workspace = createWorkspace({ branch: 'feature/new-stuff' });

      render(
        <MemoryRouter>
          <NodeWorkspaceMiniCard workspace={workspace} />
        </MemoryRouter>
      );

      expect(screen.getByText('feature/new-stuff')).toBeInTheDocument();
    });

    it('does not render branch when null', () => {
      const workspace = createWorkspace({ branch: null });

      render(
        <MemoryRouter>
          <NodeWorkspaceMiniCard workspace={workspace} />
        </MemoryRouter>
      );

      // Only one text element should be visible (the name)
      expect(screen.queryByText(/\//)).not.toBeInTheDocument();
    });
  });

  describe('Open button conditional rendering', () => {
    it('shows Open button when workspace status is running', () => {
      const workspace = createWorkspace({ status: 'running' });

      render(
        <MemoryRouter>
          <NodeWorkspaceMiniCard workspace={workspace} />
        </MemoryRouter>
      );

      expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
    });

    it('shows Open button when workspace status is recovery', () => {
      const workspace = createWorkspace({ status: 'recovery' });

      render(
        <MemoryRouter>
          <NodeWorkspaceMiniCard workspace={workspace} />
        </MemoryRouter>
      );

      expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
    });

    it('does not show Open button for stopped workspace', () => {
      const workspace = createWorkspace({ status: 'stopped' });

      render(
        <MemoryRouter>
          <NodeWorkspaceMiniCard workspace={workspace} />
        </MemoryRouter>
      );

      expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
    });

    it('does not show Open button for creating workspace', () => {
      const workspace = createWorkspace({ status: 'creating' });

      render(
        <MemoryRouter>
          <NodeWorkspaceMiniCard workspace={workspace} />
        </MemoryRouter>
      );

      expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
    });

    it('does not show Open button for stopping workspace', () => {
      const workspace = createWorkspace({ status: 'stopping' });

      render(
        <MemoryRouter>
          <NodeWorkspaceMiniCard workspace={workspace} />
        </MemoryRouter>
      );

      expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
    });
  });

  describe('Open button behavior', () => {
    it('opens workspace in new tab in browser mode', () => {
      mockUseIsStandalone.mockReturnValue(false);
      const openSpy = vi.spyOn(window, 'open').mockReturnValue({} as unknown as Window);
      const workspace = createWorkspace({ status: 'running' });

      render(
        <MemoryRouter>
          <NodeWorkspaceMiniCard workspace={workspace} />
        </MemoryRouter>
      );

      fireEvent.click(screen.getByRole('button', { name: 'Open' }));

      expect(openSpy).toHaveBeenCalledWith('/workspaces/ws-123', '_blank', 'noopener,noreferrer');
    });

    it('navigates in-place in standalone PWA mode', () => {
      mockUseIsStandalone.mockReturnValue(true);
      const openSpy = vi.spyOn(window, 'open');
      const workspace = createWorkspace({ status: 'running' });

      render(
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<NodeWorkspaceMiniCard workspace={workspace} />} />
            <Route path="/workspaces/:id" element={<div>Workspace Page</div>} />
          </Routes>
        </MemoryRouter>
      );

      fireEvent.click(screen.getByRole('button', { name: 'Open' }));

      expect(openSpy).not.toHaveBeenCalled();
      expect(screen.getByText('Workspace Page')).toBeInTheDocument();
    });

    it('navigates when popup is blocked', () => {
      mockUseIsStandalone.mockReturnValue(false);
      vi.spyOn(window, 'open').mockReturnValue(null);
      const workspace = createWorkspace({ status: 'running' });

      render(
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<NodeWorkspaceMiniCard workspace={workspace} />} />
            <Route path="/workspaces/:id" element={<div>Workspace Page</div>} />
          </Routes>
        </MemoryRouter>
      );

      fireEvent.click(screen.getByRole('button', { name: 'Open' }));

      expect(screen.getByText('Workspace Page')).toBeInTheDocument();
    });

    it('stops event propagation when Open is clicked', () => {
      const workspace = createWorkspace({ status: 'running' });
      const onClickParent = vi.fn();
      vi.spyOn(window, 'open').mockReturnValue({} as unknown as Window);

      render(
        <MemoryRouter>
          <div onClick={onClickParent}>
            <NodeWorkspaceMiniCard workspace={workspace} />
          </div>
        </MemoryRouter>
      );

      fireEvent.click(screen.getByRole('button', { name: 'Open' }));

      expect(onClickParent).not.toHaveBeenCalled();
    });
  });

  describe('Accessibility', () => {
    it('has proper semantic structure', () => {
      const workspace = createWorkspace({ status: 'running' });

      render(
        <MemoryRouter>
          <NodeWorkspaceMiniCard workspace={workspace} />
        </MemoryRouter>
      );

      // Button should have accessible name
      const button = screen.getByRole('button', { name: 'Open' });
      expect(button).toBeInTheDocument();
    });
  });
});
