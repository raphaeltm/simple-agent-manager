import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '../../../src/lib/api/client';
import {
  ACP_PERMISSION_POLL_MS,
  ACP_PERMISSION_RECOVERY_POLL_MS,
} from '../../../src/lib/poll-intervals';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('../../../src/lib/api/acp-interactions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/acp-interactions')>()),
  listAcpInteractions: mocks.list,
}));

import { useAcpPermissionInteractions } from '../../../src/hooks/useAcpPermissionInteractions';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useAcpPermissionInteractions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue({ pending: [], settled: [] });
  });

  it('refetches once when a disconnected session reconnects without entering a fetch loop', async () => {
    const pending = {
      interactionId: '11111111-1111-4111-8111-111111111111',
      kind: 'permission' as const,
      state: 'pending' as const,
      createdAt: 1,
      deadlineAt: Date.now() + 60_000,
    };
    mocks.list
      .mockResolvedValueOnce({ pending: [pending], settled: [], cursor: null })
      .mockResolvedValue({
        pending: [],
        settled: [{ ...pending, state: 'interrupted' }],
        cursor: null,
      });
    const { result, rerender } = renderHook(
      ({ connectionState }) =>
        useAcpPermissionInteractions({
          projectId: 'project-1',
          sessionId: 'session-1',
          viewerId: 'viewer-1',
          connectionState,
          refreshSignal: null,
        }),
      {
        initialProps: { connectionState: 'disconnected' },
        wrapper: createWrapper(),
      }
    );

    await waitFor(() => expect(result.current.interactions[0]?.state).toBe('pending'));
    rerender({ connectionState: 'connected' });
    await waitFor(() => expect(result.current.interactions[0]?.state).toBe('interrupted'));
    expect(mocks.list).toHaveBeenCalledTimes(2);
    await new Promise((resolve) => window.setTimeout(resolve, 25));
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('does not fetch without an authenticated viewer', async () => {
    renderHook(
      () =>
        useAcpPermissionInteractions({
          projectId: 'project-1',
          sessionId: 'session-1',
          viewerId: null,
          connectionState: 'connected',
          refreshSignal: null,
        }),
      { wrapper: createWrapper() }
    );

    await new Promise((resolve) => window.setTimeout(resolve, 25));
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('fails closed when an older fixture or malformed response omits snapshot arrays', async () => {
    mocks.list.mockResolvedValueOnce({});
    const { result } = renderHook(
      () =>
        useAcpPermissionInteractions({
          projectId: 'project-1',
          sessionId: 'session-1',
          viewerId: 'viewer-1',
          connectionState: 'connected',
          refreshSignal: null,
        }),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.interactions).toEqual([]);
  });

  it('discovers an empty-to-pending request and a second request from attention signals without reconnecting or remounting', async () => {
    const first = {
      interactionId: '11111111-1111-4111-8111-111111111111',
      kind: 'permission' as const,
      state: 'pending' as const,
      createdAt: 1,
      deadlineAt: Date.now() + 60_000,
    };
    const answered = { ...first, state: 'answered' as const, deliveryState: 'pending' as const };
    const second = {
      ...first,
      interactionId: '22222222-2222-4222-8222-222222222222',
      createdAt: 2,
    };
    mocks.list
      .mockResolvedValueOnce({ pending: [], settled: [], cursor: null })
      .mockResolvedValueOnce({ pending: [first], settled: [], cursor: null })
      .mockResolvedValueOnce({ pending: [answered], settled: [], cursor: null })
      .mockResolvedValueOnce({ pending: [answered, second], settled: [], cursor: null });

    const { result, rerender } = renderHook(
      ({ refreshSignal }) =>
        useAcpPermissionInteractions({
          projectId: 'project-1',
          sessionId: 'session-1',
          viewerId: 'viewer-1',
          connectionState: 'connected',
          refreshSignal,
        }),
      { initialProps: { refreshSignal: null as string | null }, wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.interactions).toEqual([]);

    rerender({ refreshSignal: 'marker-1' });
    await waitFor(() =>
      expect(result.current.interactions.map((item) => item.state)).toEqual(['pending'])
    );

    rerender({ refreshSignal: null });
    await waitFor(() =>
      expect(result.current.interactions.map((item) => item.state)).toEqual(['answered'])
    );

    rerender({ refreshSignal: 'marker-2' });
    await waitFor(() =>
      expect(result.current.interactions.map((item) => item.interactionId)).toEqual([
        first.interactionId,
        second.interactionId,
      ])
    );
    expect(mocks.list).toHaveBeenCalledTimes(4);
  });

  it('uses one bounded recovery request per idle interval instead of a refetch loop', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(
        () =>
          useAcpPermissionInteractions({
            projectId: 'project-1',
            sessionId: 'session-1',
            viewerId: 'viewer-1',
            connectionState: 'connected',
            refreshSignal: null,
          }),
        { wrapper: createWrapper() }
      );
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(mocks.list).toHaveBeenCalledTimes(1);

      await act(async () => vi.advanceTimersByTimeAsync(ACP_PERMISSION_RECOVERY_POLL_MS - 1));
      expect(mocks.list).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(mocks.list).toHaveBeenCalledTimes(2);
      expect(result.current.interactions).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the fast delivery refresh while the pending bucket contains an answered item', async () => {
    vi.useFakeTimers();
    const answered = {
      interactionId: '11111111-1111-4111-8111-111111111111',
      kind: 'permission' as const,
      state: 'answered' as const,
      deliveryState: 'pending' as const,
      createdAt: 1,
      deadlineAt: Date.now() + 60_000,
    };
    mocks.list
      .mockResolvedValueOnce({ pending: [answered], settled: [], cursor: null })
      .mockResolvedValueOnce({
        pending: [],
        settled: [{ ...answered, state: 'delivery_confirmed', deliveryState: 'confirmed' }],
        cursor: null,
      });
    try {
      const { result } = renderHook(
        () =>
          useAcpPermissionInteractions({
            projectId: 'project-1',
            sessionId: 'session-1',
            viewerId: 'viewer-1',
            connectionState: 'connected',
            refreshSignal: null,
          }),
        { wrapper: createWrapper() }
      );
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(result.current.interactions[0]?.state).toBe('answered');

      await act(async () => vi.advanceTimersByTimeAsync(ACP_PERMISSION_POLL_MS));
      expect(mocks.list).toHaveBeenCalledTimes(2);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(result.current.interactions[0]?.state).toBe('delivery_confirmed');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([401, 403] as const)(
    'fails closed immediately when a snapshot refetch observes authorization status %s',
    async (status) => {
      const pending = {
        interactionId: '11111111-1111-4111-8111-111111111111',
        kind: 'permission' as const,
        state: 'pending' as const,
        createdAt: 1,
        deadlineAt: Date.now() + 60_000,
      };
      mocks.list
        .mockResolvedValueOnce({ pending: [pending], settled: [], cursor: null })
        .mockRejectedValueOnce(
          new ApiClientError(
            status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
            status === 401 ? 'Unauthorized' : 'Forbidden',
            status
          )
        );
      const { result } = renderHook(
        () =>
          useAcpPermissionInteractions({
            projectId: 'project-1',
            sessionId: 'session-1',
            viewerId: 'viewer-1',
            connectionState: 'connected',
            refreshSignal: null,
          }),
        { wrapper: createWrapper() }
      );

      await waitFor(() => expect(result.current.interactions).toHaveLength(1));
      await act(async () => {
        await result.current.refresh();
      });

      await waitFor(() => expect(result.current.authorizationError).toBe(true));
      expect(result.current.interactions).toEqual([]);
    }
  );
});
