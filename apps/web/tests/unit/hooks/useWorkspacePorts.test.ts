import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWorkspacePorts } from '../../../src/hooks/useWorkspacePorts';

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listWorkspacePorts: vi.fn(),
}));

vi.mock('../../../src/hooks/useQueryScope', () => ({
  useQueryScope: () => 'user-1',
}));

import { listWorkspacePorts } from '../../../src/lib/api';

const mockListWorkspacePorts = vi.mocked(listWorkspacePorts);

const PORT_A = {
  port: 3000,
  label: 'vite',
  url: 'https://ws-abc--3000.example.com',
  isLocal: false,
};
const PORT_B = {
  port: 8080,
  label: 'api',
  url: 'https://ws-abc--8080.example.com',
  isLocal: false,
};

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: 0,
        retry: false,
        staleTime: 0,
      },
    },
  });
}

function createWrapper(client = createTestQueryClient()) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function advancePoll(ms = 10_000) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flushQueries() {
  await act(async () => {
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    vi.advanceTimersByTime(0);
    await Promise.resolve();
  });
}

describe('useWorkspacePorts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockListWorkspacePorts.mockReset();
    setVisibility('visible');
  });

  afterEach(() => {
    setVisibility('visible');
    vi.useRealTimers();
  });

  it('fetches ports immediately when all dependencies are present', async () => {
    mockListWorkspacePorts.mockResolvedValue([PORT_A]);

    const { result } = renderHook(
      () => useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', true),
      { wrapper: createWrapper() }
    );

    await flushQueries();
    expect(result.current.ports).toEqual([PORT_A]);
    expect(mockListWorkspacePorts).toHaveBeenCalledWith(
      'https://ws.example.com',
      'ws-1',
      'tok-1',
      expect.any(AbortSignal)
    );
  });

  it.each([
    ['workspaceUrl missing', undefined, 'ws-1', 'tok-1', true],
    ['workspaceId missing', 'https://ws.example.com', undefined, 'tok-1', true],
    ['token missing', 'https://ws.example.com', 'ws-1', undefined, true],
    ['workspace stopped', 'https://ws.example.com', 'ws-1', 'tok-1', false],
  ])('returns empty ports when %s', async (_name, workspaceUrl, workspaceId, token, isRunning) => {
    const { result } = renderHook(
      () => useWorkspacePorts(workspaceUrl, workspaceId, token, isRunning),
      { wrapper: createWrapper() }
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockListWorkspacePorts).not.toHaveBeenCalled();
    expect(result.current.ports).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('keeps stale ports visible during a background failure', async () => {
    mockListWorkspacePorts.mockResolvedValueOnce([PORT_A, PORT_B]);
    const { result } = renderHook(
      () => useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', true),
      { wrapper: createWrapper() }
    );
    await flushQueries();
    expect(result.current.ports).toEqual([PORT_A, PORT_B]);

    mockListWorkspacePorts.mockRejectedValueOnce(new Error('401 Unauthorized'));
    await advancePoll();

    expect(mockListWorkspacePorts).toHaveBeenCalledTimes(2);
    expect(result.current.ports).toEqual([PORT_A, PORT_B]);
  });

  it('logs failed background fetches with the consecutive failure count', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockListWorkspacePorts.mockResolvedValueOnce([PORT_A]);
    const { result } = renderHook(
      () => useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', true),
      { wrapper: createWrapper() }
    );
    await flushQueries();
    expect(result.current.ports).toEqual([PORT_A]);

    mockListWorkspacePorts.mockRejectedValueOnce(new Error('401 Unauthorized'));
    await advancePoll();

    await flushQueries();
    expect(warnSpy).toHaveBeenCalledWith('useWorkspacePorts: fetch failed', {
      workspaceId: 'ws-1',
      consecutiveFailures: 1,
      error: '401 Unauthorized',
    });
    warnSpy.mockRestore();
  });

  it('clears ports after three consecutive failures and resets after success', async () => {
    mockListWorkspacePorts.mockResolvedValueOnce([PORT_A]);
    const { result } = renderHook(
      () => useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', true),
      { wrapper: createWrapper() }
    );
    await flushQueries();
    expect(result.current.ports).toEqual([PORT_A]);

    mockListWorkspacePorts.mockRejectedValueOnce(new Error('fail 1'));
    await advancePoll();
    mockListWorkspacePorts.mockRejectedValueOnce(new Error('fail 2'));
    await advancePoll();
    expect(result.current.ports).toEqual([PORT_A]);

    mockListWorkspacePorts.mockResolvedValueOnce([PORT_B]);
    await advancePoll();
    await flushQueries();
    expect(result.current.ports).toEqual([PORT_B]);

    for (let i = 0; i < 3; i++) {
      mockListWorkspacePorts.mockRejectedValueOnce(new Error(`fail ${i}`));
      await advancePoll();
    }
    await flushQueries();
    expect(result.current.ports).toEqual([]);
  });

  it('polls at the configured interval', async () => {
    mockListWorkspacePorts.mockResolvedValue([PORT_A]);
    renderHook(() => useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', true), {
      wrapper: createWrapper(),
    });

    await flushQueries();
    expect(mockListWorkspacePorts).toHaveBeenCalledTimes(1);
    await advancePoll();
    expect(mockListWorkspacePorts).toHaveBeenCalledTimes(2);
    await advancePoll();
    expect(mockListWorkspacePorts).toHaveBeenCalledTimes(3);
  });

  it('sets loading only while the first fetch has no data', async () => {
    let resolvePromise!: (value: typeof PORT_A[]) => void;
    mockListWorkspacePorts.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePromise = resolve;
        })
    );

    const { result } = renderHook(
      () => useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', true),
      { wrapper: createWrapper() }
    );

    expect(result.current.loading).toBe(true);
    await act(async () => {
      resolvePromise([PORT_A]);
      await Promise.resolve();
    });
    await flushQueries();
    expect(result.current.loading).toBe(false);
    expect(result.current.ports).toEqual([PORT_A]);
  });

  it('uses the workspace id in the query key so late old responses cannot clobber the new target', async () => {
    let resolveFirst!: (value: typeof PORT_A[]) => void;
    mockListWorkspacePorts.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    );

    const { result, rerender } = renderHook(
      ({ workspaceId }: { workspaceId: string }) =>
        useWorkspacePorts('https://ws.example.com', workspaceId, 'tok-1', true),
      { initialProps: { workspaceId: 'ws-1' }, wrapper: createWrapper() }
    );
    await flushQueries();
    expect(mockListWorkspacePorts).toHaveBeenCalledTimes(1);

    mockListWorkspacePorts.mockResolvedValueOnce([PORT_B]);
    rerender({ workspaceId: 'ws-2' });
    await flushQueries();
    expect(result.current.ports).toEqual([PORT_B]);

    await act(async () => {
      resolveFirst([PORT_A]);
    });
    expect(result.current.ports).toEqual([PORT_B]);
  });

  it('uses token changes as a new request generation without storing raw tokens in query keys', async () => {
    let resolveFirst!: (value: typeof PORT_A[]) => void;
    mockListWorkspacePorts.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    );
    const client = createTestQueryClient();

    const { result, rerender } = renderHook(
      ({ token }: { token: string }) =>
        useWorkspacePorts('https://ws.example.com', 'ws-1', token, true),
      { initialProps: { token: 'tok-1' }, wrapper: createWrapper(client) }
    );
    await flushQueries();
    expect(mockListWorkspacePorts).toHaveBeenCalledWith(
      'https://ws.example.com',
      'ws-1',
      'tok-1',
      expect.any(AbortSignal)
    );

    mockListWorkspacePorts.mockResolvedValueOnce([PORT_B]);
    rerender({ token: 'tok-2' });
    expect(result.current.ports).toEqual([]);
    expect(result.current.loading).toBe(true);
    await flushQueries();
    expect(mockListWorkspacePorts).toHaveBeenLastCalledWith(
      'https://ws.example.com',
      'ws-1',
      'tok-2',
      expect.any(AbortSignal)
    );
    expect(result.current.ports).toEqual([PORT_B]);

    await act(async () => {
      resolveFirst([PORT_A]);
    });
    await flushQueries();
    expect(result.current.ports).toEqual([PORT_B]);

    const serializedQueryKeys = JSON.stringify(
      client.getQueryCache().getAll().map((query) => query.queryKey)
    );
    expect(serializedQueryKeys).not.toContain('tok-1');
    expect(serializedQueryKeys).not.toContain('tok-2');
  });

  it('does not issue interval refetches while the tab is hidden and resumes when visible', async () => {
    mockListWorkspacePorts.mockResolvedValue([PORT_A]);
    renderHook(() => useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', true), {
      wrapper: createWrapper(),
    });
    await flushQueries();
    expect(mockListWorkspacePorts).toHaveBeenCalledTimes(1);
    mockListWorkspacePorts.mockClear();

    setVisibility('hidden');
    await advancePoll(30_000);
    expect(mockListWorkspacePorts).not.toHaveBeenCalled();

    setVisibility('visible');
    await advancePoll();
    expect(mockListWorkspacePorts).toHaveBeenCalledTimes(1);
  });
});
