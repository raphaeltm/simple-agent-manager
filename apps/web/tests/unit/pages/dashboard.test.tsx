import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  listWorkspaces: vi.fn(),
  stopWorkspace: vi.fn(),
  restartWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  listWorkspaces: mocks.listWorkspaces,
  stopWorkspace: mocks.stopWorkspace,
  restartWorkspace: mocks.restartWorkspace,
  deleteWorkspace: mocks.deleteWorkspace,
}));

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({
    user: {
      id: 'user_123',
      email: 'dev@example.com',
      name: 'Dev User',
    },
  }),
}));

vi.mock('../../../src/components/UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu">user-menu</div>,
}));

vi.mock('../../../src/components/WorkspaceCard', () => ({
  WorkspaceCard: () => <div data-testid="workspace-card">workspace-card</div>,
}));

vi.mock('../../../src/components/ConfirmDialog', () => ({
  ConfirmDialog: () => null,
}));

import { Dashboard } from '../../../src/pages/Dashboard';
import { ToastProvider } from '../../../src/hooks/useToast';

describe('Dashboard page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listWorkspaces.mockResolvedValue([]);
  });

  it('does not render UI standards quick action', async () => {
    render(
      <ToastProvider>
        <MemoryRouter>
          <Dashboard />
        </MemoryRouter>
      </ToastProvider>
    );

    await waitFor(() => {
      expect(mocks.listWorkspaces).toHaveBeenCalled();
    });

    expect(screen.getByRole('button', { name: 'New Workspace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'UI Standards' })).not.toBeInTheDocument();
  });
});
