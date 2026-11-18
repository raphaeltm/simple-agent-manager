/**
 * A signed-out tab whose focus refetch comes back signed in as someone must not show cached data
 * from before the change. The background-revalidation path for signed-out visitors
 * (`confirmedSignedOutRef` in AuthProvider) must not skip the identity transition. Drives the real
 * BetterAuth client and its focus listener; only the network is faked. Its own file because the
 * BetterAuth session store is module state.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from '../../../src/components/AuthProvider';
import { queryClient } from '../../../src/lib/query-client';

const network = vi.hoisted(() => {
  const state = { impl: (_url: string): Promise<Response> => new Promise<Response>(() => {}) };
  globalThis.fetch = ((input: RequestInfo | URL) =>
    state.impl(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    )) as typeof fetch;
  return state;
});

vi.mock('../../../src/hooks/useQueryCachePersistence', () => ({
  useQueryCachePersistence: () => false,
  discardPersistedQueryCache: vi.fn(),
}));

const SIGNED_IN = {
  session: { id: 'session-b', userId: 'user-b', expiresAt: '2099-01-01T00:00:00.000Z' },
  user: { id: 'user-b', name: 'B', email: 'b@example.test', role: 'user', status: 'active' },
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.restoreAllMocks());

function Identity() {
  const { user } = useAuth();
  return <span data-testid="user">{user?.id ?? 'signed-out'}</span>;
}

it('clears cached data when a focus refetch finds a different signed-in identity', async () => {
  let sessionRequests = 0;
  let releaseRefetch: (() => void) | null = null;
  network.impl = async (url) => {
    if (!url.includes('/get-session')) return json(null);
    sessionRequests += 1;
    if (sessionRequests === 1) return json(null);
    await new Promise<void>((resolve) => {
      releaseRefetch = resolve;
    });
    return json(SIGNED_IN);
  };

  render(
    <AuthProvider>
      <Identity />
    </AuthProvider>
  );
  await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('signed-out'));
  act(() => {
    queryClient.setQueryData(['stale-signed-out-data'], 'cached-before-sign-in');
  });
  expect(queryClient.getQueryData(['stale-signed-out-data'])).toBe('cached-before-sign-in');

  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
  act(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await waitFor(() => expect(sessionRequests).toBe(2));
  // Mid-refetch: still signed out, page still mounted (the background revalidation path).
  expect(screen.getByTestId('user')).toHaveTextContent('signed-out');

  await act(async () => {
    releaseRefetch?.();
  });
  await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('user-b'));
  // The identity change still cleared what was cached before it.
  expect(queryClient.getQueryData(['stale-signed-out-data'])).toBeUndefined();
});
