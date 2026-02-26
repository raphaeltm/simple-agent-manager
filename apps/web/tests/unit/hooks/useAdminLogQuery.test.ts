import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAdminLogQuery } from '../../../src/hooks/useAdminLogQuery';

// Mock the API
const mockQueryAdminLogs = vi.fn();
vi.mock('../../../src/lib/api', () => ({
  queryAdminLogs: (...args: unknown[]) => mockQueryAdminLogs(...args),
}));

describe('useAdminLogQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryAdminLogs.mockResolvedValue({
      logs: [],
      cursor: null,
      hasMore: false,
    });
  });

  it('should start with empty logs', async () => {
    const { result } = renderHook(() => useAdminLogQuery());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.logs).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('should fetch logs on mount', async () => {
    const mockLogs = [
      { timestamp: '2026-02-14T12:00:00Z', level: 'info', event: 'http.request', message: 'test', details: {} },
    ];
    mockQueryAdminLogs.mockResolvedValue({
      logs: mockLogs,
      cursor: null,
      hasMore: false,
    });

    const { result } = renderHook(() => useAdminLogQuery());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.logs).toHaveLength(1);
    expect(mockQueryAdminLogs).toHaveBeenCalledTimes(1);
  });

  it('should have default filter state', async () => {
    const { result } = renderHook(() => useAdminLogQuery());

    expect(result.current.filter).toEqual({
      levels: [],
      search: '',
      timeRange: '1h',
    });
  });

  it('should pass timeRange to API', async () => {
    const { result } = renderHook(() => useAdminLogQuery());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const call = mockQueryAdminLogs.mock.calls[0][0];
    expect(call.timeRange).toHaveProperty('start');
    expect(call.timeRange).toHaveProperty('end');
    // Should be within the last hour
    const start = new Date(call.timeRange.start).getTime();
    const end = new Date(call.timeRange.end).getTime();
    expect(end - start).toBeLessThanOrEqual(60 * 60 * 1000 + 1000); // 1h + tolerance
  });

  it('should update levels filter and re-fetch', async () => {
    const { result } = renderHook(() => useAdminLogQuery());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const callsBefore = mockQueryAdminLogs.mock.calls.length;

    await act(async () => {
      result.current.setLevels(['error', 'warn']);
    });

    await waitFor(() => {
      expect(mockQueryAdminLogs.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    const lastCall = mockQueryAdminLogs.mock.calls[mockQueryAdminLogs.mock.calls.length - 1][0];
    expect(lastCall.levels).toEqual(['error', 'warn']);
  });

  it('should update search filter', async () => {
    const { result } = renderHook(() => useAdminLogQuery());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      result.current.setSearch('timeout');
    });

    await waitFor(() => {
      const calls = mockQueryAdminLogs.mock.calls;
      const lastCall = calls[calls.length - 1][0];
      expect(lastCall.search).toBe('timeout');
    });
  });

  it('should update timeRange filter', async () => {
    const { result } = renderHook(() => useAdminLogQuery());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      result.current.setTimeRange('24h');
    });

    await waitFor(() => {
      expect(result.current.filter.timeRange).toBe('24h');
    });
  });

  it('should handle API errors', async () => {
    mockQueryAdminLogs.mockRejectedValue(new Error('CF API down'));

    const { result } = renderHook(() => useAdminLogQuery());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('CF API down');
  });

  it('should support pagination with loadMore', async () => {
    mockQueryAdminLogs
      .mockResolvedValueOnce({
        logs: [{ timestamp: '2026-02-14T12:00:00Z', level: 'info', event: 'test', message: 'log 1', details: {} }],
        cursor: 'page-2',
        hasMore: true,
      })
      .mockResolvedValueOnce({
        logs: [{ timestamp: '2026-02-14T11:00:00Z', level: 'info', event: 'test', message: 'log 2', details: {} }],
        cursor: null,
        hasMore: false,
      });

    const { result } = renderHook(() => useAdminLogQuery());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.logs).toHaveLength(1);
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      result.current.loadMore();
    });

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(2);
    });

    expect(result.current.hasMore).toBe(false);
  });

  it('should reset cursor on refresh', async () => {
    const { result } = renderHook(() => useAdminLogQuery());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() => {
      // The last call should have no cursor (fresh query)
      const lastCall = mockQueryAdminLogs.mock.calls[mockQueryAdminLogs.mock.calls.length - 1][0];
      expect(lastCall.cursor).toBeUndefined();
    });
  });
});
