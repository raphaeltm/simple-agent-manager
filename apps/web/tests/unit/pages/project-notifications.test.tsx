import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { NotificationResponse, ListNotificationsResponse } from '@simple-agent-manager/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  dismissNotification: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  listNotifications: mocks.listNotifications,
  markNotificationRead: mocks.markNotificationRead,
  dismissNotification: mocks.dismissNotification,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
  };
});

vi.mock('../../../src/pages/ProjectContext', () => ({
  useProjectContext: () => ({
    projectId: 'proj-test',
    project: { name: 'Test Project' },
    settingsOpen: false,
    setSettingsOpen: vi.fn(),
    infoPanelOpen: false,
    setInfoPanelOpen: vi.fn(),
  }),
}));

import { ProjectNotifications } from '../../../src/pages/ProjectNotifications';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNotification(overrides: Partial<NotificationResponse> & { id: string }): NotificationResponse {
  return {
    projectId: 'proj-test',
    taskId: 'task-1',
    sessionId: null,
    type: 'progress',
    urgency: 'low',
    title: 'Progress: Test task',
    body: 'Some short body text',
    actionUrl: '/projects/proj-test/chat/session-1',
    metadata: null,
    readAt: null,
    dismissedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeListResponse(
  notifications: NotificationResponse[],
  nextCursor: string | null = null
): ListNotificationsResponse {
  return { notifications, unreadCount: notifications.filter((n) => !n.readAt).length, nextCursor };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ProjectNotifications />
    </MemoryRouter>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProjectNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listNotifications.mockResolvedValue(makeListResponse([]));
  });

  it('renders empty state when no notifications exist', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('No notifications yet.')).toBeInTheDocument();
    });
    expect(mocks.listNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-test' })
    );
  });

  it('renders notifications with full message from metadata', async () => {
    const fullText = 'This is the full message that is much longer than the truncated body';
    mocks.listNotifications.mockResolvedValue(
      makeListResponse([
        makeNotification({
          id: 'n-1',
          body: 'This is the full me\u2026',
          metadata: { fullMessage: fullText },
        }),
      ])
    );

    renderPage();
    await waitFor(() => {
      expect(screen.getByText(fullText)).toBeInTheDocument();
    });
  });

  it('falls back to body when metadata.fullMessage is absent', async () => {
    mocks.listNotifications.mockResolvedValue(
      makeListResponse([
        makeNotification({ id: 'n-2', body: 'Short body text', metadata: null }),
      ])
    );

    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Short body text')).toBeInTheDocument();
    });
  });

  it('shows expand/collapse for long messages', async () => {
    const longMessage = 'A'.repeat(400);
    mocks.listNotifications.mockResolvedValue(
      makeListResponse([
        makeNotification({
          id: 'n-3',
          metadata: { fullMessage: longMessage },
        }),
      ])
    );

    renderPage();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText('Show more')).toBeInTheDocument();
    });

    // Verify truncated version shown (300 chars + ellipsis)
    const truncated = longMessage.slice(0, 300) + '\u2026';
    expect(screen.getByText(truncated)).toBeInTheDocument();

    // Click to expand
    await user.click(screen.getByText('Show more'));
    expect(screen.getByText(longMessage)).toBeInTheDocument();
    expect(screen.getByText('Show less')).toBeInTheDocument();

    // Click to collapse
    await user.click(screen.getByText('Show less'));
    expect(screen.getByText(truncated)).toBeInTheDocument();
  });

  it('filters notifications by type when chip is clicked', async () => {
    mocks.listNotifications.mockResolvedValue(makeListResponse([]));

    renderPage();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText('All')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Error'));

    await waitFor(() => {
      expect(mocks.listNotifications).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', projectId: 'proj-test' })
      );
    });
  });

  it('loads more notifications when Load more is clicked', async () => {
    mocks.listNotifications
      .mockResolvedValueOnce(
        makeListResponse(
          [makeNotification({ id: 'n-page1' })],
          '1711000000000'
        )
      )
      .mockResolvedValueOnce(
        makeListResponse([makeNotification({ id: 'n-page2', title: 'Page 2 notification' })])
      );

    renderPage();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText('Load more')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Load more'));

    await waitFor(() => {
      expect(mocks.listNotifications).toHaveBeenCalledTimes(2);
      expect(mocks.listNotifications).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: '1711000000000' })
      );
    });
  });

  it('navigates to actionUrl when notification is clicked', async () => {
    mocks.listNotifications.mockResolvedValue(
      makeListResponse([
        makeNotification({
          id: 'n-click',
          title: 'Clickable notification',
          actionUrl: '/projects/proj-test/chat/session-1',
        }),
      ])
    );

    renderPage();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText('Clickable notification')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Clickable notification'));
    expect(mocks.navigate).toHaveBeenCalledWith('/projects/proj-test/chat/session-1');
  });

  it('marks notification as read via action button and removes unread indicator', async () => {
    mocks.listNotifications.mockResolvedValue(
      makeListResponse([
        makeNotification({ id: 'n-read', readAt: null }),
      ])
    );
    mocks.markNotificationRead.mockResolvedValue(undefined);

    renderPage();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByLabelText('Mark as read')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Mark as read'));
    expect(mocks.markNotificationRead).toHaveBeenCalledWith('n-read');

    // Optimistic update: "Mark as read" button should disappear
    await waitFor(() => {
      expect(screen.queryByLabelText('Mark as read')).not.toBeInTheDocument();
    });
  });

  it('dismisses notification via action button and removes it from DOM', async () => {
    mocks.listNotifications.mockResolvedValue(
      makeListResponse([
        makeNotification({ id: 'n-dismiss', title: 'Dismissable notification' }),
      ])
    );
    mocks.dismissNotification.mockResolvedValue(undefined);

    renderPage();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText('Dismissable notification')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Dismiss'));
    expect(mocks.dismissNotification).toHaveBeenCalledWith('n-dismiss');

    // Optimistic update: notification should be removed from the list
    await waitFor(() => {
      expect(screen.queryByText('Dismissable notification')).not.toBeInTheDocument();
    });
  });

  it('passes projectId to API for project-scoped queries', async () => {
    renderPage();
    await waitFor(() => {
      expect(mocks.listNotifications).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'proj-test', limit: 50 })
      );
    });
  });
});
