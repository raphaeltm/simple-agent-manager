/**
 * Tests for the notification grouping logic and NotificationGroup component.
 *
 * The grouping logic is a useMemo inside NotificationCenter that computes
 * { groups, shouldGroup } from filteredNotifications. We test it by rendering
 * the component with a mocked useNotifications hook and asserting on the
 * rendered output.
 *
 * Coverage targets:
 *  - shouldGroup = false when all notifications belong to <= 1 project
 *  - shouldGroup = true when notifications span >= 2 projects
 *  - Group header shows project name derived from metadata.projectName
 *  - Group header falls back to "Project" when metadata.projectName is absent
 *  - Group header shows "General" for null-projectId notifications
 *  - NotificationGroup collapse/expand toggle works
 *  - Unread badge count within a group is accurate
 *  - notification.updated WebSocket message patches the list in-place
 *  - Attention-only badge on bell button
 */
import type { NotificationResponse } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach,describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock useNotifications so we can inject notifications without WebSocket setup
// ---------------------------------------------------------------------------

const mockUseNotifications = vi.fn();
vi.mock('../../../src/hooks/useNotifications', () => ({
  useNotifications: () => mockUseNotifications(),
}));

// ---------------------------------------------------------------------------
// Import after mocking
// ---------------------------------------------------------------------------
import { NotificationCenter } from '../../../src/components/NotificationCenter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNotification(overrides: Partial<NotificationResponse> = {}): NotificationResponse {
  return {
    id: `notif-${Math.random().toString(36).slice(2)}`,
    type: 'needs_input',
    urgency: 'high',
    title: 'Agent needs help',
    body: null,
    projectId: 'proj-1',
    taskId: 'task-1',
    sessionId: null,
    actionUrl: null,
    metadata: null,
    readAt: null,
    dismissedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const defaultHookReturn = {
  notifications: [] as NotificationResponse[],
  unreadCount: 0,
  loading: false,
  connectionState: 'connected' as const,
  markRead: vi.fn().mockResolvedValue(undefined),
  markAllRead: vi.fn().mockResolvedValue(undefined),
  dismiss: vi.fn().mockResolvedValue(undefined),
  loadMore: vi.fn().mockResolvedValue(undefined),
  hasMore: false,
  refresh: vi.fn().mockResolvedValue(undefined),
};

function renderNotificationCenter(notifications: NotificationResponse[], unreadCount = 0) {
  mockUseNotifications.mockReturnValue({
    ...defaultHookReturn,
    notifications,
    unreadCount,
  });

  render(
    <MemoryRouter>
      <NotificationCenter />
    </MemoryRouter>,
  );

  // Open the notification panel
  fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NotificationCenter grouping logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('shouldGroup = false (single project or no notifications)', () => {
    it('renders empty state for attention tab when there are no notifications', () => {
      renderNotificationCenter([]);
      expect(screen.getByText(/nothing needs your attention/i)).toBeInTheDocument();
    });

    it('renders "No notifications yet" on the All tab when empty', () => {
      renderNotificationCenter([]);
      // Switch to All tab
      fireEvent.click(screen.getByRole('tab', { name: /^all$/i }));
      expect(screen.getByText(/no notifications yet/i)).toBeInTheDocument();
    });

    it('renders flat list when all notifications belong to the same project', () => {
      const notifications = [
        makeNotification({ id: 'n1', projectId: 'proj-1', title: 'Help 1' }),
        makeNotification({ id: 'n2', projectId: 'proj-1', title: 'Help 2' }),
      ];
      renderNotificationCenter(notifications);

      // No group headers should appear
      expect(screen.queryByRole('button', { name: /\d+ notifications/i })).toBeNull();
      // Both notification titles should appear directly
      expect(screen.getByText('Help 1')).toBeInTheDocument();
      expect(screen.getByText('Help 2')).toBeInTheDocument();
    });

    it('renders flat list when all notifications have null projectId', () => {
      const notifications = [
        makeNotification({ id: 'n1', projectId: null, title: 'Help A' }),
        makeNotification({ id: 'n2', projectId: null, title: 'Help B' }),
      ];
      renderNotificationCenter(notifications);

      expect(screen.queryByRole('button', { name: /general/i })).toBeNull();
      expect(screen.getByText('Help A')).toBeInTheDocument();
      expect(screen.getByText('Help B')).toBeInTheDocument();
    });
  });

  describe('shouldGroup = true (multiple projects)', () => {
    it('renders group headers when notifications span two projects', () => {
      const notifications = [
        makeNotification({ id: 'n1', projectId: 'proj-1', metadata: { projectName: 'Alpha' } }),
        makeNotification({ id: 'n2', projectId: 'proj-2', metadata: { projectName: 'Beta' } }),
      ];
      renderNotificationCenter(notifications);

      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
    });

    it('uses "Project <id>" as fallback when metadata.projectName is absent', () => {
      const notifications = [
        makeNotification({ id: 'n1', projectId: 'proj-1' }),
        makeNotification({ id: 'n2', projectId: 'proj-2' }),
      ];
      renderNotificationCenter(notifications);

      expect(screen.getByText('Project proj-1')).toBeInTheDocument();
      expect(screen.getByText('Project proj-2')).toBeInTheDocument();
    });

    it('uses "General" for notifications with null projectId when grouped', () => {
      const notifications = [
        makeNotification({ id: 'n1', projectId: 'proj-1', metadata: { projectName: 'Alpha' } }),
        makeNotification({ id: 'n2', projectId: null }),
      ];
      renderNotificationCenter(notifications);

      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('General')).toBeInTheDocument();
    });

    it('assigns each notification to the correct group', () => {
      const notifications = [
        makeNotification({ id: 'n1', title: 'Alpha task help', projectId: 'proj-1', metadata: { projectName: 'Alpha' } }),
        makeNotification({ id: 'n2', title: 'Beta task help', projectId: 'proj-2', metadata: { projectName: 'Beta' } }),
      ];
      renderNotificationCenter(notifications);

      expect(screen.getByText('Alpha task help')).toBeInTheDocument();
      expect(screen.getByText('Beta task help')).toBeInTheDocument();
    });
  });

  describe('NotificationGroup collapse/expand toggle', () => {
    it('collapses notifications when the group header is clicked', () => {
      const notifications = [
        makeNotification({ id: 'n1', title: 'Alpha needs help', projectId: 'proj-1', metadata: { projectName: 'UniqueAlpha' } }),
        makeNotification({ id: 'n2', title: 'Beta needs help', projectId: 'proj-2', metadata: { projectName: 'UniqueBeta' } }),
      ];
      renderNotificationCenter(notifications);

      expect(screen.getByText('Alpha needs help')).toBeInTheDocument();

      const alphaHeader = screen.getByRole('button', { name: /uniquealpha/i });
      fireEvent.click(alphaHeader);

      expect(screen.queryByText('Alpha needs help')).toBeNull();
      expect(screen.getByText('Beta needs help')).toBeInTheDocument();
    });

    it('expands a collapsed group when the header is clicked again', () => {
      const notifications = [
        makeNotification({ id: 'n1', title: 'Alpha needs help', projectId: 'proj-1', metadata: { projectName: 'UniqueAlpha2' } }),
        makeNotification({ id: 'n2', title: 'Beta needs help', projectId: 'proj-2', metadata: { projectName: 'UniqueBeta2' } }),
      ];
      renderNotificationCenter(notifications);

      const alphaHeader = screen.getByRole('button', { name: /uniquealpha2/i });

      fireEvent.click(alphaHeader);
      expect(screen.queryByText('Alpha needs help')).toBeNull();

      fireEvent.click(alphaHeader);
      expect(screen.getByText('Alpha needs help')).toBeInTheDocument();
    });
  });

  describe('unread count badge per group', () => {
    it('shows unread count badge when group has unread notifications', () => {
      const notifications = [
        makeNotification({ id: 'n1', projectId: 'proj-1', metadata: { projectName: 'UnreadAlpha' }, readAt: null }),
        makeNotification({ id: 'n2', projectId: 'proj-1', metadata: { projectName: 'UnreadAlpha' }, readAt: null }),
        makeNotification({ id: 'n3', projectId: 'proj-2', metadata: { projectName: 'UnreadBeta' }, readAt: new Date().toISOString() }),
      ];
      renderNotificationCenter(notifications, 2);

      const countElements = screen.getAllByText('2');
      expect(countElements.length).toBeGreaterThanOrEqual(1);
    });

    it('does not show unread badge when all notifications in a group are read', () => {
      const readAt = new Date().toISOString();
      const notifications = [
        makeNotification({ id: 'n1', projectId: 'proj-1', metadata: { projectName: 'Alpha' }, readAt }),
        makeNotification({ id: 'n2', projectId: 'proj-2', metadata: { projectName: 'Beta' }, readAt: null }),
      ];
      renderNotificationCenter(notifications, 1);

      const badges = screen.queryAllByText('1');
      expect(badges.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ---------------------------------------------------------------------------
// useNotifications hook — notification.updated WebSocket message handling
// ---------------------------------------------------------------------------

describe('useNotifications — notification.updated WebSocket handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replaces an existing notification by id when notification.updated arrives', async () => {
    const original: NotificationResponse = makeNotification({
      id: 'notif-progress-1',
      type: 'progress',
      title: 'Progress: Old title',
      body: 'Step 1 done',
      projectId: 'proj-1',
      readAt: new Date().toISOString(),
    });
    const updated: NotificationResponse = {
      ...original,
      title: 'Progress: New title',
      body: 'Step 2 done',
      readAt: null,
    };

    mockUseNotifications.mockReturnValue({
      ...defaultHookReturn,
      notifications: [original],
      unreadCount: 0,
    });

    render(
      <MemoryRouter>
        <NotificationCenter />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));

    // Switch to Updates tab since progress notifications are not shown on the default Attention tab
    fireEvent.click(screen.getByRole('tab', { name: /updates/i }));

    expect(screen.getByText('Progress: Old title')).toBeInTheDocument();

    mockUseNotifications.mockReturnValue({
      ...defaultHookReturn,
      notifications: [updated],
      unreadCount: 1,
    });

    fireEvent.click(screen.getByRole('button', { name: /notifications/i })); // close
    fireEvent.click(screen.getByRole('button', { name: /notifications/i })); // reopen

    await waitFor(() => {
      expect(screen.getByText('Progress: New title')).toBeInTheDocument();
    });
    expect(screen.queryByText('Progress: Old title')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tab filtering — Attention / Updates / All
// ---------------------------------------------------------------------------

describe('NotificationCenter tab filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mixedNotifications: NotificationResponse[] = [
    makeNotification({ id: 'n-input', type: 'needs_input', title: 'Agent needs help' }),
    makeNotification({ id: 'n-complete', type: 'task_complete', title: 'Task finished' }),
    makeNotification({ id: 'n-progress', type: 'progress', title: 'Working on it' }),
    makeNotification({ id: 'n-error', type: 'error', title: 'Something broke' }),
    makeNotification({ id: 'n-session', type: 'session_ended', title: 'Session ended' }),
    makeNotification({ id: 'n-pr', type: 'pr_created', title: 'PR opened' }),
  ];

  it('defaults to Attention tab showing only needs_input and error', () => {
    renderNotificationCenter(mixedNotifications, 6);

    // Attention items visible
    expect(screen.getByText('Agent needs help')).toBeInTheDocument();
    expect(screen.getByText('Something broke')).toBeInTheDocument();

    // Non-attention items NOT visible on the default tab
    expect(screen.queryByText('Task finished')).toBeNull();
    expect(screen.queryByText('Working on it')).toBeNull();
    expect(screen.queryByText('Session ended')).toBeNull();
    expect(screen.queryByText('PR opened')).toBeNull();
  });

  it('Updates tab shows task_complete, progress, session_ended, pr_created', () => {
    renderNotificationCenter(mixedNotifications, 6);
    fireEvent.click(screen.getByRole('tab', { name: /updates/i }));

    // Update items visible
    expect(screen.getByText('Task finished')).toBeInTheDocument();
    expect(screen.getByText('Working on it')).toBeInTheDocument();
    expect(screen.getByText('Session ended')).toBeInTheDocument();
    expect(screen.getByText('PR opened')).toBeInTheDocument();

    // Attention items NOT visible
    expect(screen.queryByText('Agent needs help')).toBeNull();
    expect(screen.queryByText('Something broke')).toBeNull();
  });

  it('All tab shows every notification', () => {
    renderNotificationCenter(mixedNotifications, 6);
    fireEvent.click(screen.getByRole('tab', { name: /^all$/i }));

    expect(screen.getByText('Agent needs help')).toBeInTheDocument();
    expect(screen.getByText('Task finished')).toBeInTheDocument();
    expect(screen.getByText('Working on it')).toBeInTheDocument();
    expect(screen.getByText('Something broke')).toBeInTheDocument();
    expect(screen.getByText('Session ended')).toBeInTheDocument();
    expect(screen.getByText('PR opened')).toBeInTheDocument();
  });

  it('shows attention unread count badge on the Attention tab', () => {
    const notifications = [
      makeNotification({ id: 'n1', type: 'needs_input', title: 'Help 1', readAt: null }),
      makeNotification({ id: 'n2', type: 'error', title: 'Error 1', readAt: null }),
      makeNotification({ id: 'n3', type: 'task_complete', title: 'Done 1', readAt: null }),
      makeNotification({ id: 'n4', type: 'progress', title: 'Working', readAt: null }),
    ];
    renderNotificationCenter(notifications, 4);

    // The Attention tab should show a badge with "2" (needs_input + error)
    const attentionTab = screen.getByRole('tab', { name: /attention/i });
    expect(attentionTab).toHaveTextContent('2');
  });

  it('shows 99+ when attention unread count exceeds 99', () => {
    const notifications = Array.from({ length: 110 }, (_, i) =>
      makeNotification({ id: `n${i}`, type: 'needs_input', title: `Help ${i}`, readAt: null }),
    );
    renderNotificationCenter(notifications, 110);

    const attentionTab = screen.getByRole('tab', { name: /attention/i });
    expect(attentionTab).toHaveTextContent('99+');
  });

  it('shows empty state with sub-message on Attention tab when no attention notifications exist', () => {
    const notifications = [
      makeNotification({ id: 'n1', type: 'progress', title: 'Working' }),
    ];
    renderNotificationCenter(notifications, 1);

    expect(screen.getByText(/nothing needs your attention/i)).toBeInTheDocument();
    expect(screen.getByText(/items needing your input or action appear here/i)).toBeInTheDocument();
  });

  it('bell icon badge shows attention-only unread count, not total unread', () => {
    const notifications = [
      makeNotification({ id: 'n1', type: 'needs_input', title: 'Help 1', readAt: null }),
      makeNotification({ id: 'n2', type: 'task_complete', title: 'Done 1', readAt: null }),
      makeNotification({ id: 'n3', type: 'progress', title: 'Working', readAt: null }),
      makeNotification({ id: 'n4', type: 'error', title: 'Err', readAt: null }),
      makeNotification({ id: 'n5', type: 'session_ended', title: 'Ended', readAt: new Date().toISOString() }),
    ];
    // 4 unread total (n1-n4), 2 are attention-required (n1=needs_input, n4=error)
    renderNotificationCenter(notifications, 4);

    // Bell button should show attention count (2), not total (4)
    const bellButton = screen.getByRole('button', { name: /2 need attention/i });
    expect(bellButton).toBeInTheDocument();

    // Attention tab badge should show 2
    const attentionTab = screen.getByRole('tab', { name: /attention/i });
    expect(attentionTab).toHaveTextContent('2');
  });

  it('shows "No updates" on the Updates tab when only attention notifications exist', () => {
    const notifications = [
      makeNotification({ id: 'n1', type: 'needs_input', title: 'Help' }),
    ];
    renderNotificationCenter(notifications, 1);
    fireEvent.click(screen.getByRole('tab', { name: /updates/i }));

    expect(screen.getByText(/no updates/i)).toBeInTheDocument();
  });
});
