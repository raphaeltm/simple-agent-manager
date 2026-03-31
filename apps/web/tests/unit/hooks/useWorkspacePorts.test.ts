import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWorkspacePorts } from '../../../src/hooks/useWorkspacePorts';

// Mock the api module
vi.mock('../../../src/lib/api', () => ({
  listWorkspacePorts: vi.fn(),
}));

import { listWorkspacePorts } from '../../../src/lib/api';

const mockListWorkspacePorts = vi.mocked(listWorkspacePorts);

const PORT_A = { port: 3000, label: 'vite', url: 'https://ws-abc--3000.example.com', isLocal: false };
const PORT_B = { port: 8080, label: 'api', url: 'https://ws-abc--8080.example.com', isLocal: false };

describe('useWorkspacePorts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockListWorkspacePorts.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches ports immediately when all dependencies are present', async () => {
    mockListWorkspacePorts.mockResolvedValue([PORT_A]);

    const { result } = renderHook(() =>
      useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', true)
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockListWorkspacePorts).toHaveBeenCalledWith('https://ws.example.com', 'ws-1', 'tok-1');
    expect(result.current.ports).toEqual([PORT_A]);
  });

  it('returns empty ports when workspaceUrl is undefined', async () => {
    const { result } = renderHook(() =>
      useWorkspacePorts(undefined, 'ws-1', 'tok-1', true)
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockListWorkspacePorts).not.toHaveBeenCalled();
    expect(result.current.ports).toEqual([]);
  });

  it('returns empty ports when token is undefined', async () => {
    const { result } = renderHook(() =>
      useWorkspacePorts('https://ws.example.com', 'ws-1', undefined, true)
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockListWorkspacePorts).not.toHaveBeenCalled();
    expect(result.current.ports).toEqual([]);
  });

  it('returns empty ports when workspaceId is undefined', async () => {
    const { result } = renderHook(() =>
      useWorkspacePorts('https://ws.example.com', undefined, 'tok-1', true)
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockListWorkspacePorts).not.toHaveBeenCalled();
    expect(result.current.ports).toEqual([]);
  });

  it('returns empty ports when not running', async () => {
    const { result } = renderHook(() =>
      useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', false)
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockListWorkspacePorts).not.toHaveBeenCalled();
    expect(result.current.ports).toEqual([]);
  });

  it('preserves stale ports on a single transient failure', async () => {
    // First call succeeds
    mockListWorkspacePorts.mockResolvedValueOnce([PORT_A, PORT_B]);

    const { result } = renderHook(() =>
      useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', true)
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.ports).toEqual([PORT_A, PORT_B]);

    // Next call fails — ports should be preserved (stale data)
    mockListWorkspacePorts.mockRejectedValueOnce(new Error('401 Unauthorized'));

    await act(async () => {
      vi.advanceTimersByTime(10_000); // trigger poll interval
      await Promise.resolve();
      await Promise.resolve(); // extra tick for catch branch
    });

    expect(result.current.ports).toEqual([PORT_A, PORT_B]);
  });

  it('logs a warning on fetch failure for debuggability', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockListWorkspacePorts.mockResolvedValueOnce([PORT_A]);

    renderHook(() =>
      useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', true)
    );

    await act(async () => {
      await Promise.resolve();
    });

    mockListWorkspacePorts.mockRejectedValueOnce(new Error('401 Unauthorized'));

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(warnSpy).toHaveBeenCalledWith('useWorkspacePorts: fetch failed', {
      workspaceId: 'ws-1',
      consecutiveFailures: 1,
      error: '401 Unauthorized',
    });

    warnSpy.mockRestore();
  });

  it('clears ports after MAX_CONSECUTIVE_FAILURES (3) failures', async () => {
    // First call succeeds
    mockListWorkspacePorts.mockResolvedValueOnce([PORT_A]);

    const { result } = renderHook(() =>
      useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', true)
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.ports).toEqual([PORT_A]);

    // 3 consecutive failures — should clear
    for (let i = 0; i < 3; i++) {
      mockListWorkspacePorts.mockRejectedValueOnce(new Error('Network error'));
      await act(async () => {
        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    expect(result.current.ports).toEqual([]);
  });

  it('resets failure counter on a successful fetch', async () => {
    // First call succeeds
    mockListWorkspacePorts.mockResolvedValueOnce([PORT_A]);

    const { result } = renderHook(() =>
      useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', true)
    );

    await act(async () => {
      await Promise.resolve();
    });

    // 2 consecutive failures (below threshold)
    for (let i = 0; i < 2; i++) {
      mockListWorkspacePorts.mockRejectedValueOnce(new Error('timeout'));
      await act(async () => {
        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
        await Promise.resolve();
      });
    }
    expect(result.current.ports).toEqual([PORT_A]); // still preserved

    // Success resets counter
    mockListWorkspacePorts.mockResolvedValueOnce([PORT_B]);
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(result.current.ports).toEqual([PORT_B]);

    // 2 more failures after reset — still below threshold
    for (let i = 0; i < 2; i++) {
      mockListWorkspacePorts.mockRejectedValueOnce(new Error('timeout'));
      await act(async () => {
        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
        await Promise.resolve();
      });
    }
    expect(result.current.ports).toEqual([PORT_B]); // still preserved
  });

  it('polls at 10-second intervals', async () => {
    mockListWorkspacePorts.mockResolvedValue([PORT_A]);

    renderHook(() =>
      useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', true)
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockListWorkspacePorts).toHaveBeenCalledTimes(1);

    // Advance 10s for next poll
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(mockListWorkspacePorts).toHaveBeenCalledTimes(2);

    // Advance another 10s
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(mockListWorkspacePorts).toHaveBeenCalledTimes(3);
  });

  it('sets loading to true during fetch and false after', async () => {
    let resolvePromise!: (value: typeof PORT_A[]) => void;
    mockListWorkspacePorts.mockImplementationOnce(
      () => new Promise((resolve) => { resolvePromise = resolve; })
    );

    const { result } = renderHook(() =>
      useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', true)
    );

    // Loading should be true while fetch is in-flight
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(true);

    // Resolve the fetch
    await act(async () => {
      resolvePromise([PORT_A]);
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.ports).toEqual([PORT_A]);
  });

  it('confirms counter reset to zero by verifying 3 post-reset failures trigger clear', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Initial success
    mockListWorkspacePorts.mockResolvedValueOnce([PORT_A]);

    const { result } = renderHook(() =>
      useWorkspacePorts('https://ws.example.com', 'ws-1', 'tok-1', true)
    );

    await act(async () => { await Promise.resolve(); });

    // 2 failures
    for (let i = 0; i < 2; i++) {
      mockListWorkspacePorts.mockRejectedValueOnce(new Error('fail'));
      await act(async () => {
        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
        await Promise.resolve();
      });
    }
    expect(result.current.ports).toEqual([PORT_A]); // preserved

    // Success — should reset counter to 0
    mockListWorkspacePorts.mockResolvedValueOnce([PORT_B]);
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(result.current.ports).toEqual([PORT_B]);

    // Now 3 consecutive failures from zero should trigger clear
    for (let i = 0; i < 3; i++) {
      mockListWorkspacePorts.mockRejectedValueOnce(new Error('fail'));
      await act(async () => {
        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
        await Promise.resolve();
      });
    }
    expect(result.current.ports).toEqual([]); // cleared after 3 from zero

    warnSpy.mockRestore();
  });
});
