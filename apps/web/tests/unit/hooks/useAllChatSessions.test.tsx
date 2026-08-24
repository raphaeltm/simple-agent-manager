import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAllChatSessions } from '../../../src/hooks/useAllChatSessions';

const mocks = vi.hoisted(() => ({
  getAllChats: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getAllChats: mocks.getAllChats,
}));

const SESSION = {
  id: 'session-1',
  projectId: 'project-1',
  projectName: 'Acme',
  userId: 'user-1',
  status: 'active',
  topic: 'Fix the login bug',
  taskId: null,
  workspaceId: null,
  startedAt: 1_755_000_000_000,
  lastMessageAt: 1_755_000_100_000,
  messageCount: 4,
};

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, Wrapper };
}

describe('useAllChatSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAllChats.mockResolvedValue({ sessions: [SESSION], total: 1 });
  });

  it('shows first-load loading before any data resolves', () => {
    const { Wrapper } = createWrapper();
    mocks.getAllChats.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useAllChatSessions('user-1'), { wrapper: Wrapper });

    expect(result.current.loading).toBe(true);
    expect(result.current.sessions).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('loads an empty successful response as an explicit empty state', async () => {
    const { Wrapper } = createWrapper();
    mocks.getAllChats.mockResolvedValue({ sessions: [], total: 0 });

    const { result } = renderHook(() => useAllChatSessions('user-1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sessions).toEqual([]);
    // An empty list is a real answer, not a failure — the page must be free to show
    // its empty state rather than an error.
    expect(result.current.error).toBeNull();
  });

  it('maps startedAt onto the createdAt compat field consumers expect', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useAllChatSessions('user-1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    expect(result.current.sessions[0]?.createdAt).toBe(SESSION.startedAt);
    expect(result.current.sessions[0]?.topic).toBe('Fix the login bug');
  });

  /**
   * The defect this migration fixes.
   *
   * `pages/Chats.tsx` renders its list under `{!loading && …}`. The pre-migration hook
   * set `loading` back to `true` on the *first* fetch only, but every `refresh()` also
   * ran through the same code path with `hasLoadedRef` gating `isRefreshing` — and the
   * page never consulted `isRefreshing`. Any refetch that flipped `loading` blanked the
   * entire chat list.
   *
   * `loading` must therefore be false for the whole duration of a refetch that has
   * cached data behind it.
   */
  it('never re-enters the loading state once data is cached', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useAllChatSessions('user-1'), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    let resolveRefresh: ((value: { sessions: unknown[]; total: number }) => void) | undefined;
    mocks.getAllChats.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.isRefreshing).toBe(true));
    // These two assertions together are what keep `Chats.tsx` from blanking.
    expect(result.current.loading).toBe(false);
    expect(result.current.sessions).toHaveLength(1);

    await act(async () => {
      resolveRefresh?.({ sessions: [SESSION, { ...SESSION, id: 'session-2' }], total: 2 });
    });
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));
  });

  it('keeps the list mounted when a background refresh fails', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useAllChatSessions('user-1'), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    mocks.getAllChats.mockRejectedValueOnce(new Error('network'));
    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('reports an error, not an empty list, when the first load fails', async () => {
    const { Wrapper } = createWrapper();
    mocks.getAllChats.mockRejectedValueOnce(new Error('network'));

    const { result } = renderHook(() => useAllChatSessions('user-1'), { wrapper: Wrapper });

    // The hook now propagates the real error message, like its five siblings.
    await waitFor(() => expect(result.current.error).toBe('network'));
    expect(result.current.sessions).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('isolates sessions by authenticated query scope', async () => {
    const { client, Wrapper } = createWrapper();
    mocks.getAllChats
      .mockResolvedValueOnce({ sessions: [{ ...SESSION, topic: 'User one chat' }], total: 1 })
      .mockResolvedValueOnce({ sessions: [{ ...SESSION, topic: 'User two chat' }], total: 1 });

    const { result } = renderHook(
      () => ({
        userOne: useAllChatSessions('user-1'),
        userTwo: useAllChatSessions('user-2'),
      }),
      { wrapper: Wrapper }
    );

    await waitFor(() => {
      expect(result.current.userOne.sessions[0]?.topic).toBe('User one chat');
      expect(result.current.userTwo.sessions[0]?.topic).toBe('User two chat');
    });
    expect(client.getQueryData(['auth', 'user-1', 'chats', 'list', { limit: 100 }])).toBeDefined();
    expect(client.getQueryData(['auth', 'user-2', 'chats', 'list', { limit: 100 }])).toBeDefined();
  });

  it('issues no request while signed out', async () => {
    const { Wrapper } = createWrapper();
    renderHook(() => useAllChatSessions(''), { wrapper: Wrapper });

    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.getAllChats).not.toHaveBeenCalled();
  });
});
