import type { DetectedPort, PortsResponse, WorkspaceStatus } from '@simple-agent-manager/shared';
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

const PORT_A: DetectedPort = {
  port: 3000,
  address: '0.0.0.0',
  label: 'vite',
  url: 'https://ws-abc--3000.example.com',
  detectedAt: '2026-08-26T00:00:00.000Z',
};
const PORT_B: DetectedPort = {
  port: 8080,
  address: '0.0.0.0',
  label: 'api',
  url: 'https://ws-abc--8080.example.com',
  detectedAt: '2026-08-26T00:00:00.000Z',
};

function makePortsResponse(
  ports: DetectedPort[],
  overrides: Partial<PortsResponse> = {}
): PortsResponse {
  return {
    ports,
    state: 'ready',
    ...overrides,
  };
}

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
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint32Array) {
          array.fill(0x80000000);
        }
        return array;
      }
    );
    mockListWorkspacePorts.mockReset();
    setVisibility('visible');
  });

  afterEach(() => {
    setVisibility('visible');
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('fetches ports immediately when all dependencies are present', async () => {
    mockListWorkspacePorts.mockResolvedValue(makePortsResponse([PORT_A]));

    const { result } = renderHook(
      () => useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', 'running'),
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
    ['workspaceUrl missing', undefined, 'ws-1', 'tok-1', 'running'],
    ['workspaceId missing', 'https://ws.example.com', undefined, 'tok-1', 'running'],
    ['token missing', 'https://ws.example.com', 'ws-1', undefined, 'running'],
    ['workspace provisioning', 'https://ws.example.com', 'ws-1', 'tok-1', 'creating'],
    ['workspace sleeping', 'https://ws.example.com', 'ws-1', 'tok-1', 'sleeping'],
    ['workspace stopped', 'https://ws.example.com', 'ws-1', 'tok-1', 'stopped'],
    ['workspace deleted', 'https://ws.example.com', 'ws-1', 'tok-1', 'deleted'],
  ] as const)('returns empty ports when %s', async (_name, workspaceUrl, workspaceId, token, status) => {
    const { result } = renderHook(
      () => useWorkspacePorts(workspaceUrl, workspaceId, token, status),
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
    mockListWorkspacePorts.mockResolvedValueOnce(makePortsResponse([PORT_A, PORT_B]));
    const { result } = renderHook(
      () => useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', 'running'),
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
    mockListWorkspacePorts.mockResolvedValueOnce(makePortsResponse([PORT_A]));
    const { result } = renderHook(
      () => useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', 'running'),
      { wrapper: createWrapper() }
    );
    await flushQueries();
    expect(result.current.ports).toEqual([PORT_A]);

    mockListWorkspacePorts.mockRejectedValueOnce(new Error('401 Unauthorized'));
    await advancePoll();

    await flushQueries();
    expect(warnSpy).toHaveBeenCalledWith('useWorkspacePorts: fetch failed', {
      workspaceId: 'ws-1',
      circuitOpen: false,
      consecutiveUnavailable: 1,
      error: '401 Unauthorized',
      nextRefetchIntervalMs: 10_000,
    });
    warnSpy.mockRestore();
  });

  it('backs off repeated fetch failures, preserves stale ports, opens the circuit, and resets after success', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockListWorkspacePorts.mockResolvedValueOnce(makePortsResponse([PORT_A]));
    const { result } = renderHook(
      () => useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', 'running'),
      { wrapper: createWrapper() }
    );
    await flushQueries();
    expect(result.current.ports).toEqual([PORT_A]);

    for (const [index, delay] of [10_000, 10_000, 20_000, 40_000, 80_000, 120_000].entries()) {
      mockListWorkspacePorts.mockRejectedValueOnce(new Error(`fail ${index + 1}`));
      await advancePoll(delay);
    }

    expect(mockListWorkspacePorts).toHaveBeenCalledTimes(7);
    expect(result.current.ports).toEqual([PORT_A]);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenLastCalledWith('useWorkspacePorts: fetch failed', {
      workspaceId: 'ws-1',
      circuitOpen: true,
      consecutiveUnavailable: 6,
      error: 'fail 6',
      nextRefetchIntervalMs: 300_000,
    });

    await advancePoll(120_000);
    expect(mockListWorkspacePorts).toHaveBeenCalledTimes(7);

    mockListWorkspacePorts.mockResolvedValueOnce(makePortsResponse([PORT_B]));
    await advancePoll(180_000);
    await flushQueries();
    expect(result.current.ports).toEqual([PORT_B]);
    expect(mockListWorkspacePorts).toHaveBeenCalledTimes(8);

    mockListWorkspacePorts.mockResolvedValueOnce(makePortsResponse([PORT_A, PORT_B]));
    await advancePoll(10_000);
    await flushQueries();
    expect(result.current.ports).toEqual([PORT_A, PORT_B]);
  });

  it('treats running-but-agent-not-ready as a normal backoff state without error logging', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockListWorkspacePorts.mockResolvedValue(
      makePortsResponse([], { state: 'not_ready', retryable: true })
    );

    renderHook(() => useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', 'running'), {
      wrapper: createWrapper(),
    });

    await flushQueries();
    expect(mockListWorkspacePorts).toHaveBeenCalledTimes(1);

    await advancePoll(10_000);
    expect(mockListWorkspacePorts).toHaveBeenCalledTimes(2);

    await advancePoll(10_000);
    expect(mockListWorkspacePorts).toHaveBeenCalledTimes(3);

    await advancePoll(10_000);
    expect(mockListWorkspacePorts).toHaveBeenCalledTimes(3);

    await advancePoll(20_000);
    expect(mockListWorkspacePorts).toHaveBeenCalledTimes(3);

    await advancePoll(20_000);
    expect(mockListWorkspacePorts).toHaveBeenCalledTimes(4);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('polls recovery workspaces and resumes the normal interval after ports become ready', async () => {
    mockListWorkspacePorts
      .mockResolvedValueOnce(makePortsResponse([], { state: 'not_ready', retryable: true }))
      .mockResolvedValueOnce(makePortsResponse([PORT_A]));

    const { result } = renderHook(
      () => useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', 'recovery'),
      { wrapper: createWrapper() }
    );

    await flushQueries();
    expect(result.current.ports).toEqual([]);

    await advancePoll(10_000);
    await flushQueries();
    expect(result.current.ports).toEqual([PORT_A]);

    mockListWorkspacePorts.mockResolvedValueOnce(makePortsResponse([PORT_B]));
    await advancePoll(10_000);
    await flushQueries();
    expect(result.current.ports).toEqual([PORT_B]);
  });

  it.each(['sleeping', 'stopped', 'deleted'] as const)(
    'clears ports and stops polling promptly when the workspace status becomes %s',
    async (status) => {
      mockListWorkspacePorts.mockResolvedValueOnce(makePortsResponse([PORT_A]));
      const { result, rerender } = renderHook(
        ({ workspaceStatus }: { workspaceStatus: WorkspaceStatus }) =>
          useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', workspaceStatus),
        { initialProps: { workspaceStatus: 'running' }, wrapper: createWrapper() }
      );
      await flushQueries();
      expect(result.current.ports).toEqual([PORT_A]);

      mockListWorkspacePorts.mockClear();
      rerender({ workspaceStatus: status });
      await flushQueries();
      expect(result.current.ports).toEqual([]);

      await advancePoll(300_000);
      expect(mockListWorkspacePorts).not.toHaveBeenCalled();
    }
  );

  it.each(['sleeping', 'stopped', 'deleted', 'gone'] as const)(
    'clears stale ports and hard-stops when the server reports terminal state %s',
    async (state) => {
      mockListWorkspacePorts
        .mockResolvedValueOnce(makePortsResponse([PORT_A]))
        .mockResolvedValueOnce(makePortsResponse([], { state, retryable: false }));

      const { result } = renderHook(
        () => useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', 'running'),
        { wrapper: createWrapper() }
      );

      await flushQueries();
      expect(result.current.ports).toEqual([PORT_A]);

      await advancePoll(10_000);
      await flushQueries();
      expect(result.current.ports).toEqual([]);

      mockListWorkspacePorts.mockClear();
      await advancePoll(300_000);
      expect(mockListWorkspacePorts).not.toHaveBeenCalled();
    }
  );

  it('polls at the configured interval', async () => {
    mockListWorkspacePorts.mockResolvedValue(makePortsResponse([PORT_A]));
    renderHook(() => useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', 'running'), {
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
    let resolvePromise!: (value: PortsResponse) => void;
    mockListWorkspacePorts.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePromise = resolve;
        })
    );

    const { result } = renderHook(
      () => useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', 'running'),
      { wrapper: createWrapper() }
    );

    expect(result.current.loading).toBe(true);
    await act(async () => {
      resolvePromise(makePortsResponse([PORT_A]));
      await Promise.resolve();
    });
    await flushQueries();
    expect(result.current.loading).toBe(false);
    expect(result.current.ports).toEqual([PORT_A]);
  });

  it('uses the workspace id in the query key so late old responses cannot clobber the new target', async () => {
    let resolveFirst!: (value: PortsResponse) => void;
    mockListWorkspacePorts.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    );

    const { result, rerender } = renderHook(
      ({ workspaceId }: { workspaceId: string }) =>
        useWorkspacePorts('https://ws.example.com', workspaceId, 'tok-1', 'running'),
      { initialProps: { workspaceId: 'ws-1' }, wrapper: createWrapper() }
    );
    await flushQueries();
    expect(mockListWorkspacePorts).toHaveBeenCalledTimes(1);

    mockListWorkspacePorts.mockResolvedValueOnce(makePortsResponse([PORT_B]));
    rerender({ workspaceId: 'ws-2' });
    await flushQueries();
    expect(result.current.ports).toEqual([PORT_B]);

    await act(async () => {
      resolveFirst(makePortsResponse([PORT_A]));
    });
    expect(result.current.ports).toEqual([PORT_B]);
  });

  it('uses token changes as a new request generation without storing raw tokens in query keys', async () => {
    let resolveFirst!: (value: PortsResponse) => void;
    mockListWorkspacePorts.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    );
    const client = createTestQueryClient();

    const { result, rerender } = renderHook(
      ({ token }: { token: string }) =>
        useWorkspacePorts('https://ws.example.com', 'ws-1', token, 'running'),
      { initialProps: { token: 'tok-1' }, wrapper: createWrapper(client) }
    );
    await flushQueries();
    expect(mockListWorkspacePorts).toHaveBeenCalledWith(
      'https://ws.example.com',
      'ws-1',
      'tok-1',
      expect.any(AbortSignal)
    );

    mockListWorkspacePorts.mockResolvedValueOnce(makePortsResponse([PORT_B]));
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
      resolveFirst(makePortsResponse([PORT_A]));
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
    mockListWorkspacePorts.mockResolvedValue(makePortsResponse([PORT_A]));
    renderHook(() => useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', 'running'), {
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
