/**
 * The Updates chip: FYI notifications (including the collaboration types the old bell and
 * project Notifications page showed), never the asks the inbox already lists.
 */
import type { NotificationResponse } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/components/AuthProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/components/AuthProvider')>()),
  useAuth: () => ({ user: { id: 'user-1' }, isSuperadmin: false, isLoading: false }),
}));

const { InboxUpdatesList } = await import('../../../src/components/inbox/InboxUpdatesList');

function notification(overrides: Partial<NotificationResponse>): NotificationResponse {
  return {
    id: `n-${overrides.type}`,
    projectId: 'p1',
    taskId: null,
    sessionId: 's1',
    type: 'progress',
    urgency: 'low',
    title: `A ${overrides.type}`,
    body: null,
    actionUrl: '/projects/p1/chat/s1',
    metadata: { projectName: 'Acme' },
    readAt: null,
    dismissedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as NotificationResponse;
}

const NOTIFICATIONS = [
  notification({ type: 'mention' }),
  notification({ type: 'comment' }),
  notification({ type: 'session_access' }),
  notification({ type: 'pr_created' }),
  notification({ type: 'needs_input' }),
  notification({ type: 'secret_request' }),
  notification({ type: 'operations_approval' }),
];

const calls: { method: string; path: string; search: string }[] = [];
let location = '';
function Probe() {
  const current = useLocation();
  location = current.pathname;
  return null;
}

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      calls.push({
        method: (init?.method ?? 'GET').toUpperCase(),
        path: url.pathname,
        search: url.search,
      });
      const body =
        url.pathname === '/api/notifications'
          ? { notifications: NOTIFICATIONS, unreadCount: 7, nextCursor: null }
          : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderList(projectId: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/inbox']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <InboxUpdatesList
                  projectId={projectId}
                  showProject={projectId === null}
                  now={Date.now()}
                />
                <Probe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Inbox Updates', () => {
  it('lists FYI and collaboration notifications but not the asks the inbox shows', async () => {
    renderList(null);
    for (const type of ['mention', 'comment', 'session_access', 'pr_created']) {
      expect(await screen.findByText(`A ${type}`)).toBeInTheDocument();
    }
    for (const type of ['needs_input', 'secret_request', 'operations_approval']) {
      expect(screen.queryByText(`A ${type}`)).not.toBeInTheDocument();
    }
  });

  it('opening an update marks it read and follows its link', async () => {
    renderList(null);
    fireEvent.click(await screen.findByRole('button', { name: /^A mention/ }));
    await waitFor(() => expect(location).toBe('/projects/p1/chat/s1'));
    expect(calls).toContainEqual(
      expect.objectContaining({ method: 'POST', path: '/api/notifications/n-mention/read' })
    );
  });

  it('dismisses an update', async () => {
    renderList(null);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss A comment' }));
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ method: 'POST', path: '/api/notifications/n-comment/dismiss' })
      )
    );
  });

  it('a project inbox reads only that project', async () => {
    renderList('p1');
    await screen.findByText('A mention');
    expect(calls.find((c) => c.path === '/api/notifications')?.search).toContain('projectId=p1');
  });
});
