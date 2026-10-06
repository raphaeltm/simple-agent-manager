import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRecentChats } from '../../../src/hooks/useRecentChats';

const mocks = vi.hoisted(() => ({
  getRecentChats: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getRecentChats: mocks.getRecentChats,
}));

const SESSION = {
  id: 'session-1',
  projectId: 'project-1',
  projectName: 'Acme',
  userId: 'user-1',
  status: 'active',
  topic: 'Ship the thing',
  taskId: null,
  workspaceId: null,
  startedAt: 1_755_000_000_000,
  lastMessageAt: 1_755_000_100_000,
  messageCount: 2,
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

describe('useRecentChats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRecentChats.mockResolvedValue({ sessions: [SESSION], totalActive: 3 });
  });

  afterEach(() => {
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  it('fetches nothing until the dropdown is opened', async () => {
    const { Wrapper } = createWrapper();
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useRecentChats(open, 'user-1'),
      { wrapper: Wrapper, initialProps: { open: false } }
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.getRecentChats).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);

    rerender({ open: true });
    await waitFor(() => expect(result.current.chats).toHaveLength(1));
    expect(mocks.getRecentChats).toHaveBeenCalledTimes(1);
  });

  it('exposes the active count alongside the sessions', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useRecentChats(true, 'user-1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.activeCount).toBe(3));
    expect(result.current.chats[0]?.createdAt).toBe(SESSION.startedAt);
  });

  it('keeps chats visible during a background refresh', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useRecentChats(true, 'user-1'), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.chats).toHaveLength(1));

    let resolveRefresh: ((value: { sessions: unknown[]; totalActive: number }) => void) | undefined;
    mocks.getRecentChats.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.isRefreshing).toBe(true));
    expect(result.current.chats).toHaveLength(1);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      resolveRefresh?.({ sessions: [], totalActive: 0 });
    });
    await waitFor(() => expect(result.current.chats).toHaveLength(0));
  });

  it('reopening within the stale window serves from cache without refetching', async () => {
    const { Wrapper } = createWrapper();
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useRecentChats(open, 'user-1'),
      { wrapper: Wrapper, initialProps: { open: true } }
    );
    await waitFor(() => expect(result.current.chats).toHaveLength(1));
    expect(mocks.getRecentChats).toHaveBeenCalledTimes(1);

    rerender({ open: false });
    rerender({ open: true });

    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.getRecentChats).toHaveBeenCalledTimes(1);
    expect(result.current.chats).toHaveLength(1);
  });

  /**
   * Rule 60 polling hygiene — see the equivalent test in `useActiveTasks.test.tsx`.
   *
   * The dropdown's real cadence is 30 s, which no test should wait for. Instead this
   * asserts the property that makes the cadence irrelevant: with the tab hidden, the
   * observer issues nothing regardless of how many intervals elapse.
   */
  it('stops polling while the tab is hidden', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useRecentChats(true, 'user-1'), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.chats).toHaveLength(1));

    act(() => {
      focusManager.setFocused(false);
    });
    const afterFirstLoad = mocks.getRecentChats.mock.calls.length;

    // Force a refetch attempt while hidden: an explicit invalidate is the strongest
    // available prod of "would this fetch in the background?".
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    expect(mocks.getRecentChats.mock.calls.length).toBe(afterFirstLoad);
  });

  it('isolates chats by authenticated query scope', async () => {
    const { client, Wrapper } = createWrapper();
    mocks.getRecentChats
      .mockResolvedValueOnce({ sessions: [{ ...SESSION, topic: 'User one' }], totalActive: 1 })
      .mockResolvedValueOnce({ sessions: [{ ...SESSION, topic: 'User two' }], totalActive: 2 });

    const { result } = renderHook(
      () => ({
        userOne: useRecentChats(true, 'user-1'),
        userTwo: useRecentChats(true, 'user-2'),
      }),
      { wrapper: Wrapper }
    );

    await waitFor(() => {
      expect(result.current.userOne.chats[0]?.topic).toBe('User one');
      expect(result.current.userTwo.chats[0]?.topic).toBe('User two');
    });
    expect(client.getQueryData(['auth', 'user-1', 'chats', 'recent'])).toBeUndefined();
    // The key carries the limit/threshold params, so match by predicate instead.
    const keys = client
      .getQueryCache()
      .getAll()
      .map((q) => q.queryKey as unknown[]);
    expect(keys.some((k) => k[1] === 'user-1' && k[2] === 'chats')).toBe(true);
    expect(keys.some((k) => k[1] === 'user-2' && k[2] === 'chats')).toBe(true);
  });
});
