import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    const { rerender } = renderHook(
      ({ connectionState }) =>
        useAcpPermissionInteractions({
          projectId: 'project-1',
          sessionId: 'session-1',
          viewerId: 'viewer-1',
          connectionState,
        }),
      {
        initialProps: { connectionState: 'disconnected' },
        wrapper: createWrapper(),
      }
    );

    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    rerender({ connectionState: 'connected' });
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
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
        }),
      { wrapper: createWrapper() }
    );

    await new Promise((resolve) => window.setTimeout(resolve, 25));
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
