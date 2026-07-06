import type { ProjectMembersResponse } from '@simple-agent-manager/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '../../../src/lib/api/client';

const mocks = vi.hoisted(() => ({
  applyProjectMemberOffboarding: vi.fn(),
  approveProjectAccessRequest: vi.fn(),
  createProjectInviteLink: vi.fn(),
  denyProjectAccessRequest: vi.fn(),
  getProjectCredentialAttributionHealth: vi.fn(),
  getProjectMembers: vi.fn(),
  previewProjectMemberOffboarding: vi.fn(),
  revokeProjectInviteLink: vi.fn(),
  transferProjectOwnership: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  currentUser: { id: 'owner-user', email: 'owner@example.com', name: 'Owner' },
}));

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({
    user: mocks.currentUser,
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
  applyProjectMemberOffboarding: mocks.applyProjectMemberOffboarding,
  approveProjectAccessRequest: mocks.approveProjectAccessRequest,
  createProjectInviteLink: mocks.createProjectInviteLink,
  denyProjectAccessRequest: mocks.denyProjectAccessRequest,
  getProjectCredentialAttributionHealth: mocks.getProjectCredentialAttributionHealth,
  getProjectMembers: mocks.getProjectMembers,
  previewProjectMemberOffboarding: mocks.previewProjectMemberOffboarding,
  revokeProjectInviteLink: mocks.revokeProjectInviteLink,
  transferProjectOwnership: mocks.transferProjectOwnership,
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
    mocks.currentUser = { id: 'owner-user', email: 'owner@example.com', name: 'Owner' };
    mocks.getProjectMembers.mockResolvedValue(makeMembersResponse());
    mocks.getProjectCredentialAttributionHealth.mockResolvedValue({
      projectId: 'proj-1',
      multiplayerActive: true,
      counts: {
        resources: 1,
        personalResources: 1,
        personalCredentials: 2,
        projectCoveredCredentials: 0,
        unknownCredentials: 0,
      },
      resources: [
        {
          id: 'trigger-1',
          projectId: 'proj-1',
          kind: 'trigger',
          title: 'Daily review',
          subtitle: '0 9 * * *',
          href: '/projects/proj-1/triggers/trigger-1',
          createdBy: { id: 'owner-user', name: 'Owner', email: 'owner@example.com', avatarUrl: null },
          checks: [
            {
              consumerKind: 'agent',
              consumerTarget: 'opencode',
              label: 'Agent credential (opencode)',
              source: 'personal',
              owner: { id: 'owner-user', name: 'Owner', email: 'owner@example.com', avatarUrl: null },
              projectCredential: null,
              fixHref: '/projects/proj-1/settings/connections',
              warning: "This runs on Owner's personal key.",
            },
          ],
        },
      ],
    });
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
    mocks.transferProjectOwnership.mockResolvedValue({
      projectId: 'proj-1',
      fromUserId: 'owner-user',
      toUserId: 'admin-user',
      fromRole: 'admin',
      toRole: 'owner',
      completedAt: '2026-07-04T01:00:00.000Z',
    });
    mocks.previewProjectMemberOffboarding.mockResolvedValue({
      offboardingPlanId: 'off-plan-1',
      projectId: 'proj-1',
      memberUserId: 'admin-user',
      canApply: false,
      requiresHumanDecision: true,
      summary: {
        breakAndFlag: 2,
        reattachAvailable: 1,
        blockingTeardown: 1,
      },
      resources: [
        {
          resourceKind: 'trigger',
          resourceId: 'trigger-1',
          title: 'Daily review',
          subtitle: '0 9 * * *',
          href: '/projects/proj-1/triggers/trigger-1',
          credentialSourceBefore: 'user',
          attributionUserIdBefore: 'admin-user',
          attributionProjectIdBefore: 'proj-1',
          recommendedAction: 'reattach_to_project',
          availableActions: ['reattach_to_project', 'break_and_flag', 'defer_removal'],
          requiresHumanDecision: true,
          blocksRemoval: false,
          details: {
            status: 'active',
            remainingProjectCoverage: {
              agent: { attachmentId: 'attach-agent', configurationId: 'config-agent' },
              compute: { attachmentId: 'attach-compute', configurationId: 'config-compute' },
            },
          },
        },
        {
          resourceKind: 'task_tree',
          resourceId: 'task-1',
          title: 'Running cost audit',
          subtitle: 'running',
          href: '/projects/proj-1/tasks/task-1',
          credentialSourceBefore: 'user',
          attributionUserIdBefore: 'admin-user',
          attributionProjectIdBefore: 'proj-1',
          recommendedAction: 'break_and_flag',
          availableActions: ['break_and_flag', 'defer_removal'],
          requiresHumanDecision: true,
          blocksRemoval: true,
          details: { status: 'running' },
        },
      ],
    });
    mocks.applyProjectMemberOffboarding.mockResolvedValue({
      projectId: 'proj-1',
      memberUserId: 'admin-user',
      status: 'removed',
      appliedAt: '2026-07-04T01:00:00.000Z',
      resourceResults: [],
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

  it('shows a non-blocking credential checklist during member sharing', async () => {
    const user = userEvent.setup();
    render(<ProjectMembersSection projectId="proj-1" />);

    expect(await screen.findByText('Credential checklist before sharing')).toBeInTheDocument();
    expect(screen.getByText(/Invite and approval can continue/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /create link/i }));
    await waitFor(() => {
      expect(mocks.createProjectInviteLink).toHaveBeenCalledWith('proj-1');
    });
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

  it('transfers ownership to an eligible active member after confirmation', async () => {
    const user = userEvent.setup();
    render(<ProjectMembersSection projectId="proj-1" />);

    await screen.findByText('Admin');
    await user.click(screen.getByRole('button', { name: /transfer ownership/i }));

    const dialog = await screen.findByRole('dialog', { name: /transfer ownership/i });
    expect(within(dialog).getByText(/Your account becomes an admin/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/does not copy or\s+move any secret/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /transfer ownership/i }));

    await waitFor(() => {
      expect(mocks.transferProjectOwnership).toHaveBeenCalledWith('proj-1', {
        toUserId: 'admin-user',
        oldOwnerRole: 'admin',
      });
    });
    expect(mocks.getProjectMembers).toHaveBeenCalled();
    expect(mocks.success).toHaveBeenCalledWith('Admin is now the project owner');
  });

  it('previews member removal, defaults to break and flag, and applies selected actions', async () => {
    const user = userEvent.setup();
    render(<ProjectMembersSection projectId="proj-1" />);

    await screen.findByText('Admin');
    await user.click(screen.getByRole('button', { name: /remove member/i }));

    await waitFor(() => {
      expect(mocks.previewProjectMemberOffboarding).toHaveBeenCalledWith('proj-1', 'admin-user');
    });

    const dialog = await screen.findByRole('dialog', { name: /remove member/i });
    expect(within(dialog).getByText(/This trigger runs on Admin's personal key/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Removing this member will disable the trigger/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Running tasks/i)).toBeInTheDocument();

    const triggerSelect = within(dialog).getAllByLabelText('Action')[0];
    expect(triggerSelect).toHaveValue('break_and_flag');
    await user.selectOptions(triggerSelect, 'reattach_to_project');

    await user.click(within(dialog).getByRole('button', { name: /^remove member$/i }));

    await waitFor(() => {
      expect(mocks.applyProjectMemberOffboarding).toHaveBeenCalledWith('proj-1', 'admin-user', {
        planId: 'off-plan-1',
        finalMemberStatus: 'removed',
        actions: [
          {
            resourceKind: 'trigger',
            resourceId: 'trigger-1',
            action: 'reattach_to_project',
          },
          {
            resourceKind: 'task_tree',
            resourceId: 'task-1',
            action: 'break_and_flag',
          },
        ],
      });
    });
    expect(mocks.getProjectMembers).toHaveBeenCalled();
    expect(mocks.success).toHaveBeenCalledWith('Member removed');
  });

  it('allows the current non-owner member to leave through offboarding apply', async () => {
    mocks.currentUser = { id: 'admin-user', email: 'admin@example.com', name: 'Admin' };
    mocks.previewProjectMemberOffboarding.mockResolvedValueOnce({
      offboardingPlanId: 'off-self',
      projectId: 'proj-1',
      memberUserId: 'admin-user',
      canApply: true,
      requiresHumanDecision: false,
      summary: {
        breakAndFlag: 0,
        reattachAvailable: 0,
        blockingTeardown: 0,
      },
      resources: [],
    });
    const user = userEvent.setup();
    render(<ProjectMembersSection projectId="proj-1" />);

    await screen.findByText('Admin');
    await user.click(screen.getByRole('button', { name: /leave project/i }));

    const dialog = await screen.findByRole('dialog', { name: /leave project/i });
    expect(within(dialog).getByText(/removed cleanly/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /^leave project$/i }));

    await waitFor(() => {
      expect(mocks.applyProjectMemberOffboarding).toHaveBeenCalledWith('proj-1', 'admin-user', {
        planId: 'off-self',
        finalMemberStatus: 'removed',
        actions: [],
      });
    });
    expect(mocks.success).toHaveBeenCalledWith('You left the project');
  });

  it('shows retry guidance for stale or expired offboarding plans', async () => {
    const user = userEvent.setup();
    mocks.applyProjectMemberOffboarding.mockRejectedValueOnce(
      new ApiClientError('stale_plan', 'The offboarding plan is stale', 409)
    );
    render(<ProjectMembersSection projectId="proj-1" />);

    await screen.findByText('Admin');
    await user.click(screen.getByRole('button', { name: /remove member/i }));
    const dialog = await screen.findByRole('dialog', { name: /remove member/i });
    await user.click(within(dialog).getByRole('button', { name: /^remove member$/i }));

    expect(await within(dialog).findByText(/Refresh the preview and review the resources again/i)).toBeInTheDocument();
  });
});
