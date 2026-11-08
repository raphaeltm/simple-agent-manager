import type { OperationsActionApproval } from '@simple-agent-manager/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithQuery } from '../test-utils/query-test-utils';

const mocks = vi.hoisted(() => ({
  fetchOperationsApprovals: vi.fn(),
  decideOperationsApproval: vi.fn(),
}));

vi.mock('../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'admin-1', email: 'admin@example.com', name: 'Admin' } }),
}));

vi.mock('../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api')>()),
  fetchOperationsApprovals: mocks.fetchOperationsApprovals,
  decideOperationsApproval: mocks.decideOperationsApproval,
}));

import { AdminApprovals } from '../../src/pages/AdminApprovals';

function approval(overrides: Partial<OperationsActionApproval>): OperationsActionApproval {
  return {
    id: 'appr-1',
    action: 'delete_node',
    targetType: 'node',
    targetId: 'NODE-1',
    reason: 'Node has no workspaces 3h past the warm timeout',
    evidenceSummary: 'ops_why_is_node_alive: kept_active, 0 workspaces',
    targetSummary: { nodeId: 'NODE-1', ownerUserId: 'user-7', status: 'running' },
    requestingProjectId: 'proj-ops',
    requestingTaskId: 'task-ops',
    requestingSessionId: 'chat-ops',
    requesterUserId: 'admin-1',
    status: 'pending',
    autoApproved: false,
    expiresAt: '2026-11-03T13:00:00.000Z',
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    executedAt: null,
    executionResult: null,
    createdAt: '2026-11-03T12:00:00.000Z',
    ...overrides,
  };
}

function renderPage(path = '/admin/approvals') {
  return renderWithQuery(
    <MemoryRouter initialEntries={[path]}>
      <AdminApprovals />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AdminApprovals', () => {
  it('lists what waits for a decision above recent decisions', async () => {
    mocks.fetchOperationsApprovals.mockResolvedValue({
      approvals: [
        approval({}),
        approval({
          id: 'appr-2',
          action: 'retry_snapshot',
          targetType: 'chat_session',
          targetId: 'chat-9',
          status: 'executed',
          autoApproved: true,
          executedAt: '2026-11-03T12:05:00.000Z',
          executionResult: { status: 'accepted', message: 'Background snapshot queued' },
        }),
      ],
    });

    renderPage();

    const pending = await screen.findByTestId('approval-appr-1');
    expect(within(pending).getByText('Delete node')).toBeTruthy();
    expect(within(pending).getByText('user-7')).toBeTruthy();
    expect(within(pending).getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByText('Waiting for you (1)')).toBeTruthy();

    const settled = screen.getByTestId('approval-appr-2');
    expect(within(settled).getByText('Result: Background snapshot queued')).toBeTruthy();
    expect(within(settled).queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('warns before approving an irreversible action, and not for a reversible one', async () => {
    mocks.fetchOperationsApprovals.mockResolvedValue({
      approvals: [
        approval({}),
        approval({ id: 'appr-sleep', action: 'sleep_session', targetType: 'chat_session' }),
      ],
    });

    renderPage();

    const deletion = await screen.findByTestId('approval-appr-1');
    expect(within(deletion).getByText(/Cannot be undone/)).toBeTruthy();
    expect(
      within(screen.getByTestId('approval-appr-sleep')).queryByText(/Cannot be undone/)
    ).toBeNull();
  });

  it('Approve sends the decision and refreshes the list', async () => {
    mocks.fetchOperationsApprovals
      .mockResolvedValueOnce({ approvals: [approval({})] })
      .mockResolvedValue({
        approvals: [approval({ status: 'approved', decidedAt: '2026-11-03T12:01:00.000Z' })],
      });
    mocks.decideOperationsApproval.mockResolvedValue({
      approval: approval({ status: 'approved' }),
      delivered: true,
    });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(mocks.decideOperationsApproval).toHaveBeenCalledWith('appr-1', 'approve')
    );
    await waitFor(() => expect(screen.getByText('approved')).toBeTruthy());
    expect(mocks.fetchOperationsApprovals).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('Deny sends a deny decision', async () => {
    mocks.fetchOperationsApprovals.mockResolvedValue({ approvals: [approval({})] });
    mocks.decideOperationsApproval.mockResolvedValue({
      approval: approval({ status: 'denied' }),
      delivered: true,
    });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));

    await waitFor(() =>
      expect(mocks.decideOperationsApproval).toHaveBeenCalledWith('appr-1', 'deny')
    );
  });

  it('shows a refused decision (already decided or expired) instead of failing silently', async () => {
    mocks.fetchOperationsApprovals.mockResolvedValue({ approvals: [approval({})] });
    mocks.decideOperationsApproval.mockRejectedValue(
      new Error('This request expired before it was decided')
    );

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    expect((await screen.findByRole('alert')).textContent).toContain('expired');
  });

  it('highlights the approval a notification links to', async () => {
    mocks.fetchOperationsApprovals.mockResolvedValue({
      approvals: [approval({}), approval({ id: 'appr-3', targetId: 'NODE-3' })],
    });
    window.HTMLElement.prototype.scrollIntoView = vi.fn();

    renderPage('/admin/approvals?approval=appr-3');

    const linked = await screen.findByTestId('approval-appr-3');
    expect(linked.className).toContain('ring-2');
    expect(screen.getByTestId('approval-appr-1').className).not.toContain('ring-2');
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('explains the empty state, and still renders the page', async () => {
    mocks.fetchOperationsApprovals.mockResolvedValue({ approvals: [] });

    renderPage();

    expect(await screen.findByText(/Nothing to approve/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  });
});
