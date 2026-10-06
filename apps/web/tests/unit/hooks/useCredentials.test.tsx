import type { CredentialResponse } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCredentials, useInvalidateCredentials } from '../../../src/hooks/useCredentials';

const mocks = vi.hoisted(() => ({
  listCredentials: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listCredentials: mocks.listCredentials,
}));

const CREDENTIAL = {
  id: 'cred-1',
  provider: 'hetzner',
  connected: true,
  createdAt: '2026-08-01T00:00:00.000Z',
} as unknown as CredentialResponse;

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, Wrapper };
}

describe('useCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCredentials.mockResolvedValue([CREDENTIAL]);
  });

  /**
   * The headline dedup win. This is a hook-level test: it proves N mounted consumers
   * of THIS hook collapse to one request. It deliberately does not name the real
   * components, because not all of them route through the hook yet — see
   * `lib/query-options/credentials.ts` for the current split. Whole-app dedup is a
   * property of the call sites, not of this hook, and is asserted separately in
   * `query-dedup-request-counts.test.tsx`.
   */
  it('collapses any number of concurrent consumers into one request', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(
      () => ({
        first: useCredentials('user-1'),
        second: useCredentials('user-1'),
        third: useCredentials('user-1'),
        fourth: useCredentials('user-1'),
        fifth: useCredentials('user-1'),
      }),
      { wrapper: Wrapper }
    );

    await waitFor(() => expect(result.current.first.credentials).toEqual([CREDENTIAL]));
    expect(result.current.third.credentials).toEqual([CREDENTIAL]);
    expect(result.current.fifth.credentials).toEqual([CREDENTIAL]);
    expect(mocks.listCredentials).toHaveBeenCalledTimes(1);
  });

  it('surfaces the error when the first load fails with nothing cached', async () => {
    const { Wrapper } = createWrapper();
    mocks.listCredentials.mockRejectedValue(new Error('credentials unavailable'));

    const { result } = renderHook(() => useCredentials('user-1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.error).toBe('credentials unavailable'));
    expect(result.current.credentials).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('serves a remounting consumer from cache without a network hop', async () => {
    const { Wrapper } = createWrapper();
    const first = renderHook(() => useCredentials('user-1'), { wrapper: Wrapper });
    await waitFor(() => expect(first.result.current.credentials).toEqual([CREDENTIAL]));
    first.unmount();

    const second = renderHook(() => useCredentials('user-1'), { wrapper: Wrapper });
    expect(second.result.current.credentials).toEqual([CREDENTIAL]);
    expect(second.result.current.loading).toBe(false);
    expect(mocks.listCredentials).toHaveBeenCalledTimes(1);
  });

  it('keeps credentials visible during a background refresh', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useCredentials('user-1'), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.credentials).toEqual([CREDENTIAL]));

    let resolveRefresh: ((value: CredentialResponse[]) => void) | undefined;
    mocks.listCredentials.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.isRefreshing).toBe(true));
    expect(result.current.credentials).toEqual([CREDENTIAL]);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      resolveRefresh?.([]);
    });
    await waitFor(() => expect(result.current.credentials).toEqual([]));
  });

  it('invalidation refreshes every consumer, not just the mutating one', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(
      () => ({
        settings: useCredentials('user-1'),
        sibling: useCredentials('user-1'),
        invalidate: useInvalidateCredentials('user-1'),
      }),
      { wrapper: Wrapper }
    );
    await waitFor(() => expect(result.current.sibling.credentials).toEqual([CREDENTIAL]));

    mocks.listCredentials.mockResolvedValue([CREDENTIAL, { ...CREDENTIAL, id: 'cred-2' }]);

    await act(async () => {
      await result.current.invalidate();
    });

    await waitFor(() => expect(result.current.sibling.credentials).toHaveLength(2));
    expect(result.current.settings.credentials).toHaveLength(2);
  });

  it('isolates credentials by authenticated query scope', async () => {
    const { client, Wrapper } = createWrapper();
    mocks.listCredentials
      .mockResolvedValueOnce([{ ...CREDENTIAL, id: 'user-one-cred' }])
      .mockResolvedValueOnce([{ ...CREDENTIAL, id: 'user-two-cred' }]);

    const { result } = renderHook(
      () => ({ userOne: useCredentials('user-1'), userTwo: useCredentials('user-2') }),
      { wrapper: Wrapper }
    );

    await waitFor(() => {
      expect(result.current.userOne.credentials[0]?.id).toBe('user-one-cred');
      expect(result.current.userTwo.credentials[0]?.id).toBe('user-two-cred');
    });
    expect(client.getQueryData(['auth', 'user-1', 'credentials', 'list'])).toBeDefined();
    expect(client.getQueryData(['auth', 'user-2', 'credentials', 'list'])).toBeDefined();
  });

  it('issues no request while signed out', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useCredentials(''), { wrapper: Wrapper });

    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.listCredentials).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });
});
