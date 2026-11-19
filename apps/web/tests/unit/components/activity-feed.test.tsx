import type { ProjectMembersResponse } from '@simple-agent-manager/shared';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getProjectMembers: vi.fn() }));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getProjectMembers: mocks.getProjectMembers,
}));
vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-owner' } }),
}));

import { ActivityFeed } from '../../../src/components/ActivityFeed';
import type { ActivityEventResponse } from '../../../src/lib/api';
import { ProjectContext } from '../../../src/pages/ProjectContext';
import { renderWithQuery } from '../../test-utils/query-test-utils';

function memberRow(userId: string, name: string): ProjectMembersResponse['members'][number] {
  return {
    projectId: 'proj-1',
    userId,
    role: 'maintainer',
    status: 'active',
    invitedBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    user: { id: userId, name, email: `${userId}@example.com`, image: null, avatarUrl: null },
  };
}

let sequence = 0;
function event(overrides: Partial<ActivityEventResponse>): ActivityEventResponse {
  sequence += 1;
  return {
    id: `evt-${sequence}`,
    eventType: 'session.started',
    actorType: 'user',
    actorId: 'user-owner',
    workspaceId: null,
    sessionId: 'sess-1',
    taskId: null,
    payload: null,
    createdAt: Date.now() - sequence * 1000,
    ...overrides,
  };
}

function renderFeed(events: ActivityEventResponse[]) {
  return renderWithQuery(
    <ProjectContext.Provider
      value={{ projectId: 'proj-1', project: null, installations: [], reload: async () => {} }}
    >
      <ActivityFeed events={events} hasMore={false} onLoadMore={() => undefined} />
    </ProjectContext.Provider>
  );
}

/** The lucide icon a row renders, e.g. `lucide-user-plus`. */
function iconFor(description: string): string | undefined {
  const row = screen.getByText(description).closest('li');
  const svg = row?.querySelector('svg');
  return Array.from(svg?.classList ?? []).find((name) => name.startsWith('lucide-'));
}

describe('ActivityFeed — shared session events', () => {
  beforeEach(() => {
    mocks.getProjectMembers.mockResolvedValue({
      members: [
        memberRow('user-owner', 'Prakash Rao'),
        memberRow('user-bea', 'Bea Arthur'),
        memberRow('user-cy', 'Cy Young'),
        memberRow('user-dana', 'Dana Scully'),
      ],
      inviteLinks: [],
      accessRequests: [],
    });
  });

  it('describes sharing, removal, leaving and shared answers with who did them', async () => {
    renderFeed([
      event({ eventType: 'session.access_granted', payload: { granteeUserId: 'user-bea' } }),
      event({
        eventType: 'session.access_revoked',
        actorId: 'user-bea',
        payload: { granteeUserId: 'user-cy', revokedGrantIds: ['g-cy'] },
      }),
      event({
        eventType: 'session.access_revoked',
        actorId: 'user-cy',
        payload: { granteeUserId: 'user-cy' },
      }),
      event({
        eventType: 'session.access_revoked',
        actorType: 'system',
        actorId: null,
        payload: { departedUserId: 'user-dana' },
      }),
      event({ eventType: 'session.shared_answer', actorId: 'user-bea', payload: { grantId: 'g' } }),
    ]);

    expect(await screen.findByText('Shared this session with Bea Arthur')).toBeInTheDocument();
    expect(iconFor('Shared this session with Bea Arthur')).toBe('lucide-user-plus');
    expect(
      screen.getByText('Shared this session with Bea Arthur').nextElementSibling
    ).toHaveTextContent(/^You/);

    const removed = screen.getByText('Removed shared access for Cy Young');
    expect(iconFor('Removed shared access for Cy Young')).toBe('lucide-user-minus');
    expect(removed.nextElementSibling).toHaveTextContent(/^Bea Arthur/);

    expect(screen.getByText('Left a shared session').nextElementSibling).toHaveTextContent(
      /^Cy Young/
    );
    expect(
      screen.getByText('Removed shared access for Dana Scully').nextElementSibling
    ).toHaveTextContent(/^System/);

    const answered = screen.getByText('Answered the agent (shared access)');
    expect(iconFor('Answered the agent (shared access)')).toBe('lucide-reply');
    expect(answered.nextElementSibling).toHaveTextContent(/^Bea Arthur/);
  });

  it('says how long access was shared or renewed for, and when it ran out', async () => {
    renderFeed([
      event({
        eventType: 'session.access_granted',
        payload: { granteeUserId: 'user-bea', durationMinutes: 30, renewed: false },
      }),
      event({
        eventType: 'session.access_granted',
        payload: { granteeUserId: 'user-cy', durationMinutes: 60, renewed: true },
      }),
      event({
        eventType: 'session.access_expired',
        actorType: 'system',
        actorId: null,
        payload: { granteeUserIds: ['user-dana'], cancelledDeliveryCount: 1 },
      }),
      event({
        eventType: 'session.access_expired',
        actorType: 'system',
        actorId: null,
        payload: { granteeUserIds: ['user-bea', 'user-cy'] },
      }),
    ]);

    expect(
      await screen.findByText('Shared this session with Bea Arthur for 30 min')
    ).toBeInTheDocument();
    expect(screen.getByText('Renewed shared access for Cy Young for 1 hour')).toBeInTheDocument();
    expect(iconFor('Renewed shared access for Cy Young for 1 hour')).toBe('lucide-user-plus');

    const ranOut = screen.getByText('Shared access ran out for Dana Scully');
    expect(iconFor('Shared access ran out for Dana Scully')).toBe('lucide-timer-off');
    expect(ranOut.nextElementSibling).toHaveTextContent(/^System/);
    expect(screen.getByText('Shared access ran out for 2 people')).toBeInTheDocument();
  });

  it('labels a teammate it cannot name without claiming it was you', async () => {
    renderFeed([event({ eventType: 'session.shared_answer', actorId: 'user-unknown' })]);
    const row = screen.getByText('Answered the agent (shared access)');
    await waitFor(() => expect(mocks.getProjectMembers).toHaveBeenCalled());
    expect(row.nextElementSibling).toHaveTextContent(/^A teammate/);
  });

  it('keeps distinct icons for session events instead of showing every one as stopped', () => {
    renderFeed([
      event({ eventType: 'session.started', payload: { topic: 'Retry policy' } }),
      event({ eventType: 'session.stopped' }),
      event({ eventType: 'session.wake_failed', actorType: 'system', actorId: null }),
    ]);
    expect(iconFor('Chat session started: Retry policy')).toBe('lucide-play');
    expect(iconFor('Chat session stopped')).toBe('lucide-pause');
    expect(iconFor('session wake failed')).toBe('lucide-x');
  });
});
