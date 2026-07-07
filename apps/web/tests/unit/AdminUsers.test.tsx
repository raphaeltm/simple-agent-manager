import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  approveOrSuspendUser: vi.fn(),
  changeUserRole: vi.fn(),
  fetchSignupApprovalConfig: vi.fn(),
  listAdminUsers: vi.fn(),
  updateSignupApprovalConfig: vi.fn(),
}));

vi.mock('../../src/components/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', email: 'admin@example.com', name: 'Admin' },
  }),
}));

vi.mock('../../src/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api')>()),
  approveOrSuspendUser: mocks.approveOrSuspendUser,
  changeUserRole: mocks.changeUserRole,
  fetchSignupApprovalConfig: mocks.fetchSignupApprovalConfig,
  listAdminUsers: mocks.listAdminUsers,
  updateSignupApprovalConfig: mocks.updateSignupApprovalConfig,
}));

import { AdminUsers } from '../../src/pages/AdminUsers';

describe('AdminUsers signup approval config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAdminUsers.mockResolvedValue({
      users: [
        {
          id: 'user-1',
          email: 'pending@example.com',
          name: 'Pending User',
          avatarUrl: null,
          role: 'user',
          status: 'pending',
          createdAt: '2026-07-06T00:00:00.000Z',
        },
      ],
    });
    mocks.fetchSignupApprovalConfig.mockResolvedValue({
      config: {
        requireApproval: false,
        source: 'runtime',
        updatedAt: '2026-07-06T12:00:00.000Z',
        updatedBy: 'admin-1',
      },
    });
    mocks.updateSignupApprovalConfig.mockResolvedValue({
      config: {
        requireApproval: true,
        source: 'runtime',
        updatedAt: '2026-07-06T12:05:00.000Z',
        updatedBy: 'admin-1',
      },
    });
  });

  it('explains that turning approval off does not mutate pending users', async () => {
    render(<AdminUsers />);

    expect(await screen.findByText('Signup approval')).toBeInTheDocument();
    expect(
      screen.getByText('New and pending users can use SAM while approval is off. Stored pending users are not changed to active.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /turn signup approval on/i })).toHaveAttribute('aria-checked', 'false');
    expect(await screen.findByText('Pending User')).toBeInTheDocument();
  });

  it('updates the runtime approval setting through the admin API', async () => {
    render(<AdminUsers />);

    fireEvent.click(await screen.findByRole('switch', { name: /turn signup approval on/i }));

    await waitFor(() => {
      expect(mocks.updateSignupApprovalConfig).toHaveBeenCalledWith({ requireApproval: true });
    });
    expect(await screen.findByText('Approval on')).toBeInTheDocument();
    expect(screen.getByText('New users wait for admin approval before using SAM.')).toBeInTheDocument();
  });
});
