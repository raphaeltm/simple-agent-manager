import type { ProjectMembersResponse } from '@simple-agent-manager/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  approveProjectAccessRequest: vi.fn(),
  createProjectInviteLink: vi.fn(),
  denyProjectAccessRequest: vi.fn(),
  getProjectMembers: vi.fn(),
  revokeProjectInviteLink: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'owner-user', email: 'owner@example.com', name: 'Owner' },
  }),
}));

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => ({
    success: mocks.success,
    error: mocks.error,
  }),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  approveProjectAccessRequest: mocks.approveProjectAccessRequest,
  createProjectInviteLink: mocks.createProjectInviteLink,
  denyProjectAccessRequest: mocks.denyProjectAccessRequest,
  getProjectMembers: mocks.getProjectMembers,
  revokeProjectInviteLink: mocks.revokeProjectInviteLink,
}));

import { ProjectMembersSection } from '../../../src/components/project-settings/ProjectMembersSection';

function makeMembersResponse(overrides: Partial<ProjectMembersResponse> = {}): ProjectMembersResponse {
  return {
    members: [
      {
        projectId: 'proj-1',
        userId: 'owner-user',
        role: 'owner',
        status: 'active',
        invitedBy: null,
        createdAt: '2026-07-04T00:00:00.000Z',
        updatedAt: '2026-07-04T00:00:00.000Z',
        user: {
          id: 'owner-user',
          name: 'Owner',
          email: 'owner@example.com',
          image: null,
          avatarUrl: null,
        },
      },
      {
        projectId: 'proj-1',
        userId: 'admin-user',
        role: 'admin',
        status: 'active',
        invitedBy: 'owner-user',
        createdAt: '2026-07-04T00:00:00.000Z',
        updatedAt: '2026-07-04T00:00:00.000Z',
        user: {
          id: 'admin-user',
          name: 'Admin',
          email: 'admin@example.com',
          image: null,
          avatarUrl: null,
        },
      },
    ],
    inviteLinks: [],
    accessRequests: [
      {
        id: 'request-1',
        projectId: 'proj-1',
        inviteLinkId: 'invite-1',
        requesterUserId: 'requester-user',
        status: 'pending',
        githubAccessStatus: 'verified',
        githubAccessCheckedAt: '2026-07-04T00:00:00.000Z',
        githubAccessMessage: null,
        requestedAt: '2026-07-04T00:00:00.000Z',
        decidedAt: null,
        decidedBy: null,
        decisionNote: null,
        createdAt: '2026-07-04T00:00:00.000Z',
        updatedAt: '2026-07-04T00:00:00.000Z',
        requester: {
          id: 'requester-user',
          name: 'Requester',
          email: 'requester@example.com',
          image: null,
          avatarUrl: null,
        },
      },
    ],
    ...overrides,
  };
}

describe('ProjectMembersSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProjectMembers.mockResolvedValue(makeMembersResponse());
    mocks.createProjectInviteLink.mockResolvedValue({
      id: 'invite-1',
      projectId: 'proj-1',
      status: 'active',
      token: 'sam_inv_secret',
      expiresAt: '2099-01-01T00:00:00.000Z',
      revokedAt: null,
      createdBy: 'owner-user',
      createdAt: '2026-07-04T00:00:00.000Z',
      updatedAt: '2026-07-04T00:00:00.000Z',
      lastUsedAt: null,
      useCount: 0,
    });
    mocks.approveProjectAccessRequest.mockResolvedValue({
      ...makeMembersResponse().accessRequests[0],
      status: 'approved',
      decidedBy: 'owner-user',
      decidedAt: '2026-07-04T01:00:00.000Z',
    });
  });

  it('creates invite links from project settings', async () => {
    const user = userEvent.setup();
    render(<ProjectMembersSection projectId="proj-1" />);

    await screen.findByText('Owner');
    await user.click(screen.getByRole('button', { name: /create link/i }));

    await waitFor(() => {
      expect(mocks.createProjectInviteLink).toHaveBeenCalledWith('proj-1');
    });
    const inviteInput = await screen.findByLabelText('Invite link');
    expect(inviteInput).toHaveValue('http://localhost:3000/projects/invite/sam_inv_secret');

    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
  });

  it('approves pending requests through the member management endpoint', async () => {
    const user = userEvent.setup();
    render(<ProjectMembersSection projectId="proj-1" />);

    await screen.findByText('Requester');
    await user.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => {
      expect(mocks.approveProjectAccessRequest).toHaveBeenCalledWith('proj-1', 'request-1');
    });
    expect(mocks.success).toHaveBeenCalledWith('Access approved');
  });
});
