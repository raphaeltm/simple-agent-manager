/**
 * The three collaboration notification types — `mention`, `comment`, `session_access` —
 * through the real bell panel and the project Notifications page.
 */
import type { NotificationResponse } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useNotifications: vi.fn(),
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  dismissNotification: vi.fn(),
}));

vi.mock('../../../src/hooks/useNotifications', () => ({
  useNotifications: () => mocks.useNotifications(),
}));
vi.mock('../../../src/hooks/usePushSubscription', () => ({
  usePushSubscription: () => ({
    supported: false,
    permission: 'unsupported',
    isSubscribed: false,
    isLoading: false,
    isBusy: false,
    error: null,
    enable: vi.fn(),
    disable: vi.fn(),
    refresh: vi.fn(),
  }),
}));
vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));
vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listNotifications: mocks.listNotifications,
  markNotificationRead: mocks.markNotificationRead,
  dismissNotification: mocks.dismissNotification,
}));
vi.mock('../../../src/pages/ProjectContext', () => ({
  useProjectContext: () => ({ projectId: 'proj-1', project: { name: 'Project' } }),
}));

import { NotificationCenter } from '../../../src/components/NotificationCenter';
import { ProjectNotifications } from '../../../src/pages/ProjectNotifications';

function makeNotification(overrides: Partial<NotificationResponse>): NotificationResponse {
  return {
    id: `n-${Math.random().toString(36).slice(2)}`,
    projectId: 'proj-1',
    taskId: null,
    sessionId: 'sess-1',
    type: 'progress',
    urgency: 'low',
    title: 'Title',
    body: null,
    actionUrl: null,
    metadata: null,
    readAt: null,
    dismissedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const COMMENT_URL = '/projects/proj-1/chat/sess-1?commentThread=thread-7&commentMessage=msg-3';

const MENTION = makeNotification({
  id: 'n-mention',
  type: 'mention',
  urgency: 'medium',
  title: 'Grace mentioned you in a comment',
  actionUrl: COMMENT_URL,
});
const COMMENT = makeNotification({
  id: 'n-comment',
  type: 'comment',
  title: 'Grace commented on your session',
  actionUrl: COMMENT_URL,
});
const ACCESS = makeNotification({
  id: 'n-access',
  type: 'session_access',
  urgency: 'medium',
  title: 'Prakash shared a chat with you',
  actionUrl: '/projects/proj-1/chat/sess-1',
});
const QUESTION = makeNotification({
  id: 'n-question',
  type: 'needs_input',
  urgency: 'high',
  title: 'Agent needs help',
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderBell(notifications: NotificationResponse[]) {
  mocks.useNotifications.mockReturnValue({
    notifications,
    unreadCount: notifications.length,
    loading: false,
    connectionState: 'connected',
    markRead: vi.fn().mockResolvedValue(undefined),
    markAllRead: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined),
    loadMore: vi.fn().mockResolvedValue(undefined),
    hasMore: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  });
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <NotificationCenter />
      <LocationProbe />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('NotificationCenter — collaboration types', () => {
  it('treats a mention as needing attention, and comments and shared sessions as updates', () => {
    renderBell([MENTION, COMMENT, ACCESS, QUESTION]);

    // Badge: the mention and the agent question, not the two updates.
    const bell = screen.getByRole('button', { name: /notifications \(2 need attention\)/i });
    fireEvent.click(bell);

    const panel = screen.getByRole('dialog', { name: 'Notifications' });
    expect(within(panel).getByText('Grace mentioned you in a comment')).toBeInTheDocument();
    expect(within(panel).getByText('Mention')).toBeInTheDocument();
    expect(within(panel).getByText('Agent needs help')).toBeInTheDocument();
    expect(within(panel).queryByText('Grace commented on your session')).toBeNull();
    expect(within(panel).queryByText('Prakash shared a chat with you')).toBeNull();

    fireEvent.click(within(panel).getByRole('tab', { name: /updates/i }));
    expect(within(panel).getByText('Grace commented on your session')).toBeInTheDocument();
    expect(within(panel).getByText('Comment')).toBeInTheDocument();
    expect(within(panel).getByText('Prakash shared a chat with you')).toBeInTheDocument();
    expect(within(panel).getByText('Shared Session')).toBeInTheDocument();
    expect(within(panel).queryByText('Grace mentioned you in a comment')).toBeNull();
  });

  it('opens the commented thread from a comment notification', () => {
    renderBell([MENTION]);
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    fireEvent.click(screen.getByText('Grace mentioned you in a comment'));
    expect(screen.getByTestId('location')).toHaveTextContent(COMMENT_URL);
  });

  it('renders a type this build does not know as a plain update instead of crashing', () => {
    renderBell([
      makeNotification({
        id: 'n-future',
        type: 'future_type' as NotificationResponse['type'],
        title: 'Something new happened',
      }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    fireEvent.click(screen.getByRole('tab', { name: /updates/i }));
    expect(screen.getByText('Something new happened')).toBeInTheDocument();
    expect(screen.getByText('Progress')).toBeInTheDocument();
  });
});

describe('ProjectNotifications — collaboration types', () => {
  it('offers the new types as filters and renders their rows', async () => {
    mocks.listNotifications.mockResolvedValue({
      notifications: [MENTION, COMMENT, ACCESS],
      unreadCount: 3,
      nextCursor: null,
    });
    render(
      <MemoryRouter>
        <ProjectNotifications />
      </MemoryRouter>
    );

    expect(await screen.findByText('Grace mentioned you in a comment')).toBeInTheDocument();
    expect(screen.getByText('Grace commented on your session')).toBeInTheDocument();
    expect(screen.getByText('Prakash shared a chat with you')).toBeInTheDocument();

    for (const label of ['Mention', 'Comment', 'Shared Session']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Mention' }));
    await waitFor(() =>
      expect(mocks.listNotifications).toHaveBeenLastCalledWith(
        expect.objectContaining({ projectId: 'proj-1', type: 'mention' })
      )
    );
  });

  it('does not crash on a type this build does not know', async () => {
    mocks.listNotifications.mockResolvedValue({
      notifications: [
        makeNotification({
          id: 'n-future',
          type: 'future_type' as NotificationResponse['type'],
          title: 'Something new happened',
        }),
      ],
      unreadCount: 1,
      nextCursor: null,
    });
    render(
      <MemoryRouter>
        <ProjectNotifications />
      </MemoryRouter>
    );
    expect(await screen.findByText('Something new happened')).toBeInTheDocument();
  });
});
