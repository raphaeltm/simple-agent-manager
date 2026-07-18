import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAllChats: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getAllChats: mocks.getAllChats,
}));

import { useAllChatSessions } from '../../../src/hooks/useAllChatSessions';

const NOW = Date.now();

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    projectId: 'proj-1',
    projectName: 'My Project',
    userId: 'user-1',
    status: 'active',
    topic: 'A chat session',
    taskId: null,
    workspaceId: null,
    messageCount: 5,
    startedAt: NOW - 60_000,
    lastMessageAt: NOW - 30_000,
    agentCompletedAt: null,
    endedAt: null,
    updatedAt: NOW - 30_000,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useAllChatSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows first-load loading before any data resolves', () => {
    mocks.getAllChats.mockReturnValue(deferred().promise);

    const { result } = renderHook(() => useAllChatSessions());

    expect(result.current.sessions).toEqual([]);
    expect(result.current.loading).toBe(true);
    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('loads an empty successful response as an explicit empty state', async () => {
    mocks.getAllChats.mockResolvedValue({ sessions: [], total: 0 });

    const { result } = renderHook(() => useAllChatSessions());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.sessions).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('keeps existing sessions visible while refresh is in flight', async () => {
    const refresh = deferred<{ sessions: ReturnType<typeof makeSession>[]; total: number }>();
    mocks.getAllChats
      .mockResolvedValueOnce({ sessions: [makeSession({ id: 'sess-old', topic: 'Known good session' })], total: 1 })
      .mockReturnValueOnce(refresh.promise);

    const { result } = renderHook(() => useAllChatSessions());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sessions).toMatchObject([{ id: 'sess-old', topic: 'Known good session' }]);

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.isRefreshing).toBe(true));
    expect(result.current.loading).toBe(false);
    expect(result.current.sessions).toMatchObject([{ id: 'sess-old', topic: 'Known good session' }]);

    await act(async () => {
      refresh.resolve({ sessions: [makeSession({ id: 'sess-new', topic: 'Updated session' })], total: 1 });
      await refresh.promise;
    });

    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
    expect(result.current.sessions).toMatchObject([{ id: 'sess-new', topic: 'Updated session' }]);
  });

  it('surfaces refresh failure without blanking stale data', async () => {
    const refresh = deferred<{ sessions: ReturnType<typeof makeSession>[]; total: number }>();
    mocks.getAllChats
      .mockResolvedValueOnce({ sessions: [makeSession({ id: 'sess-old', topic: 'Known good session' })], total: 1 })
      .mockReturnValueOnce(refresh.promise);

    const { result } = renderHook(() => useAllChatSessions());

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.isRefreshing).toBe(true));

    await act(async () => {
      refresh.reject(new Error('network failed'));
      await refresh.promise.catch(() => undefined);
    });

    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe('Failed to load chat sessions');
    expect(result.current.sessions).toMatchObject([{ id: 'sess-old', topic: 'Known good session' }]);
  });

  it('surfaces first-load failure with no sessions', async () => {
    mocks.getAllChats.mockRejectedValue(new Error('network failed'));

    const { result } = renderHook(() => useAllChatSessions());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('Failed to load chat sessions');
    expect(result.current.sessions).toEqual([]);
  });
});
