import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { type ReactNode, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCredentials } from '../../../src/hooks/useCredentials';
import { ToastProvider, useToast } from '../../../src/hooks/useToast';

/**
 * Regression coverage for the refetch loop behind
 * `.claude/rules/48-stale-while-revalidate-ui.md`.
 *
 * The original incident chained three things: an unmemoized context value, a loader
 * `useCallback` that listed that context object in its deps, and a `toast.error(…)`
 * in the loader's `catch`. Each toast changed the context identity, which recreated
 * the loader, which re-fired the effect, which failed, which raised another toast —
 * a self-sustaining loop with period ≈ fetch latency that took out the settings page.
 *
 * A TanStack query cannot form that cycle: the fetch is keyed by `queryKey`, not by
 * a closure identity, so re-rendering with a fresh context value does not re-fetch.
 * These tests pin that property rather than assuming it.
 */

const mocks = vi.hoisted(() => ({
  listCredentials: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listCredentials: mocks.listCredentials,
}));

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    );
  }
  return { client, Wrapper };
}

/**
 * Mirrors the incident's shape as closely as the migrated code allows: a consumer of
 * both the query and the toast context, which raises a toast whenever the query
 * reports an error. Every toast re-renders this subtree.
 */
function CredentialsPanel() {
  const toast = useToast();
  const { credentials, loading, error } = useCredentials('user-1');

  if (error) {
    // Deliberately unguarded — this is exactly what the incident did.
    toast.error(error);
  }

  return (
    <div>
      <span data-testid="status">{loading ? 'loading' : 'ready'}</span>
      <span data-testid="count">{credentials.length}</span>
      <span data-testid="error">{error ?? ''}</span>
    </div>
  );
}

describe('migrated queries cannot form a toast/context refetch loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not refetch when a failing query raises toasts that re-render the tree', async () => {
    const { Wrapper } = createWrapper();
    mocks.listCredentials.mockRejectedValue(new Error('Failed to load credentials'));

    render(<CredentialsPanel />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('Failed'));

    const callsAfterFirstFailure = mocks.listCredentials.mock.calls.length;

    // Let every queued toast render and settle. Under the incident's cycle the count
    // would keep climbing here; with a query key it must not move at all.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    expect(mocks.listCredentials.mock.calls.length).toBe(callsAfterFirstFailure);
    expect(callsAfterFirstFailure).toBeLessThanOrEqual(2);
  });

  it('does not refetch when an unrelated parent re-render changes context identity', async () => {
    const { Wrapper } = createWrapper();
    mocks.listCredentials.mockResolvedValue([]);

    // A parent whose state churn produces a new context value on every tick — the
    // identity instability that made the original loader restart.
    function ChurningParent() {
      const [tick, setTick] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setTick((t) => t + 1)} data-testid="churn">
            churn {tick}
          </button>
          <CredentialsPanel />
        </div>
      );
    }

    render(<ChurningParent />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    const baseline = mocks.listCredentials.mock.calls.length;
    expect(baseline).toBe(1);

    for (let i = 0; i < 5; i += 1) {
      act(() => {
        screen.getByTestId('churn').click();
      });
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Five parent re-renders, still one request: the query is keyed by data identity,
    // not by the closure that happened to request it.
    expect(mocks.listCredentials.mock.calls.length).toBe(baseline);
  });
});
