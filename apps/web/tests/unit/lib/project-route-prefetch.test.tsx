import { QueryClient } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  listChatSessions: vi.fn(),
  getChatSession: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getProject: mocks.getProject,
  listChatSessions: mocks.listChatSessions,
  getChatSession: mocks.getChatSession,
}));

import {
  initialChatSessionListQueryOptions,
  prefetchProjectRoute,
  readInitialSessionList,
} from '../../../src/lib/project-route-prefetch';
import { chatQueryKeys, projectQueryKeys } from '../../../src/lib/query-options';
import { CHAT_SESSION_LIST_LIMIT } from '../../../src/pages/project-chat/types';

const SESSIONS = [{ id: 'session-1', topic: 'First', status: 'active' }];

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000 } } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProject.mockResolvedValue({ id: 'proj-1', name: 'Project' });
  mocks.listChatSessions.mockResolvedValue({ sessions: SESSIONS, total: 1 });
  mocks.getChatSession.mockResolvedValue({ session: { id: 'session-1' }, messages: [] });
});

describe('prefetchProjectRoute', () => {
  it('starts project, session list and the URL-named transcript together for a chat deep link', () => {
    const client = newClient();
    prefetchProjectRoute(client, 'user-1', '/projects/proj-1/chat/session-1');

    expect(mocks.getProject).toHaveBeenCalledWith('proj-1', expect.anything());
    expect(mocks.listChatSessions).toHaveBeenCalledWith('proj-1', {
      limit: CHAT_SESSION_LIST_LIMIT,
    });
    expect(mocks.getChatSession).toHaveBeenCalledWith(
      'proj-1',
      'session-1',
      expect.objectContaining({ limit: expect.any(Number) })
    );
    // Every entry lands under the signed-in user's own scope, keyed as its consumer keys it.
    expect(client.getQueryState(projectQueryKeys.detail('user-1', 'proj-1'))).toBeDefined();
    expect(
      client.getQueryState(chatQueryKeys.sessionMessages('user-1', 'proj-1', 'session-1'))
    ).toBeDefined();
    expect(
      client.getQueryState(initialChatSessionListQueryOptions('user-1', 'proj-1').queryKey)
    ).toBeDefined();
  });

  it('starts the session list but no transcript for the bare chat route and the project index', () => {
    for (const path of ['/projects/proj-1/chat', '/projects/proj-1']) {
      vi.clearAllMocks();
      prefetchProjectRoute(newClient(), 'user-1', path);
      expect(mocks.getProject).toHaveBeenCalledTimes(1);
      expect(mocks.listChatSessions).toHaveBeenCalledTimes(1);
      expect(mocks.getChatSession).not.toHaveBeenCalled();
    }
  });

  it('starts only the project detail for a non-chat project page', () => {
    prefetchProjectRoute(newClient(), 'user-1', '/projects/proj-1/settings/runtime');
    expect(mocks.getProject).toHaveBeenCalledTimes(1);
    expect(mocks.listChatSessions).not.toHaveBeenCalled();
    expect(mocks.getChatSession).not.toHaveBeenCalled();
  });

  it('reads nothing while signed out, so no entry is written under an empty scope', () => {
    const client = newClient();
    prefetchProjectRoute(client, '', '/projects/proj-1/chat/session-1');
    expect(mocks.getProject).not.toHaveBeenCalled();
    expect(mocks.listChatSessions).not.toHaveBeenCalled();
    expect(mocks.getChatSession).not.toHaveBeenCalled();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
});

describe('readInitialSessionList', () => {
  it('joins the in-flight prefetch instead of reading the list a second time', async () => {
    const client = newClient();
    const list = deferred<{ sessions: typeof SESSIONS; total: number }>();
    mocks.listChatSessions.mockReturnValueOnce(list.promise);

    prefetchProjectRoute(client, 'user-1', '/projects/proj-1/chat/session-1');
    const read = readInitialSessionList(client, 'user-1', 'proj-1');
    list.resolve({ sessions: SESSIONS, total: 1 });

    await expect(read).resolves.toEqual(SESSIONS);
    expect(mocks.listChatSessions).toHaveBeenCalledTimes(1);
  });

  it('is consumed once: the next first-load reads the network again', async () => {
    const client = newClient();
    prefetchProjectRoute(client, 'user-1', '/projects/proj-1/chat');
    await readInitialSessionList(client, 'user-1', 'proj-1');
    expect(
      client.getQueryState(initialChatSessionListQueryOptions('user-1', 'proj-1').queryKey)
    ).toBeUndefined();

    const fresh = [{ id: 'session-2', topic: 'Newer', status: 'active' }];
    mocks.listChatSessions.mockResolvedValueOnce({ sessions: fresh, total: 1 });
    await expect(readInitialSessionList(client, 'user-1', 'proj-1')).resolves.toEqual(fresh);
    expect(mocks.listChatSessions).toHaveBeenCalledTimes(2);
  });

  it("never hands one user another user's prefetched list", async () => {
    const client = newClient();
    prefetchProjectRoute(client, 'user-1', '/projects/proj-1/chat');
    await waitFor(() => expect(mocks.listChatSessions).toHaveBeenCalledTimes(1));

    const otherUsers = [{ id: 'session-9', topic: 'Theirs', status: 'active' }];
    mocks.listChatSessions.mockResolvedValueOnce({ sessions: otherUsers, total: 1 });
    await expect(readInitialSessionList(client, 'user-2', 'proj-1')).resolves.toEqual(otherUsers);
    expect(mocks.listChatSessions).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// The real trigger: mounting the project route starts the reads, before the project
// page (here a stub that never renders its child routes) has loaded anything.
// ---------------------------------------------------------------------------

vi.mock('../../../src/components/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({ user: { id: 'user-1' }, isSuperadmin: false }),
}));
vi.mock('../../../src/components/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../../src/components/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../src/components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../../src/hooks/useToast', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../../src/pages/Project', () => ({
  Project: () => <div data-testid="project-shell" />,
}));
vi.mock('../../../src/pages/project-chat', () => ({
  ProjectChat: () => <div data-testid="project-chat" />,
}));

describe('App project route', () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
  });

  it('starts the transcript and session list when a chat deep link mounts, not after the project loads', async () => {
    mocks.getProject.mockReturnValue(new Promise(() => undefined));
    window.history.replaceState({}, '', '/projects/proj-1/chat/session-1');
    const { default: App } = await import('../../../src/App');

    const view = render(<App />);

    await waitFor(() => {
      expect(mocks.getChatSession).toHaveBeenCalledWith('proj-1', 'session-1', expect.anything());
      expect(mocks.listChatSessions).toHaveBeenCalledWith('proj-1', {
        limit: CHAT_SESSION_LIST_LIMIT,
      });
    });
    // The project read was started too, and is still outstanding.
    expect(mocks.getProject).toHaveBeenCalledWith('proj-1', expect.anything());
    expect(await view.findByTestId('project-shell')).toBeInTheDocument();
  });
});
