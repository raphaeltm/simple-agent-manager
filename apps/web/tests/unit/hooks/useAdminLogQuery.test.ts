import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAdminLogQuery } from '../../../src/hooks/useAdminLogQuery';

// Mock the API
const mockQueryAdminLogs = vi.fn();
vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
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

  it('should fetch logs once on mount', async () => {
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

  it('should have default filter state', () => {
    const { result } = renderHook(() => useAdminLogQuery());

    expect(result.current.filter).toEqual({
      levels: [],
      search: '',
      timeRange: '1h',
      scriptName: '',
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

  it('does NOT auto-fetch when a filter changes (rate-limit protection)', async () => {
    const { result } = renderHook(() => useAdminLogQuery());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(mockQueryAdminLogs).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.setLevels(['error', 'warn']);
      result.current.setSearch('timeout');
      result.current.setTimeRange('24h');
      result.current.setScriptName('sam-api-staging');
    });

    // Filter state updated locally...
    expect(result.current.filter.levels).toEqual(['error', 'warn']);
    expect(result.current.filter.search).toBe('timeout');
    expect(result.current.filter.timeRange).toBe('24h');
    expect(result.current.filter.scriptName).toBe('sam-api-staging');
    // ...but no additional CF API query was fired.
    expect(mockQueryAdminLogs).toHaveBeenCalledTimes(1);
  });

  it('fetches with the staged filters when applyFilters is called', async () => {
    const { result } = renderHook(() => useAdminLogQuery());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setLevels(['error']);
      result.current.setSearch('timeout');
      result.current.setScriptName('sam-api-staging');
    });

    await act(async () => {
      result.current.applyFilters();
    });

    await waitFor(() => {
      expect(mockQueryAdminLogs).toHaveBeenCalledTimes(2);
    });
    const lastCall = mockQueryAdminLogs.mock.calls[1][0];
    expect(lastCall.levels).toEqual(['error']);
    expect(lastCall.search).toBe('timeout');
    expect(lastCall.scriptName).toBe('sam-api-staging');
    expect(lastCall.cursor).toBeUndefined();
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

  it('omits scriptName from the query when not set', async () => {
    const { result } = renderHook(() => useAdminLogQuery());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const call = mockQueryAdminLogs.mock.calls[0][0];
    expect(call.scriptName).toBeUndefined();
  });
});
