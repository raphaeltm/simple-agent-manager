import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAdminHealth } from '../../../src/hooks/useAdminHealth';

// Mock the API
const mockFetchAdminHealth = vi.fn();
vi.mock('../../../src/lib/api', () => ({
  fetchAdminHealth: (...args: unknown[]) => mockFetchAdminHealth(...args),
}));

describe('useAdminHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchAdminHealth.mockResolvedValue({
      activeNodes: 0,
      activeWorkspaces: 0,
      inProgressTasks: 0,
      errorCount24h: 0,
      timestamp: '2026-02-14T12:00:00.000Z',
    });
  });

  it('should start in loading state', () => {
    const { result } = renderHook(() => useAdminHealth({ refreshIntervalMs: 0 }));
    expect(result.current.loading).toBe(true);
    expect(result.current.health).toBeNull();
  });

  it('should fetch health data on mount', async () => {
    const mockHealth = {
      activeNodes: 3,
      activeWorkspaces: 5,
      inProgressTasks: 2,
      errorCount24h: 42,
      timestamp: '2026-02-14T12:00:00.000Z',
    };
    mockFetchAdminHealth.mockResolvedValue(mockHealth);

    const { result } = renderHook(() => useAdminHealth({ refreshIntervalMs: 0 }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.health).toEqual(mockHealth);
    expect(result.current.error).toBeNull();
    expect(mockFetchAdminHealth).toHaveBeenCalledTimes(1);
  });

  it('should handle API errors gracefully', async () => {
    mockFetchAdminHealth.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useAdminHealth({ refreshIntervalMs: 0 }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.health).toBeNull();
    expect(result.current.error).toBe('Network error');
  });

  it('should handle non-Error rejections', async () => {
    mockFetchAdminHealth.mockRejectedValue('string error');

    const { result } = renderHook(() => useAdminHealth({ refreshIntervalMs: 0 }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Failed to load health data');
  });

  it('should expose a refresh function', async () => {
    const { result } = renderHook(() => useAdminHealth({ refreshIntervalMs: 0 }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockFetchAdminHealth).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(mockFetchAdminHealth).toHaveBeenCalledTimes(2);
    });
  });

  describe('auto-refresh with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should auto-refresh on interval', async () => {
      const refreshIntervalMs = 30_000;

      const { result } = renderHook(() => useAdminHealth({ refreshIntervalMs }));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(mockFetchAdminHealth).toHaveBeenCalledTimes(1);

      // Advance timer to trigger refresh
      await act(async () => {
        vi.advanceTimersByTime(refreshIntervalMs);
      });

      await waitFor(() => {
        expect(mockFetchAdminHealth).toHaveBeenCalledTimes(2);
      });
    });

    it('should stop auto-refresh on unmount', async () => {
      const { result, unmount } = renderHook(() => useAdminHealth({ refreshIntervalMs: 30_000 }));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(mockFetchAdminHealth).toHaveBeenCalledTimes(1);

      unmount();

      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });

      // Should not have been called again after unmount
      expect(mockFetchAdminHealth).toHaveBeenCalledTimes(1);
    });

    it('should not auto-refresh when interval is 0', async () => {
      const { result } = renderHook(() => useAdminHealth({ refreshIntervalMs: 0 }));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        vi.advanceTimersByTime(120_000);
      });

      // Only the initial fetch
      expect(mockFetchAdminHealth).toHaveBeenCalledTimes(1);
    });
  });
});
